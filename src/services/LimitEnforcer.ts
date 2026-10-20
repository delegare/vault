import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE } from '../lib/dynamodb';
import { logger } from '../lib/logger';
import { currentMonthKey } from '../lib/tokens';
import type { SpendingMandate } from '../models/SpendingMandate';

export class LimitExceededError extends Error {
  constructor(
    public readonly reason: 'per_tx' | 'monthly' | 'merchant_not_allowed' | 'delegate_inactive' | 'merchant_not_found' | 'merchant_daily_limit_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

interface CheckAndIncrementParams {
  mandate: SpendingMandate;
  amountCents: number;
  merchantId: string;
}

/**
 * Atomically validates spending limits and increments the spend counter.
 * Uses a single DynamoDB conditional update — never read-then-write.
 */
export async function checkAndIncrement(params: CheckAndIncrementParams): Promise<SpendingMandate> {
  const { mandate, amountCents, merchantId } = params;
  const { mandateId, userDid } = mandate;
  const monthKey = currentMonthKey();

  if (mandate.status !== 'active') {
    throw new LimitExceededError('delegate_inactive', `Delegate is ${mandate.status}`);
  }

  if (mandate.expiresAt && new Date(mandate.expiresAt) < new Date()) {
    throw new LimitExceededError('delegate_inactive', 'Delegate has expired');
  }

  if (mandate.allowedMerchantIds && mandate.allowedMerchantIds.length > 0 && !mandate.allowedMerchantIds.includes(merchantId)) {
    throw new LimitExceededError('merchant_not_allowed', `Merchant ${merchantId} is not allowed for this delegate`);
  }

  if (amountCents > mandate.maxAmountPerTxCents) {
    throw new LimitExceededError(
      'per_tx',
      `Amount ${amountCents} cents exceeds per-transaction limit of ${mandate.maxAmountPerTxCents} cents`,
    );
  }

  // Month key may have rolled over — handle reset atomically
  const needsMonthReset = mandate.currentMonthKey !== monthKey;
  const currentSpend = needsMonthReset ? 0 : mandate.currentMonthSpendCents;
  const projectedSpend = currentSpend + amountCents;

  if (projectedSpend > mandate.maxMonthlySpendCents) {
    throw new LimitExceededError(
      'monthly',
      `Charge would exceed monthly limit: ${projectedSpend} > ${mandate.maxMonthlySpendCents} cents`,
    );
  }

  // To prevent race conditions, we assert the max limit against what we read.
  // Because we can't do math in ConditionExpressions, we lock the check 
  // against the specific limit we just read. If another request succeeds first
  // and pushes the DB counter above max, this update will fail because we 
  // calculate the safe ceiling here:
  const allowedCurrentSpendCeiling = mandate.maxMonthlySpendCents - amountCents;

  // Atomic conditional increment — fails if another request snuck in and pushed us over
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MANDATES,
        Key: { mandateId, userDid },
        UpdateExpression: needsMonthReset
          ? 'SET currentMonthSpendCents = :newSpend, currentMonthKey = :monthKey, lastUsedAt = :now'
          : 'SET currentMonthSpendCents = currentMonthSpendCents + :amount, lastUsedAt = :now',
        ConditionExpression: needsMonthReset
          ? '#status = :active AND currentMonthKey <> :monthKey'
          : '#status = :active AND currentMonthKey = :monthKey AND currentMonthSpendCents <= :safeCeiling',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: needsMonthReset
          ? {
              ':active': 'active',
              ':newSpend': amountCents,
              ':monthKey': monthKey,
              ':now': new Date().toISOString(),
            }
          : {
              ':active': 'active',
              ':amount': amountCents,
              ':monthKey': monthKey,
              ':now': new Date().toISOString(),
              ':safeCeiling': allowedCurrentSpendCeiling,
            },
        ReturnValues: 'ALL_NEW',
      }),
    );

    return result.Attributes as SpendingMandate;
  } catch (err: unknown) {
    const awsErr = err as { name?: string };
    if (awsErr.name === 'ConditionalCheckFailedException') {
      throw new LimitExceededError('monthly', 'Monthly limit exceeded (concurrent charge detected)');
    }
    throw err;
  }
}

/**
 * Atomically checks and increments a merchant's daily receive limit.
 * If the dailyReceivedKey doesn't match today, it resets the count to 0 first.
 */
export async function checkAndIncrementMerchantReceiveLimit(merchantId: string, amountCents: number): Promise<void> {
  const getResult = await ddb.send(
    new GetCommand({
      TableName: TABLE.MERCHANTS,
      Key: { merchantId },
    }),
  );

  if (!getResult.Item) {
    throw new LimitExceededError('merchant_not_found', 'Merchant not found');
  }

  const merchant = getResult.Item as any; // Using any to avoid full typing import here if needed, but it has dailyReceiveCapCents
  const cap = merchant.dailyReceiveCapCents || 1000000; // default 10k
  const todayKey = new Date().toISOString().split('T')[0];
  
  const needsDayReset = merchant.dailyReceivedKey !== todayKey;
  const currentReceived = needsDayReset ? 0 : (merchant.dailyReceivedCents || 0);
  const projectedReceive = currentReceived + amountCents;

  if (projectedReceive > cap) {
    throw new LimitExceededError(
      'merchant_daily_limit_exceeded',
      `Transaction would exceed merchant daily receive limit: ${projectedReceive} > ${cap} cents`,
    );
  }

  const allowedCurrentReceiveCeiling = cap - amountCents;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MERCHANTS,
        Key: { merchantId },
        UpdateExpression: needsDayReset
          ? 'SET dailyReceivedCents = :newAmount, dailyReceivedKey = :todayKey'
          : 'SET dailyReceivedCents = dailyReceivedCents + :amount',
        ConditionExpression: needsDayReset
          ? 'attribute_not_exists(dailyReceivedKey) OR dailyReceivedKey <> :todayKey'
          : 'dailyReceivedKey = :todayKey AND dailyReceivedCents <= :safeCeiling',
        ExpressionAttributeValues: needsDayReset
          ? {
              ':newAmount': amountCents,
              ':todayKey': todayKey,
            }
          : {
              ':amount': amountCents,
              ':todayKey': todayKey,
              ':safeCeiling': allowedCurrentReceiveCeiling,
            },
      }),
    );
  } catch (err: unknown) {
    const awsErr = err as { name?: string };
    if (awsErr.name === 'ConditionalCheckFailedException') {
      throw new LimitExceededError('merchant_daily_limit_exceeded', 'Merchant daily limit exceeded (concurrent charge detected)');
    }
    throw err;
  }
}

export async function rollbackMerchantReceiveLimit(merchantId: string, amountCents: number, originalDayKey: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MERCHANTS,
        Key: { merchantId },
        UpdateExpression: 'SET dailyReceivedCents = dailyReceivedCents - :amount',
        ConditionExpression: 'dailyReceivedCents >= :amount AND dailyReceivedKey = :dayKey',
        ExpressionAttributeValues: { 
          ':amount': amountCents,
          ':dayKey': originalDayKey,
        },
      }),
    );
  } catch (err: unknown) {
    const awsErr = err as { name?: string };
    if (awsErr.name === 'ConditionalCheckFailedException') {
      logger.warn({ merchantId, originalDayKey, amountCents }, 'Rollback skipped due to day boundary cross or insufficient recorded volume');
      return;
    }
    logger.error({ err, merchantId, amountCents }, 'Failed to rollback merchant receive limit');
  }
}

export async function rollbackIncrement(mandate: SpendingMandate, amountCents: number, originalMonthKey: string): Promise<void> {
  try {
    const { mandateId, userDid } = mandate;
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE.MANDATES,
        Key: { mandateId, userDid },
        UpdateExpression: 'SET currentMonthSpendCents = currentMonthSpendCents - :amount',
        ConditionExpression: 'currentMonthSpendCents >= :amount AND currentMonthKey = :monthKey',
        ExpressionAttributeValues: { 
          ':amount': amountCents,
          ':monthKey': originalMonthKey,
        },
      }),
    );
  } catch (err: unknown) {
    const awsErr = err as { name?: string };
    if (awsErr.name === 'ConditionalCheckFailedException') {
      logger.warn({ mandateId: mandate.mandateId, originalMonthKey, amountCents }, 'Rollback skipped due to month boundary cross or insufficient spend');
      return;
    }
    logger.error({ err, mandateId: mandate.mandateId, amountCents }, 'Failed to rollback increment');
  }
}
