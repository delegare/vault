/**
 * RampService — on/off ramp via Coinbase Onramp and Stripe/Bridge Offramp.
 *
 * Fee model: Delegare charges a flat $0.30 on every ramp action on top of
 * whatever the provider charges for FX and their own fees. Provider costs
 * are pass-through and shown transparently in the response.
 *
 * Onramp  (fiat → USDC): Coinbase Onramp — buyer pays $X + $0.30 fiat,
 *   receives slightly less USDC after provider spread (~1.49%).
 *
 * Offramp (USDC → bank): Stripe Treasury outbound transfer (Bridge) —
 *   merchant receives USDC amount minus $0.30 Delegare fee and provider
 *   fees (~0.25% + $0.25 Stripe). Estimated 1–2 business days ACH.
 */

import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { ddb, TABLE } from '../lib/dynamodb';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret, vaultSecretId } from '../lib/secrets';
import { logger } from '../lib/logger';
import type { RampTransaction, RampProvider } from '../models/RampTransaction';

export const DELEGARE_RAMP_FEE_CENTS = 30; // $0.30 flat per ramp action

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateRampId(): string {
  return `ramp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function ttl90Days(): number {
  return Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
}

async function getStripeClient(isTestMode: boolean): Promise<Stripe> {
  const secrets = await getSecret(vaultSecretId());
  const key = isTestMode
    ? (secrets['STRIPE_TEST_SECRET_KEY'] ?? process.env.STRIPE_TEST_SECRET_KEY ?? '')
    : (secrets['STRIPE_SECRET_KEY'] ?? process.env.STRIPE_SECRET_KEY ?? '');
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' as any });
}

async function getCdpApiKey(): Promise<string | null> {
  const secrets = await getSecret(vaultSecretId());
  return secrets['COINBASE_API_KEY'] ?? process.env.COINBASE_API_KEY ?? null;
}

// ── Offramp — USDC → Bank (Stripe/Bridge) ────────────────────────────────────

export interface OfframpParams {
  merchantId: string;
  sourceWallet: string;         // merchant's USDC wallet on Base
  amountUsdc: number;           // USDC amount in cents (e.g. 10000 = $100.00)
  stripeConnectedAccountId: string;
  bankAccountId: string;        // Stripe external account ID (ba_...)
  receiptId?: string;           // payment receipt that triggered this offramp
  isTestMode?: boolean;
}

export interface OfframpResult {
  rampId: string;
  status: 'pending' | 'failed';
  estimatedFiatCents: number;   // after all fees
  delegareFeeCents: number;
  providerFeeEstimate: number;  // Stripe ~25 + 0.25%
  estimatedArrival: string;
  stripeTransferId?: string;
  failureReason?: string;
}

export async function initiateOfframp(params: OfframpParams): Promise<OfframpResult> {
  const rampId = generateRampId();
  const isTestMode = params.isTestMode ?? false;

  // Delegare fee deducted from USDC before initiating transfer
  const delegareFeeCents = DELEGARE_RAMP_FEE_CENTS;
  const amountAfterDelegare = params.amountUsdc - delegareFeeCents;

  if (amountAfterDelegare <= 0) {
    return {
      rampId, status: 'failed',
      estimatedFiatCents: 0,
      delegareFeeCents,
      providerFeeEstimate: 0,
      estimatedArrival: 'N/A',
      failureReason: `Amount too small — minimum offramp is $${(delegareFeeCents / 100 + 0.01).toFixed(2)} to cover the $0.30 Delegare fee.`,
    };
  }

  // Stripe fee estimate: 0.25% + $0.25 flat
  const stripeFeeCents = Math.round(amountAfterDelegare * 0.0025) + 25;
  const estimatedFiatCents = amountAfterDelegare - stripeFeeCents;

  // Persist pending ramp record
  const record: RampTransaction = {
    rampId,
    ownerId: params.merchantId,
    type: 'offramp',
    status: 'pending',
    provider: 'stripe',
    amountCents: params.amountUsdc,     // fiat equivalent
    amountUsdc: params.amountUsdc,
    delegareFeeCents,
    providerFeeCents: stripeFeeCents,   // estimate, updated by webhook
    fxRate: 1.0,                        // USDC pegged to USD
    sourceWallet: params.sourceWallet,
    bankAccountId: params.bankAccountId,
    estimatedArrival: '1-2 business days',
    providerRampId: '',                 // filled after Stripe call
    merchantId: params.merchantId,
    receiptId: params.receiptId,
    createdAt: new Date().toISOString(),
    ttl: ttl90Days(),
  };

  await ddb.send(new PutCommand({ TableName: TABLE.RAMP_TRANSACTIONS, Item: record }));

  try {
    const stripe = await getStripeClient(isTestMode);

    // Stripe Treasury OutboundTransfer — moves funds from Connected Account
    // financial account to the merchant's external bank account.
    // In test mode, use test clock amounts.
    const transfer = await stripe.treasury.outboundTransfers.create(
      {
        financial_account: params.stripeConnectedAccountId,
        amount: amountAfterDelegare,
        currency: 'usd',
        destination_payment_method: params.bankAccountId,
        description: `Delegare offramp ${rampId}`,
        metadata: {
          rampId,
          merchantId: params.merchantId,
          delegareFeeCents: delegareFeeCents.toString(),
          sourceWallet: params.sourceWallet,
        },
      },
      { stripeAccount: params.stripeConnectedAccountId }
    );

    // Update record with Stripe transfer ID
    await ddb.send(new UpdateCommand({
      TableName: TABLE.RAMP_TRANSACTIONS,
      Key: { rampId },
      UpdateExpression: 'SET providerRampId = :pid, #st = :status',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':pid': transfer.id, ':status': 'processing' },
    }));

    logger.info({ rampId, transferId: transfer.id, merchantId: params.merchantId, amountUsdc: params.amountUsdc }, 'Offramp initiated via Stripe Treasury');

    return {
      rampId,
      status: 'pending',
      estimatedFiatCents,
      delegareFeeCents,
      providerFeeEstimate: stripeFeeCents,
      estimatedArrival: '1-2 business days',
      stripeTransferId: transfer.id,
    };
  } catch (err: any) {
    logger.error({ rampId, err: err.message }, 'Offramp failed — Stripe Treasury error');

    await ddb.send(new UpdateCommand({
      TableName: TABLE.RAMP_TRANSACTIONS,
      Key: { rampId },
      UpdateExpression: 'SET #st = :status, failureReason = :reason',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':status': 'failed', ':reason': err.message },
    }));

    return {
      rampId, status: 'failed',
      estimatedFiatCents: 0,
      delegareFeeCents,
      providerFeeEstimate: 0,
      estimatedArrival: 'N/A',
      failureReason: err.message,
    };
  }
}

// ── Onramp — Fiat → USDC (Coinbase) ──────────────────────────────────────────

export interface OnrampParams {
  buyerId: string;
  amountFiatCents: number;      // fiat amount buyer wants to spend (incl. Delegare fee)
  destinationWallet: string;    // buyer's smart wallet on Base
  mandateId?: string;
  isTestMode?: boolean;
}

export interface OnrampResult {
  rampId: string;
  status: 'pending' | 'failed';
  widgetUrl: string;            // Coinbase Onramp hosted widget URL
  estimatedUsdcCents: number;   // USDC delivered after all fees
  delegareFeeCents: number;
  providerFeeEstimate: number;  // Coinbase ~1.49% spread
  sessionToken?: string;
  failureReason?: string;
}

export async function initiateOnramp(params: OnrampParams): Promise<OnrampResult> {
  const rampId = generateRampId();
  const delegareFeeCents = DELEGARE_RAMP_FEE_CENTS;
  const amountAfterDelegare = params.amountFiatCents - delegareFeeCents;

  if (amountAfterDelegare <= 0) {
    return {
      rampId, status: 'failed', widgetUrl: '',
      estimatedUsdcCents: 0, delegareFeeCents, providerFeeEstimate: 0,
      failureReason: `Amount too small — minimum onramp is $${((delegareFeeCents + 1) / 100).toFixed(2)}.`,
    };
  }

  // Coinbase spread estimate: ~1.49%
  const coinbaseFee = Math.round(amountAfterDelegare * 0.0149);
  const estimatedUsdcCents = amountAfterDelegare - coinbaseFee;

  const cdpApiKey = await getCdpApiKey();
  const appId = process.env.COINBASE_ONRAMP_APP_ID ?? 'delegare';

  // Coinbase Onramp widget URL — hosted by Coinbase, no card data touches Delegare
  const params_url = new URLSearchParams({
    appId,
    addresses: JSON.stringify({ [params.destinationWallet]: ['base'] }),
    assets: 'USDC',
    presetFiatAmount: (amountAfterDelegare / 100).toFixed(2),
    fiatCurrency: 'USD',
    defaultExperience: 'buy',
    partnerUserId: params.buyerId,
    ...(params.mandateId ? { partnerReferenceId: rampId } : {}),
  });

  const widgetUrl = `https://pay.coinbase.com/buy?${params_url.toString()}`;

  // Persist pending record
  const record: RampTransaction = {
    rampId,
    ownerId: params.buyerId,
    type: 'onramp',
    status: 'pending',
    provider: 'coinbase',
    amountCents: params.amountFiatCents,
    amountUsdc: estimatedUsdcCents,
    delegareFeeCents,
    providerFeeCents: coinbaseFee,
    fxRate: 1.0,
    destinationWallet: params.destinationWallet,
    providerRampId: rampId,     // Coinbase uses partnerReferenceId to link back
    mandateId: params.mandateId,
    createdAt: new Date().toISOString(),
    ttl: ttl90Days(),
  };

  await ddb.send(new PutCommand({ TableName: TABLE.RAMP_TRANSACTIONS, Item: record }));

  logger.info({ rampId, buyerId: params.buyerId, amountFiatCents: params.amountFiatCents }, 'Onramp widget URL generated via Coinbase');

  return {
    rampId,
    status: 'pending',
    widgetUrl,
    estimatedUsdcCents,
    delegareFeeCents,
    providerFeeEstimate: coinbaseFee,
  };
}

// ── Webhook handlers (called from WebhookController) ─────────────────────────

/** Handle Stripe Treasury OutboundTransfer webhook to update ramp status */
export async function handleStripeOfframpWebhook(event: any): Promise<void> {
  const transfer = event.data?.object;
  if (!transfer) return;

  const rampId = transfer.metadata?.rampId;
  if (!rampId) return;

  const status = transfer.status === 'posted' ? 'completed'
    : transfer.status === 'failed' ? 'failed'
    : 'processing';

  await ddb.send(new UpdateCommand({
    TableName: TABLE.RAMP_TRANSACTIONS,
    Key: { rampId },
    UpdateExpression: 'SET #st = :status' + (status === 'completed' ? ', completedAt = :now' : '') + (status === 'failed' ? ', failureReason = :reason' : ''),
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ...(status === 'completed' ? { ':now': new Date().toISOString() } : {}),
      ...(status === 'failed' ? { ':reason': transfer.returned_details?.code ?? 'unknown' } : {}),
    },
  }));

  logger.info({ rampId, status }, 'Offramp status updated from Stripe webhook');
}

/** Handle Coinbase Onramp webhook to mark onramp completed */
export async function handleCoinbaseOnrampWebhook(payload: any): Promise<void> {
  const rampId = payload.partnerReferenceId;
  if (!rampId) return;

  const status = payload.status === 'SUCCESS' ? 'completed' : 'failed';

  await ddb.send(new UpdateCommand({
    TableName: TABLE.RAMP_TRANSACTIONS,
    Key: { rampId },
    UpdateExpression: 'SET #st = :status, onChainTxHash = :txHash' + (status === 'completed' ? ', completedAt = :now' : ''),
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':txHash': payload.txHash ?? '',
      ...(status === 'completed' ? { ':now': new Date().toISOString() } : {}),
    },
  }));

  logger.info({ rampId, status }, 'Onramp status updated from Coinbase webhook');
}
