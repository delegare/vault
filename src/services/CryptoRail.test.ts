import { chargeCrypto, SUPPORTED_TOKENS } from './CryptoRail';
import type { SpendingMandate } from '../models/SpendingMandate';

// ── Module mocks ─────────────────────────────────────────────────────────────

const mockReadContract = jest.fn();
const mockWriteContract = jest.fn();
const mockWaitForTransactionReceipt = jest.fn();

jest.mock('viem', () => ({
  createWalletClient: jest.fn(() => ({ writeContract: mockWriteContract })),
  createPublicClient: jest.fn(() => ({
    readContract: mockReadContract,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
    getBalance: jest.fn().mockResolvedValue(BigInt(10_000_000_000_000_000)),
  })),
  http: jest.fn(),
  parseEther: jest.fn((v: string) => BigInt(Number(v) * 1e18)),
  formatEther: jest.fn((v: bigint) => String(Number(v) / 1e18)),
}));

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: jest.fn().mockReturnValue({
    address: '0xSessionKeyAddress',
  }),
}));

jest.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

const mockGetSecret = jest.fn();
jest.mock('../lib/secrets', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
  vaultSecretId: jest.fn(() => 'delegare/dev/vault'),
}));

const mockDecryptSessionKey = jest.fn();
jest.mock('./SessionKeyVault', () => ({
  decryptSessionKey: (...args: any[]) => mockDecryptSessionKey(...args),
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

const DUMMY_CIPHERTEXT = 'AQICAHiFakeKMSCiphertextBase64';
const DUMMY_SESSION_KEY = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeMockMandate(overrides: Partial<SpendingMandate> = {}): SpendingMandate {
  return {
    mandateId: 'mandate_test_123',
    userDid: 'did:key:z6Mk...',
    ownerId: 'buyer_123',
    ownerEmail: 'buyer@test.com',
    status: 'active',
    encodedMandate: '...',
    mandateHash: '...',
    maxAmountPerTxCents: 5000,
    maxMonthlySpendCents: 50000,
    allowedMerchantDIDs: [],
    allowedCurrencies: ['usd', 'usdc'],
    railPreference: 'auto',
    rail: 'crypto',
    allowRailFallback: false,
    expiresAt: '2099-01-01T00:00:00Z',
    smartWalletAddress: '0x3069c484293b7209e672afecfe2705654cdf2260',
    encryptedSessionKey: DUMMY_CIPHERTEXT,
    sessionKeyNetwork: 'base-sepolia',
    currentMonthSpendCents: 0,
    currentMonthKey: '2025-04',
    ap2Version: '1.0',
    credentialSchema: '...',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  } as SpendingMandate;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CryptoRail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENVIRONMENT = 'dev';
    // Default: decryption succeeds
    mockDecryptSessionKey.mockResolvedValue(DUMMY_SESSION_KEY);
    // Default: vault secrets resolve to empty (router address missing unless set)
    mockGetSecret.mockResolvedValue({});
  });

  describe('SUPPORTED_TOKENS', () => {
    it('should define USDC and USDT with 6 decimals', () => {
      expect(SUPPORTED_TOKENS.usdc.decimals).toBe(6);
      expect(SUPPORTED_TOKENS.usdt.decimals).toBe(6);
      expect(SUPPORTED_TOKENS.usdc.symbol).toBe('USDC');
      expect(SUPPORTED_TOKENS.usdt.symbol).toBe('USDT');
    });

    it('should have valid mainnet and testnet addresses', () => {
      expect(SUPPORTED_TOKENS.usdc.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(SUPPORTED_TOKENS.usdc.testnetAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(SUPPORTED_TOKENS.usdt.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('chargeCrypto — input validation', () => {
    it('should fail if delegate has no smartWalletAddress', async () => {
      const result = await chargeCrypto({
        delegate: makeMockMandate({ smartWalletAddress: undefined }),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('No crypto wallet');
    });

    it('should fail if amountCents is zero or negative', async () => {
      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 0,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('positive integer');
    });

    it('should fail if amountCents is not an integer', async () => {
      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 10.5,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('positive integer');
    });
  });

  describe('chargeCrypto — session key loading', () => {
    it('should fail when the mandate has no encryptedSessionKey', async () => {
      const result = await chargeCrypto({
        delegate: makeMockMandate({ encryptedSessionKey: undefined }),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('custodial session keys');
      expect(mockDecryptSessionKey).not.toHaveBeenCalled();
    });

    it('should fail gracefully when KMS decryption throws', async () => {
      mockDecryptSessionKey.mockRejectedValueOnce(new Error('InvalidCiphertextException'));

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('Could not decrypt');
    });

    it('should call decryptSessionKey with the mandate ciphertext and mandateId', async () => {
      // Force failure after decrypt to avoid running full tx flow
      mockReadContract.mockResolvedValueOnce(0); // token not whitelisted

      await chargeCrypto({
        delegate: makeMockMandate({ mandateId: 'mandate_abc' }),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(mockDecryptSessionKey).toHaveBeenCalledWith(DUMMY_CIPHERTEXT, 'mandate_abc');
    });
  });

  describe('chargeCrypto — router resolution', () => {
    it('should fail if no valid router address is available on mainnet', async () => {
      delete process.env.DELEGARE_ROUTER_MAINNET;
      process.env.ENVIRONMENT = 'prod';

      const result = await chargeCrypto({
        delegate: makeMockMandate({ sessionKeyNetwork: 'base-mainnet' }),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: false,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('No valid DelegareRouter address');
    });
  });

  describe('chargeCrypto — pre-flight checks', () => {
    it('should fail if token is not whitelisted on the router', async () => {
      mockReadContract.mockResolvedValueOnce(0); // supportedTokenDecimals returns 0

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('not whitelisted');
    });

    it('should fail if ERC-20 allowance is insufficient', async () => {
      mockReadContract
        .mockResolvedValueOnce(6) // supportedTokenDecimals = 6
        .mockResolvedValueOnce(BigInt(0)); // allowance = 0

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('Insufficient ERC-20 allowance');
    });

    it('should pass pre-flight when allowance is exactly sufficient', async () => {
      // $10.00 ≥ $1.00 → flat 3¢ fee → $10.03 = 10_030_000 base units
      const requiredUnits = BigInt(10030000);
      mockReadContract
        .mockResolvedValueOnce(6) // token whitelisted
        .mockResolvedValueOnce(requiredUnits); // exact allowance

      mockWriteContract.mockResolvedValueOnce('0xtxhash123');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('completed');
      expect(result.txHash).toBe('0xtxhash123');
    });
  });

  describe('chargeCrypto — transaction execution', () => {
    beforeEach(() => {
      mockReadContract
        .mockResolvedValueOnce(6) // token whitelisted
        .mockResolvedValueOnce(BigInt(999_999_999_999)); // huge allowance
    });

    it('should successfully execute a $19.99 USDC payment with flat 3¢ fee', async () => {
      mockWriteContract.mockResolvedValueOnce('0xSuccessTx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1999,
        currency: 'usdc',
        recipientAddress: '0xMerchantWallet',
        isTestMode: true,
      });

      expect(result.status).toBe('completed');
      expect(result.txHash).toBe('0xSuccessTx');
      expect(result.chainId).toBe(84532); // Base Sepolia

      const writeArgs = mockWriteContract.mock.calls[0][0];
      expect(writeArgs.functionName).toBe('payMerchant');
      expect(writeArgs.args[3]).toBe(BigInt(19_990_000)); // amount
      expect(writeArgs.args[4]).toBe(BigInt(30_000)); // flat 3¢ fee
    });

    it('should return failed when on-chain tx reverts', async () => {
      mockWriteContract.mockResolvedValueOnce('0xRevertedTx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 500,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('reverted');
    });

    it('should handle writeContract throwing an error', async () => {
      mockWriteContract.mockRejectedValueOnce(new Error('execution reverted: InsufficientAllowance'));

      const result = await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 500,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('InsufficientAllowance');
    });
  });

  describe('chargeCrypto — tiered fee model (floor 0.5¢, 3% < $1, flat 3¢ ≥ $1)', () => {
    beforeEach(() => {
      mockReadContract
        .mockResolvedValueOnce(6) // whitelisted
        .mockResolvedValueOnce(BigInt(999_999_999_999)); // huge allowance
      mockWriteContract.mockResolvedValueOnce('0xConvertTx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });
    });

    it('should apply $0.005 floor for micro-transaction (1¢) where 3% would be below floor', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 1,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(10_000)); // 1¢ = 10,000 units
      expect(args[4]).toBe(BigInt(5_000)); // floor: $0.005 = 5,000 units (3% of 1¢ = 300 < floor)
    });

    it('should apply $0.005 floor at 16¢ (3% = $0.0048 < floor)', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 16,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(160_000)); // 16¢
      expect(args[4]).toBe(BigInt(5_000)); // floor kicks in (3% = 4,800 < 5,000)
    });

    it('should apply 3% at 17¢ (3% = $0.0051 > floor)', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 17,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(170_000)); // 17¢
      expect(args[4]).toBe(BigInt(5_100)); // 3% of 170,000 = 5,100 (above floor)
    });

    it('should apply 3% fee for 50¢ transaction', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 50,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(500_000)); // 50¢
      expect(args[4]).toBe(BigInt(15_000)); // 3% = 1.5¢
    });

    it('should apply flat 3¢ fee at exactly $1.00 (crossover point)', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 100,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(1_000_000)); // $1.00
      expect(args[4]).toBe(BigInt(30_000)); // flat 3¢
    });

    it('should apply flat 3¢ fee for $100.00 transaction', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 10000,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(100_000_000)); // $100.00
      expect(args[4]).toBe(BigInt(30_000)); // still flat 3¢
    });

    it('should round fee up (ceil) for non-exact percentages', async () => {
      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 33,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[3]).toBe(BigInt(330_000)); // 33¢
      expect(args[4]).toBe(BigInt(9_900)); // 3% of 330,000 = 9,900
    });
  });

  describe('chargeCrypto — testnet vs mainnet routing', () => {
    it('should use testnet token address in test mode', async () => {
      mockReadContract
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(BigInt(999_999_999_999));
      mockWriteContract.mockResolvedValueOnce('0xTestnetTx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

      await chargeCrypto({
        delegate: makeMockMandate(),
        amountCents: 100,
        currency: 'usdc',
        recipientAddress: '0xMerchant',
        isTestMode: true,
      });

      const args = mockWriteContract.mock.calls[0][0].args;
      expect(args[0]).toBe(SUPPORTED_TOKENS.usdc.testnetAddress);
    });
  });
});
