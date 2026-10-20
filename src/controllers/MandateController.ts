import { Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CredentialService } from '../services/CredentialService';
import { MerchantService } from './MerchantController';
import { ddb, TABLE } from '../lib/dynamodb';
import { getSecret, vaultSecretId } from '../lib/secrets';

const credentialService = new CredentialService();

const CreateSetupSessionSchema = z.object({
  maxPerTxCents: z.number().int().positive(),
  maxMonthlySpendCents: z.number().int().positive(),
  rail: z.enum(['fiat', 'crypto', 'both']).default('both'),
  railPreference: z.enum(['auto', 'fiat_first', 'crypto_first', 'cheapest', 'fastest']).default('auto'),
  allowedMerchantIds: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const SelfServiceSetupSchema = z.object({
  rail: z.enum(['fiat', 'crypto', 'both']).optional(),
  maxPerTxCents: z.number().int().positive().optional(),
  maxMonthlyCents: z.number().int().positive().optional(),
  targetMerchantId: z.string().optional(),
});

export async function createSetupSession(req: Request, res: Response): Promise<void> {
  const parsed = CreateSetupSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const merchantId = (req as import("../types/express").AuthedRequest).merchantId;
  const merchantService = new MerchantService();
  const ownerAccount = await merchantService.getMerchant(merchantId);

  let existingMandates: any[] = [];
  if (ownerAccount) {
    const activeMandates = await credentialService.findActiveMandatesByOwnerId(merchantId);
    
    existingMandates = activeMandates.filter(m => 
      m.maxAmountPerTxCents >= parsed.data.maxPerTxCents && 
      m.maxMonthlySpendCents >= parsed.data.maxMonthlySpendCents &&
      (!parsed.data.allowedMerchantIds || parsed.data.allowedMerchantIds.every(id => m.allowedMerchantIds?.includes(id))) &&
      m.encodedMandate
    ).map(m => ({
      mandateId: m.mandateId,
      encodedMandate: m.encodedMandate,
      maxPerTxCents: m.maxAmountPerTxCents,
      maxMonthlySpendCents: m.maxMonthlySpendCents
    }));
  }

  const session = await credentialService.createSetupSession({
    merchantId,
    ...parsed.data,
  });

  const baseUrl = process.env.SETUP_UI_URL ?? ((process.env.API_BASE_URL || process.env.BASE_URL) ? (process.env.API_BASE_URL || process.env.BASE_URL)!.replace('://api.', '://app.') : 'https://app.delegare.dev');
  res.status(201).json({
    setupUrl: `${baseUrl}/setup?session=${session.sessionToken}`,
    sessionToken: session.sessionToken,
    expiresInSeconds: 1800,
    existingMandates: existingMandates.length > 0 ? existingMandates : undefined
  });
}

export async function createSelfServiceSetupSession(req: Request, res: Response): Promise<void> {
  const parsed = SelfServiceSetupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const email = (req as any).cognitoEmail;
  if (!email) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const merchantService = new MerchantService();
  const buyer = await merchantService.getMerchantByEmail(email);

  let existingMandates: any[] = [];
  if (buyer) {
    const activeMandates = await credentialService.findActiveMandatesByOwnerId(buyer.merchantId);
    
    // Filter mandates that meet the requested criteria
    const reqMaxPerTx = parsed.data.maxPerTxCents || 5000;
    const reqMaxMonthly = parsed.data.maxMonthlyCents || 50000;
    
    existingMandates = activeMandates.filter(m => 
      m.maxAmountPerTxCents >= reqMaxPerTx && 
      m.maxMonthlySpendCents >= reqMaxMonthly &&
      (!parsed.data.targetMerchantId || m.allowedMerchantIds?.includes(parsed.data.targetMerchantId)) &&
      m.encodedMandate
    ).map(m => ({
      mandateId: m.mandateId,
      encodedMandate: m.encodedMandate,
      maxPerTxCents: m.maxAmountPerTxCents,
      maxMonthlySpendCents: m.maxMonthlySpendCents
    }));
  }

  const session = await credentialService.createSelfServiceSetupSession({
    ownerEmail: email,
    ...parsed.data,
  });

  const baseUrl = process.env.SETUP_UI_URL ?? ((process.env.API_BASE_URL || process.env.BASE_URL) ? (process.env.API_BASE_URL || process.env.BASE_URL)!.replace('://api.', '://app.') : 'https://app.delegare.dev');
  res.status(201).json({
    setupUrl: `${baseUrl}/setup?session=${session.sessionToken}`,
    sessionToken: session.sessionToken,
    expiresInSeconds: 1800,
    existingMandates: existingMandates.length > 0 ? existingMandates : undefined
  });
}

// ── Buyer card-on-file via Stripe Checkout (mode='setup') ─────────────────
//
// This is the *buyer* fiat onboarding flow. It is intentionally NOT Stripe
// Connect — buyers don't run businesses. We create a Stripe Customer for the
// buyer and a Checkout Session in `mode: 'setup'` so Stripe collects card
// details (with Link auto-fill for one-tap UX) and returns a SetupIntent.
// The webhook handler then attaches the resulting PaymentMethod and issues
// the AP2 intent mandate.
//
// Stripe Connect OAuth still exists for *merchants* in /onboarding — that
// flow links a business so it can RECEIVE money. Two different primitives.

const BuyerCheckoutSchema = z.object({
  // Optional — if absent, this is an "add fiat rail to existing mandate" flow
  // and the server will mint a fresh add_rail session internally.
  sessionToken: z.string().min(8).optional(),
  successPath: z.string().optional(),
  cancelPath: z.string().optional(),
});

const BuyerWalletSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
});

async function getStripeForBuyer(): Promise<Stripe> {
  const secrets = await getSecret(vaultSecretId());
  // Buyer card-on-file uses the platform Stripe account, not a connected one.
  // Live mode in prod; test mode in dev/sandbox.
  //
  // IMPORTANT: The rest of the codebase (app.ts:264, app.ts:420,
  // WalletController.ts:116, logger.ts:5, etc.) uses 'prod' as the canonical
  // production value for ENVIRONMENT — NOT 'production'. Checking against
  // 'production' was a typo that caused useTest=true in real prod, which
  // forced this helper to pull STRIPE_TEST_SECRET_KEY (set to 'placeholder'
  // in prod secrets) and throw.
  const useTest = (process.env.ENVIRONMENT ?? 'dev') !== 'prod';
  let keyName = useTest ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
  let apiKey = secrets[keyName] ?? process.env[keyName] ?? '';

  // Safe fallback for Sandbox environments where a production key isn't provided
  if (!useTest && (!apiKey || apiKey === 'placeholder')) {
    keyName = 'STRIPE_TEST_SECRET_KEY';
    apiKey = secrets[keyName] ?? process.env[keyName] ?? '';
  }

  if (!apiKey || apiKey === 'placeholder') throw new Error(`Missing or invalid ${keyName}`);
  return new Stripe(apiKey, { apiVersion: '2024-12-18.acacia' as any });
}

export async function createBuyerCardCheckout(req: Request, res: Response): Promise<void> {
  const parsed = BuyerCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  let sessionToken = parsed.data.sessionToken;
  let existingSession = null;

  if (sessionToken) {
    existingSession = await credentialService.getSetupSession(sessionToken);
    if (!existingSession || existingSession.status !== 'pending') {
      res.status(400).json({ code: 'invalid_session', message: 'Setup session is invalid or expired' });
      return;
    }
  }

  const email = (req as any).cognitoEmail || existingSession?.ownerEmail;

  if (!email) {
    // No way to identify the user — don't create orphan rows against a shared
    // placeholder email (previous bug: 'auto-fiat@delegare.dev' catch-all
    // caused every anonymous hit to pollute the table).
    res.status(401).json({ code: 'unauthorized', message: 'Must be logged in or have a valid setup session.' });
    return;
  }

  const merchantService = new MerchantService();
  let buyer = await merchantService.getMerchantByEmail(email);

  if (!buyer) {
    // First-time buyer — mint a minimal buyer row. Use createBuyerProfile
    // (NOT upsertAutoMerchant, which is the P2P-merchant factory that
    // unnecessarily mints webhook secrets, live API keys, and crypto_only
    // rail config). Those side effects should only happen when the buyer
    // explicitly connects a crypto wallet later.
    buyer = await merchantService.createBuyerProfile(email);
  } else if ((buyer.accountType ?? 'merchant') !== 'buyer') {
    res.status(400).json({ code: 'wrong_account_type', message: 'This endpoint is for buyer accounts only. Merchants use Stripe Connect.' });
    return;
  }

  if (!sessionToken) {
    const activeMandates = await credentialService.findActiveMandatesByOwnerId(buyer!.merchantId);
    const targetMandate = activeMandates[0];
    const minted = await credentialService.createSelfServiceSetupSession({
      ownerEmail: email,
      maxPerTxCents: targetMandate?.maxAmountPerTxCents,
      maxMonthlyCents: targetMandate?.maxMonthlySpendCents,
      rail: 'fiat',
    });
    await ddb.send(new UpdateCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Key: { sessionToken: minted.sessionToken },
      UpdateExpression: 'SET #m = :addRail' + (targetMandate ? ', targetMandateId = :tmid' : ''),
      ExpressionAttributeNames: { '#m': 'mode' },
      ExpressionAttributeValues: {
        ':addRail': 'add_rail',
        ...(targetMandate ? { ':tmid': targetMandate.mandateId } : {}),
      },
    }));
    sessionToken = minted.sessionToken;
  }

  const stripe = await getStripeForBuyer();

  let customerId = buyer!.stripeBuyerCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: buyer!.contactEmail,
      name: buyer!.name,
      metadata: {
        delegareMerchantId: buyer!.merchantId,
        delegareAccountType: 'buyer',
      },
    });
    customerId = customer.id;
    await ddb.send(new UpdateCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId: buyer!.merchantId },
      UpdateExpression: 'SET stripeBuyerCustomerId = :cid, updatedAt = :now',
      ExpressionAttributeValues: { ':cid': customerId, ':now': new Date().toISOString() },
    }));
  }

  const setupUiUrl = process.env.SETUP_UI_URL
    ?? ((process.env.API_BASE_URL || process.env.BASE_URL) ? (process.env.API_BASE_URL || process.env.BASE_URL)!.replace('://api.', '://app.') : null)
    ?? 'https://app.delegare.dev';
  const successPath = parsed.data.successPath ?? `/setup?status=fiat_complete&session=${sessionToken}`;
  const cancelPath = parsed.data.cancelPath ?? `/setup?status=fiat_cancelled&session=${sessionToken}`;

  const checkout = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card', 'link'],
    success_url: `${setupUiUrl}${successPath}`,
    cancel_url: `${setupUiUrl}${cancelPath}`,
    metadata: {
      delegareSessionToken: sessionToken,
      delegareBuyerMerchantId: buyer!.merchantId,
      delegareFlow: 'buyer_card_setup',
    },
  });

  res.status(201).json({
    url: checkout.url,
    checkoutSessionId: checkout.id,
  });
}

/**
 * Buyer "add crypto rail" — attaches a USDC wallet to the logged-in buyer.
 *
 * Unlike the merchant Connect-OAuth flow, buyers DO get a funny @handle here
 * because the same address makes them P2P-receivable. We:
 *   1. Persist the wallet on the buyer's MerchantAccount row.
 *   2. Create a sibling auto-merchant row at `generateMerchantName(walletAddress)`
 *      so they show up at /@swift-amber-narwhal for incoming P2P payments.
 *   3. Patch all of the buyer's active mandates with `smartWalletAddress` and
 *      bump `rail` to 'both' so PaymentRouter sees `hasCrypto = true`.
 */
export async function addBuyerWallet(req: Request, res: Response): Promise<void> {
  const parsed = BuyerWalletSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const email = (req as any).cognitoEmail;
  if (!email) {
    res.status(401).json({ code: 'unauthorized' });
    return;
  }

  const merchantService = new MerchantService();
  const buyer = await merchantService.getMerchantByEmail(email);
  if (!buyer) {
    res.status(404).json({ code: 'no_buyer_profile' });
    return;
  }
  if ((buyer.accountType ?? 'merchant') !== 'buyer') {
    res.status(400).json({ code: 'wrong_account_type', message: 'Merchants connect crypto via /onboarding' });
    return;
  }

  const { walletAddress } = parsed.data;

  // 0. Uniqueness check — a wallet can only be linked to one account
  const existingWalletOwner = await merchantService.getMerchantByWallet(walletAddress);
  if (existingWalletOwner && existingWalletOwner.merchantId !== buyer.merchantId) {
    res.status(409).json({
      code: 'wallet_already_linked',
      message: 'This wallet is already connected to a different Delegare account. Disconnect it there first.',
    });
    return;
  }

  // 2. Create the funny-handle merchant row so this buyer becomes P2P-receivable.
  //    Lazy import to avoid a controller-level cycle through generateMerchantName.
  const { generateMerchantName } = await import('../lib/names');
  const merchantHandle = generateMerchantName(walletAddress);
  await merchantService.upsertAutoMerchant(merchantHandle, walletAddress, email);

  // 1. Update the buyer's row with the wallet AND sync the handle so
  //    profile-by-handle lookups (/:handle route) resolve correctly.
  await ddb.send(new UpdateCommand({
    TableName: TABLE.MERCHANTS,
    Key: { merchantId: buyer.merchantId },
    UpdateExpression: 'SET usdcWalletAddress = :w, merchantHandle = :h, updatedAt = :now',
    ExpressionAttributeValues: { ':w': walletAddress, ':h': merchantHandle, ':now': new Date().toISOString() },
  }));

  // 3. Patch every active mandate for this buyer to add the wallet + flip rail to 'both'
  const activeMandates = await credentialService.findActiveMandatesByOwnerId(buyer.merchantId);
  for (const m of activeMandates) {
    await credentialService.addPaymentMethodToMandate(m.mandateId, {
      smartWalletAddress: walletAddress,
    });
  }

  res.status(200).json({
    walletAddress,
    merchantHandle,
    patchedMandateCount: activeMandates.length,
  });
}

/**
 * Client-side fallback for completing a buyer card setup when the Stripe
 * webhook hasn't fired (yet). This is idempotent — if the webhook already
 * issued the mandate, we just return the existing mandate.
 */
export async function completeBuyerSetup(req: Request, res: Response): Promise<void> {
  const { sessionToken } = req.params;
  const email = (req as any).cognitoEmail;
  if (!email) {
    res.status(401).json({ code: 'unauthorized' });
    return;
  }

  const session = await credentialService.getSetupSession(sessionToken);
  if (!session) {
    res.status(404).json({ code: 'not_found', message: 'Setup session not found' });
    return;
  }

  // Already completed — return the existing mandate
  if (session.status === 'complete' && session.mandateId) {
    res.json({ status: 'complete', mandateId: session.mandateId });
    return;
  }

  if (session.status !== 'pending') {
    res.status(400).json({ code: 'invalid_session', message: `Session is ${session.status}` });
    return;
  }

  // Look up the buyer profile
  const merchantService = new MerchantService();
  const buyer = await merchantService.getMerchantByEmail(email);
  if (!buyer || (buyer.accountType ?? 'merchant') !== 'buyer') {
    res.status(400).json({ code: 'wrong_account_type', message: 'Buyer profile required' });
    return;
  }

  // Check if the buyer has a payment method attached (Stripe checkout succeeded)
  if (!buyer.stripeBuyerCustomerId || !buyer.stripeBuyerPaymentMethodId) {
    // The Stripe checkout may not have completed yet or the webhook hasn't run.
    // Try to resolve from the Stripe Checkout Session metadata.
    try {
      const stripe = await getStripeForBuyer();
      // List recent checkout sessions for this customer
      const sessions = await stripe.checkout.sessions.list({
        customer: buyer.stripeBuyerCustomerId || undefined,
        limit: 5,
      });
      const matched = sessions.data.find(
        s => s.metadata?.delegareSessionToken === sessionToken && s.status === 'complete'
      );
      if (matched) {
        // Trigger the same logic as the webhook
        const { handleBuyerCardSetupCompleted } = await import('../webhooks/StripeWebhookHandler');
        await handleBuyerCardSetupCompleted(matched, stripe);
        const updated = await credentialService.getSetupSession(sessionToken);
        res.json({ status: 'complete', mandateId: updated?.mandateId });
        return;
      }
    } catch (err) {
      console.error('[completeBuyerSetup] Stripe fallback failed', err);
    }

    res.status(202).json({ status: 'pending', message: 'Waiting for payment method confirmation' });
    return;
  }

  // Buyer has a payment method but mandate wasn't issued — issue it now
  try {
    const mandate = await credentialService.issueIntentMandate({
      sessionToken,
      ownerId: buyer.merchantId,
      stripeCustomerId: buyer.stripeBuyerCustomerId,
      stripePaymentMethodId: buyer.stripeBuyerPaymentMethodId,
      stripePaymentMethodLast4: buyer.stripeBuyerPaymentMethodLast4,
    });
    res.json({ status: 'complete', mandateId: mandate.mandateId });
  } catch (err: any) {
    console.error('[completeBuyerSetup] issueIntentMandate failed', err);
    res.status(500).json({ code: 'mandate_error', message: err.message });
  }
}

export async function getSetupSession(req: Request, res: Response): Promise<void> {
  const { sessionToken } = req.params;
  const session = await credentialService.getSetupSession(sessionToken);

  if (!session) {
    res.status(404).json({ code: 'not_found', message: 'Setup session not found' });
    return;
  }

  res.json({
    status: session.status,
    intentMandate: session.mandateId,
    encodedMandate: session.encodedMandate,
    maskedPaymentMethods: [], // populated by setup UI flow
    maxPerTxCents: session.maxPerTxCents,
    maxMonthlySpendCents: session.maxMonthlySpendCents,
  });
}

export async function getMandateBalance(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  
  let targetId = id;

  // If the agent passed the full encoded SD-JWT-VC intent mandate instead of the raw mandateId,
  // we must parse it to extract the actual database mandateId.
  if (id.split('.').length === 3) {
    try {
      const activeMandate = await credentialService.verifyIntentMandate(id);
      targetId = activeMandate.mandateId;
    } catch (err: any) {
      res.status(401).json({ code: 'invalid_mandate', message: err.message });
      return;
    }
  }

  const view = await credentialService.getMandateView(targetId);

  if (!view) {
    res.status(404).json({ code: 'not_found', message: 'Mandate not found' });
    return;
  }

  const paymentMethods = [];
  if (view.stripePaymentMethodLast4) {
    paymentMethods.push({ rail: 'fiat', display: `Card ••${view.stripePaymentMethodLast4}`, status: 'active' });
  }
  if (view.smartWalletAddress) {
    paymentMethods.push({
      rail: 'crypto',
      display: `USDC/USDT on Base (${view.smartWalletAddress.slice(0, 6)}…${view.smartWalletAddress.slice(-4)})`,
      status: 'active',
    });
  }

  res.json({
    remainingMonthlyBudgetCents: view.maxMonthlySpendCents - view.currentMonthSpendCents,
    monthlyLimitCents: view.maxMonthlySpendCents,
    spentThisMonthCents: view.currentMonthSpendCents,
    spentByRail: { fiat: { spentCents: 0, transactions: 0 }, crypto: { spentCents: 0, transactions: 0 } },
    paymentMethods,
    railPreference: view.railPreference,
    status: view.status,
    expiresAt: view.expiresAt,
  });
}

export async function rotateMandate(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  try {
    const newMandate = await credentialService.rotateMandate(id);
    res.json({ success: true, intentMandate: newMandate, rotatedAt: new Date().toISOString() });
  } catch (err: any) {
    if (err.message.includes('not found')) {
      res.status(404).json({ code: 'not_found', message: err.message });
      return;
    }
    throw err;
  }
}

export async function listBuyerMandates(req: Request, res: Response): Promise<void> {
  const ownerId = (req as any).merchantId; // buyer's merchantId is the ownerId on mandates
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);

  const { ddb, TABLE } = await import('../lib/dynamodb');
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.MANDATES,
      IndexName: 'ownerIdIndex',
      KeyConditionExpression: 'ownerId = :oid',
      ExpressionAttributeValues: { ':oid': ownerId },
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  res.json({ items: result.Items ?? [], count: result.Count ?? 0 });
}

export async function listMerchantMandates(req: Request, res: Response): Promise<void> {
  const merchantId = (req as any).merchantId;
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);

  const { ddb, TABLE } = await import('../lib/dynamodb');
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.MANDATES,
      IndexName: 'merchantIndex',
      KeyConditionExpression: 'merchantId = :mid',
      ExpressionAttributeValues: { ':mid': merchantId },
      Limit: limit,
    }),
  );

  res.json({ items: result.Items ?? [], count: result.Count ?? 0 });
}

export async function revokeMandate(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    await credentialService.revokeMandate(id);
    res.json({ success: true, revokedAt: new Date().toISOString() });
  } catch (err: unknown) {
    const awsErr = err as { name?: string };
    if (awsErr.name === 'ConditionalCheckFailedException') {
      res.status(404).json({ code: 'not_found', message: 'Mandate not found' });
      return;
    }
    throw err;
  }
}
