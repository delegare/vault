import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { generateSessionToken, currentMonthKey } from '../lib/tokens';
import { getSecret, vaultSecretId } from '../lib/secrets';
import type { SpendingMandate, Rail, RailPreference, MandatePublicView } from '../models/SpendingMandate';
import type { SetupSession } from '../models/SetupSession';
import { randomUUID, createHash } from 'crypto';
import { DidService } from './DidService';
import { logger } from '../lib/logger';

export interface CreateSetupSessionParams {
  merchantId: string;
  maxPerTxCents: number;
  maxMonthlySpendCents: number;
  rail: Rail;
  railPreference: RailPreference;
  allowedMerchantIds?: string[];
  mode?: 'setup' | 'add_rail';
  targetMandateId?: string;
}

export interface CreateMandateParams {
  sessionToken: string;
  ownerId: string;
  ownerEmail?: string;
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  stripePaymentMethodLast4?: string;
  smartWalletAddress?: string;
}

export class CredentialService {
  async createSetupSession(params: CreateSetupSessionParams): Promise<SetupSession> {
    const sessionToken = generateSessionToken();
    const now = new Date();
    const ttl = Math.floor(now.getTime() / 1000) + 30 * 60; // 30 minutes

    const session: SetupSession = {
      sessionToken,
      merchantId: params.merchantId,
      requestedRail: params.rail,
      requestedRailPreference: params.railPreference,
      maxPerTxCents: params.maxPerTxCents,
      maxMonthlySpendCents: params.maxMonthlySpendCents,
      allowedMerchantIds: params.allowedMerchantIds ?? [],
      mode: params.mode ?? 'setup',
      targetMandateId: params.targetMandateId,
      status: 'pending',
      createdAt: now.toISOString(),
      ttl,
    };

    await ddb.send(new PutCommand({ TableName: TABLE.SETUP_SESSIONS, Item: session }));
    return session;
  }

  async createSelfServiceSetupSession(params: {
    ownerEmail: string;
    maxPerTxCents?: number;
    maxMonthlyCents?: number;
    rail?: Rail;
    targetMerchantId?: string;
  }): Promise<SetupSession> {
    const sessionToken = generateSessionToken();
    const now = new Date();
    const ttl = Math.floor(now.getTime() / 1000) + 30 * 60; // 30 minutes

    const session: SetupSession = {
      sessionToken,
      type: 'setup_session',
      ownerEmail: params.ownerEmail,
      merchantId: params.targetMerchantId ?? 'system',
      requestedRail: params.rail ?? 'both',
      requestedRailPreference: 'auto',
      maxPerTxCents: params.maxPerTxCents ?? 5000, // $50 default
      maxMonthlySpendCents: params.maxMonthlyCents ?? 50000, // $500 default
      allowedMerchantIds: params.targetMerchantId ? [params.targetMerchantId] : [],
      mode: 'setup',
      status: 'pending',
      createdAt: now.toISOString(),
      ttl,
    };

    await ddb.send(new PutCommand({ TableName: TABLE.SETUP_SESSIONS, Item: session }));
    return session;
  }

  async getSetupSession(sessionToken: string): Promise<SetupSession | null> {
    const result = await ddb.send(
      new GetCommand({ TableName: TABLE.SETUP_SESSIONS, Key: { sessionToken } }),
    );
    return (result.Item as SetupSession) ?? null;
  }

  async issueIntentMandate(params: CreateMandateParams): Promise<SpendingMandate> {
    // 1. Generate User DID
    const userKeys = await DidService.generateUserDid();
    
    // In production, user's private key should be returned to them or stored encrypted by a key only they hold.
    // For this prototype, we're storing it so we can sign checkout mandates on their behalf.
    const mandateId = `mandate_${randomUUID().replace(/-/g, '')}`;
    const now = new Date().toISOString();
    
    // 2. Fetch session limits
    const session = await this.getSetupSession(params.sessionToken);
    if (!session || session.status !== 'pending') {
      throw new Error('Invalid or expired setup session');
    }

    const ownerEmail = params.ownerEmail ?? session.ownerEmail;

    // 3. Create the AP2 Intent Mandate payload
    const mandatePayload = {
      type: ['VerifiableCredential', 'IntentMandate'],
      credentialSubject: {
        id: userKeys.did,
        constraints: {
          maxAmountPerTxCents: session.maxPerTxCents,
          maxMonthlyCents: session.maxMonthlySpendCents,
          allowedMerchantDIDs: session.allowedMerchantIds,
          allowedCurrencies: ['usd', 'usdc', 'usdt'],
        }
      },
      evidence: {
        type: 'DelegareConsentProof2026',
        sessionToken: params.sessionToken
      }
    };

    // 4. Sign it with Delegare's DID key
    const encodedMandate = await DidService.signCredential(mandatePayload);
    const mandateHash = createHash('sha256').update(encodedMandate).digest('hex');

    // 5. Create Internal Record
    const mandate: SpendingMandate = {
      mandateId,
      userDid: userKeys.did,
      ownerId: params.ownerId,
      ownerEmail: ownerEmail,
      status: 'active',
      encodedMandate,
      mandateHash,
      maxAmountPerTxCents: session.maxPerTxCents,
      maxMonthlySpendCents: session.maxMonthlySpendCents,
      allowedMerchantDIDs: session.allowedMerchantIds,
      allowedMerchantIds: session.allowedMerchantIds, // Legacy compatibility
      allowedCurrencies: ['usd', 'usdc', 'usdt'],
      railPreference: session.requestedRailPreference,
      rail: session.requestedRail,
      allowRailFallback: true,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
      stripeCustomerId: params.stripeCustomerId,
      stripePaymentMethodId: params.stripePaymentMethodId,
      stripePaymentMethodLast4: params.stripePaymentMethodLast4,
      smartWalletAddress: params.smartWalletAddress,
      currentMonthSpendCents: 0,
      currentMonthKey: currentMonthKey(),
      ap2Version: '1.0',
      credentialSchema: 'https://ap2-protocol.org/schemas/intent-mandate-v1.json',
      createdAt: now,
      updatedAt: now,
    };

    // Also write `issuedAt` so items are projected into the ownerIdIndex GSI
    // (its sort key is `issuedAt` — items missing this attribute are silently
    // excluded from the index).
    await ddb.send(new PutCommand({
      TableName: TABLE.MANDATES,
      Item: { ...mandate, issuedAt: now },
    }));
    
    // Mark session complete
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Key: { sessionToken: params.sessionToken },
        UpdateExpression: 'SET #st = :comp, mandateId = :mid, encodedMandate = :enc, ownerId = :oid, completedAt = :now',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':comp': 'complete',
          ':mid': mandateId,
          ':enc': encodedMandate,
          ':oid': params.ownerId,
          ':now': now,
        },
      }),
    );

    return mandate;
  }

  async getMandateView(mandateId: string): Promise<MandatePublicView | null> {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MANDATES,
        KeyConditionExpression: 'mandateId = :mid',
        ExpressionAttributeValues: { ':mid': mandateId },
        Limit: 1,
      }),
    );

    const mandate = result.Items?.[0] as SpendingMandate | undefined;
    if (!mandate) return null;

    return {
      mandateId: mandate.mandateId,
      userDid: mandate.userDid,
      rail: mandate.rail,
      railPreference: mandate.railPreference,
      allowRailFallback: mandate.allowRailFallback,
      railMismatchBehavior: mandate.railMismatchBehavior,
      maxAmountPerTxCents: mandate.maxAmountPerTxCents,
      maxMonthlySpendCents: mandate.maxMonthlySpendCents,
      currentMonthSpendCents: mandate.currentMonthSpendCents,
      currentMonthKey: mandate.currentMonthKey,
      status: mandate.status,
      expiresAt: mandate.expiresAt,
      allowedMerchantIds: mandate.allowedMerchantIds,
      stripePaymentMethodLast4: mandate.stripePaymentMethodLast4,
      smartWalletAddress: mandate.smartWalletAddress,
    };
  }

  async rotateMandate(oldMandateId: string): Promise<string> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE.MANDATES,
        Key: { mandateId: oldMandateId },
      }),
    );

    const oldMandate = result.Item as SpendingMandate | undefined;
    if (!oldMandate || oldMandate.status !== 'active') {
      throw new Error('Mandate not found or not active');
    }

    // A real implementation would generate a new User DID and sign a new SD-JWT-VC.
    // For this prototype, we're just copying the data over to a new PK.
    const newMandateId = `mandate_${randomUUID().replace(/-/g, '')}`;

    const newMandate: SpendingMandate = {
      ...oldMandate,
      mandateId: newMandateId,
      currentMonthSpendCents: 0, // Reset spend counter for safety/simplicity
      status: 'active',
      updatedAt: new Date().toISOString()
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE.MANDATES,
        Item: newMandate,
      }),
    );

    await this.revokeMandate(oldMandateId);

    return newMandateId;
  }

  /**
   * Find all active mandates owned by a given ownerId.
   * Used by the buyer "add a payment rail" flow so we can patch
   * existing mandates in place instead of issuing duplicates.
   */
  async findActiveMandatesByOwnerId(ownerId: string): Promise<SpendingMandate[]> {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE.MANDATES,
      IndexName: 'ownerIdIndex',
      KeyConditionExpression: 'ownerId = :oid',
      FilterExpression: '#st = :active',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':oid': ownerId, ':active': 'active' },
    }));
    return (result.Items as SpendingMandate[] | undefined) ?? [];
  }

  /**
   * Patch an existing active mandate to add a second payment rail.
   * Upgrades `rail` to 'both' so the PaymentRouter can pick either side.
   */
  async addPaymentMethodToMandate(
    mandateId: string,
    fields: {
      stripeCustomerId?: string;
      stripePaymentMethodId?: string;
      stripePaymentMethodLast4?: string;
      smartWalletAddress?: string;
    },
  ): Promise<void> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MANDATES,
        KeyConditionExpression: 'mandateId = :mid',
        ExpressionAttributeValues: { ':mid': mandateId },
        Limit: 1,
      }),
    );
    const mandate = result.Items?.[0] as SpendingMandate | undefined;
    if (!mandate) {
      throw new Error(`Mandate not found: ${mandateId}`);
    }

    const sets: string[] = ['updatedAt = :now', '#rail = :both'];
    const values: Record<string, any> = {
      ':now': new Date().toISOString(),
      ':both': 'both',
    };
    const names: Record<string, string> = { '#rail': 'rail' };

    if (fields.stripeCustomerId !== undefined) {
      sets.push('stripeCustomerId = :sc');
      values[':sc'] = fields.stripeCustomerId;
    }
    if (fields.stripePaymentMethodId !== undefined) {
      sets.push('stripePaymentMethodId = :spm');
      values[':spm'] = fields.stripePaymentMethodId;
    }
    if (fields.stripePaymentMethodLast4 !== undefined) {
      sets.push('stripePaymentMethodLast4 = :sl4');
      values[':sl4'] = fields.stripePaymentMethodLast4;
    }
    if (fields.smartWalletAddress !== undefined) {
      sets.push('smartWalletAddress = :swa');
      values[':swa'] = fields.smartWalletAddress;
    }

    await ddb.send(new UpdateCommand({
      TableName: TABLE.MANDATES,
      Key: { mandateId, userDid: mandate.userDid },
      UpdateExpression: 'SET ' + sets.join(', '),
      ConditionExpression: 'attribute_exists(mandateId) AND #st = :active',
      ExpressionAttributeNames: { ...names, '#st': 'status' },
      ExpressionAttributeValues: { ...values, ':active': 'active' },
    }));
  }

  async revokeMandate(mandateId: string): Promise<void> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE.MANDATES,
        KeyConditionExpression: 'mandateId = :mid',
        ExpressionAttributeValues: { ':mid': mandateId },
        Limit: 1,
      }),
    );
    const mandate = result.Items?.[0] as SpendingMandate | undefined;
    if (!mandate) return; // Silent return or throw?

    //    Revoking a mandate also wipes the encrypted session key. The mandate
    //    row stays in Dynamo for audit purposes, but the session key ciphertext
    //    is removed so the row can no longer be used to authorize a payment.
    //    (Historical note: session keys used to live in Secrets Manager and
    //    were soft-deleted with a 7-day recovery window; since we now KMS-encrypt
    //    onto the mandate row, a REMOVE on that field is the equivalent action.)
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MANDATES,
        Key: { mandateId, userDid: mandate.userDid },
        UpdateExpression: 'SET #status = :revoked, revokedAt = :now REMOVE encryptedSessionKey',
        ConditionExpression: 'attribute_exists(mandateId)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked',
          ':now': new Date().toISOString(),
        },
      }),
    );
  }

  /**
   * Helper function for MCP to verify a submitted SD-JWT-VC string.
   * Extracts the internal `mandateId` to map back to the DynamoDB limits state.
   */
  async verifyIntentMandate(encodedMandate: string): Promise<SpendingMandate> {
    try {
      // 1. Verify the cryptographic signature of the AP2 Intent Mandate
      const payload = await DidService.verifyCredential(encodedMandate);
      
      const userDid = payload?.credentialSubject?.id;
      if (!userDid) {
         throw new Error("Invalid Intent Mandate: Missing credentialSubject.id");
      }

      // 2. Hash the mandate and find the record in DynamoDB.
      // In production, we query the mandateHashIndex.
      const mandateHash = createHash('sha256').update(encodedMandate).digest('hex');

      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
      const result = await ddb.send(
        new QueryCommand({
          TableName: TABLE.MANDATES,
          IndexName: 'mandateHashIndex',
          KeyConditionExpression: 'mandateHash = :mandateHash',
          ExpressionAttributeValues: {
            ':mandateHash': mandateHash,
          },
          Limit: 1
        })
      );

      if (!result.Items || result.Items.length === 0) {
        throw new Error('Mandate record not found for the given intentMandate');
      }
      
      return result.Items[0] as SpendingMandate;
    } catch (e) {
      logger.error({ err: e }, 'Failed to verify AP2 Intent Mandate');
      throw e;
    }
  }
}
