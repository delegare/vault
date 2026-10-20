import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { MerchantService } from '../controllers/MerchantController';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { logger } from '../lib/logger';
import type { AuthedRequest, CognitoRequest } from '../types/express';

const merchantService = new MerchantService();

let cognitoVerifier: any = null;

/**
 * Initializes or returns the Cognito JWT Verifier singleton.
 */
function getCognitoVerifier() {
  if (cognitoVerifier) return cognitoVerifier;
  const userPoolId = process.env.COGNITO_USER_POOL_ID || process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID || process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;

  if (!userPoolId || !clientId) {
    throw new Error('Missing Cognito User Pool configuration variables for JWT verification');
  }

  cognitoVerifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id', // use tokenUse instead of tokenType for aws-jwt-verify
    clientId,
  });

  return cognitoVerifier;
}

/**
 * Validates a Cognito Identity Provider JWT (Bearer token).
 * Used by the web dashboard to securely authenticate a user session
 * and fetch their associated Merchant Account profile.
 */
export async function authenticateCognito(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ code: 'unauthorized', message: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const verifier = getCognitoVerifier();
    const payload = await verifier.verify(token);

    if (!payload.email) {
      res.status(401).json({ code: 'unauthorized', message: 'No email found in Cognito token claims' });
      return;
    }

    (req as CognitoRequest).cognitoEmail = payload.email as string;
    (req as CognitoRequest).cognitoSub = payload.sub;
    next();
  } catch (err: any) {
    res.status(401).json({ code: 'unauthorized', message: `Invalid token: ${err.message}` });
  }
}

/**
 * Validates the merchant API key from X-Delegare-Api-Key header OR an OAuth Access Token.
 * Attaches merchantId to the request on success.
 */
export async function authenticateMerchant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  let merchantId = req.headers['x-delegare-merchant-id'] as string;
  const apiKey = req.headers['x-delegare-api-key'] as string;
  
  let isOAuthToken = false;
  let isTestMode = false;

  // 1. Try OAuth Bearer token (Delegare `token_xxx` tokens) OR Cognito JWTs.
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const isJwt = token.split('.').length === 3;

    if (!isJwt) {
      const result = await ddb.send(new GetCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Key: { sessionToken: token }
      }));

      if (result.Item && result.Item.type === 'access_token') {
        // Overwrite merchantId with the one proven by OAuth
        merchantId = result.Item.merchantId;
        isOAuthToken = true;
      } else {
        res.status(401).json({ code: 'unauthorized', message: 'Invalid or expired OAuth token' });
        return;
      }
    } else {
      // It's a JWT. Check if it's a valid Cognito token for first-party agent use.
      try {
        const verifier = getCognitoVerifier();
        const payload = await verifier.verify(token);
        if (payload.email) {
          const email = payload.email as string;
          let buyer = await merchantService.getMerchantByEmail(email);
          
          if (!buyer) {
            // Auto-provision a *minimal* buyer profile for first-time agent
            // users. Do NOT call upsertAutoMerchant here — that mints full
            // P2P-merchant side effects (webhook secret, live API key hash,
            // crypto_only rail) which are wrong for a plain Cognito buyer.
            buyer = await merchantService.createBuyerProfile(email);
          }
          
          if (buyer) {
            merchantId = buyer.merchantId;
            isOAuthToken = true; // Act as if it's a valid OAuth token
            (req as any).cognitoEmail = payload.email;
            (req as any).cognitoSub = payload.sub;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Cognito JWT verification or auto-provisioning failed');
        // Not a valid Cognito token, might be a malformed string. 
        // Fall through to the API key logic below.
      }
    }
  }

  if (!merchantId) {
    res.status(401).json({ code: 'unauthorized', message: 'X-Delegare-Merchant-Id header or OAuth token required' });
    return;
  }

  const merchant = await merchantService.getMerchant(merchantId);
  if (!merchant) {
    logger.warn({ merchantId }, 'Merchant not found in DB during authentication');
    res.status(401).json({ code: 'unauthorized', message: 'Invalid credentials' });
    return;
  }

  // For OAuth tokens, derive test mode from the environment since there's no API key to inspect.
  // On sandbox/dev environments, all OAuth sessions are implicitly test mode.
  if (isOAuthToken) {
    const env = process.env.ENVIRONMENT ?? 'dev';
    isTestMode = env !== 'prod';
  }

  // 2. Validate API key if not using OAuth
  if (!isOAuthToken) {
    if (!apiKey) {
      res.status(401).json({ code: 'unauthorized', message: 'X-Delegare-Api-Key header required' });
      return;
    }
    
    const isTestKey = apiKey.startsWith('dk_test_');
    isTestMode = isTestKey;

    if (isTestKey) {
      if (merchant.testApiKey !== apiKey) {
        res.status(401).json({ code: 'unauthorized', message: 'Invalid test credentials' });
        return;
      }
    } else {
      const keyHash = createHash('sha256').update(apiKey).digest('hex');
      if (keyHash !== merchant.apiKeyHash) {
        res.status(401).json({ code: 'unauthorized', message: 'Invalid live credentials' });
        return;
      }
    }
  }

  if (merchant.status !== 'active') {
    res.status(403).json({ code: 'forbidden', message: 'Merchant account is suspended' });
    return;
  }

  (req as AuthedRequest).merchantId = merchantId;
  (req as AuthedRequest).isTestMode = isTestMode;
  next();
}
