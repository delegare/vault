/**
 * x402 payment-required middleware.
 *
 * Merchants mount this on routes they want to gate behind a USDC micropayment:
 *
 *   app.get('/premium', requireX402Payment({
 *     price: '0.05',           // decimal USDC — human-friendly
 *     payTo: '0xMerchant...',  // Base address that receives the funds
 *   }), handler);
 *
 * Flow:
 *   1. No `X-PAYMENT` header → respond 402 with PaymentRequirements (spec shape).
 *   2. Header present → base64-decode, call the in-process x402 service to
 *      verify + settle. On success, set `X-PAYMENT-RESPONSE` and call next().
 *
 * This middleware intentionally does NOT self-HTTP to the facilitator —
 * it imports the service module directly so unit tests and horizontal
 * scale don't pay a localhost roundtrip penalty.
 *
 * USDC-only for now: USDT on Base does not implement EIP-3009.
 */

import { Request, Response, NextFunction } from 'express';
import { SUPPORTED_TOKENS } from '../services/CryptoRail';
import {
  verifyX402Payment,
  settleX402Payment,
  settleMandateBackedX402,
  priceToAtomicUsdc,
  type X402Requirements,
} from '../services/x402';
import { CredentialService } from '../services/CredentialService';
import { logger } from '../lib/logger';

const credentialService = new CredentialService();

export interface X402PaymentOptions {
  /** Decimal USDC amount as a string, e.g. "0.05". */
  price: string;
  /** Base mainnet address that receives the payment. */
  payTo: string;
  /** Optional human-readable resource identifier (defaults to req.originalUrl). */
  resource?: string;
  /** MIME type of the gated resource — advertised in PaymentRequirements. */
  mimeType?: string;
  /** How long the signed authorization is valid (default 3600s). */
  maxTimeoutSeconds?: number;
  /** When true, use Base Sepolia instead of mainnet. */
  testMode?: boolean;
}

export function requireX402Payment(options: X402PaymentOptions) {
  const tokenConfig = SUPPORTED_TOKENS.usdc;
  const network: 'base' | 'base-sepolia' = options.testMode ? 'base-sepolia' : 'base';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const xPayment = req.header('x-payment');
    const xMandate = req.header('x-delegare-mandate');

    // ── Case A: no payment yet → advertise requirements ──────────────
    if (!xPayment && !xMandate) {
      // x402 spec requires `maxAmountRequired` in atomic units as a decimal
      // string. USDC has 6 decimals: "0.05" → "50000".
      let maxAmountRequired: string;
      try {
        maxAmountRequired = priceToAtomicUsdc(options.price).toString();
      } catch {
        res.status(500).json({
          code: 'x402_misconfigured',
          message: `Invalid price: ${options.price}`,
        });
        return;
      }

      res.status(402).json({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network,
            asset: tokenConfig.address,
            maxAmountRequired,
            payTo: options.payTo,
            resource: options.resource || req.originalUrl,
            description: `USDC payment for ${options.resource || req.originalUrl}`,
            mimeType: options.mimeType || 'application/json',
            maxTimeoutSeconds: options.maxTimeoutSeconds ?? 3600,
            extra: {
              name: tokenConfig.name,
              version: '2',
            },
          },
        ],
      });
      return;
    }

    // ── Case B1: mandate header → route through chargeCrypto ─────────
    //
    // Buyer agents holding a Delegare intent mandate (SD-JWT-VC) send their
    // mandate in `X-DELEGARE-MANDATE` instead of signing an EIP-3009
    // authorization themselves. This is the "zero popups" path used by the
    // MCP server — the smart wallet pays the merchant via the router with
    // no user interaction required.
    if (xMandate) {
      const requirements: X402Requirements = {
        price: options.price,
        payTo: options.payTo,
        resource: options.resource || req.originalUrl,
        mimeType: options.mimeType,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        testMode: options.testMode,
      };

      try {
        const mandate = await credentialService.verifyIntentMandate(xMandate);
        const settled = await settleMandateBackedX402({
          mandateId: mandate.mandateId,
          requirements,
          resourceDescription: requirements.resource,
          // Retries carrying the same Idempotency-Key are deduped at the
          // settle layer (spend increment + charge); absent it, each call is
          // treated as a distinct metered charge.
          idempotencyKey: req.header('idempotency-key') || undefined,
        });

        if (!settled.success || !settled.transaction) {
          res.status(402).json({
            code: 'payment_settlement_failed',
            message: settled.errorReason ?? 'Mandate-backed settlement failed',
          });
          return;
        }

        const responseHeader = Buffer.from(
          JSON.stringify({
            success: true,
            transaction: settled.transaction,
            network: settled.network,
            payer: settled.payer,
          }),
        ).toString('base64');
        res.setHeader('X-PAYMENT-RESPONSE', responseHeader);

        (req as any).x402Payer = settled.payer;
        (req as any).x402Transaction = settled.transaction;
        (req as any).x402MandateId = mandate.mandateId;

        next();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, '[x402 middleware] mandate-backed path failed');
        res.status(402).json({
          code: 'invalid_mandate',
          message,
        });
        return;
      }
    }

    // ── Case B2: payment header present → verify + settle ─────────────
    let paymentData: unknown;
    try {
      const decoded = Buffer.from(xPayment as string, 'base64').toString('utf8');
      paymentData = JSON.parse(decoded);
    } catch {
      res.status(400).json({
        code: 'invalid_x_payment_header',
        message: 'X-PAYMENT header must be base64-encoded JSON',
      });
      return;
    }

    const requirements: X402Requirements = {
      price: options.price,
      payTo: options.payTo,
      resource: options.resource || req.originalUrl,
      mimeType: options.mimeType,
      maxTimeoutSeconds: options.maxTimeoutSeconds,
      testMode: options.testMode,
    };

    try {
      const verified = await verifyX402Payment(paymentData, requirements);
      if (!verified.isValid) {
        res.status(402).json({
          code: 'invalid_payment',
          message: verified.invalidReason,
        });
        return;
      }

      const settled = await settleX402Payment(paymentData, requirements);
      if (!settled.success || !settled.transaction) {
        res.status(402).json({
          code: 'payment_settlement_failed',
          message: settled.errorReason ?? 'Settlement failed',
        });
        return;
      }

      // x402 spec X-PAYMENT-RESPONSE shape: { success, transaction, network, payer }
      const responseHeader = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settled.transaction,
          network: settled.network,
          payer: settled.payer,
        }),
      ).toString('base64');
      res.setHeader('X-PAYMENT-RESPONSE', responseHeader);

      // Attach payer context so the downstream handler can log / personalize.
      (req as any).x402Payer = settled.payer;
      (req as any).x402Transaction = settled.transaction;

      next();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[x402 middleware] unexpected error',
      );
      res.status(500).json({
        code: 'x402_internal_error',
        message: 'Unexpected error processing payment',
      });
    }
  };
}
