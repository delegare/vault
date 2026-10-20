import { Request, Response } from 'express';
import { z } from 'zod';
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { logger } from '../lib/logger';
import { generateReceiptId } from '../lib/tokens';
import { checkAndIncrement, rollbackIncrement, LimitExceededError, checkAndIncrementMerchantReceiveLimit, rollbackMerchantReceiveLimit } from '../services/LimitEnforcer';
import { selectRail, getFallbackRail, ActiveRail, RailMismatchError } from '../services/PaymentRouter';
import { chargeFiat } from '../services/FiatRail';
import { chargeCrypto } from '../services/CryptoRail';
import { MerchantService } from './MerchantController';
import { CredentialService } from '../services/CredentialService';
import type { SpendingMandate } from '../models/SpendingMandate';
import type { TransactionLog, TransactionStatus } from '../models/TransactionLog';

import { EmailService } from '../services/EmailService';
import { WebhookService } from '../services/WebhookService';
import { pushCdpBazaarIndex } from '../services/x402';
import { initiateOfframp, DELEGARE_RAMP_FEE_CENTS } from '../services/RampService';
import { runWithOperationIdempotency, operationIdemId, type OperationResult } from '../lib/idempotency';

/**
 * Zod schema for validating payment charge requests.
 */
const ChargeSchema = z.object({
  intentMandate: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.enum(['usd', 'usdc', 'usdt']),
  description: z.string().max(500),
  idempotencyKey: z.string().max(255),
  metadata: z.record(z.string(), z.string()).optional(),
  recipient: z.string().optional(), // 'merchantHandle', '0x...', or '@twitter'
});

const merchantService = new MerchantService();
const credentialService = new CredentialService();

const VAULT_VERSION = '0.1.0';

interface RailResult {
  status: TransactionStatus;
  txHash?: string;
  stripePaymentIntentId?: string;
  failureReason?: string;
}

/**
 * Internal helper to execute a charge on a specific payment rail (fiat or crypto).
 */
async function executeOnRail(
  rail: ActiveRail,
  delegate: SpendingMandate,
  params: {
    amountCents: number;
    platformFeeCents?: number;
    currency: string;
    description: string;
    receiptId: string;
    metadata?: Record<string, string>;
    merchantStripeAccountId?: string;
    recipientWalletAddress?: string;
    isTestMode: boolean;
  },
): Promise<RailResult> {
  if (rail === 'fiat') {
    const result = await chargeFiat({
      delegate,
      amountCents: params.amountCents,
      currency: params.currency,
      description: params.description,
      merchantStripeAccountId: params.merchantStripeAccountId,
      merchantApplicationFeeAmountCents: params.platformFeeCents ?? 3,
      idempotencyKey: `${params.receiptId}_fiat`,
      metadata: params.metadata,
      isTestMode: params.isTestMode,
    });
    return {
      status: result.status,
      stripePaymentIntentId: result.stripePaymentIntentId,
      failureReason: result.failureReason,
    };
  } else {
    const cryptoCurrency: 'usdc' | 'usdt' = params.currency === 'usdt' ? 'usdt' : 'usdc';
    const recipientAddress = params.recipientWalletAddress || (params.merchantStripeAccountId ? process.env[`MERCHANT_WALLET_${params.merchantStripeAccountId.toUpperCase()}`] : undefined) || '';
    // No idempotencyKey — chargeCrypto cannot dedup on-chain (see ChargeCryptoParams).
    // Retry safety for /v1/charge is enforced at the operation layer in `charge`.
    const result = await chargeCrypto({
      delegate,
      amountCents: params.amountCents,
      currency: cryptoCurrency,
      recipientAddress,
      isTestMode: params.isTestMode,
    });
    return {
      status: result.status,
      txHash: result.txHash || undefined,
      failureReason: result.failureReason,
    };
  }
}

/**
 * Main entry point for executing a payment charge.
 * 
 * This function:
 * 1. Validates the request body using Zod.
 * 2. Checks for existing transactions to enforce idempotency.
 * 3. Atomically validates and increments spending limits (preventing race conditions).
 * 4. Verifies merchant status and per-transaction limits.
 * 5. Selects the optimal payment rail (Fiat vs Crypto) based on preferences and availability.
 * 6. Executes the payment with automatic fallback support (e.g., trying crypto if fiat fails).
 * 7. Records the transaction in an immutable log.
 * 8. Rolls back spending limits if the payment ultimately fails.
 * 
 * @param req - Express request with AuthedRequest containing merchantId.
 * @param res - Express response.
 */
export async function charge(req: Request, res: Response): Promise<void> {
  const authedReq = req as import("../types/express").AuthedRequest;
  const callerMerchantId = authedReq.merchantId;
  const isTestMode = authedReq.isTestMode;

  const parsed = ChargeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const { intentMandate, amountCents, currency, description, idempotencyKey, metadata, recipient } = parsed.data;

  let activeMandate: SpendingMandate;
  try {
    activeMandate = await credentialService.verifyIntentMandate(intentMandate);
  } catch (err: any) {
    res.status(401).json({ code: 'invalid_mandate', message: err.message });
    return;
  }

  const mandateId = activeMandate.mandateId;

  // Resolve target merchant and wallet based on recipient
  let targetMerchantId = callerMerchantId;
  let targetWalletAddress: string | undefined;

  if (recipient) {
    if (recipient.startsWith('0x') && recipient.length === 42) {
      targetWalletAddress = recipient;
      // Keep targetMerchantId as callerMerchantId for direct raw transfers
    } else {
      // Look up the handle or merchant ID
      const recipientMerchant = await merchantService.getMerchant(recipient);
      if (!recipientMerchant || recipientMerchant.status !== 'active') {
        res.status(404).json({ code: 'not_found', message: `Recipient ${recipient} not found or inactive` });
        return;
      }
      // If the recipient is an alias (funny handle), follow the pointer to the primary account
      targetMerchantId = (recipientMerchant as any).targetMerchantId || recipientMerchant.merchantId;
      targetWalletAddress = recipientMerchant.walletAddress;
    }
  }

  // Load the target merchant to check status and self-payment
  const merchant = await merchantService.getMerchant(targetMerchantId);
  if (!merchant || merchant.status !== 'active') {
    res.status(403).json({ code: 'merchant_inactive', message: 'Target merchant account is not active' });
    return;
  }

  // Self-payment check
  // We check by email or wallet address to ensure the user isn't paying themselves
  const delegate = activeMandate;

  if (delegate) {
    const isSameEmail = delegate.ownerEmail && merchant.contactEmail && delegate.ownerEmail === merchant.contactEmail;
    const isSameWallet = delegate.smartWalletAddress && merchant.walletAddress && 
                       delegate.smartWalletAddress.toLowerCase() === merchant.walletAddress.toLowerCase();

    if (isSameEmail || isSameWallet) {
      logger.warn({
        event: 'self_payment_blocked',
        merchantId: targetMerchantId,
        mandateId,
        ownerEmail: delegate.ownerEmail,
        walletAddress: delegate.smartWalletAddress,
      }, 'User attempted to pay their own merchant account');

      res.status(422).json({
        allowed: false,
        status: 'failed',
        error: {
          code: 'self_payment_not_allowed',
          message: 'Payment declined — delegate and merchant have the same owner.',
          merchantId: targetMerchantId,
          hint: 'You cannot use a spending delegate to pay your own merchant account or funny handle.',
        }
      });
      return;
    }
  }

  // Check idempotency against the caller (to prevent double-charges initiated by the same caller)
  const existingReceipt = await findByIdempotencyKey(callerMerchantId, idempotencyKey);
  if (existingReceipt) {
    res.json(toChargeResponse(existingReceipt));
    return;
  }

  // ── Operation-level idempotency ──────────────────────────────────────────
  //  Everything below MUTATES: it increments the mandate spend counter AND the
  //  merchant receive counter AND broadcasts an on-chain (or Stripe) charge AND
  //  writes the transaction log. All of these must be claimed as ONE operation:
  //  deduping only the charge (or only the increment) would let a retry double-
  //  count a spend counter while the charge dedupes, or vice-versa. We therefore
  //  guard the whole thing behind a claim keyed by (callerMerchantId,
  //  idempotencyKey). A completed key replays the stored response WITHOUT re-
  //  incrementing or re-charging; an in-flight duplicate gets a retryable 409.
  //
  //  NOTE: this is operation-level idempotency, not on-chain dedup. If the
  //  crypto rail broadcasts a tx and then times out awaiting confirmation, it
  //  reports failure and the claim is released — a retry can broadcast a second
  //  transfer, because DelegareRouter.payMerchant has no on-chain nonce. See the
  //  residual note in services/CryptoRail.ts.
  const idemId = operationIdemId('charge', callerMerchantId, idempotencyKey);
  const outcome = await runWithOperationIdempotency(
    idemId,
    async (): Promise<OperationResult> => {
      // Validate limits and atomically increment spend counter against the target merchant
      let updatedDelegate: SpendingMandate;
      try {
        updatedDelegate = await checkAndIncrement({ mandate: activeMandate, amountCents, merchantId: targetMerchantId });
      } catch (err) {
        if (err instanceof LimitExceededError) {
          return { success: false, httpStatus: 402, body: { code: err.reason, message: err.message } };
        }
        throw err;
      }

      // Now validate and increment the merchant's daily receive limit
      const todayKey = new Date().toISOString().split('T')[0];
      try {
        await checkAndIncrementMerchantReceiveLimit(targetMerchantId, amountCents);
      } catch (err) {
        await rollbackIncrement(activeMandate, amountCents, activeMandate.currentMonthKey);
        if (err instanceof LimitExceededError) {
          return { success: false, httpStatus: 402, body: { code: err.reason, message: err.message } };
        }
        throw err;
      }

      if (amountCents > merchant.maxChargePerTxCents) {
        await rollbackMerchantReceiveLimit(targetMerchantId, amountCents, todayKey);
        await rollbackIncrement(activeMandate, amountCents, activeMandate.currentMonthKey);
        return { success: false, httpStatus: 402, body: { code: 'merchant_limit_exceeded', message: 'Amount exceeds merchant maximum' } };
      }

      const receiptId = generateReceiptId();
      const requestedAt = new Date().toISOString();

      let primaryRail: ActiveRail;
      try {
        primaryRail = selectRail(updatedDelegate, merchant, currency, amountCents);
      } catch (err) {
        if (err instanceof RailMismatchError) {
          await rollbackMerchantReceiveLimit(targetMerchantId, amountCents, todayKey);
          await rollbackIncrement(activeMandate, amountCents, activeMandate.currentMonthKey);

          const setupSession = await credentialService.createSetupSession({
            merchantId: merchant.merchantId,
            maxPerTxCents: updatedDelegate.maxAmountPerTxCents,
            maxMonthlySpendCents: updatedDelegate.maxMonthlySpendCents,
            rail: err.targetRail,
            railPreference: updatedDelegate.railPreference,
            allowedMerchantIds: updatedDelegate.allowedMerchantIds,
            mode: 'add_rail',
            targetMandateId: mandateId,
          });

          const baseUrl = process.env.SETUP_UI_URL ?? 'https://delegare.co';
          return {
            success: false,
            httpStatus: 400,
            body: {
              allowed: false,
              code: 'rail_mismatch',
              message: err.message,
              merchantAccepts: err.merchantAccepts,
              delegateHas: err.delegateHas,
              resolution: err.resolution,
              setupUrl: `${baseUrl}/setup?session=${setupSession.sessionToken}&addRail=${err.targetRail}`,
            },
          };
        }
        throw err;
      }

      // If no explicit recipient wallet was specified, fall back to the merchant's
      // registered wallet. Prefer walletAddress; fall back to usdcWalletAddress.
      // This ensures charges work even when the caller omits a recipient field.
      const resolvedWalletAddress = targetWalletAddress
        || merchant.walletAddress
        || (merchant as any).usdcWalletAddress
        || undefined;

      // Guard: crypto rails require a valid recipient wallet address.
      // If none is configured, return a clear actionable error rather than letting
      // viem throw a cryptic "Address '' is invalid" deep in the call stack.
      if ((currency === 'usdc' || currency === 'usdt') && !resolvedWalletAddress) {
        await rollbackMerchantReceiveLimit(targetMerchantId, amountCents, todayKey);
        await rollbackIncrement(activeMandate, amountCents, activeMandate.currentMonthKey);

        const hasFiat = !!merchant.stripeConnectedAccountId;
        return {
          success: false,
          httpStatus: 422,
          body: {
            allowed: false,
            status: 'failed',
            error: {
              code: 'merchant_wallet_not_configured',
              message: `The merchant "${merchant.name}" has no USDC wallet address configured and cannot receive ${currency.toUpperCase()} payments.`,
              merchantId: targetMerchantId,
              ...(hasFiat ? {
                fiatAvailable: true,
                hint: `This merchant accepts card payments via Stripe. Re-submit with currency="usd" to pay via Stripe instead. Minimum charge is $5.00 USD when using fiat (credited against future API calls).`,
                suggestedCurrency: 'usd',
                minimumFiatCents: 500,
              } : {
                fiatAvailable: false,
                hint: 'Please contact the merchant to connect a USDC wallet or Stripe account before payments can be processed.',
              }),
            },
          },
        };
      }

      const railParams = {
        amountCents,
        platformFeeCents: merchant.platformFee || 3,
        currency,
        description,
        receiptId,
        metadata,
        merchantStripeAccountId: merchant.stripeConnectedAccountId,
        recipientWalletAddress: resolvedWalletAddress,
        isTestMode,
      };

      let railResult = await executeOnRail(primaryRail, updatedDelegate, railParams);
      let railUsed: ActiveRail = primaryRail;
      let railFallbackUsed = false;

      // Fallback to other rail if primary failed
      if (railResult.status === 'failed' && updatedDelegate.allowRailFallback && updatedDelegate.rail === 'both') {
        const fallbackRail = getFallbackRail(primaryRail);
        const fallbackResult = await executeOnRail(fallbackRail, updatedDelegate, railParams);
        if (fallbackResult.status !== 'failed') {
          railResult = fallbackResult;
          railUsed = fallbackRail;
          railFallbackUsed = true;
        }
      }

      // Rollback spend counters if payment ultimately failed
      if (railResult.status === 'failed') {
        await rollbackMerchantReceiveLimit(targetMerchantId, amountCents, todayKey);
        await rollbackIncrement(activeMandate, amountCents, activeMandate.currentMonthKey);
      }

      // Write immutable transaction log
      const log: TransactionLog = {
        receiptId,
        mandateId: mandateId,
        ownerId: updatedDelegate.ownerId,
        ownerEmail: updatedDelegate.ownerEmail,
        merchantId: targetMerchantId,
        merchantName: merchant.name,
        rail: railUsed,
        amountCents,
        currency: currency as TransactionLog['currency'],
        description,
        idempotencyKey,
        status: railResult.status,
        failureReason: railResult.failureReason,
        stripePaymentIntentId: railResult.stripePaymentIntentId || undefined,
        txHash: railResult.txHash || undefined,
        railFallbackUsed,
        platformFeeCents: merchant.platformFee || 3,
        platformFeeSettled: false,
        requestedAt,
        completedAt: railResult.status === 'completed' ? new Date().toISOString() : undefined,
        agentpayVersion: VAULT_VERSION,
        metadata,
        isTestMode,
        ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, // Keep logs for 30 days
      };

      await ddb.send(new PutCommand({ TableName: TABLE.TRANSACTIONS, Item: log }));

      if (railResult.status === 'completed') {
        // Increment merchant stats — always update regardless of buyer email
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE.MERCHANTS,
            Key: { merchantId: targetMerchantId },
            UpdateExpression: 'SET totalVolumeCents = if_not_exists(totalVolumeCents, :zero) + :vol, totalTransactions = if_not_exists(totalTransactions, :zero) + :one',
            ExpressionAttributeValues: {
              ':vol': amountCents,
              ':one': 1,
              ':zero': 0,
            },
          }),
        ).catch(e => logger.error({ err: e }, 'Failed to update merchant stats'));

        // Fire and forget email sending — only if email is available
        if (updatedDelegate.ownerEmail) {
          void EmailService.sendReceipt({
            toEmail: updatedDelegate.ownerEmail,
            amountCents,
            merchantName: merchant.name,
            description,
            receiptId
          });
        }
      }

      if (railResult.status === 'completed' && merchant.webhookUrl && merchant.webhookSecret) {
        void WebhookService.dispatch(targetMerchantId, merchant.webhookUrl, merchant.webhookSecret, {
          event: 'payment.succeeded',
          data: toChargeResponse(log),
          timestamp: new Date().toISOString(),
        });
      }

      // Auto-offramp: if merchant has enabled auto-offramp and this was a USDC settlement,
      // automatically sweep the received amount to their bank. Fire-and-forget.
      if (
        railResult.status === 'completed' &&
        railUsed === 'crypto' &&
        merchant.autoOfframp &&
        merchant.autoOfframpBankAccountId &&
        merchant.stripeConnectedAccountId
      ) {
        const threshold = merchant.autoOfframpThresholdCents ?? 0;
        if (amountCents >= threshold && amountCents > DELEGARE_RAMP_FEE_CENTS) {
          void initiateOfframp({
            merchantId: targetMerchantId,
            sourceWallet: resolvedWalletAddress ?? '',
            amountUsdc: amountCents,
            stripeConnectedAccountId: merchant.stripeConnectedAccountId,
            bankAccountId: merchant.autoOfframpBankAccountId,
            receiptId,
            isTestMode,
          }).then(result => {
            if (result.status === 'failed') {
              logger.warn({ receiptId, rampId: result.rampId, reason: result.failureReason }, 'Auto-offramp failed after settlement');
            } else {
              logger.info({ receiptId, rampId: result.rampId, amountCents }, 'Auto-offramp initiated after USDC settlement');
            }
          }).catch(err => {
            logger.error({ err: err.message, receiptId }, 'Auto-offramp threw unexpectedly');
          });
        }
      }

      // Push to CDP Bazaar for agentic.market indexing after successful USDC payments.
      // The indexed entity is the merchant, not the payment rail.
      // Fire-and-forget — never blocks the payment response.
      if (railResult.status === 'completed' && (currency === 'usdc' || currency === 'usdt') && railResult.txHash) {
        // Allow merchants to pass service-level metadata via charge metadata fields.
        const serviceEndpoint = metadata?.serviceEndpoint || merchant.websiteUrl || merchant.webhookUrl;
        const serviceLogoUrl = metadata?.logoUrl || merchant.logoUrl;
        const serviceCategory = metadata?.category || merchant.category || 'ai-agent-services';
        const serviceDescription = metadata?.serviceDescription
          || merchant.serviceDescription
          || `${merchant.name} — AI agent services accepting x402 payments`;

        pushCdpBazaarIndex({
          requirements: {
            payTo: resolvedWalletAddress ?? '',
            price: (amountCents / 100).toFixed(2),
            resource: serviceEndpoint || description,
            mimeType: 'application/json',
            maxTimeoutSeconds: 60,
          },
          txHash: railResult.txHash,
          network: 'base',
          bazaar: {
            description: serviceDescription,
            input: {
              merchant: merchant.name,
              merchantId: targetMerchantId,
              ...(serviceLogoUrl ? { logoUrl: serviceLogoUrl } : {}),
              ...(serviceEndpoint ? { endpoint: serviceEndpoint } : {}),
              category: serviceCategory,
            },
            output: { example: { receiptId, status: 'completed', amountCents } },
          },
        });
      }

      // A transaction log was written (completed, pending, or failed charge) —
      // this is a terminal recorded state, so finalize the claim: a retry with
      // the same key replays this response rather than re-charging. (Pre-charge
      // validation rejections above return success:false to release the claim.)
      const httpStatus = railResult.status === 'completed' ? 200 : railResult.status === 'pending' ? 202 : 402;
      return { success: true, httpStatus, body: toChargeResponse(log) };
    },
    {
      success: false,
      httpStatus: 409,
      body: {
        code: 'charge_in_progress',
        message: 'A charge with this idempotency key is already being processed. Retry after it settles.',
      },
    },
  );

  res.status(outcome.httpStatus).json(outcome.body);
}

/**
 * Retrieves a transaction receipt by its unique ID.
 * 
 * @param req - Express request with receiptId in params.
 * @param res - Express response.
 */
export async function getReceipt(req: Request, res: Response): Promise<void> {
  const { receiptId } = req.params;
  const result = await ddb.send(new GetCommand({ TableName: TABLE.TRANSACTIONS, Key: { receiptId } }));

  if (!result.Item) {
    res.status(404).json({ code: 'not_found', message: 'Receipt not found' });
    return;
  }

  res.json(toChargeResponse(result.Item as TransactionLog));
}

/**
 * Helper to find an existing transaction for a merchant using an idempotency key.
 * Used to ensure that retried requests do not result in multiple charges.
 * 
 * @param merchantId - The merchant's unique ID.
 * @param idempotencyKey - The client-provided idempotency key.
 * @returns The existing TransactionLog or null if not found.
 */
async function findByIdempotencyKey(
  merchantId: string,
  idempotencyKey: string,
): Promise<TransactionLog | null> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.TRANSACTIONS,
      IndexName: 'idempotencyIndex',
      KeyConditionExpression: 'merchantId = :mid AND idempotencyKey = :key',
      ExpressionAttributeValues: { ':mid': merchantId, ':key': idempotencyKey },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as TransactionLog) ?? null;
}

/**
 * Refunds a completed transaction and restores the spending delegate's limit.
 * Currently only supports Fiat rails via Stripe.
 */
export async function refund(req: Request, res: Response): Promise<void> {
  const { receiptId } = req.params;
  const merchantId = (req as any).merchantId;

  // 1. Look up the transaction log
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE.TRANSACTIONS,
      Key: { receiptId },
    })
  );

  const log = result.Item as TransactionLog | undefined;
  if (!log) {
    res.status(404).json({ code: 'not_found', message: 'Transaction not found' });
    return;
  }

  // 2. Validate merchant owns this receipt
  if (log.merchantId !== merchantId) {
    res.status(403).json({ code: 'forbidden', message: 'You can only refund your own transactions' });
    return;
  }

  // 3. Validate status
  if (log.status === 'refunded') {
    res.json({ status: 'refunded', receiptId });
    return;
  }
  if (log.status !== 'completed') {
    res.status(400).json({ code: 'invalid_status', message: `Cannot refund a ${log.status} transaction` });
    return;
  }

  // 4. Process Refund based on rail
  if (log.rail === 'fiat') {
    if (!log.stripePaymentIntentId) {
      res.status(500).json({ code: 'internal_error', message: 'Missing Stripe PaymentIntent ID' });
      return;
    }
    
    // We only want to instantiate Stripe to issue the refund
    const Stripe = (await import('stripe')).default;
    const { getSecret, vaultSecretId } = await import('../lib/secrets');
    const secrets = await getSecret(vaultSecretId());
    const keyName = log.isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
    const apiKey = secrets[keyName] ?? process.env[keyName] ?? '';
    const stripe = new Stripe(apiKey, { apiVersion: '2024-12-18.acacia' as any });

    try {
      // Find the merchant's stripe connected account ID to refund on their behalf
      const merchant = await merchantService.getMerchant(merchantId);
      const stripeAccount = merchant?.billingStripeCustomerId; // In our model billingStripeCustomerId actually stores the connect account ID sometimes, wait, actually we have stripeConnectedAccountId
      const connectedAccount = merchant?.stripeConnectedAccountId;
      
      await stripe.refunds.create({
        payment_intent: log.stripePaymentIntentId,
      }, connectedAccount ? { stripeAccount: connectedAccount } : undefined);
    } catch (err: any) {
      logger.error({ err, receiptId }, 'Stripe refund failed');
      res.status(400).json({ code: 'refund_failed', message: err.message });
      return;
    }
  } else if (log.rail === 'crypto') {
    // Crypto refunds are not natively reversible. The merchant must send funds back on-chain.
    res.status(400).json({ code: 'crypto_refund_unsupported', message: 'Crypto transactions cannot be automatically refunded. Please manually send funds back to the delegate owner on-chain.' });
    return;
  }

  // 5. Update transaction log status to refunded
  await ddb.send(
    new PutCommand({
      TableName: TABLE.TRANSACTIONS,
      Item: {
        ...log,
        status: 'refunded',
      }
    })
  );

  // 6. Rollback limits to restore budget to the agent
  // We need the monthKey the transaction occurred in, extracted from requestedAt
  const txDate = new Date(log.requestedAt);
  const originalMonthKey = `${txDate.getUTCFullYear()}-${String(txDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const originalDayKey = log.requestedAt.split('T')[0];

  const mandateResult = await ddb.send(new QueryCommand({
    TableName: TABLE.MANDATES,
    KeyConditionExpression: 'mandateId = :id',
    ExpressionAttributeValues: { ':id': log.mandateId },
    Limit: 1
  }));
  const mandate = mandateResult.Items?.[0] as SpendingMandate | undefined;

  if (mandate) {
    await rollbackIncrement(mandate, log.amountCents, originalMonthKey);
  }
  await rollbackMerchantReceiveLimit(log.merchantId, log.amountCents, originalDayKey);

  // Fetch merchant to get webhook settings
  const merchant = await merchantService.getMerchant(merchantId);
  if (merchant?.webhookUrl && merchant?.webhookSecret) {
    void WebhookService.dispatch(merchantId, merchant.webhookUrl, merchant.webhookSecret, {
      event: 'refund.succeeded',
      data: { receiptId, originalAmountCents: log.amountCents },
      timestamp: new Date().toISOString(),
    });
  }

  res.json({
    status: 'refunded',
    receiptId,
  });
}

/**
 * Transforms an internal TransactionLog model into a clean public API response.
 * Filters out internal fields like ownerId and mandateId for security.
 * 
 * @param log - The internal transaction log item.
 * @returns Cleaned up charge response object.
 */
function toChargeResponse(log: TransactionLog) {
  return {
    receiptId: log.receiptId,
    status: log.status,
    amountCents: log.amountCents,
    currency: log.currency,
    railUsed: log.rail,
    railFallbackUsed: log.railFallbackUsed,
    txHash: log.txHash,
    stripePaymentIntentId: log.stripePaymentIntentId,
    failureReason: log.failureReason,
    completedAt: log.completedAt ?? log.requestedAt,
    // Add compatible error fields for SDK parsing if failed
    ...(log.status === 'failed' ? { code: 'payment_failed', message: log.failureReason } : {})
  };
}
