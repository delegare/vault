import { createHash } from 'crypto';
import request from 'supertest';

// Mock the MCP server before importing app
jest.mock('@delegare/mcp-server/middleware', () => ({
  mcp: () => (req: any, res: any, next: any) => next(),
}));
jest.mock('@delegare/mcp-server', () => ({
  __esModule: true,
  default: {},
}));

jest.mock('../../services/CredentialService', () => {
  return {
    CredentialService: jest.fn().mockImplementation(() => {
      return {
        verifyIntentMandate: jest.fn().mockImplementation((token) => {
          if (token === 'dtok_missing' || token === 'dtok_inactive') {
            return Promise.reject(new Error('Mandate not found or inactive'));
          }
          return Promise.resolve({
            mandateId: token,
            userDid: 'did:key:z123',
            ownerId: 'u_123',
            status: 'active',
            maxAmountPerTxCents: 10000,
            maxMonthlySpendCents: 50000,
            currentMonthSpendCents: 0,
            currentMonthKey: '2024-03',
            allowedMerchantIds: [],
            rail: 'both',
            railPreference: 'auto',
            stripeCustomerId: 'cus_123',
          });
        })
      };
    })
  };
});

import app from '../../app';
import { ddb, TABLE } from '../../lib/dynamodb';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { chargeFiat } from '../../services/FiatRail';
import { chargeCrypto } from '../../services/CryptoRail';

// Mock the DynamoDB document client
jest.mock('../../lib/dynamodb', () => {
  const actual = jest.requireActual('../../lib/dynamodb');
  return {
    ...actual,
    ddb: {
      send: jest.fn(),
    },
  };
});

// Mock the payment rails to avoid real Stripe/Crypto calls
jest.mock('../../services/FiatRail', () => ({
  chargeFiat: jest.fn(),
}));

jest.mock('../../services/CryptoRail', () => ({
  chargeCrypto: jest.fn(),
}));

import { Server } from 'http';

let server: Server;
beforeAll((done) => {
  server = app.listen(0, done);
});

afterAll((done) => {
  server.close(done);
});

describe('POST /v1/payments/charge Integration', () => {
  const merchantId = 'm_123';
  const apiKey = 'dk_live_oss_example_not_a_secret';
  // Derived from the example key above so the fixture stays consistent without a stored digest.
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const intentMandate = 'dtok_valid_token';

  const merchantHeaders = {
    'x-delegare-merchant-id': merchantId,
    'x-delegare-api-key': apiKey,
    'content-type': 'application/json',
  };

  const mockMandate = {
    mandateId: intentMandate,
    userDid: 'did:key:z123',
    ownerId: 'u_123',
    status: 'active',
    maxAmountPerTxCents: 10000,
    maxMonthlySpendCents: 50000,
    currentMonthSpendCents: 0,
    currentMonthKey: '2024-03',
    allowedMerchantIds: [],
    rail: 'both',
    railPreference: 'auto',
    stripeCustomerId: 'cus_123',
  };

  const mockMerchant = {
    merchantId,
    apiKeyHash,
    status: 'active',
    // selectRail requires the merchant to actually accept a rail; give it a
    // Stripe account so 'usd' charges route to fiat instead of RailMismatch.
    stripeConnectedAccountId: 'acct_test_123',
    maxChargePerTxCents: 1_000_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default ddb.send mocks
    (ddb.send as jest.Mock).mockImplementation(async (command) => {
      const commandName = command.constructor.name;
      
      // Handle Merchant Auth check
      if (commandName === 'GetCommand' && command.input.TableName?.includes('merchants')) {
        return { Item: mockMerchant };
      }
      
      // Handle Mandate check in LimitEnforcer
      if (commandName === 'GetCommand' && command.input.TableName?.includes('mandates')) {
        return { Item: mockMandate };
      }
      
      // Handle Idempotency check (QueryCommand)
      if (commandName === 'QueryCommand' && command.input.TableName?.includes('transactions')) {
        return { Items: [] };
      }

      // Handle other commands (Update, Put)
      return { Attributes: mockMandate };
    });
  });

  describe('Happy Path', () => {
    it('completes a fiat charge successfully', async () => {
      (chargeFiat as jest.Mock).mockResolvedValueOnce({
        status: 'completed',
        stripePaymentIntentId: 'pi_test_123',
      });

      const res = await request(app)
        .post('/v1/payments/charge')
        .set(merchantHeaders)
        .send({
          intentMandate,
          amountCents: 5000,
          currency: 'usd',
          description: 'Monthly Subscription',
          idempotencyKey: 'idem_001',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.receiptId).toMatch(/^rcpt_/);
      expect(res.body.railUsed).toBe('fiat');
      expect(res.body.stripePaymentIntentId).toBe('pi_test_123');
      
      // Verify DynamoDB calls
      expect(ddb.send).toHaveBeenCalledWith(expect.any(PutCommand)); // Save transaction
    });

    it('enforces idempotency — same key returns same receipt', async () => {
      const existingReceipt = {
        receiptId: 'rcpt_exists',
        status: 'completed',
        amountCents: 5000,
        currency: 'usd',
      };
      
      (ddb.send as jest.Mock).mockImplementation(async (command) => {
        const commandName = command.constructor.name;
        if (commandName === 'GetCommand' && command.input.TableName?.includes('merchants')) {
          return { Item: mockMerchant };
        }
        if (commandName === 'QueryCommand' && command.input.TableName?.includes('transactions')) {
          return { Items: [existingReceipt] };
        }
        return { Items: [] };
      });

      const res = await request(app)
        .post('/v1/payments/charge')
        .set(merchantHeaders)
        .send({
          intentMandate,
          amountCents: 5000,
          currency: 'usd',
          description: 'Idempotency test',
          idempotencyKey: 'idem_001',
        });

      expect(res.status).toBe(200);
      expect(res.body.receiptId).toBe('rcpt_exists');
      expect(chargeFiat).not.toHaveBeenCalled();
    });
  });

  describe('Limit Enforcement', () => {
    it('returns 402 when per-tx limit is exceeded', async () => {
      const res = await request(app)
        .post('/v1/payments/charge')
        .set(merchantHeaders)
        .send({
          intentMandate,
          amountCents: 20000, // Exceeds 10000 limit
          currency: 'usd',
          description: 'Limit test',
          idempotencyKey: 'idem_limit',
        });

      expect(res.status).toBe(402);
      expect(res.body.code).toBe('per_tx');
      expect(chargeFiat).not.toHaveBeenCalled();
    });
  });

  describe('Authentication', () => {
    it('returns 401 for invalid merchant credentials', async () => {
      const res = await request(app)
        .post('/v1/payments/charge')
        .set({ ...merchantHeaders, 'x-delegare-api-key': 'wrong' })
        .send({
          intentMandate,
          amountCents: 1000,
          currency: 'usd',
          description: 'Auth test 1',
          idempotencyKey: 'idem_auth',
        });

      expect(res.status).toBe(401);
    });

    it('returns 402 for invalid delegate token (mocked as not found)', async () => {
      (ddb.send as jest.Mock).mockImplementation(async (command) => {
        const commandName = command.constructor.name;
        if (commandName === 'GetCommand' && command.input.TableName?.includes('merchants')) {
          return { Item: mockMerchant };
        }
        if (commandName === 'GetCommand' && command.input.TableName?.includes('delegates')) {
          return { Item: null };
        }
        return { Items: [] };
      });

      const res = await request(app)
        .post('/v1/payments/charge')
        .set(merchantHeaders)
        .send({
          intentMandate: 'dtok_missing',
          amountCents: 1000,
          currency: 'usd',
          description: 'Auth test 2',
          idempotencyKey: 'idem_missing',
        });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_mandate');
    });
  });

  describe('Rail Failures', () => {
    it('handles Stripe decline gracefully', async () => {
      (chargeFiat as jest.Mock).mockResolvedValueOnce({
        status: 'failed',
        failureReason: 'Card declined',
      });

      const res = await request(app)
        .post('/v1/payments/charge')
        .set(merchantHeaders)
        .send({
          intentMandate,
          amountCents: 1000,
          currency: 'usd',
          description: 'Fail test',
          idempotencyKey: 'idem_decline',
        });

      expect(res.status).toBe(402);
      expect(res.body.status).toBe('failed');
      expect(res.body.failureReason).toBe('Card declined');
    });
  });
});
