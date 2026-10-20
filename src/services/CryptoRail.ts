import { createWalletClient, createPublicClient, http, parseEther, formatEther, type Hash, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { getSecret, vaultSecretId } from '../lib/secrets';
import { decryptSessionKey } from './SessionKeyVault';
import { logger } from '../lib/logger';
import type { SpendingMandate } from '../models/SpendingMandate';

export const SUPPORTED_TOKENS = {
  usdc: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    testnetAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const,
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
  },
  usdt: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as const,
    testnetAddress: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as const, // Replace with valid base-sepolia USDT when available
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
  },
} as const;

// Minimal ERC-20 ABI for allowance checks
const ERC20_ABI = [
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// Minimal Router ABI for delegated payments
const ROUTER_ABI = [
  {
    name: 'payMerchant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'from', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'fee', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'supportedTokenDecimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export interface ChargeCryptoParams {
  delegate: SpendingMandate;
  amountCents: number;
  currency: 'usdc' | 'usdt';
  recipientAddress: string;
  isTestMode: boolean;
}

// NOTE ON IDEMPOTENCY / RETRY SAFETY:
//   `chargeCrypto` deliberately takes NO idempotency key. It cannot provide
//   idempotency on its own: every call broadcasts a fresh DelegareRouter
//   `payMerchant` transaction, and that call carries no on-chain nonce, so the
//   contract cannot dedup a repeated transfer. A previous `idempotencyKey` param
//   here was a silent no-op — callers assumed retry protection they never had.
//
//   Retry protection lives ONE LAYER UP, at the operation that pairs the spend-
//   counter increment with the charge:
//     • the direct /v1/charge path — controllers/PaymentController.ts via
//       lib/idempotency.ts `runWithOperationIdempotency`
//     • the x402 mandate-settle paths — services/x402.ts
//       `runWithSettleIdempotency`
//   Both claim the whole operation so a replay skips increment AND charge.
//
//   RESIDUAL (see also lib/idempotency.ts): if this function broadcasts a tx and
//   then the confirmation wait times out, it returns status:'failed'. The
//   operation layer then releases its claim and a retry re-broadcasts — a SECOND
//   on-chain transfer, i.e. a double charge. Closing this fully requires a nonce
//   / idempotency argument threaded into DelegareRouter.payMerchant so the
//   contract itself rejects the duplicate. Until then, a post-broadcast crash or
//   timeout is the one window operation-level idempotency cannot cover.

export interface CryptoChargeResult {
  txHash: string;
  chainId: number;
  status: 'completed' | 'pending' | 'failed';
  failureReason?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert integer cents to token base units using pure BigInt arithmetic.
 * Avoids floating point entirely: 1999 cents → 1_999_000 (6 decimals).
 */
function centsToTokenUnits(cents: number, decimals: number): bigint {
  // cents is an integer (enforced upstream). Token units = cents * 10^(decimals-2)
  // e.g. 1999 cents * 10^4 = 19_990_000 for 6-decimal tokens
  if (decimals < 2) throw new Error(`Token decimals (${decimals}) must be >= 2`);
  const multiplier = 10n ** BigInt(decimals - 2);
  return BigInt(Math.round(cents)) * multiplier;
}

/**
 * Compute the platform fee in token base units.
 *
 * Fee schedule:
 *   • floor $0.005 — ensures Base gas (~$0.002 typical) + infra is covered on tiny txs
 *   • amount < $1.00 (< 100 cents): 3% of amount (subject to floor; floor binds below ~16.7¢)
 *   • amount ≥ $1.00 (≥ 100 cents): flat 3¢
 *
 * All math is pure BigInt to avoid floating-point drift.
 * For sub-cent fractions the fee is rounded up (ceil) so we never under-charge.
 */
function computePlatformFee(amountCents: number, decimals: number): bigint {
  // $0.005 = 5 × 10^(decimals-3) base units (5_000 for USDC's 6 decimals)
  const floorUnits = 5n * 10n ** BigInt(decimals - 3);

  let fee: bigint;
  if (amountCents >= 100) {
    fee = centsToTokenUnits(3, decimals);
  } else {
    const amountUnits = centsToTokenUnits(amountCents, decimals);
    // ceil division: (a * 3 + 99) / 100  (integer ceil of a*3/100)
    fee = (amountUnits * 3n + 99n) / 100n;
  }
  return fee < floorUnits ? floorUnits : fee;
}

/**
 * Resolve the router address from Secrets Manager, env vars, or hardcoded fallback.
 * Returns null if no valid address is available (prevents sending to 0x0).
 */
function resolveRouterAddress(
  vaultSecrets: Record<string, string>,
  isTestMode: boolean,
): `0x${string}` | null {
  const secretKey = isTestMode ? 'DELEGARE_ROUTER_SEPOLIA' : 'DELEGARE_ROUTER_MAINNET';
  const candidates = [
    vaultSecrets[secretKey],
    process.env[secretKey],
  ];

  const ZERO = '0x0000000000000000000000000000000000000000';

  for (let addr of candidates) {
    if (addr) addr = addr.trim();
    if (addr && addr !== ZERO && addr !== 'placeholder' && /^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return addr as `0x${string}`;
    }
  }

  // Testnet-only hardcoded fallback (never for mainnet)
  if (isTestMode) {
    return '0x85f2afB670E54a3a0F31966F49A18C73ea6a0f62';
  }

  return null;
}

// ── Session key gas top-up ──────────────────────────────────────────────────

const TOP_UP_THRESHOLD = parseEther('0.000002'); // ~1 tx worth of gas
const TOP_UP_AMOUNT = parseEther('0.000005');    // refill ~3 txs

/**
 * Fire-and-forget: checks the session key's ETH balance after a successful tx
 * and tops it up from the ops wallet if it's running low. This keeps
 * heavy-use mandates alive without any manual intervention or user friction.
 */
async function topUpSessionKeyIfLow(
  sessionKeyAddress: `0x${string}`,
  chain: Chain,
  rpcUrl: string | undefined,
  vaultSecrets: Record<string, string>,
  isTestMode: boolean,
): Promise<void> {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const balance = await publicClient.getBalance({ address: sessionKeyAddress });

  if (balance > TOP_UP_THRESHOLD) return; // still has gas

  const opsKey = vaultSecrets.OPS_WALLET_PRIVATE_KEY;
  if (!opsKey) {
    logger.warn({ sessionKeyAddress, balance: formatEther(balance) }, 'Session key low on gas but OPS_WALLET_PRIVATE_KEY not configured');
    return;
  }

  const opsAccount = privateKeyToAccount(opsKey as `0x${string}`);
  const opsClient = createWalletClient({ account: opsAccount, chain, transport: http(rpcUrl) });

  const hash = await opsClient.sendTransaction({
    to: sessionKeyAddress,
    value: TOP_UP_AMOUNT,
  });

  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

  logger.info({
    sessionKeyAddress,
    previousBalance: formatEther(balance),
    topUp: formatEther(TOP_UP_AMOUNT),
    hash,
  }, 'Session key auto-topped up with gas');
}

// ── Main ────────────────────────────────────────────────────────────────────

const TX_RECEIPT_TIMEOUT_MS = 60_000; // 60s timeout for tx confirmation

export async function chargeCrypto(params: ChargeCryptoParams): Promise<CryptoChargeResult> {
  const { delegate, amountCents, currency, recipientAddress, isTestMode } = params;

  if (!delegate.smartWalletAddress) {
    return { txHash: '', chainId: 8453, status: 'failed', failureReason: 'No crypto wallet on delegate' };
  }

  if (amountCents <= 0 || !Number.isInteger(amountCents)) {
    return { txHash: '', chainId: 8453, status: 'failed', failureReason: 'Amount must be a positive integer in cents' };
  }

  // ── Load + decrypt session key from the mandate row ─────────────────────
  //
  //    Session keys used to live in Secrets Manager at one secret per mandate
  //    ($0.40/mandate/month). They now live as a KMS-encrypted ciphertext on
  //    the mandate row itself, with encryption context bound to mandateId.
  if (!delegate.encryptedSessionKey) {
    return {
      txHash: '',
      chainId: 8453,
      status: 'failed',
      failureReason: 'Vault does not hold custodial session keys for this wallet. Payment must be signed directly by the client EVM.',
    };
  }

  let sessionKeyPrivate: string;
  try {
    sessionKeyPrivate = await decryptSessionKey(delegate.encryptedSessionKey, delegate.mandateId);
  } catch (err: any) {
    logger.error({ mandateId: delegate.mandateId, err: err.message }, 'Failed to decrypt session key');
    return {
      txHash: '',
      chainId: 8453,
      status: 'failed',
      failureReason: 'Could not decrypt session key for this mandate.',
    };
  }

  // ── Resolve chain config ───────────────────────────────────────────────
  const vaultSecrets = await getSecret(vaultSecretId()).catch(() => ({} as Record<string, string>));

  const network = isTestMode ? 'base-sepolia' : (delegate.sessionKeyNetwork ?? 'base-mainnet');
  const chain = network === 'base-sepolia' ? baseSepolia : base;
  const rpcUrl = process.env[network === 'base-sepolia' ? 'BASE_SEPOLIA_RPC_URL' : 'BASE_RPC_URL'];

  const routerAddress = resolveRouterAddress(vaultSecrets, isTestMode);
  if (!routerAddress) {
    return {
      txHash: '',
      chainId: chain.id,
      status: 'failed',
      failureReason: 'No valid DelegareRouter address configured. Cannot execute crypto payment.',
    };
  }

  const account = privateKeyToAccount(sessionKeyPrivate as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // ── Convert amounts using pure BigInt (no floating point) ──────────────
  const tokenConfig = SUPPORTED_TOKENS[currency];
  const tokenAddress = (isTestMode && tokenConfig.testnetAddress
    ? tokenConfig.testnetAddress
    : tokenConfig.address) as `0x${string}`;
  const tokenAmount = centsToTokenUnits(amountCents, tokenConfig.decimals);
  const feeAmount = computePlatformFee(amountCents, tokenConfig.decimals);
  const totalRequired = tokenAmount + feeAmount;

  try {
    // ── 1. Pre-flight: verify token is whitelisted on the Router ──────────
    const onChainDecimals = await publicClient.readContract({
      address: routerAddress,
      abi: ROUTER_ABI,
      functionName: 'supportedTokenDecimals',
      args: [tokenAddress],
    }) as number;

    if (onChainDecimals === 0) {
      return {
        txHash: '',
        chainId: chain.id,
        status: 'failed',
        failureReason: `Token ${tokenConfig.symbol} (${tokenAddress}) is not whitelisted on the DelegareRouter (${routerAddress}). An admin must call addSupportedToken().`,
      };
    }

    // ── 2. Pre-flight: check ERC-20 allowance (token → Router) ─────────────────────────────
    const currentAllowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [delegate.smartWalletAddress as `0x${string}`, routerAddress],
    }) as bigint;

    if (currentAllowance < totalRequired) {
      return {
        txHash: '',
        chainId: chain.id,
        status: 'failed',
        failureReason: `Insufficient ERC-20 allowance. The user's wallet (${delegate.smartWalletAddress}) must approve the Delegare Router (${routerAddress}) to spend ${tokenConfig.symbol}. Required: ${totalRequired}, Current: ${currentAllowance}`,
      };
    }

    // ── 3. Pre-flight: check gas balance and top up synchronously if needed ──
    const gasBalance = await publicClient.getBalance({ address: account.address });
    if (gasBalance < TOP_UP_THRESHOLD) {
      logger.info({ mandate: delegate.mandateId, balance: formatEther(gasBalance) }, 'Session key low on gas before tx, topping up synchronously');
      try {
        await topUpSessionKeyIfLow(account.address, chain, rpcUrl, vaultSecrets, isTestMode);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to top up session key');
        return {
          txHash: '',
          chainId: chain.id,
          status: 'failed',
          failureReason: `Session key requires gas to execute transaction, but top-up failed: ${err.message}`,
        };
      }
    }

    // ── 4. Execute delegated payment via the Router ───────────────────────
    logger.info({
      mandate: delegate.mandateId,
      currency,
      amountCents,
      feeTokenUnits: feeAmount.toString(),
      feeModel: amountCents >= 100 ? 'flat_3c' : amountCents < 17 ? 'floor_0.5c' : '3%',
      router: routerAddress,
      from: delegate.smartWalletAddress,
      to: recipientAddress,
    }, 'CryptoRail: submitting payMerchant tx');

    // RESIDUAL: payMerchant takes no on-chain nonce, so the router cannot dedup a
    // repeated transfer. A retry after a post-broadcast crash/timeout double-pays.
    // See the idempotency note on ChargeCryptoParams — true dedup needs a nonce arg here.
    const txHash: Hash = await walletClient.writeContract({
      address: routerAddress,
      abi: ROUTER_ABI,
      functionName: 'payMerchant',
      args: [
        tokenAddress,
        delegate.smartWalletAddress as `0x${string}`,
        recipientAddress as `0x${string}`,
        tokenAmount,
        feeAmount,
      ],
    });

    // ── 5. Wait for confirmation with timeout ─────────────────────────────
    const receipt = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Transaction confirmation timed out after 60s')), TX_RECEIPT_TIMEOUT_MS),
      ),
    ]);

    logger.info({ txHash, status: receipt.status, chainId: chain.id }, 'CryptoRail: tx confirmed');

    // ── 6. Fire-and-forget: top up session key if gas is running low ────
    //    This keeps heavy-use mandates alive without manual intervention.
    //    The ops wallet absorbs gas as a cost of goods sold (~$0.002/tx).
    if (receipt.status === 'success') {
      topUpSessionKeyIfLow(account.address, chain, rpcUrl, vaultSecrets, isTestMode).catch(() => {});
    }

    return {
      txHash,
      chainId: chain.id,
      status: receipt.status === 'success' ? 'completed' : 'failed',
      failureReason: receipt.status !== 'success' ? 'Transaction reverted on-chain' : undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, mandate: delegate.mandateId }, 'CryptoRail: charge failed');
    return { txHash: '', chainId: chain.id, status: 'failed', failureReason: message };
  }
}
