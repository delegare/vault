import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamodb';
import { currentMonthKey } from '../lib/tokens';
import { checkAndIncrement, rollbackIncrement, LimitExceededError } from './LimitEnforcer';
import type { SpendingMandate } from '../models/SpendingMandate';

jest.mock('../lib/dynamodb', () => ({
  ddb: {
    send: jest.fn(),
  },
  TABLE: {
    MANDATES: 'test-mandates',
  },
}));

jest.mock('../lib/tokens', () => ({
  currentMonthKey: jest.fn(),
}));

describe('LimitEnforcer', () => {
  const mockDelegate = {
    mandateId: 'test-token',
    userDid: 'did:test:123',
    ownerId: 'owner_123',
    ownerEmail: 'owner@test.com',
    rail: 'fiat',
    status: 'active',
    maxAmountPerTxCents: 1000,
    maxMonthlySpendCents: 5000,
    currentMonthSpendCents: 1000,
    currentMonthKey: '2024-03',
    allowedMerchantIds: [],
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mandateHash: 'hash',
  } as unknown as SpendingMandate;

  beforeEach(() => {
    jest.clearAllMocks();
    (currentMonthKey as jest.Mock).mockReturnValue('2024-03');
  });

  describe('checkAndIncrement', () => {

    it('throws if delegate is inactive', async () => {
      const inactiveDelegate = { ...mockDelegate, status: 'paused' as any };

      await expect(
        checkAndIncrement({ mandate: inactiveDelegate, amountCents: 100, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('delegate_inactive', 'Delegate is paused'));
    });

    it('throws if delegate has expired', async () => {
      const expiredDelegate = { ...mockDelegate, expiresAt: new Date(Date.now() - 10000).toISOString() };

      await expect(
        checkAndIncrement({ mandate: expiredDelegate, amountCents: 100, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('delegate_inactive', 'Delegate has expired'));
    });

    it('throws if merchant is not allowed', async () => {
      const restrictedDelegate = { ...mockDelegate, allowedMerchantIds: ['m2'] };

      await expect(
        checkAndIncrement({ mandate: restrictedDelegate, amountCents: 100, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('merchant_not_allowed', 'Merchant m1 is not allowed for this delegate'));
    });

    it('throws if per-tx limit exceeded', async () => {
      await expect(
        checkAndIncrement({ mandate: mockDelegate, amountCents: 2000, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('per_tx', 'Amount 2000 cents exceeds per-transaction limit of 1000 cents'));
    });

    it('throws if monthly limit exceeded (pre-check)', async () => {
      const nearlyExhaustedDelegate = { ...mockDelegate, currentMonthSpendCents: 4500 };

      await expect(
        checkAndIncrement({ mandate: nearlyExhaustedDelegate, amountCents: 600, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('monthly', 'Charge would exceed monthly limit: 5100 > 5000 cents'));
    });

    it('successfully increments spend atomically', async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: { ...mockDelegate, currentMonthSpendCents: 1100 } });

      const result = await checkAndIncrement({ mandate: mockDelegate, amountCents: 100, merchantId: 'm1' });

      expect(result.currentMonthSpendCents).toBe(1100);
      expect(ddb.send).toHaveBeenCalledTimes(1);
      
      const updateCall = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(updateCall.input.UpdateExpression).toContain('currentMonthSpendCents + :amount');
    });

    it('resets monthly spend if month key changed', async () => {
      (currentMonthKey as jest.Mock).mockReturnValue('2024-04');
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: { ...mockDelegate, currentMonthSpendCents: 100, currentMonthKey: '2024-04' } });

      const result = await checkAndIncrement({ mandate: mockDelegate, amountCents: 100, merchantId: 'm1' });

      expect(result.currentMonthSpendCents).toBe(100);
      expect(result.currentMonthKey).toBe('2024-04');
      
      const updateCall = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(updateCall.input.UpdateExpression).toContain('SET currentMonthSpendCents = :newSpend');
    });

    it('throws monthly limit error if ConditionalCheckFailedException occurs', async () => {
      (ddb.send as jest.Mock).mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' });

      await expect(
        checkAndIncrement({ mandate: mockDelegate, amountCents: 100, merchantId: 'm1' })
      ).rejects.toThrow(new LimitExceededError('monthly', 'Monthly limit exceeded (concurrent charge detected)'));
    });

    it('handles concurrent requests atomically - only one should succeed if budget is limited', async () => {
      // Setup a delegate with $10.00 budget and $0 spent
      const delegate = {
        ...mockDelegate,
        maxMonthlySpendCents: 1000,
        currentMonthSpendCents: 0,
      };

      let updateCalls = 0;
      (ddb.send as jest.Mock).mockImplementation(async (command) => {
        const commandName = command.constructor.name;
        
        if (commandName === 'UpdateCommand') {
          updateCalls++;
          if (updateCalls === 1) {
            return { Attributes: { ...delegate, currentMonthSpendCents: 1000 } };
          }
          throw { name: 'ConditionalCheckFailedException' };
        }
        return {};
      });

      // Fire 10 concurrent $10.00 charges
      const promises = Array(10).fill(null).map(() => 
        checkAndIncrement({ mandate: delegate, amountCents: 1000, merchantId: 'm1' })
      );

      const results = await Promise.allSettled(promises);
      
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      rejected.forEach(r => {
        const error = (r as PromiseRejectedResult).reason;
        if (error.reason !== 'monthly') {
           console.error('Unexpected error reason:', error.reason, 'message:', error.message);
        }
        expect(error).toBeInstanceOf(LimitExceededError);
        expect(error.reason).toBe('monthly');
      });
    });
  });

  describe('rollbackIncrement', () => {
    it('successfully rolls back spend', async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});

      await rollbackIncrement({ mandateId: 'test-token', userDid: 'did:test:123' } as any, 100, '2024-03');

      expect(ddb.send).toHaveBeenCalledWith(expect.any(UpdateCommand));
      const updateCall = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(updateCall.input.UpdateExpression).toContain('currentMonthSpendCents - :amount');
    });

    it('swallows errors during rollback', async () => {
      const { logger } = require('../lib/logger');
      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation();
      
      (ddb.send as jest.Mock).mockRejectedValueOnce(new Error('DB Down'));

      await expect(rollbackIncrement({ mandateId: 'test-token', userDid: 'did:test:123' } as any, 100, '2024-03')).resolves.not.toThrow();
      expect(loggerSpy).toHaveBeenCalled();
      loggerSpy.mockRestore();
    });
  });
});

