import { Request, Response } from 'express';
import { z } from 'zod';
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'crypto';
import { ddb, TABLE } from '../lib/dynamodb';
import { generateMerchantApiKey } from '../lib/tokens';
import type { MerchantAccount, MerchantPublicView } from '../models/MerchantAccount';

const CreateMerchantSchema = z.object({
  merchantId: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/, 'lowercase alphanumeric and hyphens only'),
  name: z.string().min(1).max(200),
  contactEmail: z.string().email(),
  webhookUrl: z.string().url().optional(),
  allowedOrigins: z.array(z.string()).default([]),
  maxChargePerTxCents: z.number().int().positive().default(1_000_000), // $10,000 default
  railRequirement: z.enum(['any', 'fiat_only', 'crypto_only']).default('any'),
  billingStripeCustomerId: z.string().default('placeholder'),
  billingStripeSubscriptionItemId: z.string().default('placeholder'),
});

export class MerchantService {
  async getMerchant(merchantId: string): Promise<MerchantAccount | null> {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE.MERCHANTS, Key: { merchantId } }),
    );
    return (result.Item as MerchantAccount) ?? null;
  }

  async getMerchantByEmail(email: string): Promise<MerchantAccount | null> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MERCHANTS,
        IndexName: 'emailIndex',
        KeyConditionExpression: 'contactEmail = :email',
        ExpressionAttributeValues: { ':email': email },
      }),
    );
    
    if (!result.Items || result.Items.length === 0) return null;
    
    // Prefer the primary account (not auto-created)
    const primaryAccount = result.Items.find(item => !item.autoCreated);
    return (primaryAccount || result.Items[0]) as MerchantAccount;
  }

  /**
   * Look up a merchant/buyer by their connected USDC wallet address.
   * Returns the primary account (not the auto-created alias) if multiple match.
   * Uses the walletIndex GSI when available, falls back to emailIndex scan.
   */
  async getMerchantByWallet(walletAddress: string): Promise<MerchantAccount | null> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MERCHANTS,
        IndexName: 'walletIndex',
        KeyConditionExpression: 'usdcWalletAddress = :w',
        ExpressionAttributeValues: { ':w': walletAddress },
      }),
    ).catch(async () => {
      // Fallback if GSI doesn't exist yet — scan with filter (fine for small tables)
      const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
      return ddb.send(new ScanCommand({
        TableName: TABLE.MERCHANTS,
        FilterExpression: 'usdcWalletAddress = :w',
        ExpressionAttributeValues: { ':w': walletAddress },
      }));
    });

    if (!result.Items || result.Items.length === 0) return null;

    // Prefer primary accounts (not auto-created aliases)
    const primary = result.Items.find(
      (item) => !item.autoCreated && !item.targetMerchantId,
    );
    return (primary || result.Items[0]) as MerchantAccount;
  }

  /**
   * Provision a minimal buyer row for first-time Cognito users going through
   * fiat card setup (or any other non-crypto flow).
   *
   * IMPORTANT: Do NOT reuse `upsertAutoMerchant` for this — that method is the
   * P2P-merchant factory and unconditionally mints a webhook secret, live API
   * key hash, placeholder wallet address, and `railRequirement: 'crypto_only'`.
   * None of those side effects are appropriate for a plain fiat buyer. P2P
   * merchant semantics should only be attached when the user *explicitly*
   * connects a crypto wallet (via addBuyerWallet / WalletController).
   *
   * The merchantId is deterministic (`b_<sha256(email).slice(16)>`) so repeated
   * calls are idempotent — no duplicate rows on concurrent requests.
   */
  async createBuyerProfile(email: string): Promise<MerchantAccount> {
    const merchantId = 'b_' + createHash('sha256').update(email).digest('hex').substring(0, 16);

    const existing = await this.getMerchant(merchantId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const buyer: MerchantAccount = {
      merchantId,
      name: email, // no @handle for pure buyers
      contactEmail: email,
      accountType: 'buyer',
      allowedOrigins: [],
      maxChargePerTxCents: 100000, // $1000 default
      railRequirement: 'any', // buyer can pay via either rail; set by the mandate
      platformTrustLevel: 'new',
      dailyReceiveCapCents: 0, // buyers don't receive
      dailyReceivedCents: 0,
      dailyReceivedKey: now.split('T')[0],
      billingStripeCustomerId: '',
      billingStripeSubscriptionItemId: '',
      totalTransactions: 0,
      totalVolumeCents: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      // Intentionally omitted: webhookSecret, apiKeyHash, testApiKey,
      // walletAddress, usdcWalletAddress, autoCreated (P2P-merchant concept).
    };

    await ddb.send(new PutCommand({ TableName: TABLE.MERCHANTS, Item: buyer }));
    return buyer;
  }

  async upsertAutoMerchant(merchantId: string, walletAddress: string, ownerEmail: string): Promise<MerchantAccount> {
    const existing = await this.getMerchant(merchantId);
    
    if (existing) {
      // Just update the updated timestamp and ensure it has the correct address
      await ddb.send(
        new PutCommand({
          TableName: TABLE.MERCHANTS,
          Item: {
            ...existing,
            walletAddress,
            updatedAt: new Date().toISOString(),
          }
        })
      );
      return { ...existing, walletAddress, updatedAt: new Date().toISOString() };
    }

    // Create a new P2P merchant handle
    const { raw: apiKey } = generateMerchantApiKey();
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const now = new Date().toISOString();

    const merchant: MerchantAccount = {
      merchantId,
      name: merchantId, // the handle IS the name
      contactEmail: ownerEmail,
      autoCreated: true,
      walletAddress,
      platformFee: 3, // 3 cents
      allowedOrigins: [],
      maxChargePerTxCents: 10_000_000, // Very high implicit ceiling for P2P receipts
      railRequirement: 'crypto_only',
      webhookSecret: `whsec_${randomBytes(16).toString('hex')}`,
      platformTrustLevel: 'new',
      dailyReceiveCapCents: 1000000, // $10,000/day
      dailyReceivedCents: 0,
      dailyReceivedKey: now.split('T')[0],
      billingStripeCustomerId: 'p2p_auto', // billing not relevant since sender pays
      billingStripeSubscriptionItemId: 'p2p_auto',
      apiKeyHash,
      totalTransactions: 0,
      totalVolumeCents: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(new PutCommand({ TableName: TABLE.MERCHANTS, Item: merchant }));
    return merchant;
  }

  async updateStripeAccount(merchantId: string, stripeConnectedAccountId: string): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MERCHANTS,
        Key: { merchantId },
        UpdateExpression: 'SET stripeConnectedAccountId = :stripeId, updatedAt = :now',
        ExpressionAttributeValues: {
          ':stripeId': stripeConnectedAccountId,
          ':now': new Date().toISOString(),
        },
      }),
    );
  }
}

export async function createMerchant(req: Request, res: Response): Promise<void> {
  const parsed = CreateMerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // Check for duplicate
  const existing = await new MerchantService().getMerchant(data.merchantId);
  if (existing) {
    res.status(409).json({ code: 'conflict', message: `Merchant ${data.merchantId} already exists` });
    return;
  }

  const { raw: apiKey } = generateMerchantApiKey();
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const now = new Date().toISOString();
  const merchant: MerchantAccount = {
    merchantId: data.merchantId,
    name: data.name,
    contactEmail: data.contactEmail,
    webhookUrl: data.webhookUrl,
    allowedOrigins: data.allowedOrigins,
    maxChargePerTxCents: data.maxChargePerTxCents,
    railRequirement: data.railRequirement,
    webhookSecret: `whsec_${randomBytes(16).toString('hex')}`,
    platformTrustLevel: 'new',
    dailyReceiveCapCents: 1000000,
    dailyReceivedCents: 0,
    dailyReceivedKey: now.split('T')[0],
    billingStripeCustomerId: data.billingStripeCustomerId,
    billingStripeSubscriptionItemId: data.billingStripeSubscriptionItemId,
    apiKeyHash,
    totalTransactions: 0,
    totalVolumeCents: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE.MERCHANTS, Item: merchant }));

  // Return API key once — never stored in plaintext
  res.status(201).json({
    merchantId: merchant.merchantId,
    name: merchant.name,
    status: merchant.status,
    createdAt: merchant.createdAt,
    apiKey, // ONLY returned here — cannot be recovered after this response
    warning: 'Store this API key securely. It will not be shown again.',
  });
}

const UpdateMerchantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(16).max(100).optional(),
  allowedOrigins: z.array(z.string()).optional(),
  maxChargePerTxCents: z.number().int().positive().optional(),
  railRequirement: z.enum(['any', 'fiat_only', 'crypto_only']).optional(),
  // Auto-offramp settings
  autoOfframp: z.boolean().optional(),
  autoOfframpProvider: z.enum(['stripe', 'coinbase']).optional(),
  autoOfframpBankAccountId: z.string().optional(),
  autoOfframpThresholdCents: z.number().int().min(0).optional(),
});

export async function updateMerchant(req: Request, res: Response): Promise<void> {
  const { merchantId } = req.params;
  const callerMerchantId = (req as any).merchantId;

  if (merchantId !== callerMerchantId) {
    res.status(403).json({ code: 'forbidden', message: 'You can only update your own merchant account' });
    return;
  }

  const parsed = UpdateMerchantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'validation_error', message: parsed.error.message });
    return;
  }

  const data = parsed.data;
  const updateExpression: string[] = ['updatedAt = :now'];
  const expressionAttributeValues: Record<string, any> = {
    ':now': new Date().toISOString(),
  };
  const expressionAttributeNames: Record<string, string> = {};

  if (data.name !== undefined) {
    updateExpression.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = data.name;
  }
  if (data.webhookUrl !== undefined) {
    updateExpression.push('webhookUrl = :webhookUrl');
    expressionAttributeValues[':webhookUrl'] = data.webhookUrl;
  }
  if (data.webhookSecret !== undefined) {
    updateExpression.push('webhookSecret = :webhookSecret');
    expressionAttributeValues[':webhookSecret'] = data.webhookSecret;
  }
  if (data.allowedOrigins !== undefined) {
    updateExpression.push('allowedOrigins = :origins');
    expressionAttributeValues[':origins'] = data.allowedOrigins;
  }
  if (data.maxChargePerTxCents !== undefined) {
    updateExpression.push('maxChargePerTxCents = :maxCharge');
    expressionAttributeValues[':maxCharge'] = data.maxChargePerTxCents;
  }
  if (data.railRequirement !== undefined) {
    updateExpression.push('railRequirement = :railReq');
    expressionAttributeValues[':railReq'] = data.railRequirement;
  }
  if (data.autoOfframp !== undefined) {
    updateExpression.push('autoOfframp = :autoOfframp');
    expressionAttributeValues[':autoOfframp'] = data.autoOfframp;
  }
  if (data.autoOfframpProvider !== undefined) {
    updateExpression.push('autoOfframpProvider = :aoProvider');
    expressionAttributeValues[':aoProvider'] = data.autoOfframpProvider;
  }
  if (data.autoOfframpBankAccountId !== undefined) {
    updateExpression.push('autoOfframpBankAccountId = :aoBankId');
    expressionAttributeValues[':aoBankId'] = data.autoOfframpBankAccountId;
  }
  if (data.autoOfframpThresholdCents !== undefined) {
    updateExpression.push('autoOfframpThresholdCents = :aoThreshold');
    expressionAttributeValues[':aoThreshold'] = data.autoOfframpThresholdCents;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MERCHANTS,
        Key: { merchantId },
        UpdateExpression: 'SET ' + updateExpression.join(', '),
        ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ code: 'internal_error', message: 'Failed to update merchant' });
  }
}

export async function getMerchantPublicProfile(req: Request, res: Response): Promise<void> {
  const { merchantId } = req.params;
  const merchant = await new MerchantService().getMerchant(merchantId);

  if (!merchant || merchant.status !== 'active') {
    res.status(404).json({ code: 'not_found', message: 'Merchant not found or inactive' });
    return;
  }

  const view: MerchantPublicView = {
    merchantId: merchant.merchantId,
    name: merchant.name,
    allowedOrigins: merchant.allowedOrigins,
    webhookUrl: merchant.webhookUrl,
    webhookSecret: merchant.webhookSecret,
    maxChargePerTxCents: merchant.maxChargePerTxCents,
    railRequirement: merchant.railRequirement,
    totalTransactions: merchant.totalTransactions,
    totalVolumeCents: merchant.totalVolumeCents,
    status: merchant.status,
    createdAt: merchant.createdAt,
    autoCreated: merchant.autoCreated,
    merchantHandle: merchant.merchantHandle,
    walletAddress: merchant.walletAddress,
    twitterHandle: merchant.twitterHandle,
  };

  res.json(view);
}

export async function getMerchantStats(req: Request, res: Response): Promise<void> {
  const { merchantId } = req.params;
  const merchant = await new MerchantService().getMerchant(merchantId);

  if (!merchant) {
    res.status(404).json({ code: 'not_found', message: 'Merchant not found' });
    return;
  }

  const view: MerchantPublicView = {
    merchantId: merchant.merchantId,
    name: merchant.name,
    allowedOrigins: merchant.allowedOrigins,
    webhookUrl: merchant.webhookUrl,
    webhookSecret: merchant.webhookSecret,
    maxChargePerTxCents: merchant.maxChargePerTxCents,
    railRequirement: merchant.railRequirement,
    totalTransactions: merchant.totalTransactions,
    totalVolumeCents: merchant.totalVolumeCents,
    status: merchant.status,
    createdAt: merchant.createdAt,
  };

  res.json(view);
}

export async function getMerchantTransactions(req: Request, res: Response): Promise<void> {
  const { merchantId } = req.params;
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.TRANSACTIONS,
      IndexName: 'merchantIndex',
      KeyConditionExpression: 'merchantId = :mid',
      ExpressionAttributeValues: { ':mid': merchantId },
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  res.json({ items: result.Items ?? [], count: result.Count ?? 0 });
}

export async function getBuyerTransactions(req: Request, res: Response): Promise<void> {
  const { ownerId } = req.params;
  const limit = Math.min(Number(req.query['limit'] ?? 50), 200);

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE.TRANSACTIONS,
      IndexName: 'ownerIdIndex',
      KeyConditionExpression: 'ownerId = :oid',
      ExpressionAttributeValues: { ':oid': ownerId },
      Limit: limit,
      ScanIndexForward: false, // newest first
    }),
  );

  res.json({ items: result.Items ?? [], count: result.Count ?? 0 });
}

/**
 * Endpoint: GET /v1/auth/me
 * Secured by Cognito JWT (authenticateCognito).
 * Finds the merchant associated with the logged-in email and returns their profile.
 */
export async function getMyMerchant(req: Request, res: Response): Promise<void> {
  const email = (req as import("../types/express").CognitoRequest).cognitoEmail;
  if (!email) {
    res.status(401).json({ code: 'unauthorized', message: 'No email found in session' });
    return;
  }

  const merchant = await new MerchantService().getMerchantByEmail(email);

  if (!merchant) {
    // Return 404 so the dashboard knows they need to complete the setup flow
    res.status(404).json({ code: 'not_found', message: 'No profile linked to this email' });
    return;
  }

  const view: MerchantPublicView & {
    accountType?: string;
    contactEmail?: string;
    stripeBuyerCustomerId?: string;
    stripeBuyerPaymentMethodId?: string;
    stripeBuyerPaymentMethodLast4?: string;
  } = {
    merchantId: merchant.merchantId,
    name: merchant.name,
    accountType: merchant.accountType || 'merchant',
    contactEmail: merchant.contactEmail,
    allowedOrigins: merchant.allowedOrigins,
    webhookUrl: merchant.webhookUrl,
    webhookSecret: merchant.webhookSecret,
    maxChargePerTxCents: merchant.maxChargePerTxCents,
    railRequirement: merchant.railRequirement,
    totalTransactions: merchant.totalTransactions,
    totalVolumeCents: merchant.totalVolumeCents,
    status: merchant.status,
    createdAt: merchant.createdAt,
    autoCreated: merchant.autoCreated,
    merchantHandle: merchant.merchantHandle,
    walletAddress: merchant.walletAddress,
    twitterHandle: merchant.twitterHandle,
    testApiKey: merchant.testApiKey,
    stripeConnectedAccountId: merchant.stripeConnectedAccountId,
    usdcWalletAddress: merchant.usdcWalletAddress,
    // Buyer-side fiat (saved card-on-file) — used by the dashboard
    // Payment Methods panel to render "Connected ••4242" vs a Connect CTA.
    stripeBuyerCustomerId: merchant.stripeBuyerCustomerId,
    stripeBuyerPaymentMethodId: merchant.stripeBuyerPaymentMethodId,
    stripeBuyerPaymentMethodLast4: merchant.stripeBuyerPaymentMethodLast4,
  };

  // Attach the deterministic handle if they have a connected USDC wallet
  // (The dashboard uses this to display the P2P handle)
  if (view.usdcWalletAddress && !view.merchantHandle) {
    try {
      const { generateMerchantName } = await import('../lib/names');
      view.merchantHandle = generateMerchantName(view.usdcWalletAddress);
    } catch (e) {
      // ignore
    }
  }

  res.json(view);
}

/**
 * Endpoint: POST /v1/auth/me
 * Secured by Cognito JWT (authenticateCognito).
 * Creates a new merchant profile for the logged in user.
 */
export async function registerPartnerMerchant(req: Request, res: Response): Promise<void> {
  const { merchantId, name, contactEmail, webhookUrl } = req.body;

  if (!merchantId || !name || !contactEmail) {
    res.status(400).json({ code: 'validation_error', message: 'merchantId, name, and contactEmail are required' });
    return;
  }

  // Check for duplicate
  const existing = await new MerchantService().getMerchant(merchantId);
  if (existing) {
    res.status(409).json({ code: 'conflict', message: `Merchant ${merchantId} already exists` });
    return;
  }

  const { raw: liveApiKey } = generateMerchantApiKey();
  const apiKeyHash = createHash('sha256').update(liveApiKey).digest('hex');
  const { raw: testApiKey } = generateMerchantApiKey('test');

  const now = new Date().toISOString();
  const merchant: MerchantAccount = {
    merchantId,
    name,
    contactEmail,
    webhookUrl,
    allowedOrigins: ['*'],
    maxChargePerTxCents: 1000000,
    railRequirement: 'any',
    webhookSecret: `whsec_${randomBytes(16).toString('hex')}`,
    platformTrustLevel: 'new',
    dailyReceiveCapCents: 1000000,
    dailyReceivedCents: 0,
    dailyReceivedKey: now.split('T')[0],
    billingStripeCustomerId: 'partner_managed',
    billingStripeSubscriptionItemId: 'partner_managed',
    apiKeyHash,
    testApiKey,
    totalTransactions: 0,
    totalVolumeCents: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE.MERCHANTS, Item: merchant }));

  res.status(201).json({
    merchantId: merchant.merchantId,
    name: merchant.name,
    liveApiKey,
    testApiKey,
    webhookSecret: merchant.webhookSecret,
  });
}

export async function registerMyMerchant(req: Request, res: Response): Promise<void> {
  const email = (req as import("../types/express").CognitoRequest).cognitoEmail;
  if (!email) {
    res.status(401).json({ code: 'unauthorized', message: 'No email found in session' });
    return;
  }

  const existing = await new MerchantService().getMerchantByEmail(email);

  const name = req.body.name || email.split('@')[0];
  const accountType = req.body.accountType || 'merchant';
  const stripeConnectedAccountId = req.body.stripeConnectedAccountId || undefined;
  const usdcWalletAddress = req.body.usdcWalletAddress || undefined;

  if (existing) {
    if (stripeConnectedAccountId || usdcWalletAddress || req.body.accountType) {
      const updateExpression: string[] = ['updatedAt = :now'];
      const expressionAttributeValues: Record<string, any> = {
        ':now': new Date().toISOString()
      };

      if (stripeConnectedAccountId) {
        updateExpression.push('stripeConnectedAccountId = :stripe');
        expressionAttributeValues[':stripe'] = stripeConnectedAccountId;
      }
      if (usdcWalletAddress) {
        updateExpression.push('usdcWalletAddress = :usdc');
        expressionAttributeValues[':usdc'] = usdcWalletAddress;

        try {
          const { generateMerchantName } = await import('../lib/names');
          const merchantHandle = generateMerchantName(usdcWalletAddress);
          await new MerchantService().upsertAutoMerchant(merchantHandle, usdcWalletAddress, email);
          // Sync the handle to the primary account so profile lookups by handle work
          updateExpression.push('merchantHandle = :handle');
          expressionAttributeValues[':handle'] = merchantHandle;
        } catch (e) {
          console.error('Failed to create P2P alias for merchant', e);
        }
      }
      if (req.body.accountType) {
        updateExpression.push('accountType = :type');
        expressionAttributeValues[':type'] = req.body.accountType;
      }

      await ddb.send(new UpdateCommand({
        TableName: TABLE.MERCHANTS,
        Key: { merchantId: existing.merchantId },
        UpdateExpression: 'SET ' + updateExpression.join(', '),
        ExpressionAttributeValues: expressionAttributeValues
      }));
      
      existing.usdcWalletAddress = usdcWalletAddress || existing.usdcWalletAddress;
      existing.stripeConnectedAccountId = stripeConnectedAccountId || existing.stripeConnectedAccountId;
      existing.accountType = req.body.accountType || existing.accountType;
    }
    
    res.status(200).json({
      merchantId: existing.merchantId,
      name: existing.name,
      accountType: existing.accountType || 'merchant',
      status: existing.status,
      createdAt: existing.createdAt,
      testApiKey: existing.testApiKey,
      stripeConnectedAccountId: existing.stripeConnectedAccountId,
      usdcWalletAddress: existing.usdcWalletAddress,
      warning: 'Profile already exists. Live API key not returned.',
    });
    return;
  }

  const merchantId = (accountType === 'buyer' ? 'b_' : 'm_') + createHash('sha256').update(email).digest('hex').substring(0, 16);

  const { raw: liveApiKey } = generateMerchantApiKey();
  const apiKeyHash = createHash('sha256').update(liveApiKey).digest('hex');
  const { raw: testApiKey } = generateMerchantApiKey('test');

  const now = new Date().toISOString();
  const merchant: MerchantAccount = {
    merchantId,
    accountType: accountType as any,
    name,
    contactEmail: email,
    allowedOrigins: ['*'],
    maxChargePerTxCents: 100000, // $1000 default limit
    railRequirement: 'any',
    webhookSecret: `whsec_${randomBytes(16).toString('hex')}`,
    platformTrustLevel: 'new',
    dailyReceiveCapCents: 1000000, // $10,000/day
    dailyReceivedCents: 0,
    dailyReceivedKey: now.split('T')[0],
    billingStripeCustomerId: '', // To be filled later if needed
    billingStripeSubscriptionItemId: '',
    apiKeyHash,
    testApiKey,
    stripeConnectedAccountId,
    usdcWalletAddress,
    totalTransactions: 0,
    totalVolumeCents: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE.MERCHANTS, Item: merchant }));

  res.status(201).json({
    merchantId: merchant.merchantId,
    name: merchant.name,
    accountType: merchant.accountType,
    status: merchant.status,
    createdAt: merchant.createdAt,
    liveApiKey: accountType === 'buyer' ? undefined : liveApiKey,
    testApiKey: accountType === 'buyer' ? undefined : testApiKey,
    warning: accountType === 'buyer' ? undefined : 'Store the liveApiKey securely. It will not be shown again.',
  });
}

/**
 * Rotate the caller's live API key. Generates a fresh dk_live_ key, updates the
 * stored apiKeyHash, and returns the new plaintext key exactly once. The old
 * key is invalidated immediately.
 *
 * Auth: Cognito session (same as registerMyMerchant / getMyMerchant).
 * Route: POST /v1/auth/me/rotate-key
 */
export async function rotateMyMerchantApiKey(req: Request, res: Response): Promise<void> {
  const email = (req as import("../types/express").CognitoRequest).cognitoEmail;
  if (!email) {
    res.status(401).json({ code: 'unauthorized', message: 'No email found in session' });
    return;
  }

  const merchant = await new MerchantService().getMerchantByEmail(email);
  if (!merchant) {
    res.status(404).json({ code: 'not_found', message: 'Merchant profile not found. Complete onboarding first.' });
    return;
  }

  if (merchant.accountType === 'buyer') {
    res.status(400).json({ code: 'not_a_merchant', message: 'Buyers do not have API keys.' });
    return;
  }

  const { raw: liveApiKey } = generateMerchantApiKey('live');
  const apiKeyHash = createHash('sha256').update(liveApiKey).digest('hex');
  const now = new Date().toISOString();

  await ddb.send(new UpdateCommand({
    TableName: TABLE.MERCHANTS,
    Key: { merchantId: merchant.merchantId },
    UpdateExpression: 'SET apiKeyHash = :hash, updatedAt = :now',
    ExpressionAttributeValues: {
      ':hash': apiKeyHash,
      ':now': now,
    },
  }));

  res.status(200).json({
    merchantId: merchant.merchantId,
    liveApiKey,
    rotatedAt: now,
    warning: 'Store this key securely. It will not be shown again. The previous key is now invalid.',
  });
}
