import { Request, Response, NextFunction } from 'express';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { ddb, TABLE } from '../lib/dynamodb';
import { logger } from '../lib/logger';
import type { AuthedRequest } from '../types/express';

const WINDOW_S = 60;
const MAX_REQUESTS_DEFAULT = 100;
const MAX_REQUESTS_CHARGE = 20;
const MAX_REQUESTS_PER_DELEGATE = 10;

function limit(maxRequests: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Use merchantId if set (post-auth), fall back to IP
    const identifier = (req as AuthedRequest).merchantId ?? req.ip ?? 'unknown';
    
    // Fixed window key: identifier:path:window_timestamp
    const nowS = Math.floor(Date.now() / 1000);
    const windowStart = nowS - (nowS % WINDOW_S);
    const key = `${identifier}:${req.path}:${windowStart}`;

    try {
      const result = await ddb.send(
        new UpdateCommand({
          TableName: TABLE.RATE_LIMITS,
          Key: { id: key },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :inc, #ttl = :ttl',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':inc': 1,
            ':zero': 0,
            ':ttl': windowStart + WINDOW_S + 3600, // Keep in DB for 1 hour for analysis, but TTL handles cleanup
          },
          ReturnValues: 'ALL_NEW',
        }),
      );

      const count = result.Attributes?.['count'] as number;
      const resetAt = windowStart + WINDOW_S;

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
      res.setHeader('X-RateLimit-Reset', resetAt);

      if (count > maxRequests) {
        logger.warn({ identifier, path: req.path, count, maxRequests }, 'Rate limit exceeded');
        res.status(429).json({
          code: 'rate_limit_exceeded',
          message: `Too many requests. Limit is ${maxRequests} per minute.`,
        });
        return;
      }

      next();
    } catch (err) {
      logger.error({ err }, '[RateLimiter] DynamoDB error');
      // Fail open in case of DB issues to avoid blocking all traffic, 
      // but log it prominently.
      next();
    }
  };
}

/**
 * Specifically limits the number of times a single delegate token can be used 
 * to attempt charges within a window. This prevents brute force token guessing 
 * or runaway agents draining small amounts instantly.
 */
function limitDelegate(maxRequests: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const mandateId = req.body?.mandateId;
    if (!mandateId || typeof mandateId !== 'string') {
      // If there's no delegate token, the actual endpoint validation will fail it anyway.
      // We just pass it through here.
      return next();
    }

    // Hash the token so we don't store raw sensitive tokens in the rate limit table
    const tokenHash = createHash('sha256').update(mandateId).digest('hex').substring(0, 16);
    
    const nowS = Math.floor(Date.now() / 1000);
    const windowStart = nowS - (nowS % WINDOW_S);
    const key = `delegate:${tokenHash}:${req.path}:${windowStart}`;

    try {
      const result = await ddb.send(
        new UpdateCommand({
          TableName: TABLE.RATE_LIMITS,
          Key: { id: key },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :inc, #ttl = :ttl',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':inc': 1,
            ':zero': 0,
            ':ttl': windowStart + WINDOW_S + 3600,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );

      const count = result.Attributes?.['count'] as number;

      if (count > maxRequests) {
        logger.warn({ tokenHash, path: req.path, count, maxRequests }, 'Delegate token rate limit exceeded');
        res.status(429).json({
          code: 'rate_limit_exceeded',
          message: `Too many charge attempts for this delegate token. Try again in 60 seconds.`,
        });
        return;
      }

      next();
    } catch (err) {
      logger.error({ err }, '[DelegateRateLimiter] DynamoDB error');
      next();
    }
  };
}

export const defaultRateLimit = limit(MAX_REQUESTS_DEFAULT);
export const chargeRateLimit = limit(MAX_REQUESTS_CHARGE);
export const delegateChargeRateLimit = limitDelegate(MAX_REQUESTS_PER_DELEGATE);
