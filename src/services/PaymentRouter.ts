import type { SpendingMandate } from '../models/SpendingMandate';
import type { MerchantAccount } from '../models/MerchantAccount';

export type ActiveRail = 'fiat' | 'crypto';

export class RailMismatchError extends Error {
  public merchantAccepts: string;
  public delegateHas: string;
  public resolution: 'add_fiat_method' | 'add_crypto_method';
  public targetRail: 'fiat' | 'crypto';

  constructor(merchantAccepts: string, delegateHas: string, targetRail: 'fiat' | 'crypto') {
    super(`This merchant only accepts ${targetRail} payments. Your delegate has ${delegateHas} only.`);
    this.name = 'RailMismatchError';
    this.merchantAccepts = merchantAccepts;
    this.delegateHas = delegateHas;
    this.targetRail = targetRail;
    this.resolution = targetRail === 'fiat' ? 'add_fiat_method' : 'add_crypto_method';
  }
}

export function selectRail(
  delegate: SpendingMandate,
  merchant: MerchantAccount,
  requestedCurrency: string,
  amountCents: number,
): ActiveRail {
  const delegateHasFiat = !!delegate.stripeCustomerId;
  const delegateHasCrypto = !!delegate.smartWalletAddress;

  // What the merchant can actually receive (independent of their railRequirement setting)
  const merchantAcceptsFiat = !!merchant.stripeConnectedAccountId;
  const merchantAcceptsCrypto = !!(merchant.walletAddress || (merchant as any).usdcWalletAddress);

  // Merchant hard constraint always wins
  if (merchant.railRequirement === 'fiat_only') {
    if (!delegateHasFiat) throw new RailMismatchError('fiat_only', delegate.rail, 'fiat');
    if (!merchantAcceptsFiat) throw new RailMismatchError('fiat_only — but merchant has no Stripe account', delegate.rail, 'fiat');
    return 'fiat';
  }

  if (merchant.railRequirement === 'crypto_only') {
    if (!delegateHasCrypto) throw new RailMismatchError('crypto_only', delegate.rail, 'crypto');
    if (!merchantAcceptsCrypto) throw new RailMismatchError('crypto_only — but merchant has no wallet', delegate.rail, 'crypto');
    return 'crypto';
  }

  // Explicit stablecoin request — always crypto, but merchant must have a wallet
  if (['usdc', 'usdt'].includes(requestedCurrency)) {
    if (!merchantAcceptsCrypto) {
      // Merchant has no wallet — if fiat is available on both sides, auto-downgrade
      if (delegateHasFiat && merchantAcceptsFiat) return 'fiat';
      throw new RailMismatchError('any (no crypto wallet configured)', delegate.rail, 'crypto');
    }
    return 'crypto';
  }

  // 'usd' denomination — prefer fiat if both sides support it, else fall through
  if (requestedCurrency === 'usd' && delegateHasFiat && merchantAcceptsFiat) return 'fiat';

  // Single-rail delegate — the mandate literally only has one payment method.
  // No silent cross-rail: a fiat-only mandate has no crypto wallet and vice versa.
  // Throw RailMismatchError so the caller can prompt the user to create a new
  // mandate with the required rail (via setup_fiat_mandate or initiate_payment_setup).
  if (delegate.rail === 'fiat') {
    if (merchantAcceptsFiat) return 'fiat';
    // Merchant has no Stripe but accepts crypto — buyer needs a crypto mandate
    throw new RailMismatchError(
      merchantAcceptsCrypto ? 'crypto_only (no Stripe connected)' : 'none',
      'fiat',
      'crypto',
    );
  }
  if (delegate.rail === 'crypto') {
    if (merchantAcceptsCrypto) return 'crypto';
    // Merchant has no wallet but accepts fiat — buyer needs a fiat mandate
    throw new RailMismatchError(
      merchantAcceptsFiat ? 'fiat_only (no crypto wallet)' : 'none',
      'crypto',
      'fiat',
    );
  }

  // Both rails on delegate — pick best mutual rail, apply user preference
  const canFiat = delegateHasFiat && merchantAcceptsFiat;
  const canCrypto = delegateHasCrypto && merchantAcceptsCrypto;

  if (!canFiat && !canCrypto) {
    throw new RailMismatchError('none', delegate.rail, 'fiat');
  }

  switch (delegate.railPreference) {
    case 'fiat_first':
      return canFiat ? 'fiat' : 'crypto';

    case 'crypto_first':
      return canCrypto ? 'crypto' : 'fiat';

    case 'cheapest':
      // Crypto (Base L2) gas is ~$0.001 — nearly always cheaper
      return canCrypto ? 'crypto' : 'fiat';

    case 'fastest':
      // Base ~2s, Stripe ~1-3s — similar, prefer fiat for familiarity
      return canFiat ? 'fiat' : 'crypto';

    case 'auto':
    default:
      // Auto: use crypto for large amounts ($100+), fiat for small
      if (amountCents >= 10_000 && canCrypto) return 'crypto';
      return canFiat ? 'fiat' : 'crypto';
  }
}

export function getFallbackRail(primary: ActiveRail): ActiveRail {
  return primary === 'fiat' ? 'crypto' : 'fiat';
}
