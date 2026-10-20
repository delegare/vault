/**
 * x402 facilitator service.
 *
 * Implements the Coinbase x402 spec (https://x402.gitbook.io/x402) on top of
 * vault's existing crypto rail. Two entry points:
 *
 *   verifyX402Payment  — checks the EIP-3009 signed transferWithAuthorization
 *                        is valid, bounded by mandate limits (if any), and
 *                        funded. Must NEVER return isValid=true for a payment
 *                        that cannot settle — the x402 contract permits a
 *                        server to release goods on a good verify.
 *
 *   settleX402Payment  — executes the payment on-chain. For EOA payers we
 *                        broadcast USDC.receiveWithAuthorization via the
 *                        relayer. For mandate-backed payers (where the
 *                        "from" is a smart wallet whose authority is a
 *                        session key, not an ecrecoverable owner) we fall
 *                        back to the existing router-based chargeCrypto path
 *                        since USDC's EIP-3009 will not accept a session-key
 *                        signature for a smart wallet "from".
 *
 * This module is used by both the HTTP facilitator endpoints (X402Controller)
 * and the in-process Express middleware (middleware/x402), so the middleware
 * does NOT self-HTTP to localhost.
 *
 * x402 is USDC-only (EIP-3009). USDT on Base does not implement
 * transferWithAuthorization, so we reject any non-USDC request up front.
 */

import {
  verifyTypedData,
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  hexToNumber,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { QueryCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { SUPPORTED_TOKENS, chargeCrypto } from './CryptoRail';
import { checkAndIncrement, LimitExceededError } from './LimitEnforcer';
import type { SpendingMandate } from '../models/SpendingMandate';
import { logger } from '../lib/logger';

// ── Types ────────────────────────────────────────────────────────────────

/** Options a merchant-side middleware passes to build PaymentRequirements. */
export interface X402Requirements {
  /** Decimal USDC amount as a string, e.g. "0.05" — matches Stripe-style UX. */
  price: string;
  payTo: string;
  resource?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** Default mainnet. Tests override to base-sepolia. */
  testMode?: boolean;
}

/** Bazaar discovery metadata forwarded from @delegare/x402 middleware
 *  via declareDiscoveryExtension(). Matches the CDP Bazaar extension schema. */
export interface BazaarExtension {
  description?: string;
  input?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  output?: { example?: unknown; schema?: Record<string, unknown> };
}

// ── CDP Bazaar Indexing ──────────────────────────────────────────────────

const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

/**
 * After a successful x402 settlement, push the service metadata to the CDP
 * Bazaar so it gets indexed for AI agent discovery.
 *
 * This is intentionally fire-and-forget — CDP indexing must NEVER block
 * the primary settlement response. Errors are logged but not propagated.
 *
 * The Bazaar indexes a service the first time it settles through CDP.
 * Subsequent settlements update quality signals (buyer reach, volume).
 *
 * Ref: https://docs.cdp.coinbase.com/x402/bazaar
 */

export function pushCdpBazaarIndex(params: {
  requirements: X402Requirements;
  txHash: string;
  network: string;
  bazaar?: BazaarExtension;
}): void {
  if (!params.bazaar) return; // No discovery metadata — skip silently

  // Fire-and-forget — do not await
  (async () => {
    try {
      const body = {
        // Standard x402 settle payload — CDP needs this to verify the transaction
        payment: {
          transaction: params.txHash,
          network: params.network,
        },
        requirements: {
          scheme: 'exact',
          network: params.network,
          asset: 'usdc',
          payTo: params.requirements.payTo,
          maxAmountRequired: params.requirements.price,
          resource: params.requirements.resource ?? '',
          mimeType: params.requirements.mimeType ?? 'application/json',
          maxTimeoutSeconds: params.requirements.maxTimeoutSeconds ?? 60,
        },
        // CDP Bazaar extension — service metadata for search indexing
        extensions: {
          bazaar: params.bazaar,
        },
      };

      // NOTE: CDP Bazaar indexing is NOT triggered by posting to /settle directly.
      // Per docs.cdp.coinbase.com/x402/bazaar — services are indexed automatically
      // the first time the CDP Facilitator settles a payment for that endpoint.
      // Use declareDiscoveryExtension() on x402-gated routes and route payments
      // through the CDP Facilitator at https://api.cdp.coinbase.com/platform/v2/x402
      // This call is retained for telemetry / future use when CDP opens the API.
      const res = await fetch(`${CDP_FACILITATOR_URL}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn(
          { status: res.status, resource: params.requirements.resource, body },
          '[x402] CDP Bazaar indexing call returned non-2xx — service may not be discoverable',
        );
      } else {
        logger.info(
          { resource: params.requirements.resource, txHash: params.txHash },
          '[x402] CDP Bazaar index pushed successfully',
        );
      }
    } catch (err) {
      // Network errors, timeouts — log and continue
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), resource: params.requirements.resource },
        '[x402] CDP Bazaar indexing call failed — service may not be discoverable in Bazaar',
      );
    }
  })();
}

/** EIP-3009 signed authorization — wire format is base64 JSON. */
export interface ExactEvmPayload {
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string; // atomic units (uint256 decimal string)
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
}

export interface X402Payment {
  scheme: 'exact';
  network: 'base' | 'base-sepolia';
  /** Inner payload. We accept both the new `authorization` key and legacy
   *  flattened fields for backwards-compat with an earlier draft. */
  payload: ExactEvmPayload;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  /** Mandate whose smart wallet matches payment.from (if any). */
  payerMandate?: SpendingMandate;
  /** The normalized EIP-3009 authorization used for downstream settlement. */
  auth?: ExactEvmPayload['authorization'] & { signature: `0x${string}` };
}

export interface SettleResult {
  success: boolean;
  /** x402 spec: transaction hash on success. */
  transaction?: string;
  network?: 'base' | 'base-sepolia';
  /** Who paid — mandate id if mandate-backed, else the raw EOA. */
  payer?: string;
  errorReason?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function eip712Domain(testMode: boolean) {
  const USDC = SUPPORTED_TOKENS.usdc;
  return {
    name: USDC.name, // "USD Coin"
    version: '2',
    chainId: testMode ? 84532 : 8453,
    verifyingContract: USDC.address as `0x${string}`,
  } as const;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Accept both `{ payload: { authorization, signature } }` (spec) and the
 *  older flattened `{ payment: {...} }` shape still emitted by CredentialService
 *  so existing clients continue to work. */
export function normalizePayment(raw: unknown): X402Payment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (r.scheme !== 'exact') return null;

  // Shape A: spec — { scheme, network, payload: { signature, authorization } }
  if (r.payload?.authorization && r.payload?.signature) {
    return {
      scheme: 'exact',
      network: r.network === 'base-sepolia' ? 'base-sepolia' : 'base',
      payload: {
        signature: r.payload.signature,
        authorization: {
          from: r.payload.authorization.from,
          to: r.payload.authorization.to,
          value: String(r.payload.authorization.value),
          validAfter: String(r.payload.authorization.validAfter ?? 0),
          validBefore: String(
            r.payload.authorization.validBefore ?? Math.floor(Date.now() / 1000) + 3600,
          ),
          nonce: r.payload.authorization.nonce,
        },
      },
    };
  }

  // Shape B: legacy — { scheme, payment: { from, to, value, ..., signature } }
  const inner = r.payment ?? r.payload;
  if (inner?.from && inner?.to && inner?.value && inner?.signature) {
    return {
      scheme: 'exact',
      network: r.network === 'base-sepolia' ? 'base-sepolia' : 'base',
      payload: {
        signature: inner.signature,
        authorization: {
          from: inner.from,
          to: inner.to,
          value: String(inner.value),
          validAfter: String(inner.validAfter ?? 0),
          validBefore: String(inner.validBefore ?? Math.floor(Date.now() / 1000) + 3600),
          nonce: inner.nonce,
        },
      },
    };
  }

  return null;
}

/** Convert "0.05" → 50000n (USDC is 6 decimals). */
export function priceToAtomicUsdc(price: string): bigint {
  const USDC = SUPPORTED_TOKENS.usdc;
  return parseUnits(price, USDC.decimals);
}

/** Atomic units → cents (rounded down). USDC has 6 decimals, cents has 2. */
export function atomicUsdcToCents(atomic: bigint): number {
  return Number(atomic / 10_000n);
}

/** Look up mandate by smart wallet address using the smartWalletAddressIndex
 *  GSI. Returns undefined if no active mandate exists. */
async function findMandateBySmartWallet(
  smartWalletAddress: string,
): Promise<SpendingMandate | undefined> {
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MANDATES,
        IndexName: 'smartWalletAddressIndex',
        KeyConditionExpression: 'smartWalletAddress = :addr',
        FilterExpression: '#st = :active',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':addr': smartWalletAddress,
          ':active': 'active',
        },
        Limit: 1,
      }),
    );
    return res.Items?.[0] as SpendingMandate | undefined;
  } catch (err) {
    // Index may not exist yet in some envs — log and treat as "no mandate".
    logger.warn({ err: (err as Error).message }, '[x402] smartWalletAddressIndex query failed');
    return undefined;
  }
}

// ── Settle idempotency (mandate paths) ───────────────────────────────────
//
//  The mandate settle paths perform an atomic spend increment AND an on-chain
//  charge. Idempotency must wrap BOTH: deduping only the charge would let a
//  retry double-increment the mandate's monthly spend counter while the charge
//  is deduped. We therefore guard at the settle layer — a caller-supplied
//  Idempotency-Key claims an `x402settle_<key>` sentinel row before any spend
//  or charge, and a replay of a completed key returns the stored SettleResult
//  without re-incrementing or re-charging.
//
//  The stored txHash lives under `settleTxHash` (NOT `txHash`) so the sentinel
//  never lands in the txHashIndex GSI used by verifyX402Receipt.
//
//  WITHOUT a key we cannot distinguish a retry from a genuine new metered
//  charge, so each call proceeds independently. Making retries safe therefore
//  requires the client to send a stable per-request Idempotency-Key; the EOA
//  path already gets this for free via the EIP-3009 nonce.

function settleIdemId(key: string | undefined): string | undefined {
  return key ? `x402settle_${key}` : undefined;
}

function replayFromItem(item: Record<string, any>): SettleResult {
  return {
    success: true,
    transaction: item.settleTxHash as string,
    network: item.settleNetwork as 'base' | 'base-sepolia',
    payer: item.settlePayer as string,
  };
}

/**
 * Claim an idempotency key for a settle operation.
 * - `{ replay }` → a completed result already exists; return it, do not charge.
 * - `{ claimed: true }` → this caller owns the in-flight claim; proceed, then
 *   call finalize (success) or release (failure).
 * - `{ claimed: false }` and no replay → another caller holds the claim; treat
 *   as in-progress.
 */
async function claimSettleIdempotency(
  key: string | undefined,
): Promise<{ replay?: SettleResult; claimed: boolean }> {
  const id = settleIdemId(key);
  if (!id) return { claimed: false };

  try {
    const prior = await ddb.send(
      new GetCommand({ TableName: TABLE.TRANSACTIONS, Key: { receiptId: id } }),
    );
    if (prior.Item?.status === 'completed') {
      return { replay: replayFromItem(prior.Item), claimed: false };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, id }, '[x402] settle idempotency read failed — proceeding to claim');
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE.TRANSACTIONS,
        Item: { receiptId: id, kind: 'x402-settle-idempotency', status: 'in_flight', createdAt: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(receiptId) OR #s = :failed',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed' },
      }),
    );
    return { claimed: true };
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // Lost the race — return the winner's result if it has completed.
      const cur = await ddb
        .send(new GetCommand({ TableName: TABLE.TRANSACTIONS, Key: { receiptId: id } }))
        .catch(() => undefined);
      if (cur?.Item?.status === 'completed') {
        return { replay: replayFromItem(cur.Item), claimed: false };
      }
      return { claimed: false }; // still in-flight elsewhere
    }
    throw err;
  }
}

async function finalizeSettleIdempotency(key: string | undefined, result: SettleResult): Promise<void> {
  const id = settleIdemId(key);
  if (!id || !result.success) return;
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE.TRANSACTIONS,
        Key: { receiptId: id },
        UpdateExpression: 'SET #s = :completed, settleTxHash = :tx, settleNetwork = :net, settlePayer = :payer',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':completed': 'completed',
          ':tx': result.transaction ?? '',
          ':net': result.network ?? 'base',
          ':payer': result.payer ?? '',
        },
      }),
    )
    .catch((err) => logger.error({ err: (err as Error).message, id }, '[x402] settle idempotency finalize failed'));
}

async function releaseSettleIdempotency(key: string | undefined): Promise<void> {
  const id = settleIdemId(key);
  if (!id) return;
  await ddb
    .send(
      new UpdateCommand({
        TableName: TABLE.TRANSACTIONS,
        Key: { receiptId: id },
        UpdateExpression: 'SET #s = :failed',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed' },
        ConditionExpression: 'attribute_exists(receiptId)',
      }),
    )
    .catch(() => {});
}

/**
 * Wrap a settle operation with idempotency. On a completed replay it returns
 * the stored result without running `op` (so no double spend-increment and no
 * double charge). On failure it releases the claim so a legitimate retry can
 * re-attempt. A no-op passthrough when `idempotencyKey` is undefined.
 */
async function runWithSettleIdempotency(
  idempotencyKey: string | undefined,
  op: () => Promise<SettleResult>,
): Promise<SettleResult> {
  const claim = await claimSettleIdempotency(idempotencyKey);
  if (claim.replay) return claim.replay;
  if (idempotencyKey && !claim.claimed) {
    return { success: false, errorReason: 'A settlement for this idempotency key is already in progress' };
  }
  try {
    const result = await op();
    if (result.success) await finalizeSettleIdempotency(idempotencyKey, result);
    else await releaseSettleIdempotency(idempotencyKey);
    return result;
  } catch (err) {
    await releaseSettleIdempotency(idempotencyKey);
    throw err;
  }
}

// ── Receipt Verification (post-settlement) ───────────────────────────────

/**
 * TTL (in milliseconds) during which a settlement receipt is considered
 * valid for post-settlement verification via /v1/x402/verify-receipt.
 *
 * Without this bound, a captured X-PAYMENT-RESPONSE receipt could be
 * replayed indefinitely against the same resource — paying once and
 * accessing forever. 60s gives clients enough room for legitimate retries
 * (handler 5xx, network blip) while sharply limiting replay windows.
 */
export const RECEIPT_TTL_MS = 60_000;

export interface VerifyReceiptParams {
  /** On-chain transaction hash (0x…) from the X-PAYMENT-RESPONSE receipt. */
  transaction: string;
  /** Network the receipt's tx settled on. */
  network: 'base' | 'base-sepolia';
  /** Merchant wallet expected to have received the payment. */
  expectedPayTo: string;
  /** Atomic USDC amount the merchant required, as a decimal string. */
  expectedAmount: string;
  /**
   * Resource identifier the merchant is gating. REQUIRED — without this
   * the receipt is not bound to a specific endpoint and the same receipt
   * could be replayed across any same-(payTo, amount) endpoint of the
   * merchant. See https://github.com/delegare/delegare/issues/1.
   */
  expectedResource: string;
}

/**
 * Verify a post-settlement X-PAYMENT-RESPONSE receipt against the
 * transaction record we wrote at settle time.
 *
 * This is DIFFERENT from verifyX402Payment(), which verifies an unsettled
 * EIP-3009 authorization payload. This function verifies a receipt for an
 * already-settled tx: looks the tx up in our transactions table by txHash,
 * then enforces resource / payTo / amount binding plus a TTL.
 *
 * Critical: callers MUST supply `expectedResource`. We fail-closed if it's
 * missing or doesn't match the stored resource — that's the fix for the
 * cross-resource receipt replay vulnerability reported in issue #1.
 */
export async function verifyX402Receipt(
  params: VerifyReceiptParams,
): Promise<VerifyResult> {
  // 1. Input validation — fail-closed on any missing field.
  if (!params.transaction || typeof params.transaction !== 'string') {
    return { isValid: false, invalidReason: 'Missing transaction hash' };
  }
  if (!params.expectedResource || typeof params.expectedResource !== 'string') {
    return {
      isValid: false,
      invalidReason:
        'Missing expectedResource — receipt verification requires resource binding to prevent cross-resource replay',
    };
  }
  if (!params.expectedPayTo) {
    return { isValid: false, invalidReason: 'Missing expectedPayTo' };
  }
  if (!params.expectedAmount) {
    return { isValid: false, invalidReason: 'Missing expectedAmount' };
  }

  // 2. Look up the transaction record via the txHash GSI.
  let receiptId: string | undefined;
  try {
    const q = await ddb.send(
      new QueryCommand({
        TableName: TABLE.TRANSACTIONS,
        IndexName: 'txHashIndex',
        KeyConditionExpression: 'txHash = :tx',
        ExpressionAttributeValues: { ':tx': params.transaction },
        Limit: 1,
      }),
    );
    if (!q.Items || q.Items.length === 0) {
      return {
        isValid: false,
        invalidReason: 'Receipt not found — transaction not settled through this facilitator',
      };
    }
    receiptId = q.Items[0].receiptId as string;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[x402] verifyReceipt: txHash GSI query failed');
    return { isValid: false, invalidReason: 'Receipt lookup failed' };
  }

  // 3. Fetch the full record (GSI only projects [receiptId, status]).
  const full = await ddb.send(
    new GetCommand({
      TableName: TABLE.TRANSACTIONS,
      Key: { receiptId },
    }),
  );
  if (!full.Item) {
    return { isValid: false, invalidReason: 'Receipt record missing' };
  }
  const record = full.Item as Record<string, any>;

  // 4. Status check — only completed transactions are valid receipts.
  if (record.status !== 'completed') {
    return {
      isValid: false,
      invalidReason: `Receipt status is "${record.status}", not "completed"`,
    };
  }

  // 5. Resource binding — THE PRIMARY FIX.
  //    Reject receipts whose stored resource doesn't match the current
  //    endpoint the merchant is gating. Without this, a receipt from
  //    /route-a could grant access to /route-b for the same (payTo, amount).
  //    Also fail-closed if the stored resource is null — legacy records
  //    pre-fix lack the structured field; refuse rather than fall through.
  if (!record.resource) {
    return {
      isValid: false,
      invalidReason:
        'Receipt lacks resource binding (pre-fix legacy record) — re-settle required',
    };
  }
  if (record.resource !== params.expectedResource) {
    return {
      isValid: false,
      invalidReason:
        'Receipt resource does not match — cross-resource replay rejected',
    };
  }

  // 6. payTo binding.
  if (!record.payTo || record.payTo.toLowerCase() !== params.expectedPayTo.toLowerCase()) {
    return { isValid: false, invalidReason: 'Receipt payTo does not match expectedPayTo' };
  }

  // 7. Amount binding (atomic USDC).
  //    Prefer the structured paidAtomic field; fall back to amountCents
  //    × 10_000 for any record predating the structured field.
  let recordAtomic: bigint;
  try {
    recordAtomic = record.paidAtomic
      ? BigInt(record.paidAtomic)
      : BigInt(record.amountCents ?? 0) * BigInt(10_000);
  } catch {
    return { isValid: false, invalidReason: 'Receipt amount unparseable' };
  }
  let expectedAtomic: bigint;
  try {
    expectedAtomic = BigInt(params.expectedAmount);
  } catch {
    return { isValid: false, invalidReason: 'expectedAmount unparseable' };
  }
  if (recordAtomic < expectedAtomic) {
    return { isValid: false, invalidReason: 'Receipt amount below expectedAmount' };
  }

  // 8. TTL check — caps the replay window even for resource-matched, same-
  //    merchant retries. Use receiptExpiresAt if stored, otherwise derive
  //    from completedAt + RECEIPT_TTL_MS for legacy records.
  let expiresAtMs: number;
  if (record.receiptExpiresAt) {
    expiresAtMs = new Date(record.receiptExpiresAt).getTime();
  } else if (record.completedAt) {
    expiresAtMs = new Date(record.completedAt).getTime() + RECEIPT_TTL_MS;
  } else {
    return { isValid: false, invalidReason: 'Receipt has no timestamp — cannot verify TTL' };
  }
  if (Date.now() > expiresAtMs) {
    return {
      isValid: false,
      invalidReason: `Receipt expired (TTL ${RECEIPT_TTL_MS}ms past settlement)`,
    };
  }

  // 9. Atomic one-time-use enforcement — the final gate.
  //    Stamps `consumedAt` on the record via a conditional update that only
  //    succeeds when the attribute is absent. DDB serializes the writes, so
  //    two parallel verify calls of the same tx both pass steps 1–8 and then
  //    race here — exactly one wins. The loser gets ConditionalCheckFailedException
  //    and is reported as "already consumed". TTL bounds the window in which
  //    the race can happen; this collapses it to zero (single-shot semantics
  //    inside the window).
  //    See https://github.com/delegare/delegare/issues/2.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.TRANSACTIONS,
        Key: { receiptId },
        UpdateExpression: 'SET consumedAt = :now',
        ConditionExpression: 'attribute_not_exists(consumedAt)',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }),
    );
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return {
        isValid: false,
        invalidReason: 'Receipt already consumed (one-time-use enforcement)',
      };
    }
    // Any other DDB error: fail-closed. A transient outage during consume
    // blocks legitimate access for the TTL window, but never lets a tx be
    // reused. TTL itself still bounds the worst case.
    logger.error(
      { err: (err as Error).message },
      '[x402] verifyReceipt: consume update failed — failing closed',
    );
    return { isValid: false, invalidReason: 'Receipt consume failed — try again' };
  }

  return { isValid: true };
}

// ── Verify ───────────────────────────────────────────────────────────────

export async function verifyX402Payment(
  rawPayment: unknown,
  requirements: X402Requirements,
): Promise<VerifyResult> {
  // If rawPayment is a string, it's likely a mandate token (SD-JWT)
  if (typeof rawPayment === 'string' && rawPayment.startsWith('eyJ')) {
    // For pure mandate verification, we just confirm the token is structurally valid.
    // Settlement will do the actual limit check and on-chain execution.
    return {
      isValid: true,
      auth: {
        from: '0x0000000000000000000000000000000000000000', // Placeholder
        to: (requirements.payTo as `0x${string}`),
        value: String(priceToAtomicUsdc(requirements.price)),
        validAfter: '0',
        validBefore: '0',
        nonce: `0x${Date.now().toString(16)}`,
        signature: '0x',
      }
    };
  }

  const payment = normalizePayment(rawPayment);
  if (!payment) {
    return { isValid: false, invalidReason: 'Unsupported payment shape (expected scheme=exact)' };
  }

  const testMode = !!requirements.testMode || payment.network === 'base-sepolia';
  const domain = eip712Domain(testMode);
  const auth = payment.payload.authorization;
  const signature = payment.payload.signature;

  // 1. Basic field sanity
  if (!auth.from || !auth.to || !auth.value || !auth.nonce || !signature) {
    return { isValid: false, invalidReason: 'Missing EIP-3009 fields' };
  }

  // 2. Amount matches requirement (exact scheme requires ≥ required)
  let requiredAtomic: bigint;
  try {
    requiredAtomic = priceToAtomicUsdc(requirements.price);
  } catch {
    return { isValid: false, invalidReason: 'Invalid requirements.price' };
  }
  let paidAtomic: bigint;
  try {
    paidAtomic = BigInt(auth.value);
  } catch {
    return { isValid: false, invalidReason: 'Invalid authorization.value' };
  }
  if (paidAtomic < requiredAtomic) {
    return { isValid: false, invalidReason: 'Payment value below required amount' };
  }

  // 3. payTo matches
  if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { isValid: false, invalidReason: 'Payment `to` does not match payTo' };
  }

  // 4. Time window
  const now = Math.floor(Date.now() / 1000);
  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);
  if (validBefore && validBefore <= now) {
    return { isValid: false, invalidReason: 'Authorization expired' };
  }
  if (validAfter && validAfter > now) {
    return { isValid: false, invalidReason: 'Authorization not yet valid' };
  }

  // 5. Signature recovery against `from`.
  //    This is the ONLY signature check we perform — USDC's transferWithAuthorization
  //    uses ecrecover against the `from` field, so a signature from anyone
  //    other than the owner of `from` will always revert on-chain. We refuse
  //    to return isValid=true for a payment that cannot settle.
  const isSigValid = await verifyTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: paidAtomic,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: auth.nonce,
    },
    signature,
    address: auth.from,
  }).catch(() => false);

  // If the signature doesn't ecrecover to `from`, `from` might still be a
  // smart wallet owned by one of our mandates. In that case we reject the
  // x402 verify path outright — the caller should use the router-based
  // chargeCrypto flow instead. (We can't honor a smart-wallet EIP-3009 via
  // the canonical USDC contract because it does not call isValidSignature.)
  if (!isSigValid) {
    const mandate = await findMandateBySmartWallet(auth.from);
    if (mandate) {
      return {
        isValid: false,
        invalidReason:
          'Smart-wallet mandates cannot sign USDC EIP-3009 directly — use POST /v1/charge (router path) for this buyer',
      };
    }
    return { isValid: false, invalidReason: 'Signature does not recover to `from` address' };
  }

  // 6. EOA payer: confirm USDC balance covers the auth value.
  //    (Per-tx / monthly limits only apply to mandate-backed payers, which
  //    we've just ruled out above — if isSigValid is true, it's an EOA.)
  const rpcUrl = process.env[testMode ? 'BASE_SEPOLIA_RPC_URL' : 'BASE_RPC_URL'];
  if (rpcUrl) {
    try {
      const publicClient = createPublicClient({
        chain: testMode ? baseSepolia : base,
        transport: http(rpcUrl),
      });
      const balance = (await publicClient.readContract({
        address: domain.verifyingContract,
        abi: [
          {
            name: 'balanceOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ],
        functionName: 'balanceOf',
        args: [auth.from],
      })) as bigint;
      if (balance < paidAtomic) {
        return { isValid: false, invalidReason: 'Insufficient USDC balance' };
      }

      // Also check nonce hasn't been used — transferWithAuthorization rejects
      // duplicate nonces on-chain; catching it now avoids a failed broadcast.
      try {
        const used = (await publicClient.readContract({
          address: domain.verifyingContract,
          abi: [
            {
              name: 'authorizationState',
              type: 'function',
              stateMutability: 'view',
              inputs: [
                { name: 'authorizer', type: 'address' },
                { name: 'nonce', type: 'bytes32' },
              ],
              outputs: [{ name: '', type: 'bool' }],
            },
          ],
          functionName: 'authorizationState',
          args: [auth.from, auth.nonce],
        })) as boolean;
        if (used) {
          return { isValid: false, invalidReason: 'Authorization nonce already used' };
        }
      } catch {
        // Non-USDC token or older contract — skip.
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[x402] balance check failed');
      // Fall through — we still verified the signature.
    }
  }

  return { isValid: true, auth: { ...auth, signature } };
}

// ── Settle ───────────────────────────────────────────────────────────────

/** Splits a 65-byte compact signature into (v,r,s). */
function splitSignature(sig: `0x${string}`): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const r = (sig.slice(0, 66)) as `0x${string}`;
  const s = (`0x${sig.slice(66, 130)}`) as `0x${string}`;
  let v = hexToNumber((`0x${sig.slice(130, 132)}`) as `0x${string}`);
  if (v < 27) v += 27;
  return { v, r, s };
}

const USDC_RECEIVE_WITH_AUTH_ABI = [
  {
    name: 'receiveWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export async function settleX402Payment(
  rawPayment: unknown,
  requirements: X402Requirements,
  bazaar?: BazaarExtension,
  idempotencyKey?: string,
): Promise<SettleResult> {
  // ── Handle Mandate String Flow ───────────────────────────────────────────
  if (typeof rawPayment === 'string' && rawPayment.startsWith('eyJ')) {
    return runWithSettleIdempotency(idempotencyKey, async () => {
    const amountCents = Math.ceil(parseFloat(requirements.price) * 100);
    try {
      const { CredentialService } = await import('./CredentialService');
      const credentialService = new CredentialService();
      
      // 1. Verify the SD-JWT and resolve the active Mandate object
      const mandate = await credentialService.verifyIntentMandate(rawPayment);
      
      // 2. Check spend limits
      await checkAndIncrement({
        mandate,
        amountCents,
        merchantId: requirements.payTo, // In x402, payTo is the merchant address
      });

      // 3. Charge via the crypto rail
      // Idempotency for this settle is enforced above by runWithSettleIdempotency
      // (it claims the spend increment + charge as one op). chargeCrypto itself
      // takes no key — passing one here was a no-op. See ChargeCryptoParams.
      const receipt = await chargeCrypto({
        delegate: mandate,
        amountCents,
        currency: 'usdc',
        recipientAddress: requirements.payTo,
        isTestMode: requirements.testMode ?? false,
      });

      if (receipt.status !== 'completed') {
        // Rollback limit on failure
        const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE.MANDATES,
            Key: { mandateId: mandate.mandateId, userDid: mandate.userDid },
            UpdateExpression: 'SET currentMonthSpendCents = currentMonthSpendCents - :amount',
            ConditionExpression: 'currentMonthSpendCents >= :amount',
            ExpressionAttributeValues: { ':amount': amountCents },
          }),
        );
        return {
          success: false,
          errorReason: receipt.failureReason || 'Crypto charge failed',
        };
      }

      // Persist x402-style receipt so GET /transactions and GET /receipts works
      const { PutCommand, QueryCommand: Query } = await import('@aws-sdk/lib-dynamodb');
      const transactionId = `x402_mandate_${mandate.mandateId}_${receipt.txHash}`;
      
      // Attempt to look up the merchant by wallet address to get their ID and name
      let merchantId = requirements.payTo;
      let merchantName = 'Web3 Merchant';
      try {
        const merchantLookup = await ddb.send(new Query({
          TableName: TABLE.MERCHANTS,
          IndexName: 'walletIndex',
          KeyConditionExpression: 'usdcWalletAddress = :addr',
          ExpressionAttributeValues: { ':addr': requirements.payTo.toLowerCase() },
          Limit: 1
        }));
        
        // Let's also check if they match their raw Wallet address or anything else.
        if (merchantLookup.Items?.[0]) {
          // If we found a merchant, but it's an auto-created P2P alias (accountType: 'p2p_auto'), 
          // we actually want the transactions to appear under their REAL primary merchant account
          // which has the same email!
          const matchedItem = merchantLookup.Items[0];
          merchantId = matchedItem.merchantId;
          merchantName = matchedItem.name;

          if (matchedItem.autoCreated && matchedItem.contactEmail) {
            const emailLookup = await ddb.send(new Query({
              TableName: TABLE.MERCHANTS,
              IndexName: 'emailIndex',
              KeyConditionExpression: 'contactEmail = :email',
              ExpressionAttributeValues: { ':email': matchedItem.contactEmail }
            }));
            
            const primaryAccount = emailLookup.Items?.find(item => !item.autoCreated);
            if (primaryAccount) {
              merchantId = primaryAccount.merchantId;
              merchantName = primaryAccount.name;
            }
          }
        }
      } catch (e) {
        logger.warn({ payTo: requirements.payTo }, 'Could not resolve merchantId for x402 transaction');
      }

      await ddb.send(
        new PutCommand({
          TableName: TABLE.TRANSACTIONS,
          Item: {
            receiptId: transactionId,
            mandateId: mandate.mandateId,
            ownerId: mandate.ownerId,
            merchantId: merchantId,
            merchantName: merchantName,
            amountCents,
            description: requirements.resource ? `x402 payment for ${requirements.resource}` : 'x402 payment',
            status: 'completed',
            rail: 'crypto',
            currency: 'usdc',
            txHash: receipt.txHash,
            requestedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        }),
      );

      const settleResult: SettleResult = {
        success: true,
        transaction: receipt.txHash,
        network: requirements.testMode ? 'base-sepolia' : 'base',
        payer: mandate.mandateId,
      };
      // Push to CDP Bazaar for discovery indexing (fire-and-forget)
      pushCdpBazaarIndex({ requirements, txHash: receipt.txHash, network: settleResult.network!, bazaar });
      return settleResult;
    } catch (err: any) {
      return {
        success: false,
        errorReason: err.message || 'Mandate settlement failed',
      };
    }
    });
  }

  // ── Handle EIP-3009 Flow ─────────────────────────────────────────────────
  // Re-verify on settle — the x402 spec allows this and it closes the
  // verify/settle binding gap (nothing stops a client from calling /settle
  // directly).
  const verified = await verifyX402Payment(rawPayment, requirements);
  if (!verified.isValid || !verified.auth) {
    return { success: false, errorReason: verified.invalidReason };
  }
  const auth = verified.auth;
  const testMode = !!requirements.testMode;
  const network: 'base' | 'base-sepolia' = testMode ? 'base-sepolia' : 'base';
  const domain = eip712Domain(testMode);
  const paidAtomic = BigInt(auth.value);
  const amountCents = atomicUsdcToCents(paidAtomic);

  // Idempotency: the authorization nonce is globally unique and doubles as a
  // natural idempotency key. Persist receipts under `x402_<nonce>` to avoid
  // colliding with the rcpt_ namespace used by the Stripe path.
  const receiptId = `x402_${auth.nonce}`;
  try {
    const existing = await ddb.send(
      new GetCommand({ TableName: TABLE.TRANSACTIONS, Key: { receiptId } }),
    );
    if (existing.Item && existing.Item['status'] === 'completed') {
      return {
        success: true,
        transaction: existing.Item['txHash'] as string,
        network,
        payer: (existing.Item['mandateId'] as string) ?? auth.from,
      };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[x402] idempotency check failed');
  }

  // EOA path: broadcast receiveWithAuthorization via relayer.
  const rpcUrl = process.env[testMode ? 'BASE_SEPOLIA_RPC_URL' : 'BASE_RPC_URL'];
  const relayerKey = process.env.X402_RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY;

  if (!rpcUrl || !relayerKey) {
    // Fail loudly — previously we returned a "simulated" tx hash which is a
    // footgun for merchants gating digital goods.
    return {
      success: false,
      errorReason: 'Facilitator is not configured (missing RPC or relayer key)',
    };
  }

  try {
    const account = privateKeyToAccount(relayerKey as `0x${string}`);
    const chain = testMode ? baseSepolia : base;
    const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    const { v, r, s } = splitSignature(auth.signature);

    const txHash = await walletClient.writeContract({
      address: domain.verifyingContract,
      abi: USDC_RECEIVE_WITH_AUTH_ABI,
      functionName: 'receiveWithAuthorization',
      args: [
        auth.from,
        auth.to,
        paidAtomic,
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce,
        v,
        r,
        s,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    if (receipt.status !== 'success') {
      return { success: false, errorReason: 'Transaction reverted on-chain' };
    }

    // Persist the receipt for idempotency, downstream analytics, and
    // post-settlement receipt verification (see verifyX402Receipt).
    //
    // The structured `resource`, `payTo`, and `paidAtomic` fields below are
    // required by the receipt-verification path — they prevent X-PAYMENT-RESPONSE
    // replay across resources or against the wrong merchant. `receiptExpiresAt`
    // enforces a TTL on receipt verification so a captured receipt cannot be
    // replayed indefinitely against the same resource.
    const completedAtIso = new Date().toISOString();
    await ddb.send(
      new PutCommand({
        TableName: TABLE.TRANSACTIONS,
        Item: {
          receiptId,
          mandateId: auth.from, // EOA payer — no mandate
          payTo: auth.to.toLowerCase(),                                // structured for receipt verify
          resource: requirements.resource ?? null,                     // structured for receipt verify (binding)
          paidAtomic: paidAtomic.toString(),                           // structured for receipt verify (amount)
          amountCents,
          description: `x402 payment for ${requirements.resource ?? 'unknown'}`,
          status: 'completed',
          rail: 'crypto',
          currency: 'usdc',
          txHash,
          authNonce: auth.nonce,
          requestedAt: completedAtIso,
          completedAt: completedAtIso,
          receiptExpiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
        },
      }),
    );

    const settleResult: SettleResult = { success: true, transaction: txHash, network, payer: auth.from };
    // Push to CDP Bazaar for discovery indexing (fire-and-forget)
    pushCdpBazaarIndex({ requirements, txHash, network, bazaar });
    return settleResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, '[x402] settlement failed');
    return { success: false, errorReason: message };
  }
}

/** Mandate-backed settlement path for buyer agents: when the caller already
 *  holds an active mandate, we can charge via the existing router (chargeCrypto)
 *  instead of EIP-3009. Used by the MCP buyer helper for Phase 3. */
export async function settleMandateBackedX402(params: {
  mandateId: string;
  requirements: X402Requirements;
  resourceDescription?: string;
  bazaar?: BazaarExtension;
  idempotencyKey?: string;
}): Promise<SettleResult> {
  return runWithSettleIdempotency(params.idempotencyKey, async () => {
  const { mandateId, requirements: rawRequirements } = params;

  // 1. Fetch mandate first — needed to resolve payTo from allowedMerchantIds
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const mandateRes = await ddb.send(
    new QueryCommand({
      TableName: TABLE.MANDATES,
      KeyConditionExpression: 'mandateId = :id',
      ExpressionAttributeValues: { ':id': mandateId },
      Limit: 1
    }),
  );
  const mandate = mandateRes.Items?.[0] as SpendingMandate | undefined;
  if (!mandate || mandate.status !== 'active') {
    return { success: false, errorReason: 'Mandate not found or not active' };
  }

  // 2. Resolve payTo from requirements or from the mandate's allowedMerchantIds.
  // No fallback is acceptable — mandates are merchant-scoped and the wallet
  // must be explicitly bound to the mandate at setup time.
  let resolvedPayTo = rawRequirements.payTo;

  if (!resolvedPayTo) {
    // Try to resolve from the mandate's allowedMerchantIds — look up the
    // first allowed merchant's usdcWalletAddress.
    const allowedIds = mandate.allowedMerchantIds ?? [];
    if (allowedIds.length > 0) {
      try {
        const { GetCommand: GC } = await import('@aws-sdk/lib-dynamodb');
        const merchantRes = await ddb.send(new GC({
          TableName: TABLE.MERCHANTS,
          Key: { merchantId: allowedIds[0] },
        }));
        const rawWallet = merchantRes.Item?.usdcWalletAddress as string | undefined ?? '';
        // Checksum the address — DynamoDB stores lowercase, viem requires EIP-55
        resolvedPayTo = rawWallet ? getAddress(rawWallet) : '';
      } catch (err: any) {
        logger.error({ mandateId, merchantId: allowedIds[0], err: err.message },
          '[x402] Failed to resolve merchant wallet from allowedMerchantIds');
      }
    }

    if (!resolvedPayTo) {
      logger.error({ mandateId, allowedMerchantIds: allowedIds },
        '[x402] settleMandateBackedX402: payTo is empty and could not be resolved from mandate — payment rejected');
      return { success: false, errorReason: 'Merchant wallet address (payTo) is required for mandate settlement' };
    }

    logger.info({ mandateId, resolvedPayTo, merchantId: allowedIds[0] },
      '[x402] Resolved payTo from mandate allowedMerchantIds');
  }

  const requirements: X402Requirements = { ...rawRequirements, payTo: resolvedPayTo };

  const requiredAtomic = priceToAtomicUsdc(requirements.price);
  const amountCents = atomicUsdcToCents(requiredAtomic);

  // Atomically check + reserve spend budget. Throws LimitExceededError on
  // breach, rolls forward on success. The payTo address plays the merchant
  // role here for allowlist enforcement.
  try {
    await checkAndIncrement({
      mandate,
      amountCents,
      merchantId: requirements.payTo,
    });
  } catch (err) {
    if (err instanceof LimitExceededError) {
      return { success: false, errorReason: err.message };
    }
    throw err;
  }

  // Idempotency for this settle is enforced by the wrapping runWithSettleIdempotency
  // (claims the spend increment + charge as one op). chargeCrypto takes no key —
  // the previous x402_mandate_… key was a no-op. See ChargeCryptoParams.
  const result = await chargeCrypto({
    delegate: mandate,
    amountCents,
    currency: 'usdc',
    recipientAddress: requirements.payTo,
    isTestMode: !!requirements.testMode,
  });

  if (result.status !== 'completed') {
    // Roll back the spend counter on failure — same pattern PaymentController uses.
    try {
      const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE.MANDATES,
          Key: { mandateId },
          UpdateExpression: 'SET currentMonthSpendCents = currentMonthSpendCents - :amount',
          ConditionExpression: 'currentMonthSpendCents >= :amount',
          ExpressionAttributeValues: { ':amount': amountCents },
        }),
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[x402] spend rollback failed');
    }
    return { success: false, errorReason: result.failureReason ?? 'Charge failed' };
  }

  // Persist x402-style receipt so GET /transactions shows it alongside fiat.
  await ddb.send(
    new PutCommand({
      TableName: TABLE.TRANSACTIONS,
      Item: {
        receiptId: `x402_mandate_${mandateId}_${result.txHash}`,
        mandateId,
        amountCents,
        description: `x402 payment for ${requirements.resource ?? 'unknown'}`,
        status: 'completed',
        rail: 'crypto',
        currency: 'usdc',
        txHash: result.txHash,
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    }),
  );

  const network = requirements.testMode ? 'base-sepolia' : 'base';
  const settleResult: SettleResult = {
    success: true,
    transaction: result.txHash,
    network,
    payer: mandateId,
  };
  // Push to CDP Bazaar for discovery indexing (fire-and-forget)
  pushCdpBazaarIndex({ requirements, txHash: result.txHash, network, bazaar: params.bazaar });
  return settleResult;
  });
}
