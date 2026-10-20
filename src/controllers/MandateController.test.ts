import { Request, Response } from 'express';
import { addBuyerWallet } from './MandateController';
import { ddb } from '../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

// We mock the modules that MandateController uses internally
jest.mock('../lib/dynamodb', () => ({
  ddb: { send: jest.fn() },
  TABLE: { MERCHANTS: 'test-merchants' }
}));

jest.mock('./MerchantController', () => {
  const mSvc = {
    getMerchantByEmail: jest.fn(),
    getMerchantByWallet: jest.fn(),
    upsertAutoMerchant: jest.fn(),
  };
  return {
    MerchantService: jest.fn(() => mSvc),
  };
});

jest.mock('../services/CredentialService', () => {
  const cSvc = {
    findActiveMandatesByOwnerId: jest.fn(),
    addPaymentMethodToMandate: jest.fn(),
  };
  return {
    CredentialService: jest.fn(() => cSvc),
  };
});

// Need to explicitly mock generateMerchantName since it's lazily imported
jest.mock('../lib/names', () => ({
  generateMerchantName: jest.fn().mockReturnValue('mock-funny-handle')
}));

describe('MandateController - addBuyerWallet', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let resJson: jest.Mock;
  let resStatus: jest.Mock;
  let merchantSvcMock: any;
  let credSvcMock: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // We import them here to access the mocked instances
    const { MerchantService } = require('./MerchantController');
    const { CredentialService } = require('../services/CredentialService');
    
    merchantSvcMock = new MerchantService();
    credSvcMock = new CredentialService();
    merchantSvcMock.getMerchantByWallet.mockResolvedValue(null); // no existing wallet owner

    resJson = jest.fn();
    resStatus = jest.fn().mockReturnValue({ json: resJson });
    mockReq = {
      body: { walletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260' },
    } as Partial<Request>;
    (mockReq as any).cognitoEmail = 'buyer@test.com';
    mockRes = { status: resStatus, json: resJson } as Partial<Response>;
  });

  it('should successfully add a crypto rail to an existing buyer profile', async () => {
    merchantSvcMock.getMerchantByEmail.mockResolvedValue({
      merchantId: 'primary_buyer_123',
      accountType: 'buyer'
    });
    
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({
      merchantId: 'mock-funny-handle'
    });

    credSvcMock.findActiveMandatesByOwnerId.mockResolvedValue([
      { mandateId: 'mandate_1' },
      { mandateId: 'mandate_2' }
    ]);
    
    (ddb.send as jest.Mock).mockResolvedValue({});

    await addBuyerWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(200);
    expect(resJson).toHaveBeenCalledWith({
      walletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260',
      merchantHandle: 'mock-funny-handle',
      patchedMandateCount: 2
    });

    // Verify step 1: primary account update
    expect(ddb.send).toHaveBeenCalledWith(expect.any(UpdateCommand));
    const updateCall = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(updateCall.input.Key.merchantId).toBe('primary_buyer_123');
    expect(updateCall.input.ExpressionAttributeValues[':w']).toBe('0x3069c484293b7209e672afecfe2705654cdf2260');

    // Verify step 2: funny handle creation
    expect(merchantSvcMock.upsertAutoMerchant).toHaveBeenCalledWith(
      'mock-funny-handle',
      '0x3069c484293b7209e672afecfe2705654cdf2260',
      'buyer@test.com'
    );

    // Verify step 3: mandates patched
    expect(credSvcMock.addPaymentMethodToMandate).toHaveBeenCalledTimes(2);
    expect(credSvcMock.addPaymentMethodToMandate).toHaveBeenCalledWith('mandate_1', {
      smartWalletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260'
    });
  });

  it('should reject wallet already linked to a different buyer (409)', async () => {
    merchantSvcMock.getMerchantByEmail.mockResolvedValue({
      merchantId: 'primary_buyer_123',
      accountType: 'buyer',
    });
    merchantSvcMock.getMerchantByWallet.mockResolvedValue({
      merchantId: 'other_buyer_456',
      contactEmail: 'other@test.com',
    });

    await addBuyerWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(409);
    expect(resJson).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'wallet_already_linked' }),
    );
  });

  it('should return 400 if user is a merchant and not a buyer', async () => {
    merchantSvcMock.getMerchantByEmail.mockResolvedValue({
      merchantId: 'merchant_123',
      accountType: 'merchant' // Incorrect role
    });

    await addBuyerWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith({
      code: 'wrong_account_type',
      message: expect.stringContaining('Merchants connect crypto via')
    });
  });
});
