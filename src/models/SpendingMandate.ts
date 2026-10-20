export type Rail = 'fiat' | 'crypto' | 'both';
export type RailPreference = 'auto' | 'fiat_first' | 'crypto_first' | 'cheapest' | 'fastest';
export type MandateStatus = 'active' | 'revoked' | 'expired';
export type LimitMode = 'shared' | 'per_rail';
export type RailMismatchBehavior = 'fail_with_error' | 'auto_convert' | 'prompt_user';

export interface SpendingMandate {
  // Primary key
  mandateId: string;            // PK
  userDid: string;              // SK did:key:z6Mk...
  
  ownerId: string;              // internal — for dashboard lookups
  ownerEmail?: string;
  status: MandateStatus;

  // Credential
  encodedMandate: string;       // full SD-JWT-VC
  mandateHash: string;          // SHA-256 of encodedMandate

  // Spending constraints (denormalized for LimitEnforcer)
  maxAmountPerTxCents: number;
  maxMonthlySpendCents: number; // Changed from maxMonthlyCents to match existing references
  allowedMerchantDIDs: string[]; // Or allowedMerchantIds in the short term
  allowedMerchantIds?: string[];
  allowedCurrencies: string[];
  railPreference: RailPreference;
  rail: Rail;
  allowRailFallback: boolean;
  railMismatchBehavior?: RailMismatchBehavior;
  expiresAt: string;

  // Payment method references
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  stripePaymentMethodLast4?: string;
  smartWalletAddress?: string;
  sessionKeyAddress?: string;

  /**
   * KMS-encrypted session key private key (base64 ciphertext).
   * Present only for mandates with crypto rail.
   * Decryption requires the exact encryption context bound to this mandateId —
   * see SessionKeyVault.ts for details.
   */
  encryptedSessionKey?: string;
  /** Network the session key signs for. Defaults to base-mainnet in prod. */
  sessionKeyNetwork?: 'base-mainnet' | 'base-sepolia';

  // Usage tracking
  currentMonthSpendCents: number;
  currentMonthKey: string;
  lastUsedAt?: string;

  // Auto-merchant handle
  merchantHandle?: string;      // sunny-violet-panda

  // AP2 metadata
  ap2Version: '1.0';
  credentialSchema: string;     // AP2 schema URL
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

export type MandatePublicView = Pick<
  SpendingMandate,
  | 'mandateId'
  | 'userDid'
  | 'rail'
  | 'railPreference'
  | 'allowRailFallback'
  | 'railMismatchBehavior'
  | 'maxAmountPerTxCents'
  | 'maxMonthlySpendCents'
  | 'currentMonthSpendCents'
  | 'currentMonthKey'
  | 'status'
  | 'expiresAt'
  | 'allowedMerchantIds'
> & {
  stripePaymentMethodLast4?: string;
  smartWalletAddress?: string; // public address is safe
};
