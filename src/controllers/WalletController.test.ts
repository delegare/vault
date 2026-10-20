import { Request, Response } from 'express';
import { connectWallet } from './WalletController';
import { ddb } from '../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Mock dependencies
jest.mock('../lib/dynamodb', () => ({
  ddb: { send: jest.fn() },
  TABLE: { MERCHANTS: 'test-merchants', MANDATES: 'test-mandates' }
}));

const mockGetSecret = jest.fn();
jest.mock('../lib/secrets', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
  vaultSecretId: jest.fn(() => 'delegare/dev/vault'),
}));

const mockEncryptSessionKey = jest.fn();
jest.mock('../services/SessionKeyVault', () => ({
  encryptSessionKey: (...args: any[]) => mockEncryptSessionKey(...args),
}));

jest.mock('viem/accounts', () => ({
  generatePrivateKey: jest.fn().mockReturnValue('0xprivatekey'),
  privateKeyToAccount: jest.fn().mockReturnValue({ address: '0xsessionkey' })
}));

// Viem top-level mock so the ops wallet funding block doesn't try to reach the network
jest.mock('viem', () => ({
  createWalletClient: jest.fn(() => ({
    sendTransaction: jest.fn().mockResolvedValue('0xfundhash'),
  })),
  http: jest.fn(),
  parseEther: jest.fn(() => BigInt(1)),
}));

jest.mock('viem/chains', () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

jest.mock('../lib/names', () => ({
  generateMerchantName: jest.fn().mockReturnValue('mock-funny-handle')
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../services/CredentialService', () => {
  const cSvc = {
    getSetupSession: jest.fn(),
    issueIntentMandate: jest.fn()
  };
  return {
    CredentialService: jest.fn(() => cSvc)
  };
});

jest.mock('./MerchantController', () => {
  const mSvc = {
    getMerchantByEmail: jest.fn(),
    getMerchantByWallet: jest.fn(),
    upsertAutoMerchant: jest.fn()
  };
  return {
    MerchantService: jest.fn(() => mSvc)
  };
});

describe('WalletController - connectWallet', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let resStatus: jest.Mock;
  let resJson: jest.Mock;
  let credSvcMock: any;
  let merchantSvcMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    const { CredentialService } = require('../services/CredentialService');
    const { MerchantService } = require('./MerchantController');
    credSvcMock = new CredentialService();
    merchantSvcMock = new MerchantService();

    resJson = jest.fn();
    resStatus = jest.fn().mockReturnValue({ json: resJson });

    mockReq = {
      body: {
        sessionToken: 'valid-session-token',
        walletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260',
        ownerEmail: 'user@test.com'
      }
    };
    mockRes = { status: resStatus, json: resJson } as Partial<Response>;

    mockEncryptSessionKey.mockResolvedValue('base64-kms-ciphertext');
    mockGetSecret.mockResolvedValue({}); // No OPS_WALLET_PRIVATE_KEY — funding block skips
    merchantSvcMock.getMerchantByWallet.mockResolvedValue(null);
  });

  it('should validate the setup session and issue a mandate', async () => {
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'pending' });
    merchantSvcMock.getMerchantByEmail.mockResolvedValue(null);
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({ merchantId: 'mock-funny-handle' });
    credSvcMock.issueIntentMandate.mockResolvedValue({ mandateId: 'mandate_123', userDid: 'did:key:z6Mk...' });
    (ddb.send as jest.Mock).mockResolvedValue({});

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(credSvcMock.getSetupSession).toHaveBeenCalledWith('valid-session-token');
    expect(merchantSvcMock.upsertAutoMerchant).toHaveBeenCalledWith(
      'mock-funny-handle',
      '0x3069c484293b7209e672afecfe2705654cdf2260',
      'user@test.com'
    );
    expect(credSvcMock.issueIntentMandate).toHaveBeenCalledWith({
      sessionToken: 'valid-session-token',
      ownerId: 'mock-funny-handle',
      ownerEmail: 'user@test.com',
      smartWalletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260'
    });

    expect(resStatus).toHaveBeenCalledWith(201);
    expect(resJson).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      intentMandate: 'mandate_123',
      sessionKeyAddress: '0xsessionkey'
    }));
  });

  it('should fallback to using the primary account ID if user already has an account', async () => {
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'pending' });
    merchantSvcMock.getMerchantByEmail.mockResolvedValue({ merchantId: 'existing_account_id' });
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({ merchantId: 'mock-funny-handle' });
    credSvcMock.issueIntentMandate.mockResolvedValue({ mandateId: 'mandate_123', userDid: 'did:key:z6Mk...' });
    (ddb.send as jest.Mock).mockResolvedValue({});

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(merchantSvcMock.upsertAutoMerchant).toHaveBeenCalledWith(
      'mock-funny-handle',
      '0x3069c484293b7209e672afecfe2705654cdf2260',
      'user@test.com'
    );

    expect(credSvcMock.issueIntentMandate).toHaveBeenCalledWith({
      sessionToken: 'valid-session-token',
      ownerId: 'existing_account_id',
      ownerEmail: 'user@test.com',
      smartWalletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260'
    });
  });

  it('should return 400 for invalid setup session', async () => {
    credSvcMock.getSetupSession.mockResolvedValue(null);

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith({
      code: 'invalid_session',
      message: 'Session is invalid or expired'
    });
  });

  // ── Session key generation & storage ─────────────────────────────────────

  it('should KMS-encrypt the session key and write it to the mandate row', async () => {
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'pending' });
    merchantSvcMock.getMerchantByEmail.mockResolvedValue(null);
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({ merchantId: 'mock-funny-handle' });
    credSvcMock.issueIntentMandate.mockResolvedValue({
      mandateId: 'mandate_xyz',
      userDid: 'did:key:z6MkTest',
    });
    (ddb.send as jest.Mock).mockResolvedValue({});

    await connectWallet(mockReq as Request, mockRes as Response);

    // Private key must be encrypted under a mandate-bound encryption context
    expect(mockEncryptSessionKey).toHaveBeenCalledTimes(1);
    expect(mockEncryptSessionKey).toHaveBeenCalledWith('0xprivatekey', 'mandate_xyz');

    // The mandate row must be updated with the encrypted ciphertext and session key metadata
    const updateCalls = (ddb.send as jest.Mock).mock.calls
      .map(c => c[0])
      .filter(cmd => cmd instanceof UpdateCommand);

    const mandateUpdate: any = updateCalls.find((cmd: any) =>
      cmd.input.TableName === 'test-mandates' &&
      cmd.input.Key?.mandateId === 'mandate_xyz'
    );

    expect(mandateUpdate).toBeDefined();
    expect(mandateUpdate.input.Key).toEqual({
      mandateId: 'mandate_xyz',
      userDid: 'did:key:z6MkTest',
    });
    expect(mandateUpdate.input.UpdateExpression).toContain('encryptedSessionKey = :ek');
    expect(mandateUpdate.input.ExpressionAttributeValues[':ek']).toBe('base64-kms-ciphertext');
    expect(mandateUpdate.input.ExpressionAttributeValues[':a']).toBe('0xsessionkey');
  });

  it('should return sessionKeyAddress in the response body', async () => {
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'pending' });
    merchantSvcMock.getMerchantByEmail.mockResolvedValue(null);
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({ merchantId: 'mock-funny-handle' });
    credSvcMock.issueIntentMandate.mockResolvedValue({
      mandateId: 'mandate_abc',
      userDid: 'did:key:z6MkTest',
    });
    (ddb.send as jest.Mock).mockResolvedValue({});

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resJson).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKeyAddress: '0xsessionkey',
        walletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260',
        merchantHandle: 'mock-funny-handle',
      })
    );
  });

  it('should return 400 for invalid wallet address format', async () => {
    mockReq.body.walletAddress = 'not-a-valid-address';

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'validation_error' })
    );
  });

  it('should return 400 for missing required fields', async () => {
    mockReq.body = { sessionToken: 'tok' };

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'validation_error' })
    );
  });

  it('should reject wallet already linked to a different account (409)', async () => {
    merchantSvcMock.getMerchantByWallet.mockResolvedValue({
      merchantId: 'other_buyer',
      contactEmail: 'someone.else@test.com',
    });

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(409);
    expect(resJson).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'wallet_already_linked' }),
    );
    expect(credSvcMock.issueIntentMandate).not.toHaveBeenCalled();
    expect(mockEncryptSessionKey).not.toHaveBeenCalled();
  });

  it('should allow re-linking the same wallet to the same account', async () => {
    merchantSvcMock.getMerchantByWallet.mockResolvedValue({
      merchantId: 'existing_account',
      contactEmail: 'user@test.com',
    });
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'pending' });
    merchantSvcMock.getMerchantByEmail.mockResolvedValue({ merchantId: 'existing_account' });
    merchantSvcMock.upsertAutoMerchant.mockResolvedValue({ merchantId: 'mock-funny-handle' });
    credSvcMock.issueIntentMandate.mockResolvedValue({
      mandateId: 'mandate_relink',
      userDid: 'did:key:z6MkTest',
    });
    (ddb.send as jest.Mock).mockResolvedValue({});

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(201);
  });

  it('should return 400 for expired session (status !== pending)', async () => {
    credSvcMock.getSetupSession.mockResolvedValue({ status: 'completed' });

    await connectWallet(mockReq as Request, mockRes as Response);

    expect(resStatus).toHaveBeenCalledWith(400);
    expect(resJson).toHaveBeenCalledWith({
      code: 'invalid_session',
      message: 'Session is invalid or expired'
    });
  });
});
