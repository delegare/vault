import { Request, Response } from 'express';
import { PutCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamodb';
import { generateReceiptId } from '../lib/tokens';
import { checkAndIncrement, rollbackIncrement, LimitExceededError, checkAndIncrementMerchantReceiveLimit, rollbackMerchantReceiveLimit } from '../services/LimitEnforcer';
import { selectRail, getFallbackRail } from '../services/PaymentRouter';
import { chargeFiat } from '../services/FiatRail';
import { chargeCrypto } from '../services/CryptoRail';
import { MerchantService } from './MerchantController';
import { CredentialService } from '../services/CredentialService';
import { charge } from './PaymentController';

jest.mock('../lib/dynamodb', () => ({
  ddb: {
    send: jest.fn(),
  },
  TABLE: {
    TRANSACTIONS: 'test-transactions',
    MANDATES: 'test-mandates',
  },
}));

jest.mock('../lib/tokens', () => ({
  generateReceiptId: jest.fn(),
}));

jest.mock('../services/LimitEnforcer', () => ({
  checkAndIncrement: jest.fn(),
  rollbackIncrement: jest.fn(),
  checkAndIncrementMerchantReceiveLimit: jest.fn(),
  rollbackMerchantReceiveLimit: jest.fn(),
  LimitExceededError: class extends Error {
    constructor(public reason: string, message: string) {
      super(message);
    }
  },
}));

jest.mock('../services/PaymentRouter', () => ({
  selectRail: jest.fn(),
  getFallbackRail: jest.fn(),
  RailMismatchError: class extends Error {
    public targetRail = 'fiat';
    public resolution = 'add_fiat_method';
    public merchantAccepts = 'fiat_only';
    public delegateHas = 'crypto';
    constructor() {
      super('Rail mismatch');
    }
  }
}));

jest.mock('../services/FiatRail', () => ({
  chargeFiat: jest.fn(),
}));

jest.mock('../services/CryptoRail', () => ({
  chargeCrypto: jest.fn(),
}));

jest.mock('./MerchantController');
// Do not use jest.mock for CredentialService, use spyOn instead.

describe('PaymentController', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock the CredentialService to bypass JWT validation
    jest.spyOn(CredentialService.prototype, 'verifyIntentMandate').mockResolvedValue({
      mandateId: 'dtok_123',
      userDid: 'did:key:z123',
      ownerId: 'o1',
      ownerEmail: 'user@example.com',
      currentMonthSpendCents: 0,
      currentMonthKey: '2024-03',
      maxAmountPerTxCents: 10000,
      maxMonthlySpendCents: 50000,
      rail: 'both',
      railPreference: 'auto',
      allowRailFallback: true,
      allowedCurrencies: ['usd'],
      allowedMerchantDIDs: [],
      status: 'active',
      expiresAt: '2099-01-01T00:00:00.000Z',
      encodedMandate: '...',
      mandateHash: '...',
      ap2Version: '1.0',
      credentialSchema: '...',
      createdAt: '...',
      updatedAt: '...'
    });

    mockReq = {
      body: {
        intentMandate: 'dtok_123',
        amountCents: 1000,
        currency: 'usd',
        description: 'Test Charge',
        idempotencyKey: 'idemp_123',
      },
    };
    (mockReq as any).merchantId = 'm1';
    (mockReq as any).isTestMode = true;
    
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    (generateReceiptId as jest.Mock).mockReturnValue('rcpt_123');

    // Default mock for getMerchant
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      maxChargePerTxCents: 5000,
      billingStripeCustomerId: 'cus_123',
      name: 'Test Merchant',
      contactEmail: 'merchant@example.com'
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 on validation error', async () => {
    mockReq.body.amountCents = -1;
    await charge(mockReq as Request, mockRes as Response);
    expect(mockRes.status).toHaveBeenCalledWith(400);
  });

  it('returns 422 on self-payment attempt', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm1',
      status: 'active',
      contactEmail: 'user@example.com'
    });

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(422);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'self_payment_not_allowed' })
    }));
  });
  it('returns existing receipt on idempotency hit', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      contactEmail: 'other@example.com'
    });

    const existingLog = { receiptId: 'rcpt_old', status: 'completed', amountCents: 1000, currency: 'usd' };
    (ddb.send as jest.Mock).mockResolvedValue({ Items: [existingLog] }); // Used mockResolvedValue instead of Once
    
    // Just in case it falls through, prevent TypeError
    (chargeFiat as jest.Mock).mockResolvedValue({ status: 'completed', stripePaymentIntentId: 'pi_123' });
    (chargeCrypto as jest.Mock).mockResolvedValue({ status: 'completed', txHash: '0x123' });

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 'rcpt_old' }));
    expect(checkAndIncrement).not.toHaveBeenCalled();
  });

  it('returns 402 on LimitExceededError', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      contactEmail: 'other@example.com'
    });

    (ddb.send as jest.Mock).mockResolvedValue({});

    (checkAndIncrement as jest.Mock).mockRejectedValueOnce(new LimitExceededError('per_tx', 'Limit exceeded'));

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'per_tx' }));
  });

  it('successfully charges on fiat rail', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      contactEmail: 'other@example.com',
      maxChargePerTxCents: 5000,
      billingStripeCustomerId: 'cus_123',
      name: 'Other Merchant'
    });
    
    (ddb.send as jest.Mock).mockResolvedValue({}); // default mock for everything

    (checkAndIncrement as jest.Mock).mockResolvedValue({ ownerId: 'o1' });
    (selectRail as jest.Mock).mockReturnValue('fiat');
    (chargeFiat as jest.Mock).mockResolvedValueOnce({ status: 'completed', stripePaymentIntentId: 'pi_123' });

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', stripePaymentIntentId: 'pi_123' }));
  });

  it('falls back to crypto if fiat fails', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      contactEmail: 'other@example.com',
      maxChargePerTxCents: 5000,
      billingStripeCustomerId: 'cus_123'
    });

    (ddb.send as jest.Mock).mockResolvedValue({});

    (checkAndIncrement as jest.Mock).mockResolvedValue({ 
      ownerId: 'o1', 
      allowRailFallback: true, 
      rail: 'both' 
    });
    (selectRail as jest.Mock).mockReturnValue('fiat');
    (getFallbackRail as jest.Mock).mockReturnValue('crypto');
    (chargeFiat as jest.Mock).mockResolvedValueOnce({ status: 'failed', failureReason: 'Card declined' });
    (chargeCrypto as jest.Mock).mockResolvedValueOnce({ status: 'completed', txHash: '0x123' });

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', txHash: '0x123', railFallbackUsed: true }));
  });

  it('rolls back and returns 402 if all rails fail', async () => {
    (MerchantService.prototype.getMerchant as jest.Mock).mockResolvedValue({
      merchantId: 'm2',
      status: 'active',
      contactEmail: 'other@example.com',
      maxChargePerTxCents: 5000,
      billingStripeCustomerId: 'cus_123'
    });
    
    (ddb.send as jest.Mock).mockResolvedValue({});

    (checkAndIncrement as jest.Mock).mockResolvedValue({ ownerId: 'o1' });
    (selectRail as jest.Mock).mockReturnValue('fiat');
    (chargeFiat as jest.Mock).mockResolvedValueOnce({ status: 'failed', failureReason: 'Card declined' });
    (getFallbackRail as jest.Mock).mockReturnValue(null); // No fallback

    await charge(mockReq as Request, mockRes as Response);

    expect(mockRes.status).toHaveBeenCalledWith(402);
    expect(rollbackIncrement).toHaveBeenCalled();
  });
});

