/**
 * Tests for verifyX402Receipt — the post-settlement receipt verification
 * path that closes the cross-resource receipt replay vulnerability
 * reported in delegare/delegare#1.
 *
 * Each test exercises a different rejection condition. The critical case
 * is "receipt issued for /route-a rejected when replayed against /route-b".
 */

// Mock DynamoDB SDK before importing the service.
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const send = jest.fn();
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send }),
    },
    QueryCommand: jest.fn((input) => ({ __type: 'Query', input })),
    GetCommand: jest.fn((input) => ({ __type: 'Get', input })),
    PutCommand: jest.fn((input) => ({ __type: 'Put', input })),
    UpdateCommand: jest.fn((input) => ({ __type: 'Update', input })),
    __send: send,
  };
});

// Provide minimal ddb client surface for the service.
jest.mock('../../lib/dynamodb', () => {
  const sdk = require('@aws-sdk/lib-dynamodb');
  return {
    ddb: { send: sdk.__send },
    TABLE: {
      TRANSACTIONS: 'test-transactions',
      MANDATES: 'test-mandates',
      MERCHANTS: 'test-merchants',
    },
  };
});

// CredentialService dep — not used by verifyX402Receipt but the module imports cascade.
jest.mock('../../services/CryptoRail', () => ({
  SUPPORTED_TOKENS: {},
  chargeCrypto: jest.fn(),
}));
jest.mock('../../services/LimitEnforcer', () => ({
  checkAndIncrement: jest.fn(),
  LimitExceededError: class extends Error {},
}));

import { verifyX402Receipt, RECEIPT_TTL_MS } from '../../services/x402';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __send: send } = require('@aws-sdk/lib-dynamodb');

const TX = '0xabc123def456';
const RESOURCE_A = '/api/route-a';
const RESOURCE_B = '/api/route-b';
const PAY_TO = '0xMerchantWallet000000000000000000000000';
const PAID_ATOMIC = '50000'; // 0.05 USDC

function buildRecord(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  return {
    receiptId: 'rcpt_test_1',
    txHash: TX,
    status: 'completed',
    payTo: PAY_TO.toLowerCase(),
    resource: RESOURCE_A,
    paidAtomic: PAID_ATOMIC,
    amountCents: 5,
    completedAt: now,
    receiptExpiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
    ...overrides,
  };
}

function mockTxLookup(record: any) {
  send
    .mockImplementationOnce(async () => ({ Items: [{ receiptId: record.receiptId }] })) // Query GSI
    .mockImplementationOnce(async () => ({ Item: record })); // GetItem by receiptId
}

/** Append a successful UpdateCommand response (for the one-time-use consume step). */
function mockConsumeSuccess() {
  send.mockImplementationOnce(async () => ({}));
}

/** Append a ConditionalCheckFailedException response (already consumed). */
function mockConsumeAlreadyConsumed() {
  send.mockImplementationOnce(async () => {
    const err: any = new Error('Conditional check failed');
    err.name = 'ConditionalCheckFailedException';
    throw err;
  });
}

/** Append a transient DDB error response. */
function mockConsumeTransientError() {
  send.mockImplementationOnce(async () => {
    throw new Error('DDB transient error');
  });
}

beforeEach(() => {
  send.mockReset();
});

describe('verifyX402Receipt', () => {
  it('returns isValid=true for a matching receipt within TTL and stamps consumedAt', async () => {
    mockTxLookup(buildRecord());
    mockConsumeSuccess();

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(true);

    // Verify the atomic consume was attempted with the correct
    // ConditionExpression — this is what enforces one-time-use semantics.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    expect(UpdateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { receiptId: 'rcpt_test_1' },
        UpdateExpression: 'SET consumedAt = :now',
        ConditionExpression: 'attribute_not_exists(consumedAt)',
      }),
    );
  });

  // ── One-time-use enforcement (delegare/delegare#2) ─────────────────────
  it('rejects a second verify of a receipt that has already been consumed', async () => {
    mockTxLookup(buildRecord());
    mockConsumeAlreadyConsumed();

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/already consumed|one-time-use/i);
  });

  it('fails closed when the consume update errors transiently', async () => {
    mockTxLookup(buildRecord());
    mockConsumeTransientError();

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    // Transient DDB error must not grant access — fail-closed.
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/consume failed|try again/i);
  });

  // ── THE CRITICAL TEST — cross-resource replay must be rejected ─────────
  it('rejects a receipt issued for /route-a when replayed against /route-b (delegare/delegare#1)', async () => {
    mockTxLookup(buildRecord({ resource: RESOURCE_A }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_B, // attacker tries to replay against /route-b
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/cross-resource replay/i);
  });

  it('rejects when expectedResource is missing (fail-closed)', async () => {
    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: '', // empty
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/resource binding/i);
    // Should not even attempt DynamoDB if input validation fails.
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects when the stored record has no resource (legacy pre-fix)', async () => {
    mockTxLookup(buildRecord({ resource: null }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/legacy record|re-settle/i);
  });

  it('rejects when payTo does not match', async () => {
    mockTxLookup(buildRecord({ payTo: '0xDifferentMerchant000000000000000000000000' }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/payTo/i);
  });

  it('rejects when amount paid is below expectedAmount', async () => {
    mockTxLookup(buildRecord({ paidAtomic: '10000' /* 0.01 USDC */ }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: '50000', // expects 0.05 USDC
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/amount/i);
  });

  it('rejects when the receipt is past TTL', async () => {
    const expired = new Date(Date.now() - 10_000).toISOString(); // 10s in the past
    mockTxLookup(buildRecord({ receiptExpiresAt: expired }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/expired|TTL/i);
  });

  it('rejects when txHash is unknown to the facilitator', async () => {
    send.mockImplementationOnce(async () => ({ Items: [] })); // Query returns nothing

    const result = await verifyX402Receipt({
      transaction: '0xunknowntxhash',
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/not settled|not found/i);
  });

  it('rejects when status is not "completed"', async () => {
    mockTxLookup(buildRecord({ status: 'pending' }));

    const result = await verifyX402Receipt({
      transaction: TX,
      network: 'base',
      expectedPayTo: PAY_TO,
      expectedAmount: PAID_ATOMIC,
      expectedResource: RESOURCE_A,
    });

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/status/i);
  });
});
