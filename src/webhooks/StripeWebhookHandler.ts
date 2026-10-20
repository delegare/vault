import { Request, Response } from 'express';
import Stripe from 'stripe';
import { UpdateCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret, vaultSecretId } from '../lib/secrets';
import { ddb, TABLE } from '../lib/dynamodb';
import { EmailService } from '../services/EmailService';
import { CredentialService } from '../services/CredentialService';
import { MerchantService } from '../controllers/MerchantController';
import { logger } from '../lib/logger';

async function getStripeInstance(isTestMode: boolean = false): Promise<Stripe> {
  const secrets = await getSecret(vaultSecretId());
  let keyName = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
  let apiKey = secrets[keyName] ?? process.env[keyName] ?? '';

  if (!isTestMode && (!apiKey || apiKey === 'placeholder')) {
    keyName = 'STRIPE_TEST_SECRET_KEY';
    apiKey = secrets[keyName] ?? process.env[keyName] ?? '';
    console.warn(`[Stripe] Using ${keyName} because live key is missing or a placeholder`);
  }

  if (!apiKey || apiKey === 'placeholder') {
    throw new Error(`Missing or invalid ${keyName} in environment or secrets`);
  }

  // Safety check: ensure the key matches the mode to avoid "Authorization code does not belong to you"
  const isTestKey = apiKey.startsWith('sk_test_');
  if (isTestMode && !isTestKey) {
    throw new Error(`Stripe mode mismatch: requested TEST mode but ${keyName} is a LIVE key`);
  }
  if (!isTestMode && isTestKey) {
    console.warn(`[Stripe] mode mismatch: received LIVE code but backend only has a TEST key in ${keyName}`);
  }

  return new Stripe(apiKey, { apiVersion: '2024-12-18.acacia' as any });
}

// ── Stripe event webhook ──────────────────────────────────────────────────

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const secrets = await getSecret(vaultSecretId());
  
  // We can loosely parse the JSON first to check `livemode`, then strictly verify the signature.
  let isTestMode = false;
  try {
    const rawPayload = req.body.toString('utf8');
    const parsed = JSON.parse(rawPayload);
    isTestMode = parsed.livemode === false;
  } catch (err) {
    // Ignore, let the strict stripe.webhooks.constructEvent handle parsing errors
  }

  const webhookSecret = isTestMode ? (secrets['STRIPE_TEST_WEBHOOK_SECRET'] ?? '') : (secrets['STRIPE_WEBHOOK_SECRET'] ?? '');
  const stripe = await getStripeInstance(isTestMode);

  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).json({ code: 'missing_signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    // req.body must be the raw buffer — mounted before json() middleware
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
  } catch {
    res.status(400).json({ code: 'invalid_signature' });
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // Buyer card-on-file flow: Checkout Session in mode='setup' completed.
      // Attach the resulting PaymentMethod to the Customer and issue the AP2
      // intent mandate so the buyer's agent can spend off-session.
      const checkoutSession = event.data.object as Stripe.Checkout.Session;
      if (checkoutSession.mode === 'setup' && checkoutSession.metadata?.delegareFlow === 'buyer_card_setup') {
        try {
          logger.info({ sessionToken: checkoutSession.metadata?.delegareSessionToken, buyerMerchantId: checkoutSession.metadata?.delegareBuyerMerchantId }, '[StripeWebhook] Processing buyer_card_setup');
          await handleBuyerCardSetupCompleted(checkoutSession, stripe);
          logger.info({ sessionToken: checkoutSession.metadata?.delegareSessionToken }, '[StripeWebhook] buyer_card_setup completed successfully');
        } catch (err: any) {
          logger.error({ err, sessionToken: checkoutSession.metadata?.delegareSessionToken, message: err?.message, stack: err?.stack }, '[StripeWebhook] buyer_card_setup completion failed');
        }
      }
      break;
    }
    case 'payment_intent.succeeded': {
      const intent = event.data.object as Stripe.PaymentIntent;
      const tx = await updateTransactionByStripeId(intent.id, 'completed');
      // Send receipt for payments that were pending at charge time (e.g. bank debits)
      if (tx?.ownerEmail) {
        void EmailService.sendReceipt({
          toEmail: tx.ownerEmail as string,
          amountCents: tx.amountCents as number,
          merchantName: tx.merchantName as string,
          description: tx.description as string,
          receiptId: tx.receiptId as string,
        });
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object as Stripe.PaymentIntent;
      await updateTransactionByStripeId(
        intent.id,
        'failed',
        intent.last_payment_error?.message,
      );
      break;
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
      if (!chargeId) break;

      // Find the payment intent from the charge
      let piId: string | undefined;
      try {
        const stripeClient = await getStripeInstance(isTestMode);
        const chargeObj = await stripeClient.charges.retrieve(chargeId);
        piId = typeof chargeObj.payment_intent === 'string' ? chargeObj.payment_intent : chargeObj.payment_intent?.id;
      } catch (err) {
        console.error('Failed to retrieve charge for dispute', err);
      }

      if (piId) {
        await revokeDelegateOnDispute(piId);
      }
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}

export async function handleBuyerCardSetupCompleted(
  checkoutSession: Stripe.Checkout.Session,
  stripe: Stripe,
): Promise<void> {
  const sessionToken = checkoutSession.metadata?.delegareSessionToken;
  const buyerMerchantId = checkoutSession.metadata?.delegareBuyerMerchantId;
  if (!sessionToken || !buyerMerchantId) {
    throw new Error('Missing delegare metadata on checkout session');
  }

  // 1. Resolve the SetupIntent → PaymentMethod
  const setupIntentId = typeof checkoutSession.setup_intent === 'string'
    ? checkoutSession.setup_intent
    : checkoutSession.setup_intent?.id;
  if (!setupIntentId) throw new Error('No setup_intent on checkout session');

  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  const paymentMethodId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;
  if (!paymentMethodId) throw new Error('SetupIntent has no payment_method');

  const customerId = typeof checkoutSession.customer === 'string'
    ? checkoutSession.customer
    : checkoutSession.customer?.id;
  if (!customerId) throw new Error('Checkout session has no customer');

  // 2. Make this PM the default for off-session charges
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  // 3. Fetch card details for display (last4)
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const last4 = pm.card?.last4 ?? pm.link?.email ?? undefined;

  // 4. Persist on the buyer's MerchantAccount row
  await ddb.send(new UpdateCommand({
    TableName: TABLE.MERCHANTS,
    Key: { merchantId: buyerMerchantId },
    UpdateExpression: 'SET stripeBuyerCustomerId = :cid, stripeBuyerPaymentMethodId = :pm, stripeBuyerPaymentMethodLast4 = :l4, updatedAt = :now',
    ExpressionAttributeValues: {
      ':cid': customerId,
      ':pm': paymentMethodId,
      ':l4': last4,
      ':now': new Date().toISOString(),
    },
  }));

  // 5. Either patch an existing mandate (add-rail flow from buyer dashboard)
  //    or issue a new one (first-time onboarding from /setup cold-start).
  //
  //    PaymentRouter only needs `stripeCustomerId` + `stripePaymentMethodId`
  //    populated to see `hasFiat = true`, so a patched mandate works
  //    identically to a freshly issued one.
  const credentialService = new CredentialService();
  const session = await credentialService.getSetupSession(sessionToken);
  logger.info({ sessionToken, sessionFound: !!session, sessionStatus: session?.status, sessionMode: session?.mode }, '[StripeWebhook] Setup session lookup');

  // Idempotency: if the session was already completed (e.g. by the
  // completeBuyerSetup fallback endpoint), skip mandate creation.
  if (session?.status === 'complete') {
    logger.info({ sessionToken, mandateId: session.mandateId }, '[StripeWebhook] Session already complete, skipping');
    return;
  }

  const isAddRail = session?.mode === 'add_rail';

  if (isAddRail) {
    // Patch every active mandate this buyer owns. Usually just one.
    const activeMandates = await credentialService.findActiveMandatesByOwnerId(buyerMerchantId);
    const targetIds = session?.targetMandateId
      ? [session.targetMandateId]
      : activeMandates.map(m => m.mandateId);

    for (const mandateId of targetIds) {
      await credentialService.addPaymentMethodToMandate(mandateId, {
        stripeCustomerId: customerId,
        stripePaymentMethodId: paymentMethodId,
        stripePaymentMethodLast4: last4,
      });
    }

    // Mark the session complete so it can't be reused.
    await ddb.send(new UpdateCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Key: { sessionToken },
      UpdateExpression: 'SET #st = :comp, completedAt = :now',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':comp': 'complete', ':now': new Date().toISOString() },
    }));
  } else {
    await credentialService.issueIntentMandate({
      sessionToken,
      ownerId: buyerMerchantId,
      stripeCustomerId: customerId,
      stripePaymentMethodId: paymentMethodId,
      stripePaymentMethodLast4: last4,
    });
  }
}

async function revokeDelegateOnDispute(stripePaymentIntentId: string): Promise<void> {
  // Query the Transactions table by GSI or fallback to full scan (simplified for now, 
  // ideally add a GSI on stripePaymentIntentId if high volume)
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE.TRANSACTIONS,
    IndexName: 'stripePaymentIntentIndex', // We need to add this index to DynamoDB or just scan for the prototype
  })).catch(() => null); 
  
  // Since we don't have a GSI on stripePaymentIntentId yet, we will do a scan for the prototype
  // In production, you MUST use a GSI.
  const scanResult = await ddb.send(new ScanCommand({
    TableName: TABLE.TRANSACTIONS,
    FilterExpression: 'stripePaymentIntentId = :pi',
    ExpressionAttributeValues: { ':pi': stripePaymentIntentId },
    Limit: 1
  }));

  const log = scanResult.Items?.[0];
  if (log && log.mandateId) {
    const { CredentialService } = await import('../services/CredentialService');
    const credentialService = new CredentialService();
    await credentialService.revokeMandate(log.mandateId);
    console.warn(`[Dispute Automation] Revoked mandate ${log.mandateId} due to Stripe dispute on ${stripePaymentIntentId}`);
  }
}

/**
 * Transitions a pending transaction to completed/failed based on a Stripe webhook.
 * Returns the transaction item if the transition actually happened (was pending),
 * or null if it was already in a terminal state (idempotent / duplicate webhook).
 */
async function updateTransactionByStripeId(
  stripePaymentIntentId: string,
  status: 'completed' | 'failed',
  failureReason?: string,
): Promise<Record<string, any> | null> {
  // Query the stripeIntentIndex GSI to find the receipt
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.TRANSACTIONS,
      IndexName: 'stripeIntentIndex',
      KeyConditionExpression: 'stripePaymentIntentId = :id',
      ExpressionAttributeValues: { ':id': stripePaymentIntentId },
      Limit: 1,
    }),
  );

  const item = result.Items?.[0];
  if (!item) return null;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.TRANSACTIONS,
        Key: { receiptId: item['receiptId'] as string },
        UpdateExpression: 'SET #status = :status, completedAt = :now' +
          (failureReason ? ', failureReason = :reason' : ''),
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status,
          ':pending': 'pending',
          ':now': new Date().toISOString(),
          ...(failureReason ? { ':reason': failureReason } : {}),
        },
      }),
    );
    return item; // transition happened
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') return null; // already terminal — no-op
    throw err;
  }
}

// ── Stripe Connect OAuth callback ─────────────────────────────────────────

const delegateService = new CredentialService();

/**
 * Handles the OAuth redirect from Stripe after a user connects their account.
 * URL: GET /v1/webhooks/stripe-connect/callback?code=...&state=<sessionToken>
 *
 * Configure in Stripe Dashboard → Connect → OAuth settings:
 *   Redirect URI: https://api.delegare.dev/v1/webhooks/stripe-connect/callback
 */
export async function handleStripeConnectCallback(req: Request, res: Response): Promise<void> {
  const { code, state: sessionToken, error } = req.query as Record<string, string>;

  const setupUiUrl = process.env.SETUP_UI_URL ?? 'https://app.delegare.dev';

  if (error) {
    console.error('[StripeConnect] OAuth error', { error });
    res.redirect(`${setupUiUrl}/setup/error?reason=stripe_oauth_denied`);
    return;
  }

  if (!code || !sessionToken) {
    res.redirect(`${setupUiUrl}/setup/error?reason=missing_parameters`);
    return;
  }

  // If this is a merchant connecting Stripe, we do NOT validate a setup session
  if (sessionToken.startsWith('merchant_')) {
    // Determine if this is a test mode connection by checking the prefix of the code
    const isTestMode = code.startsWith('ac_test_');
    const stripe = await getStripeInstance(isTestMode);

    console.info(`[StripeConnect] Exchanging code for merchant. Mode: ${isTestMode ? 'test' : 'live'}. Code: ${code.substring(0, 10)}...`);

    // Exchange code for connected account credentials
    let oauthResponse: Stripe.OAuthToken;
    try {
      oauthResponse = await stripe.oauth.token({ grant_type: 'authorization_code', code });
    } catch (err: any) {
      console.error('[StripeConnect] Token exchange failed', {
        error: err.message,
        type: err.type,
        code: err.code,
        requestId: err.requestId,
        isTestMode
      });
      res.redirect(`${setupUiUrl}/onboarding?error=stripe_token_exchange_failed&reason=${encodeURIComponent(err.message)}`);
      return;
    }

    const connectedAccountId = oauthResponse.stripe_user_id;
    if (!connectedAccountId) {
      res.redirect(`${setupUiUrl}/onboarding?error=no_account_id`);
      return;
    }

    // Verify the connected account has the `transfers` capability.
    // For Standard Connect accounts (OAuth), capabilities are inherited from
    // what the PLATFORM has enabled under Stripe Dashboard → Connect → Settings.
    // We cannot grant them via API — the platform owner must enable them once
    // in the Stripe Dashboard (test mode: https://dashboard.stripe.com/test/settings/connect).
    // We log the status here so ops can diagnose capability issues immediately
    // at connect time rather than at first charge.
    try {
      const account = await stripe.accounts.retrieve(connectedAccountId);
      const caps = (account as any).capabilities ?? {};
      const hasTransfers = caps.transfers === 'active' || caps.legacy_payments === 'active';
      if (!hasTransfers) {
        console.warn(
          `[StripeConnect] Account ${connectedAccountId} is missing 'transfers' capability ` +
          `(current: ${JSON.stringify(caps)}). ` +
          `Enable it in Stripe Dashboard → Connect → Settings → Capabilities, ` +
          `or the merchant's payouts will fail at charge time.`,
        );
      } else {
        console.info(`[StripeConnect] Account ${connectedAccountId} has transfers capability ✓`);
      }
    } catch (capErr: any) {
      console.warn(`[StripeConnect] Could not retrieve account ${connectedAccountId}: ${capErr.message}`);
    }

    const merchantId = sessionToken.split('_').slice(1).join('_');
    try {
      await new MerchantService().updateStripeAccount(merchantId, connectedAccountId);

      // Auto-populate the offramp bank account ID from the connected account's
      // external accounts. This means the merchant never has to manually enter a
      // ba_... ID — it's fetched automatically at connect time.
      try {
        const externalAccounts = await stripe.accounts.listExternalAccounts(
          connectedAccountId,
          { object: 'bank_account', limit: 1 },
        );
        const firstBank = externalAccounts.data[0] as Stripe.BankAccount | undefined;
        if (firstBank?.id && firstBank.status !== 'errored') {
          await ddb.send(new UpdateCommand({
            TableName: TABLE.MERCHANTS,
            Key: { merchantId },
            UpdateExpression: 'SET autoOfframpBankAccountId = :bankId, updatedAt = :now',
            ExpressionAttributeValues: {
              ':bankId': firstBank.id,
              ':now': new Date().toISOString(),
            },
          }));
          console.info(`[StripeConnect] Auto-populated offramp bank account ${firstBank.id} (${firstBank.bank_name} ****${firstBank.last4})`);
        }
      } catch (bankErr: any) {
        // Non-fatal — merchant can enter bank account ID manually in dashboard
        console.warn(`[StripeConnect] Could not auto-fetch external bank accounts: ${bankErr.message}`);
      }

      // Redirect back to the dashboard root
      res.redirect(`${setupUiUrl}/`);
    } catch (err) {
      console.error('[StripeConnect] Merchant update failed', err);
      res.redirect(`${setupUiUrl}/onboarding?error=merchant_update_failed`);
    }
    return;
  }

  // Otherwise, Handle Delegate Setup Flow (Buyer connecting card)
  const session = await delegateService.getSetupSession(sessionToken);
  if (!session || session.status !== 'pending') {
    res.redirect(`${setupUiUrl}/setup/error?reason=session_expired`);
    return;
  }

  const isTestMode = code.startsWith('ac_test_');
  const stripe = await getStripeInstance(isTestMode);

  // Exchange code for connected account credentials
  let oauthResponse: Stripe.OAuthToken;
  try {
    oauthResponse = await stripe.oauth.token({ grant_type: 'authorization_code', code });
  } catch (err) {
    console.error('[StripeConnect] Token exchange failed', err);
    res.redirect(`${setupUiUrl}/setup/error?reason=stripe_token_exchange_failed`);
    return;
  }

  const connectedAccountId = oauthResponse.stripe_user_id;
  if (!connectedAccountId) {
    res.redirect(`${setupUiUrl}/setup/error?reason=no_account_id`);
    return;
  }

  // Create a customer on the connected account and attach default payment method
  const stripeConnected = await getStripeInstance(isTestMode);

  const customer = await stripeConnected.customers.create(
    {
      description: `Delegare delegate — session ${sessionToken}`,
      metadata: { sessionToken, delegareEnv: process.env.ENVIRONMENT ?? 'dev' },
    },
    { stripeAccount: connectedAccountId }
  );

  // Get the default payment method (setup intent would be better for card on file)
  // For now, use the first payment method on the connected account
  const paymentMethods = await stripeConnected.paymentMethods.list(
    {
      customer: customer.id,
      type: 'card',
      limit: 1,
    },
    { stripeAccount: connectedAccountId }
  );

  const paymentMethod = paymentMethods.data[0];

  // Create the delegate now that we have Stripe credentials
  await delegateService.issueIntentMandate({
    sessionToken,
    ownerId: `stripe_${connectedAccountId}`,
    stripeCustomerId: customer.id,
    stripePaymentMethodId: paymentMethod?.id,
    stripePaymentMethodLast4: (paymentMethod?.card?.last4) ?? undefined,
  });

  // Redirect to dashboard root on completion
  res.redirect(`${setupUiUrl}/`);
}
