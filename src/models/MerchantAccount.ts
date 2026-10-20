export type MerchantStatus = 'active' | 'suspended';
export type MerchantRailRequirement = 'any' | 'fiat_only' | 'crypto_only';
export type PlatformTrustLevel = 'new' | 'verified' | 'trusted';
export type AccountType = 'merchant' | 'buyer';

export interface MerchantAccount {
  // Primary key
  merchantId: string;

  // Account type — discriminator. 'merchant' is the default for legacy rows
  // that don't have this field set. Buyers use the same table/columns but
  // with accountType='buyer', no API keys, and a different UI in the dashboard.
  accountType?: AccountType;

  // Identity
  name: string;
  contactEmail: string;

  // Social / P2P Auto-created
  autoCreated?: boolean;
  walletAddress?: string;
  twitterHandle?: string;
  platformFee?: number; // fee passed on to sender

  // Config
  webhookUrl?: string;
  webhookSecret?: string;
  allowedOrigins: string[];
  maxChargePerTxCents: number;
  railRequirement: MerchantRailRequirement;

  // Platform Risk Controls
  platformTrustLevel?: PlatformTrustLevel;
  dailyReceiveCapCents?: number; // e.g. $10,000/day during beta
  dailyReceivedCents?: number;   // resets at midnight
  dailyReceivedKey?: string;     // YYYY-MM-DD

  // Billing — AgentPay charges merchant 1¢/tx via metered billing
  billingStripeCustomerId: string;
  billingStripeSubscriptionItemId: string;

  // Auth. Optional because pure buyer rows (fiat-only card-on-file users) don't
  // have API keys — they authenticate via Cognito, not dk_live_ bearer tokens.
  // P2P merchants and registered merchants always have it set.
  apiKeyHash?: string; // Live API key, only hashed
  testApiKey?: string; // Test API key, stored in plaintext for dashboard convenience

  // Integrations
  stripeConnectedAccountId?: string; // Merchants only — Stripe Connect (receives money)
  usdcWalletAddress?: string; // If they connect USDC (sends + receives P2P)

  // Buyer-side fiat: Stripe Customer + saved card-on-file (sends only).
  // Populated via Stripe Checkout in mode='setup' (SetupIntent + Link),
  // never via Stripe Connect OAuth. Distinct from billingStripeCustomerId
  // (which is the AgentPay metered-billing customer for *merchants*).
  stripeBuyerCustomerId?: string;
  stripeBuyerPaymentMethodId?: string;
  stripeBuyerPaymentMethodLast4?: string;

  // Stats — denormalized counters
  totalTransactions: number;
  totalVolumeCents: number;

  // The funny handle (e.g. sunny-violet-panda) synced to the primary account
  merchantHandle?: string;

  // Bazaar / agentic.market discovery metadata
  websiteUrl?: string;      // e.g. "https://example.com"
  logoUrl?: string;         // publicly accessible image URL
  category?: string;        // e.g. "financial-services", "agent-payments"
  serviceDescription?: string; // short pitch for Bazaar listing

  // Auto-offramp — automatically sweep USDC to bank after each settlement
  autoOfframp?: boolean;
  autoOfframpProvider?: 'stripe' | 'coinbase';
  autoOfframpBankAccountId?: string;    // Stripe ba_... or Coinbase ACH
  autoOfframpThresholdCents?: number;   // only sweep if settlement >= threshold (0 = always)

  // Lifecycle
  status: MerchantStatus;
  createdAt: string;
  updatedAt: string;
}

// Safe to return via API
export type MerchantPublicView = Pick<
  MerchantAccount,
  | 'merchantId'
  | 'name'
  | 'allowedOrigins'
  | 'webhookUrl'
  | 'webhookSecret'
  | 'maxChargePerTxCents'
  | 'railRequirement'
  | 'totalTransactions'
  | 'totalVolumeCents'
  | 'status'
  | 'createdAt'
> & Partial<Pick<MerchantAccount, 'autoCreated' | 'walletAddress' | 'twitterHandle' | 'testApiKey' | 'stripeConnectedAccountId' | 'usdcWalletAddress' | 'merchantHandle'>>;
