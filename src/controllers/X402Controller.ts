/**
 * x402 facilitator HTTP endpoints.
 *
 * Thin adapter over services/x402 — all verification / settlement logic
 * lives there so the in-process Express middleware can call the same code
 * without a self-HTTP hop.
 *
 * Endpoints:
 *   POST /v1/x402/verify          { payment, requirements } → { isValid, invalidReason? }
 *   POST /v1/x402/verify-receipt  { transaction, network, expectedPayTo,
 *                                   expectedAmount, expectedResource } → { isValid, invalidReason? }
 *   POST /v1/x402/settle          { payment, requirements } → { success, transaction, network, payer }
 *
 * /verify is for unsettled EIP-3009 authorization payloads (precheck).
 * /verify-receipt is for already-settled X-PAYMENT-RESPONSE receipts; it
 * enforces resource/payTo/amount binding + TTL to prevent receipt replay.
 *
 * All endpoints are intentionally unauthenticated. x402 facilitators are
 * called by the resource server (merchant), not by the buyer, and the
 * payment payload itself is self-authenticating (EIP-712 signature).
 */

import { Request, Response } from 'express';
import {
  verifyX402Payment,
  verifyX402Receipt,
  settleX402Payment,
  type X402Requirements,
  type BazaarExtension,
} from '../services/x402';

function parseRequirements(raw: any): X402Requirements | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.price !== 'string' || typeof raw.payTo !== 'string') return null;
  return {
    price: raw.price,
    payTo: raw.payTo,
    resource: typeof raw.resource === 'string' ? raw.resource : undefined,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
    maxTimeoutSeconds:
      typeof raw.maxTimeoutSeconds === 'number' ? raw.maxTimeoutSeconds : undefined,
    testMode:
      typeof raw.testMode === 'boolean'
        ? raw.testMode
        : raw.network === 'base-sepolia',
  };
}

export async function verifyX402(req: Request, res: Response): Promise<void> {
  try {
    const requirements = parseRequirements(req.body?.requirements);
    if (!requirements) {
      res.status(400).json({ isValid: false, invalidReason: 'Missing or invalid requirements' });
      return;
    }
    const result = await verifyX402Payment(req.body?.payment, requirements);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ isValid: false, invalidReason: message });
  }
}

/**
 * Verify a post-settlement X-PAYMENT-RESPONSE receipt.
 *
 * Distinct from /verify (which checks an unsettled authorization payload).
 * This endpoint enforces resource binding, payTo binding, amount binding,
 * and a TTL on receipt reuse. Required to prevent the cross-resource
 * receipt replay attack reported in delegare/delegare#1.
 */
export async function verifyX402ReceiptController(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const { transaction, network, expectedPayTo, expectedAmount, expectedResource } = body;

    // Validate inputs up front — fail-closed with a clear 400 on shape errors.
    if (typeof transaction !== 'string' || !transaction) {
      res.status(400).json({ isValid: false, invalidReason: 'transaction (string) is required' });
      return;
    }
    if (network !== 'base' && network !== 'base-sepolia') {
      res.status(400).json({ isValid: false, invalidReason: 'network must be "base" or "base-sepolia"' });
      return;
    }
    if (typeof expectedPayTo !== 'string' || !expectedPayTo) {
      res.status(400).json({ isValid: false, invalidReason: 'expectedPayTo (string) is required' });
      return;
    }
    if (typeof expectedAmount !== 'string' || !expectedAmount) {
      res.status(400).json({ isValid: false, invalidReason: 'expectedAmount (atomic USDC as string) is required' });
      return;
    }
    if (typeof expectedResource !== 'string' || !expectedResource) {
      res.status(400).json({
        isValid: false,
        invalidReason:
          'expectedResource (string) is required — receipt verification must be bound to a resource',
      });
      return;
    }

    const result = await verifyX402Receipt({
      transaction,
      network,
      expectedPayTo,
      expectedAmount,
      expectedResource,
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ isValid: false, invalidReason: message });
  }
}

export async function settleX402(req: Request, res: Response): Promise<void> {
  try {
    // Middleware sends requirements at top level, or nested in .requirements
    const requirements = parseRequirements(req.body?.requirements || req.body);
    if (!requirements) {
      res.status(400).json({ success: false, errorReason: 'Missing or invalid requirements (need price and payTo)' });
      return;
    }

    // Middleware sends mandate at top level, or nested in payment.mandate
    const mandate = req.body?.mandate || req.body?.payment?.mandate;
    const payment = req.body?.payment;

    // Extract optional CDP Bazaar discovery metadata forwarded by
    // @delegare/x402 middleware when declareDiscoveryExtension() is used.
    const bazaar: BazaarExtension | undefined = req.body?.extensions?.bazaar;

    // Optional caller-supplied idempotency key. When present, retries of the
    // same logical settle are deduped at the settle layer (spend + charge).
    // Accept the standard `Idempotency-Key` header or a body field.
    const idempotencyKey =
      (typeof req.header === 'function' ? req.header('idempotency-key') : undefined) ||
      (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined) ||
      undefined;

    const result = await settleX402Payment(mandate || payment, requirements, bazaar, idempotencyKey);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, errorReason: message });
  }
}
