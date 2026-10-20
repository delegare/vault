#!/usr/bin/env ts-node
/**
 * Migrate per-mandate session keys from Secrets Manager to KMS-encrypted
 * values on the mandate row in DynamoDB.
 *
 * Before:
 *   delegare/{env}/delegates/{mandateId}/crypto  →  JSON {sessionKeyPrivate, ...}
 *   Cost: $0.40 / secret / month.
 *
 * After:
 *   MANDATES.encryptedSessionKey = KMS-encrypted base64 ciphertext
 *   MANDATES.sessionKeyNetwork   = 'base-mainnet' | 'base-sepolia'
 *   Cost: ~$0.  KMS request cost is $0.03 per 10k decrypts (negligible).
 *
 * This script is idempotent:
 *   - Skips mandates that already have `encryptedSessionKey`.
 *   - Skips mandates whose Secrets Manager secret is missing (already migrated
 *     or never existed — e.g. fiat-only mandates).
 *
 * Usage:
 *   pnpm ts-node scripts/migrate-session-keys-to-kms.ts --dry-run
 *   pnpm ts-node scripts/migrate-session-keys-to-kms.ts
 *   pnpm ts-node scripts/migrate-session-keys-to-kms.ts --delete-old-secrets
 *
 * Flags:
 *   --dry-run                Print planned actions, do not mutate anything.
 *   --delete-old-secrets     After successful migration, delete the
 *                            Secrets Manager secret (7-day recovery window).
 *   --limit=N                Process at most N mandates (for staged rollouts).
 *
 * Safe to run repeatedly. Intended to be run once per environment after deploy.
 */

import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import { ddb, TABLE } from '../src/lib/dynamodb';
import { encryptSessionKey } from '../src/services/SessionKeyVault';
import { cryptoDelegateSecretId } from '../src/lib/secrets';
import type { SpendingMandate } from '../src/models/SpendingMandate';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DELETE_OLD = args.includes('--delete-old-secrets');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-2' });

interface MigrationStats {
  scanned: number;
  skippedAlreadyMigrated: number;
  skippedNoSecret: number;
  skippedNonCrypto: number;
  migrated: number;
  oldSecretsDeleted: number;
  errors: number;
}

async function scanAllMandates(): Promise<SpendingMandate[]> {
  const out: SpendingMandate[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE.MANDATES,
      ExclusiveStartKey: lastKey,
    }));

    for (const item of page.Items ?? []) {
      out.push(item as SpendingMandate);
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return out;
}

async function loadOldSecret(mandateId: string): Promise<{ sessionKeyPrivate: string; network?: string } | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({
      SecretId: cryptoDelegateSecretId(mandateId),
    }));
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString);
  } catch (err: unknown) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

async function migrateOne(
  mandate: SpendingMandate,
  stats: MigrationStats,
): Promise<void> {
  // Skip: not a crypto mandate
  if (mandate.rail !== 'crypto' && mandate.rail !== 'both') {
    stats.skippedNonCrypto += 1;
    return;
  }

  // Skip: already migrated
  if (mandate.encryptedSessionKey) {
    stats.skippedAlreadyMigrated += 1;
    return;
  }

  // Load the old Secrets Manager secret
  const old = await loadOldSecret(mandate.mandateId);
  if (!old) {
    stats.skippedNoSecret += 1;
    return;
  }
  if (!old.sessionKeyPrivate?.startsWith('0x')) {
    console.warn(`[skip] mandate=${mandate.mandateId} secret has malformed sessionKeyPrivate`);
    stats.errors += 1;
    return;
  }

  const network: 'base-mainnet' | 'base-sepolia' =
    old.network === 'base-sepolia' ? 'base-sepolia' : 'base-mainnet';

  if (DRY_RUN) {
    console.log(`[dry-run] would migrate mandate=${mandate.mandateId} network=${network}`);
    stats.migrated += 1;
    return;
  }

  // Encrypt with KMS, bound to this mandate's context
  const encryptedSessionKey = await encryptSessionKey(old.sessionKeyPrivate, mandate.mandateId);

  // Write to DynamoDB
  await ddb.send(new UpdateCommand({
    TableName: TABLE.MANDATES,
    Key: { mandateId: mandate.mandateId, userDid: mandate.userDid },
    UpdateExpression: 'SET encryptedSessionKey = :ek, sessionKeyNetwork = :n, updatedAt = :now',
    ConditionExpression: 'attribute_not_exists(encryptedSessionKey)',
    ExpressionAttributeValues: {
      ':ek': encryptedSessionKey,
      ':n': network,
      ':now': new Date().toISOString(),
    },
  }));

  stats.migrated += 1;
  console.log(`[ok] migrated mandate=${mandate.mandateId} network=${network}`);

  // Optionally delete the old secret (7-day recovery window)
  if (DELETE_OLD) {
    try {
      await sm.send(new DeleteSecretCommand({
        SecretId: cryptoDelegateSecretId(mandate.mandateId),
        RecoveryWindowInDays: 7,
      }));
      stats.oldSecretsDeleted += 1;
    } catch (err) {
      console.warn(`[warn] failed to delete old secret for mandate=${mandate.mandateId}:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log(`── Session Key Migration ────────────────────────────────`);
  console.log(`environment: ${process.env.ENVIRONMENT ?? 'dev'}`);
  console.log(`region:      ${process.env.AWS_REGION ?? 'us-east-2'}`);
  console.log(`dry-run:     ${DRY_RUN}`);
  console.log(`delete-old:  ${DELETE_OLD}`);
  console.log(`limit:       ${LIMIT === Infinity ? 'none' : LIMIT}`);
  console.log(``);

  const mandates = await scanAllMandates();
  console.log(`scanned ${mandates.length} mandates total`);

  const stats: MigrationStats = {
    scanned: mandates.length,
    skippedAlreadyMigrated: 0,
    skippedNoSecret: 0,
    skippedNonCrypto: 0,
    migrated: 0,
    oldSecretsDeleted: 0,
    errors: 0,
  };

  let processed = 0;
  for (const mandate of mandates) {
    if (processed >= LIMIT) break;
    try {
      await migrateOne(mandate, stats);
    } catch (err: any) {
      console.error(`[err] mandate=${mandate.mandateId}: ${err.message}`);
      stats.errors += 1;
    }
    processed += 1;
  }

  console.log(``);
  console.log(`── Results ──────────────────────────────────────────────`);
  console.log(`scanned:               ${stats.scanned}`);
  console.log(`migrated:              ${stats.migrated}`);
  console.log(`skipped (already):     ${stats.skippedAlreadyMigrated}`);
  console.log(`skipped (no secret):   ${stats.skippedNoSecret}`);
  console.log(`skipped (non-crypto):  ${stats.skippedNonCrypto}`);
  console.log(`old secrets deleted:   ${stats.oldSecretsDeleted}`);
  console.log(`errors:                ${stats.errors}`);

  if (stats.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
