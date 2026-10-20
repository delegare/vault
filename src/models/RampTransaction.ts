export type RampType = 'onramp' | 'offramp';
export type RampStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type RampProvider = 'coinbase' | 'stripe';

export interface RampTransaction {
  // Primary key
  rampId: string;              // ramp_...
  ownerId: string;             // GSI: merchantId or buyerId

  type: RampType;
  status: RampStatus;
  provider: RampProvider;

  // Amounts
  amountCents: number;         // fiat amount in cents
  amountUsdc: number;          // USDC amount (6 decimal precision * 1e6)
  delegareFeeCents: number;    // always 30
  providerFeeCents: number;    // actual provider fee (filled on completion webhook)
  fxRate: number;              // USD/USDC rate at execution time

  // Onramp fields
  destinationWallet?: string;  // buyer's smart wallet
  onChainTxHash?: string;      // Base tx hash after delivery

  // Offramp fields
  sourceWallet?: string;       // merchant's USDC wallet
  bankAccountId?: string;      // Stripe bank account or Coinbase ACH
  estimatedArrival?: string;   // "1-2 business days"

  // Provider reference
  providerRampId: string;      // Coinbase ramp ID or Stripe transfer ID

  // Links
  mandateId?: string;          // if onramp linked to a mandate
  merchantId?: string;         // if offramp for a merchant payment settlement
  receiptId?: string;          // if triggered by a payment settlement

  // Lifecycle
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
  ttl: number;                 // 90 days
}
