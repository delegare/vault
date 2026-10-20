import { selectRail, ActiveRail } from './PaymentRouter';
import type { SpendingMandate } from '../models/SpendingMandate';
import type { MerchantAccount } from '../models/MerchantAccount';

describe('PaymentRouter', () => {
  const mockDelegate = (overrides: Partial<SpendingMandate> = {}): SpendingMandate => ({
    mandateId: 'dtok_123',
    ownerId: 'usr_123',
    rail: 'both',
    railPreference: 'auto',
    stripeCustomerId: 'cus_123',
    smartWalletAddress: '0x123',
    maxAmountPerTxCents: 10000,
    maxMonthlySpendCents: 50000,
    currentMonthSpendCents: 0,
    currentMonthKey: '2024-03',
    allowedMerchantIds: [],
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as SpendingMandate);

  const mockMerchant = (overrides: Partial<MerchantAccount> = {}): MerchantAccount => ({
    merchantId: 'm_123',
    status: 'active',
    railRequirement: 'none',
    // selectRail requires the merchant to actually have a receiving method for a
    // rail before it will route there; default both so these tests exercise
    // delegate/currency/preference logic rather than merchant-capability gating.
    stripeConnectedAccountId: 'acct_test_123',
    walletAddress: '0xMerchantWallet',
    ...overrides,
  } as MerchantAccount);

  describe('selectRail', () => {
    it('respects merchant fiat_only constraint', () => {
      const merchant = mockMerchant({ railRequirement: 'fiat_only' });
      const delegate = mockDelegate({ rail: 'crypto' }); // even if delegate is crypto
      expect(selectRail(delegate, merchant, 'usdc', 100)).toBe('fiat');
    });

    it('respects merchant crypto_only constraint', () => {
      const merchant = mockMerchant({ railRequirement: 'crypto_only' });
      const delegate = mockDelegate({ rail: 'fiat' });
      expect(selectRail(delegate, merchant, 'usd', 100)).toBe('crypto');
    });

    it('routes to crypto for usdc/usdt', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate();
      expect(selectRail(delegate, merchant, 'usdc', 100)).toBe('crypto');
      expect(selectRail(delegate, merchant, 'usdt', 100)).toBe('crypto');
    });

    it('routes to fiat for usd when fiat is available', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate();
      expect(selectRail(delegate, merchant, 'usd', 100)).toBe('fiat');
    });

    it('falls through to crypto for usd when fiat is unavailable', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ stripeCustomerId: undefined });
      expect(selectRail(delegate, merchant, 'usd', 100)).toBe('crypto');
    });

    it('respects delegate fiat-only rail', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ rail: 'fiat' });
      expect(selectRail(delegate, merchant, 'auto', 100)).toBe('fiat');
    });

    it('respects delegate crypto-only rail', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ rail: 'crypto' });
      expect(selectRail(delegate, merchant, 'auto', 100)).toBe('crypto');
    });

    it('applies fiat_first preference', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ railPreference: 'fiat_first' });
      expect(selectRail(delegate, merchant, 'auto', 100)).toBe('fiat');
      
      const delegateNoFiat = mockDelegate({ railPreference: 'fiat_first', stripeCustomerId: undefined });
      expect(selectRail(delegateNoFiat, merchant, 'auto', 100)).toBe('crypto');
    });

    it('applies crypto_first preference', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ railPreference: 'crypto_first' });
      expect(selectRail(delegate, merchant, 'auto', 100)).toBe('crypto');
    });

    it('applies auto preference based on amount ($100+)', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ railPreference: 'auto' });
      
      // $99.99 -> fiat
      expect(selectRail(delegate, merchant, 'auto', 9999)).toBe('fiat');
      // $100.00 -> crypto
      expect(selectRail(delegate, merchant, 'auto', 10000)).toBe('crypto');
    });

    it('falls back to fiat if crypto is preferred but unavailable in auto mode', () => {
      const merchant = mockMerchant();
      const delegate = mockDelegate({ railPreference: 'auto', smartWalletAddress: undefined });
      expect(selectRail(delegate, merchant, 'auto', 20000)).toBe('fiat');
    });
  });
});
