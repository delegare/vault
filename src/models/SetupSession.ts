import type { Rail, RailPreference } from './SpendingMandate';

export type SetupSessionStatus = 'pending' | 'complete' | 'expired';

export interface SetupSession {
  // Primary key
  sessionToken: string;

  // Flow type (e.g. 'setup_session' for self-service)
  type?: string;

  // What delegate to create on completion
  merchantId: string;
  requestedRail: Rail;
  requestedRailPreference: RailPreference;
  maxPerTxCents: number;
  maxMonthlySpendCents: number;
  allowedMerchantIds: string[];

  // User context
  ownerEmail?: string;

  // Flow type (default is 'setup')
  mode?: 'setup' | 'add_rail';
  targetMandateId?: string;

  // Result — populated when user completes setup
  status: SetupSessionStatus;
  mandateId?: string;
  encodedMandate?: string;
  ownerId?: string;

  // Timestamps
  createdAt: string;
  completedAt?: string;

  // DynamoDB TTL — 30 minutes from creation
  ttl: number;
}
