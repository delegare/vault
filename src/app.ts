import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore
import { mcp as mcpMiddleware } from '@delegare/mcp-server/middleware';
// @ts-ignore
import mcpServer from '@delegare/mcp-server';

import { logger, httpLogger } from './lib/logger';
import { authenticateMerchant, authenticateCognito } from './middleware/auth';
import { authenticateAdmin } from './middleware/adminAuth';
import { ssrfGuard } from './middleware/ssrfGuard';
import { defaultRateLimit, chargeRateLimit, delegateChargeRateLimit } from './middleware/rateLimiter';
import {
  createSetupSession,
  createSelfServiceSetupSession,
  createBuyerCardCheckout,
  addBuyerWallet,
  completeBuyerSetup,
  getSetupSession,
  getMandateBalance,
  revokeMandate,
  rotateMandate,
} from './controllers/MandateController';
import { charge, getReceipt, refund } from './controllers/PaymentController';
import { createMerchant, getMerchantStats, getMerchantTransactions, getMyMerchant, registerMyMerchant, rotateMyMerchantApiKey, getMerchantPublicProfile, updateMerchant, registerPartnerMerchant } from './controllers/MerchantController';
import { verifyX402, verifyX402ReceiptController, settleX402 } from './controllers/X402Controller';
import { initiateOfframpHandler, initiateOnrampHandler, getRampHistory, listBankAccounts } from './controllers/RampController';
import { connectWallet } from './controllers/WalletController';
import { handleStripeWebhook, handleStripeConnectCallback } from './webhooks/StripeWebhookHandler';
import { handleOnchainEvent } from './webhooks/OnchainEventListener';
import { OAuthController } from './controllers/OAuthController';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from './lib/dynamodb';
import { startWebhookWorker } from './workers/WebhookWorker';
import { DidService } from './services/DidService';
import { DiscoveryService } from './services/DiscoveryService';
import cors from 'cors';

const app = express();

// ── Logging ───────────────────────────────────────────────────────────────
app.use(httpLogger);


// ── CORS ──────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    // Match both the apex domain AND any subdomain. `.endsWith('.delegare.dev')`
    // alone would only match subdomains (app.delegare.dev, api.delegare.dev),
    // not the bare apex `https://delegare.dev` used by the marketing site +
    // the public @handle profile pages.
    const allowedHosts = ['delegare.dev', 'delegare.co'];
    const matchesAllowedHost = allowedHosts.some(host =>
      origin === `https://${host}` || origin === `http://${host}` || origin.endsWith(`.${host}`)
    );
    if (matchesAllowedHost || origin.endsWith('chatgpt.com') || origin.endsWith('.web-sandbox.oaiusercontent.com') || origin.endsWith('claude.ai') || origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Delegare-Merchant-Id', 'X-Delegare-Api-Key', 'X-Admin-Key']
}));

// ── Webhook routes — raw body required for Stripe signature verification ───
app.post(
  '/v1/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => { void handleStripeWebhook(req, res); },
);
app.get(
  '/v1/webhooks/stripe-connect/callback',
  (req, res) => { void handleStripeConnectCallback(req, res); },
);
app.post(
  '/v1/webhooks/onchain',
  express.json(),
  (req, res) => { void handleOnchainEvent(req, res); },
);

// ── Body parsers ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));

// ── SSRF guard — applied globally ──────────────────────────────────────────
app.use(ssrfGuard);

// ── Health check — unauthenticated ─────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: process.env.npm_package_version ?? '0.1.0' });
});

// ── OAuth Discovery (MCP Spec) ──────────────────────────────────────────────
app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  const baseUrl = process.env.API_BASE_URL || process.env.BASE_URL || 'https://api.delegare.dev';
  res.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ["pay", "balance", "revoke"],
    resource_documentation: "https://docs.delegare.dev/mcp"
  });
});

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const baseUrl = process.env.API_BASE_URL || process.env.BASE_URL || 'https://api.delegare.dev';
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/v1/oauth2/authorize`,
    token_endpoint: `${baseUrl}/v1/oauth2/token`,
    registration_endpoint: `${baseUrl}/v1/oauth2/register`,
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["pay", "balance", "revoke"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"]
  });
});

app.get('/.well-known/did.json', async (_req, res) => {
  const doc = await DidService.getDidDocument();
  res.json(doc);
});

app.get('/.well-known/jwks.json', async (_req, res) => {
  const jwks = await DidService.getJwks();
  res.json(jwks);
});

app.get('/.well-known/ap2-configuration', (_req, res) => {
  const baseUrl = process.env.API_BASE_URL || process.env.BASE_URL || 'https://api.delegare.dev';
  res.json({
    issuer: DidService.getPlatformDid(),
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    supported_mandate_types: ['intent', 'checkout', 'payment'],
    supported_rails: ['fiat', 'crypto'],
    supported_currencies: ['usd', 'usdc', 'usdt'],
    ap2_version: '1.0'
  });
});

app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json(DiscoveryService.getAgentCard());
});

app.get('/.well-known/ap2.json', (_req, res) => {
  res.json(DiscoveryService.getAp2Manifest());
});

// ── OpenAI Apps domain verification ─────────────────────────────────────────
// Must be public and unauthenticated — OpenAI fetches this to verify ownership
// of api.delegare.dev for the ChatGPT App submission. The token is public.
app.get('/.well-known/openai-apps-challenge', (_req, res) => {
  res.type('text/plain').send(
    process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? 'fx_caanrZ-UAktCR8aibSyU0Hy3C8h--IMDHQuV5jVY',
  );
});

// ── API v1 router ──────────────────────────────────────────────────────────
const v1 = express.Router();

// OAuth Endpoints
v1.post('/oauth2/register', (req, res) => { void OAuthController.register(req, res); });
v1.get('/oauth2/authorize', (req, res) => { void OAuthController.authorize(req, res); });
v1.post('/oauth2/token', (req, res) => { void OAuthController.token(req, res); });
v1.post('/oauth2/approve', authenticateCognito, (req, res) => { void OAuthController.approve(req, res); });

// Merchant Authentication
v1.get('/auth/me', authenticateCognito, (req, res) => {
  void getMyMerchant(req, res);
});
v1.post('/auth/me', authenticateCognito, (req, res) => {
  void registerMyMerchant(req, res);
});
// Rotate the caller's live API key. Returns the new plaintext key exactly once.
v1.post('/auth/me/rotate-key', authenticateCognito, (req, res) => {
  void rotateMyMerchantApiKey(req, res);
});
v1.post('/auth/me/setup-session', authenticateCognito, (req, res) => {
  void createSelfServiceSetupSession(req, res);
});
// Buyer-only: Stripe Checkout in setup mode (saves card-on-file for off-session
// charges later). NOT Stripe Connect — buyers don't run businesses.
//
// IMPORTANT: use `.catch(next)` rather than `void` so unhandled rejections
// become proper 500 responses (with CORS headers) instead of hanging the
// request until ALB returns a header-less 502. The CORS middleware only
// attaches headers to responses that actually flow through Express; a dead
// request bubbles up as ELB's HTML error page and the browser reports it as
// a misleading CORS failure.
v1.post('/auth/me/payment-method/checkout', authenticateCognito, (req, res, next) => {
  createBuyerCardCheckout(req, res).catch(next);
});

v1.post('/payment-method/checkout', defaultRateLimit, (req, res, next) => {
  // Unauthenticated flow — uses auto-crypto email or fetches ownerEmail from
  // the session record if missing.
  createBuyerCardCheckout(req, res).catch(next);
});
// Buyer-only: attach a USDC wallet (also creates funny @handle for P2P receive).
v1.post('/auth/me/payment-method/wallet', authenticateCognito, (req, res, next) => {
  addBuyerWallet(req, res).catch(next);
});
// Disconnect a payout method (Stripe or USDC wallet)
v1.delete('/auth/me/payout-method/:type', authenticateCognito, async (req, res) => {
  const email = (req as any).cognitoEmail;
  const { type } = req.params;
  if (!email) return res.status(401).json({ code: 'unauthorized' });

  try {
    const { MerchantService } = await import('./controllers/MerchantController');
    const merchantService = new MerchantService();
    const merchant = await merchantService.getMerchantByEmail(email);
    if (!merchant) return res.status(404).json({ code: 'not_found' });

    const { ddb, TABLE } = await import('./lib/dynamodb');
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

    let updateExpression = '';
    const isBuyerAccount = (merchant.accountType ?? 'merchant') === 'buyer';

    if (type === 'stripe') {
      // Buyers store card details in buyer-specific fields; merchants use stripeConnectedAccountId
      updateExpression = isBuyerAccount
        ? 'REMOVE stripeBuyerCustomerId, stripeBuyerPaymentMethodId, stripeBuyerPaymentMethodLast4'
        : 'REMOVE stripeConnectedAccountId';
    } else if (type === 'crypto' || type === 'usdc') {
      // Always clear the wallet; also clear the P2P handle for buyers since it's wallet-derived
      updateExpression = isBuyerAccount
        ? 'REMOVE usdcWalletAddress, merchantHandle'
        : 'REMOVE usdcWalletAddress';
    } else {
      return res.status(400).json({ code: 'invalid_type', message: 'Type must be stripe or crypto' });
    }

    await ddb.send(new UpdateCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId: merchant.merchantId },
      UpdateExpression: updateExpression,
    }));

    res.json({ success: true });
  } catch (err: any) {
    console.error('[disconnect-payout-method]', err);
    res.status(500).json({ code: 'internal_error', message: err.message });
  }
});
// Buyer-only: enable spending on an already-connected wallet.
// Creates a self-service setup session → mandate → session key in one shot.
// The frontend then uses the returned sessionKeyAddress for on-chain authorization.
v1.post('/auth/me/spending/enable', authenticateCognito, async (req, res) => {
  try {
    const email = (req as any).cognitoEmail;
    if (!email) return res.status(401).json({ code: 'unauthorized' });

    const { MerchantService } = await import('./controllers/MerchantController');
    const merchantService = new MerchantService();
    const buyer = await merchantService.getMerchantByEmail(email);
    if (!buyer) return res.status(404).json({ code: 'no_buyer_profile' });
    if ((buyer.accountType ?? 'merchant') !== 'buyer') {
      return res.status(400).json({ code: 'wrong_account_type' });
    }
    if (!buyer.usdcWalletAddress) {
      return res.status(400).json({ code: 'no_wallet', message: 'Connect a wallet first via /auth/me/payment-method/wallet' });
    }

    const maxPerTxCents = req.body?.maxPerTxCents ?? 5000;   // $50 default
    const maxMonthlyCents = req.body?.maxMonthlyCents ?? 50000; // $500 default

    const { CredentialService } = await import('./services/CredentialService');
    const credentialService = new CredentialService();

    // 1. Create a self-service setup session
    const session = await credentialService.createSelfServiceSetupSession({
      ownerEmail: email,
      maxPerTxCents,
      maxMonthlyCents,
      rail: 'crypto',
    });

    // 2. Issue a mandate from this session
    const mandate = await credentialService.issueIntentMandate({
      sessionToken: session.sessionToken,
      ownerId: buyer.merchantId,
      ownerEmail: email,
      smartWalletAddress: buyer.usdcWalletAddress,
    });

    // 3. Generate a session key for autonomous spending
    const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
    const { encryptSessionKey } = await import('./services/SessionKeyVault');
    const { ddb: ddbClient, TABLE: TABLE_CFG } = await import('./lib/dynamodb');
    const { UpdateCommand: Update } = await import('@aws-sdk/lib-dynamodb');

    const sessionKeyPrivate = generatePrivateKey();
    const sessionKeyAddress = privateKeyToAccount(sessionKeyPrivate).address;
    const isTestMode = process.env.ENVIRONMENT !== 'prod';
    const network = isTestMode ? 'base-sepolia' : 'base-mainnet';

    // KMS-encrypt and store on the mandate row (replaces per-mandate Secrets Manager entry)
    const encryptedSessionKey = await encryptSessionKey(sessionKeyPrivate, mandate.mandateId);

    await ddbClient.send(new Update({
      TableName: TABLE_CFG.MANDATES,
      Key: { mandateId: mandate.mandateId, userDid: mandate.userDid },
      UpdateExpression: 'SET encryptedSessionKey = :ek, sessionKeyNetwork = :n, sessionKeyAddress = :a, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ek': encryptedSessionKey,
        ':n': network,
        ':a': sessionKeyAddress,
        ':now': new Date().toISOString(),
      },
    }));

    res.status(201).json({
      mandateId: mandate.mandateId,
      sessionKeyAddress,
      maxPerTxCents,
      maxMonthlyCents,
      walletAddress: buyer.usdcWalletAddress,
    });
  } catch (err: any) {
    console.error('[enable-spending]', err);
    res.status(500).json({ code: 'internal_error', message: err.message });
  }
});
// Buyer-only: complete setup session (fallback when Stripe webhook hasn't fired).
v1.post('/auth/me/setup-sessions/:sessionToken/complete', authenticateCognito, (req, res) => {
  void completeBuyerSetup(req, res);
});
// Agent token provisioning — creates a long-lived Delegare access token for
// use in OpenClaw, MCP clients, or any agent that needs API access.
v1.post('/auth/me/agent-token', authenticateCognito, async (req, res) => {
  const email = (req as any).cognitoEmail;
  if (!email) return res.status(401).json({ error: 'unauthorized' });
  const { MerchantService } = await import('./controllers/MerchantController');
  const svc = new MerchantService();
  let merchant = await svc.getMerchantByEmail(email);

  // Auto-provision a buyer profile if this is a brand new user
  if (!merchant) {
    const { randomBytes } = await import('crypto');
    const buyerId = `buyer_${randomBytes(8).toString('hex')}`;
    await svc.upsertAutoMerchant(buyerId, buyerId, email);
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    const { ddb: db, TABLE: T } = await import('./lib/dynamodb');
    await db.send(new UpdateCommand({
      TableName: T.MERCHANTS,
      Key: { merchantId: buyerId },
      UpdateExpression: 'SET accountType = :buyer',
      ExpressionAttributeValues: { ':buyer': 'buyer' },
    }));
    merchant = await svc.getMerchantByEmail(email);
  }

  if (!merchant) return res.status(500).json({ error: 'failed_to_provision' });

  const { randomBytes } = await import('crypto');
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const { ddb: db, TABLE: T } = await import('./lib/dynamodb');
  const label = req.body?.label || 'agent';
  const ttlDays = Math.min(req.body?.ttlDays || 90, 365); // Max 1 year
  const accessToken = `token_${randomBytes(32).toString('hex')}`;

  await db.send(new PutCommand({
    TableName: T.SETUP_SESSIONS,
    Item: {
      sessionToken: accessToken,
      type: 'access_token',
      merchantId: merchant.merchantId,
      clientId: `agent_${label}`,
      label,
      ttl: Math.floor(Date.now() / 1000) + ttlDays * 86400,
    },
  }));

  res.status(201).json({
    accessToken,
    merchantId: merchant.merchantId,
    expiresInDays: ttlDays,
    label,
  });
});

v1.get('/auth/me/transactions', authenticateCognito, async (req, res) => {
  // Use the same logic as getMerchantTransactions, but use the cognito context
  const email = (req as any).cognitoEmail;
  if (!email) return res.status(401).json({ error: 'unauthorized' });
  const { MerchantService, getMerchantTransactions, getBuyerTransactions } = await import('./controllers/MerchantController');
  const merchant = await new MerchantService().getMerchantByEmail(email);
  if (!merchant) return res.status(404).json({ error: 'not_found' });

  const isBuyer = (merchant.accountType ?? 'merchant') === 'buyer';
  if (isBuyer) {
    req.params.ownerId = merchant.merchantId;
    void getBuyerTransactions(req, res);
  } else {
    // Inject the merchantId into req.params so the controller can handle it
    req.params.merchantId = merchant.merchantId;
    void getMerchantTransactions(req, res);
  }
});v1.get('/auth/me/mandates', authenticateCognito, async (req, res) => {
  const email = (req as any).cognitoEmail;
  if (!email) return res.status(401).json({ error: 'unauthorized' });
  const { MerchantService } = await import('./controllers/MerchantController');
  const merchant = await new MerchantService().getMerchantByEmail(email);
  if (!merchant) return res.status(404).json({ error: 'not_found' });

  const isBuyer = (merchant.accountType ?? 'merchant') === 'buyer';
  if (isBuyer) {
    // Buyers own mandates — query by ownerId
    const { listBuyerMandates } = await import('./controllers/MandateController');
    (req as any).merchantId = merchant.merchantId;
    void listBuyerMandates(req, res);
  } else {
    // Merchants receive mandates — query by merchantId
    (req as any).merchantId = merchant.merchantId;
    const { listMerchantMandates } = await import('./controllers/MandateController');
    void listMerchantMandates(req, res);
  }
});

// Merchant registration — admin key required
v1.get('/merchants/:merchantId', (req, res) => {
  void getMerchantPublicProfile(req, res);
});
v1.post('/merchants', authenticateAdmin, (req, res) => { void createMerchant(req, res); });
v1.post('/partners/register-merchant', authenticateAdmin, (req, res) => { void registerPartnerMerchant(req, res); });
v1.get('/merchants/:merchantId/stats', authenticateMerchant, (req, res) => {
  void getMerchantStats(req, res);
});
v1.get('/merchants/:merchantId/transactions', authenticateMerchant, (req, res) => {
  void getMerchantTransactions(req, res);
});
v1.patch('/merchants/:merchantId', authenticateMerchant, (req, res) => {
  void updateMerchant(req, res);
});

// One-shot endpoint: request `transfers` + `card_payments` capabilities on the
// merchant's already-linked Stripe connected account, without requiring a full
// OAuth re-connect.  Merchant-authenticated so only the account owner can call it.
v1.post('/merchants/:merchantId/stripe/request-capabilities', authenticateMerchant, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { MerchantService } = await import('./controllers/MerchantController');
    const merchant = await new MerchantService().getMerchant(merchantId);
    if (!merchant?.stripeConnectedAccountId) {
      res.status(400).json({ code: 'no_connected_account', message: 'No Stripe connected account on this merchant.' });
      return;
    }
    const { getSecret, vaultSecretId } = await import('./lib/secrets');
    const secrets = await getSecret(vaultSecretId());
    const isTestMode = process.env.ENVIRONMENT !== 'prod';
    const keyName = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_SECRET_KEY';
    const apiKey = secrets[keyName] ?? process.env[keyName] ?? '';
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(apiKey, { apiVersion: '2024-12-18.acacia' as any });
    await stripe.accounts.update(merchant.stripeConnectedAccountId, {
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    });
    logger.info({ merchantId, connectedAccountId: merchant.stripeConnectedAccountId }, '[Stripe] Capabilities requested');
    res.json({ ok: true, connectedAccountId: merchant.stripeConnectedAccountId });
  } catch (err: any) {
    logger.error({ err }, '[Stripe] Failed to request capabilities');
    res.status(500).json({ code: 'stripe_error', message: err.message });
  }
});

// Mandate lifecycle — merchant-authenticated
v1.post('/mandates', defaultRateLimit, authenticateMerchant, (req, res) => {
  void createSetupSession(req, res);
});
v1.get('/mandates', authenticateMerchant, (req, res) => {
  const { listMerchantMandates } = require('./controllers/MandateController');
  void listMerchantMandates(req, res);
});
v1.get('/setup-sessions/:sessionToken', authenticateMerchant, (req, res) => {
  void getSetupSession(req, res);
});
v1.get('/mandates/:id/balance', defaultRateLimit, authenticateMerchant, (req, res) => {
  void getMandateBalance(req, res);
});
v1.delete('/mandates/:id', authenticateMerchant, (req, res) => {
  void revokeMandate(req, res);
});
v1.post('/mandates/:id/rotate', authenticateMerchant, (req, res) => {
  void rotateMandate(req, res);
});

// Crypto Onboarding
v1.post('/wallets/connect', defaultRateLimit, (req, res, next) => {
  connectWallet(req, res).catch(next);
});

// Payment execution — tighter rate limit
v1.post('/payments/charge', chargeRateLimit, delegateChargeRateLimit, authenticateMerchant, (req, res, next) => {
  charge(req, res).catch(next);
});
v1.get('/payments/:receiptId', authenticateMerchant, (req, res, next) => {
  getReceipt(req, res).catch(next);
});
v1.post('/payments/:receiptId/refund', authenticateMerchant, (req, res) => {
  void refund(req, res);
});

// X402 Facilitator endpoints (public — payment payloads self-authenticate)
v1.post('/x402/verify', defaultRateLimit, (req, res) => {
  void verifyX402(req, res);
});
// Post-settlement receipt verification — distinct from /verify (which checks
// unsettled authorization payloads). Enforces resource/payTo/amount binding
// + TTL to prevent X-PAYMENT-RESPONSE replay across resources or merchants.
// See delegare/delegare#1.
v1.post('/x402/verify-receipt', defaultRateLimit, (req, res) => {
  void verifyX402ReceiptController(req, res);
});
v1.post('/x402/settle', defaultRateLimit, (req, res) => {
  void settleX402(req, res);
});

app.use('/v1', v1);
// ── MCP and Widgets ───────────────────────────────────────────────────────
// Provide a CommonJS-compatible __dirname replacement
const _dirname = path.resolve();

// Serve the widget web assets from the mcp-server package
// In production, we expect this to be built into node_modules/@delegare/mcp-server/dist/web
const webPathNodeModules = path.join(_dirname, '../node_modules/@delegare/mcp-server/dist/web');
const webPathLocal = path.join(process.cwd(), 'packages/mcp-server/dist/web');

// Skybridge production template generates URLs like /assets/assets/foo.js
// (hardcoded /assets/ prefix + manifest path which includes assets/ dir)
// So we mount dist/web at /assets to resolve /assets/assets/foo.js → dist/web/assets/foo.js
app.use('/assets', express.static(webPathNodeModules));
app.use('/assets', express.static(webPathLocal));
app.use(express.static(webPathNodeModules));
app.use(express.static(webPathLocal));

// ── MCP JSON-RPC fix for ChatGPT ──────────────────────────────────────────
// ChatGPT adds proprietary fields like "__nv_message_id" and "kind" to MCP messages
// which causes the standard MCP SDK to throw validation errors.
app.use('/mcp', (req, res, next) => {
  if (req.method === 'POST' && req.body) {
    const stripKeys = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(stripKeys);
        return;
      }
      delete obj.__nv_message_id;
      delete obj.kind;
      Object.values(obj).forEach(stripKeys);
    };
    stripKeys(req.body);
  }
  next();
});

// ── MCP Auth Guard ─────────────────────────────────────────────────────────
async function mcpAuthGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const isToolCall = req.body?.method === 'tools/call';
  if (!isToolCall) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  let isValid = false;
  let merchantId = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const result = await ddb.send(new GetCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Key: { sessionToken: token }
      }));
      if (result.Item && result.Item.type === 'access_token') {
        isValid = true;
        merchantId = result.Item.merchantId;
      }
    } catch (e) {
      // Ignore
    }
  }

  if (!isValid) {
    const baseUrl = process.env.API_BASE_URL || process.env.BASE_URL || 'https://api.delegare.dev';
    // Return HTTP 401 with WWW-Authenticate header per MCP OAuth spec.
    // Claude.ai requires this to trigger its built-in OAuth flow.
    res.status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`)
      .json({
        jsonrpc: "2.0",
        id: req.body?.id || null,
        error: {
          code: -32001,
          message: "Authentication required: no valid access token provided."
        }
      });
    return;
  }

  // Inject auth context into _meta (not top-level args) to avoid violating
  // additionalProperties:false in tool JSON Schemas — which causes the MCP SDK
  // to reject the entire args object and Zod to see all fields as undefined.
  if (req.body?.params?.arguments) {
    if (!req.body.params.arguments._meta) req.body.params.arguments._meta = {};
    req.body.params.arguments._meta.merchantId = merchantId;
    req.body.params.arguments._meta.oauthToken = authHeader ? authHeader.split(' ')[1] : undefined;
  }

  next();
}

// ── Ramp routes ───────────────────────────────────────────────────────────
v1.post('/ramp/offramp/initiate', authenticateMerchant, (req, res) => { void initiateOfframpHandler(req, res); });
v1.post('/ramp/onramp/initiate', authenticateMerchant, (req, res) => { void initiateOnrampHandler(req, res); });
v1.get('/ramp/history', authenticateMerchant, (req, res) => { void getRampHistory(req, res); });
v1.get('/ramp/bank-accounts', authenticateMerchant, (req, res) => { void listBankAccounts(req, res); });

// ── MCP protocol handler ──────────────────────────────────────────────────
app.post('/mcp', mcpAuthGuard, mcpMiddleware(mcpServer));

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'sandbox' || process.env.ENVIRONMENT === 'prod';
  if (!isProd && process.env.NODE_ENV !== 'test') {
    logger.info("Running in development mode, Vite middleware will be enabled for MCP UI.");
    try {
      // Force CORS headers to bypass ngrok/sandbox blocks
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
        res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,Content-Type,Authorization,ngrok-skip-browser-warning");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        if (req.method === "OPTIONS") return res.sendStatus(200);
        next();
      });

      // @ts-ignore - vite is only available in dev, not in production Docker builds
      const vite = await import("vite");
      const viteServer = await vite.createServer({
        root: path.join(process.cwd(), 'packages/mcp-server'),
        server: {
          middlewareMode: true,
          cors: true,
          allowedHosts: true,
          hmr: { overlay: false }
        },
        appType: "custom",
        base: "/", 
      });
      app.use(viteServer.middlewares);
    } catch (e) {
      logger.error(`Failed to start Vite: ${e}`);
    }
  }

  // ── Root handler to confirm server is running ──────────────────────────────
  app.get('/', (_req, res) => {
    res.send('<html><body><h1>Delegare Vault API is running</h1><p>Ready to receive MCP requests.</p></body></html>');
  });

  // ── 404 handler ────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ code: 'not_found', message: 'Endpoint not found' });
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error');

    if (err.name === 'ZodError' || Array.isArray(err.errors)) {
      if (_req.path.startsWith('/mcp')) {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid JSON-RPC request structure", data: err.errors },
          id: (_req.body as any)?.id || null,
        });
      }
      return res.status(400).json(err.errors);
    }

    res.status(500).json({ code: 'internal_error', message: 'Internal server error' });
  });

  if (process.env.NODE_ENV !== 'test') {
    const PORT = Number(process.env.PORT ?? 3000);
    const server = app.listen(PORT, () => {
      logger.info({ port: PORT, env: process.env.ENVIRONMENT ?? 'dev' }, 'Vault service started');
    });

    const shutdown = (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal — draining requests');
      server.close(() => {
        logger.info('HTTP server closed — exiting process');
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Shutdown timed out — forcing exit');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // Start background workers
  void startWebhookWorker();
}

void startServer();
export default app;

