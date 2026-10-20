import { Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { initiateOfframp, initiateOnramp, DELEGARE_RAMP_FEE_CENTS } from '../services/RampService';
import { MerchantService } from './MerchantController';
import { logger } from '../lib/logger';
import { ddb, TABLE } from '../lib/dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret, vaultSecretId } from '../lib/secrets';

async function getStripeClient(isTestMode: boolean): Promise<Stripe> {
  const secrets = await getSecret(vaultSecretId());
  const key = isTestMode
    ? (secrets['STRIPE_TEST_SECRET_KEY'] ?? process.env.STRIPE_TEST_SECRET_KEY ?? '')
    : (secrets['STRIPE_SECRET_KEY'] ?? process.env.STRIPE_SECRET_KEY ?? '');
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' as any });
}

const OfframpSchema = z.object({
  amountUsdc: z.number().positive().describe('USDC amount in cents to offramp (e.g. 10000 = $100.00)'),
  bankAccountId: z.string().describe('Stripe external bank account ID (ba_...) or Coinbase ACH ID'),
  provider: z.enum(['stripe', 'coinbase', 'auto']).default('auto'),
  receiptId: z.string().optional(),
});

const OnrampSchema = z.object({
  amountFiatCents: z.number().int().positive().describe('Fiat amount in cents the buyer wants to spend including Delegare fee'),
  destinationWallet: z.string().describe("Buyer's smart wallet address on Base"),
  provider: z.enum(['coinbase', 'auto']).default('coinbase'),
  mandateId: z.string().optional(),
});

/**
 * POST /v1/ramp/offramp/initiate
 * Merchant converts USDC → bank via Stripe/Bridge.
 * Requires merchant auth (dk_live_ API key or Cognito token).
 */
export async function initiateOfframpHandler(req: Request, res: Response): Promise<void> {
  const authedReq = req as import('../types/express').AuthedRequest;
  const callerMerchantId = authedReq.merchantId;
  const isTestMode = authedReq.isTestMode;

  const parsed = OfframpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const { amountUsdc, bankAccountId, provider, receiptId } = parsed.data;

  const merchant = await new MerchantService().getMerchant(callerMerchantId);
  if (!merchant || merchant.status !== 'active') {
    res.status(403).json({ code: 'merchant_not_found' });
    return;
  }

  if (!merchant.stripeConnectedAccountId) {
    res.status(422).json({
      code: 'stripe_not_connected',
      message: 'Connect a Stripe account first to enable fiat offramp. Go to Settings → Connected Payout Methods.',
    });
    return;
  }

  const sourceWallet = merchant.walletAddress ?? (merchant as any).usdcWalletAddress;
  if (!sourceWallet) {
    res.status(422).json({
      code: 'crypto_wallet_not_connected',
      message: 'Connect a USDC wallet first to offramp. Go to Settings → Connected Payout Methods.',
    });
    return;
  }

  if (amountUsdc <= DELEGARE_RAMP_FEE_CENTS) {
    res.status(422).json({
      code: 'amount_too_small',
      message: `Minimum offramp amount is $${((DELEGARE_RAMP_FEE_CENTS + 1) / 100).toFixed(2)} to cover the $0.30 Delegare fee.`,
      minimumCents: DELEGARE_RAMP_FEE_CENTS + 1,
    });
    return;
  }

  const result = await initiateOfframp({
    merchantId: callerMerchantId,
    sourceWallet,
    amountUsdc,
    stripeConnectedAccountId: merchant.stripeConnectedAccountId,
    bankAccountId,
    receiptId,
    isTestMode,
  });

  if (result.status === 'failed') {
    res.status(502).json({
      code: 'offramp_failed',
      message: result.failureReason,
      rampId: result.rampId,
    });
    return;
  }

  res.json({
    rampId: result.rampId,
    status: result.status,
    amountUsdc,
    estimatedFiatCents: result.estimatedFiatCents,
    estimatedFiatUsd: `$${(result.estimatedFiatCents / 100).toFixed(2)}`,
    breakdown: {
      grossUsdcCents: amountUsdc,
      delegareFeeCents: result.delegareFeeCents,
      delegareFeeUsd: '$0.30',
      providerFeeEstimateCents: result.providerFeeEstimate,
      providerFeeNote: 'Stripe ~0.25% + $0.25. Shown as estimate; actual charged on settlement.',
      netFiatCents: result.estimatedFiatCents,
    },
    estimatedArrival: result.estimatedArrival,
    stripeTransferId: result.stripeTransferId,
  });
}

/**
 * POST /v1/ramp/onramp/initiate
 * Buyer gets a Coinbase-hosted widget URL to buy USDC with fiat.
 * Requires buyer auth (Cognito token).
 */
export async function initiateOnrampHandler(req: Request, res: Response): Promise<void> {
  const authedReq = req as import('../types/express').AuthedRequest;
  const callerMerchantId = authedReq.merchantId; // buyer account
  const isTestMode = authedReq.isTestMode;

  const parsed = OnrampSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const { amountFiatCents, destinationWallet, mandateId } = parsed.data;

  const result = await initiateOnramp({
    buyerId: callerMerchantId,
    amountFiatCents,
    destinationWallet,
    mandateId,
    isTestMode,
  });

  if (result.status === 'failed') {
    res.status(400).json({ code: 'onramp_failed', message: result.failureReason });
    return;
  }

  res.json({
    rampId: result.rampId,
    widgetUrl: result.widgetUrl,
    amountFiatCents,
    estimatedUsdcCents: result.estimatedUsdcCents,
    estimatedUsdcUsd: `$${(result.estimatedUsdcCents / 100).toFixed(2)}`,
    breakdown: {
      grossFiatCents: amountFiatCents,
      delegareFeeCents: result.delegareFeeCents,
      delegareFeeUsd: '$0.30',
      providerFeeEstimateCents: result.providerFeeEstimate,
      providerFeeNote: 'Coinbase ~1.49% spread. Actual rate locked at widget completion.',
      netUsdcCents: result.estimatedUsdcCents,
    },
    instructions: 'Visit widgetUrl to complete the purchase. Coinbase handles card entry securely — Delegare never sees card details. USDC will be delivered to your wallet on Base after completion.',
  });
}

/**
 * GET /v1/ramp/bank-accounts
 * Returns the merchant's linked bank accounts from their Stripe connected account.
 * Used by the dashboard to show which bank is linked for offramp without
 * requiring the merchant to manually enter a ba_... ID.
 */
export async function listBankAccounts(req: Request, res: Response): Promise<void> {
  const authedReq = req as import('../types/express').AuthedRequest;
  const callerMerchantId = authedReq.merchantId;
  const isTestMode = authedReq.isTestMode;

  const merchant = await new MerchantService().getMerchant(callerMerchantId);
  if (!merchant?.stripeConnectedAccountId) {
    res.json({ bankAccounts: [] });
    return;
  }

  try {
    const stripe = await getStripeClient(isTestMode);
    const externalAccounts = await stripe.accounts.listExternalAccounts(
      merchant.stripeConnectedAccountId,
      { object: 'bank_account', limit: 10 },
    );

    const bankAccounts = externalAccounts.data.map((acct: any) => ({
      id: acct.id,
      bankName: acct.bank_name,
      last4: acct.last4,
      currency: acct.currency,
      status: acct.status,
      isDefault: acct.default_for_currency,
    }));

    res.json({
      bankAccounts,
      autoOfframpBankAccountId: merchant.autoOfframpBankAccountId,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to list bank accounts');
    res.status(500).json({ code: 'stripe_error', message: err.message });
  }
}

/**
 * GET /v1/ramp/history
 * Returns ramp transaction history for the authenticated merchant/buyer.
 */
export async function getRampHistory(req: Request, res: Response): Promise<void> {
  const authedReq = req as import('../types/express').AuthedRequest;
  const ownerId = authedReq.merchantId;

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE.RAMP_TRANSACTIONS,
      IndexName: 'ownerIndex',
      KeyConditionExpression: 'ownerId = :ownerId',
      ExpressionAttributeValues: { ':ownerId': ownerId },
      ScanIndexForward: false,
      Limit: 50,
    }));

    res.json({ ramps: result.Items ?? [] });
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to fetch ramp history');
    res.status(500).json({ code: 'internal_error' });
  }
}
