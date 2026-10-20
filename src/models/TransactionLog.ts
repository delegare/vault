export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'refunded';
export type TransactionRail = 'fiat' | 'crypto';
export type TransactionCurrency = 'usd' | 'usdc' | 'usdt';

export interface TransactionLog {
  // Primary key — globally unique
  receiptId: string;

  // Delegate reference
  mandateId: string; // GSI PK
  ownerId: string;
  ownerEmail?: string; // stored at write time so webhook can send receipt without a mandate lookup

  // Merchant reference
  merchantId: string; // GSI PK
  merchantName: string;

  // Payment details
  rail: TransactionRail;
  amountCents: number;
  currency: TransactionCurrency;
  description: string;
  idempotencyKey: string; // unique per merchantId — enforced via conditional write

  // Status
  status: TransactionStatus;
  failureReason?: string;

  // Fiat
  stripePaymentIntentId?: string;

  // Crypto
  txHash?: string;
  chainId?: number; // 8453 = Base mainnet

  // Rail fallback tracking
  primaryRailAttempted?: TransactionRail;
  railFallbackUsed: boolean;

  // Platform billing
  platformFeeCents: number; // always 1
  platformFeeSettled: boolean;

  // Test Mode
  isTestMode?: boolean;

  // Timestamps — immutable after creation
  requestedAt: string;
  completedAt?: string;

  // Metadata
  metadata?: Record<string, string>;
  agentpayVersion: string;

  // TTL for compliance window (optional)
  ttl?: number;
}
