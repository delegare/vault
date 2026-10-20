import { Request, Response } from 'express';
import { randomBytes, createHash } from 'crypto';
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { logger } from '../lib/logger';
import { MerchantService } from './MerchantController';

export class OAuthController {
  
  static async register(req: Request, res: Response) {
    const clientId = `client_${randomBytes(8).toString('hex')}`;
    const clientSecret = randomBytes(16).toString('hex');
    const redirectUris = req.body.redirect_uris || [];

    await ddb.send(new PutCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Item: {
        sessionToken: clientId,
        type: 'oauth_client',
        clientSecret,
        redirectUris,
        ttl: Math.floor(Date.now() / 1000) + 31536000,
      }
    }));

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris
    });
  }

  static async authorize(req: Request, res: Response) {
    const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;
    
    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }
    
    const reqId = `oauthreq_${randomBytes(16).toString('hex')}`;
    
    await ddb.send(new PutCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Item: {
        sessionToken: reqId,
        type: 'oauth_req',
        clientId: client_id,
        redirectUri: redirect_uri,
        scope,
        state,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        status: 'pending',
        ttl: Math.floor(Date.now() / 1000) + 600,
      }
    }));

    logger.info({ reqId, client_id, redirect_uri, scope, hasCodeChallenge: !!code_challenge }, 'OAuth authorize: created request, redirecting to frontend');

    // Redirect to frontend login/authorize page
    // Derive frontend URL from env vars, or from the request Host header (api.X -> app.X)
    const frontendUrl = process.env.SETUP_UI_URL
      || (process.env.API_BASE_URL || process.env.BASE_URL ? (process.env.API_BASE_URL || process.env.BASE_URL)!.replace('://api.', '://app.') : null)
      || (req.headers.host?.includes('api.') ? `https://${req.headers.host.replace('api.', 'app.')}` : null)
      || (process.env.NODE_ENV === 'production' ? 'https://app.delegare.dev' : 'http://localhost:3000');
    // The dashboard is hosted at the root (/) and handles the Authenticator logic
    res.redirect(`${frontendUrl}/?oauthReqId=${reqId}`);
  }

  // Called via an authenticated POST request from the frontend after login
  static async approve(req: Request, res: Response) {
    const { oauthReqId } = req.body;
    let merchantId = (req as any).merchantId; 

    // If authenticated via Cognito, we have the email. We must resolve the actual merchantId.
    const email = (req as any).cognitoEmail;
    if (!merchantId && email) {
      const merchantService = new MerchantService();
      let buyer = await merchantService.getMerchantByEmail(email);
      
      if (!buyer) {
        // Auto-provision a *minimal* buyer profile. See MerchantService.createBuyerProfile
        // for why upsertAutoMerchant is not appropriate here (it mints P2P-merchant
        // side effects — webhook secret, live API key, crypto_only rail).
        buyer = await merchantService.createBuyerProfile(email);
      }

      merchantId = buyer?.merchantId;
    }

    if (!merchantId) {
      res.status(401).json({ error: 'unauthorized', message: 'Missing merchant context from token' });
      return;
    }

    const result = await ddb.send(new GetCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Key: { sessionToken: oauthReqId }
    }));
    
    const authReq = result.Item;
    if (!authReq || authReq.type !== 'oauth_req' || authReq.status !== 'pending') {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid or expired authorization request' });
      return;
    }

    const code = `code_${randomBytes(16).toString('hex')}`;
    
    await ddb.send(new PutCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Item: {
        sessionToken: code,
        type: 'oauth_code',
        clientId: authReq.clientId,
        redirectUri: authReq.redirectUri,
        merchantId,
        codeChallenge: authReq.codeChallenge,
        codeChallengeMethod: authReq.codeChallengeMethod,
        ttl: Math.floor(Date.now() / 1000) + 600,
      }
    }));

    // Mark req as complete
    await ddb.send(new PutCommand({
      TableName: TABLE.SETUP_SESSIONS,
      Item: { ...authReq, status: 'complete' }
    }));

    const redirectUrl = new URL(authReq.redirectUri);
    redirectUrl.searchParams.append('code', code);
    if (authReq.state) redirectUrl.searchParams.append('state', authReq.state);
    
    res.json({ redirectUri: redirectUrl.toString() });
  }

  static async token(req: Request, res: Response) {
    // Support URL-encoded bodies which OAuth clients send
    const grant_type = req.body.grant_type;
    const code = req.body.code;
    const redirect_uri = req.body.redirect_uri;
    
    // Some OAuth clients (like OpenAI) send client_id in the body, others via Basic Auth header.
    let client_id = req.body.client_id;
    let client_secret = req.body.client_secret;

    if (!client_id && req.headers.authorization?.startsWith('Basic ')) {
      const b64auth = req.headers.authorization.split(' ')[1];
      const [user, pass] = Buffer.from(b64auth, 'base64').toString().split(':');
      client_id = user;
      client_secret = pass;
    }

    const code_verifier = req.body.code_verifier;
    const refresh_token = req.body.refresh_token;

    if (grant_type === 'authorization_code') {
      logger.info({ client_id, hasCode: !!code, hasCodeVerifier: !!code_verifier, redirect_uri }, 'Token exchange: authorization_code');

      const result = await ddb.send(new GetCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Key: { sessionToken: code }
      }));

      const codeData = result.Item;
      if (!codeData || codeData.type !== 'oauth_code') {
        logger.warn({ code: code?.substring(0, 20), found: !!codeData, type: codeData?.type }, 'Token exchange: code not found or wrong type');
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found or expired' });
        return;
      }

      if (codeData.redirectUri !== redirect_uri || codeData.clientId !== client_id) {
        logger.warn({ expectedRedirect: codeData.redirectUri, gotRedirect: redirect_uri, expectedClient: codeData.clientId, gotClient: client_id }, 'Token exchange: mismatch');
        res.status(400).json({ error: 'invalid_grant', error_description: 'Mismatched redirect_uri or client_id' });
        return;
      }

      if (codeData.codeChallenge && codeData.codeChallengeMethod === 'S256' && code_verifier) {
        const hash = createHash('sha256').update(code_verifier).digest('base64url');
        logger.info({ expectedChallenge: codeData.codeChallenge, computedHash: hash }, 'PKCE verification');
        if (hash !== codeData.codeChallenge) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }
      
      await ddb.send(new DeleteCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Key: { sessionToken: code }
      }));
      
      const accessToken = `token_${randomBytes(32).toString('hex')}`;
      const refreshToken = `refresh_${randomBytes(32).toString('hex')}`;
      
      await ddb.send(new PutCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Item: {
          sessionToken: accessToken,
          type: 'access_token',
          merchantId: codeData.merchantId,
          clientId: client_id,
          ttl: Math.floor(Date.now() / 1000) + 86400, // 24 hours
        }
      }));
      
      await ddb.send(new PutCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Item: {
          sessionToken: refreshToken,
          type: 'refresh_token',
          merchantId: codeData.merchantId,
          clientId: client_id,
          ttl: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
        }
      }));
      
      logger.info({ merchantId: codeData.merchantId, client_id }, 'Token exchange: success — issued access_token');
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 86400,
        refresh_token: refreshToken,
      });

    } else if (grant_type === 'refresh_token') {
       const result = await ddb.send(new GetCommand({
         TableName: TABLE.SETUP_SESSIONS,
         Key: { sessionToken: refresh_token }
       }));
       const rData = result.Item;
       if (!rData || rData.type !== 'refresh_token' || rData.clientId !== client_id) {
         res.status(400).json({ error: 'invalid_grant' });
         return;
       }

       const newAccessToken = `token_${randomBytes(32).toString('hex')}`;
       
       await ddb.send(new PutCommand({
        TableName: TABLE.SETUP_SESSIONS,
        Item: {
          sessionToken: newAccessToken,
          type: 'access_token',
          merchantId: rData.merchantId,
          clientId: client_id,
          ttl: Math.floor(Date.now() / 1000) + 86400,
        }
      }));
      
      res.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: 86400,
        refresh_token: refresh_token,
      });
      
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  }
}
