/**
 * SessionKeyVault — KMS-backed envelope encryption for per-mandate session keys.
 *
 * Prior art: session keys were stored one-per-secret in AWS Secrets Manager at
 * `delegare/{env}/delegates/{mandateId}/crypto`. That cost $0.40/secret/month,
 * which scales linearly with mandate count (hits meaningful money around
 * 1k+ mandates).
 *
 * Current model: store the private key as a base64 KMS ciphertext on the
 * mandate row in DynamoDB. Two layers of protection:
 *   1. Envelope encryption via KMS (encryption context bound to mandateId)
 *   2. Table-level encryption at rest (same KMS key, CDK config)
 *
 * The encryption context is load-bearing security: Decrypt will fail if
 * anyone tries to decrypt mandate A's ciphertext in mandate B's context.
 * This means copying a row between mandates cannot grant cross-mandate
 * spending capability.
 *
 * Costs (10k mandates):
 *   Before:  $4,000 / month (Secrets Manager at $0.40/secret)
 *   After:   $3     / month (KMS requests only; storage is negligible)
 */

import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { logger } from '../lib/logger';

const ENV = process.env.ENVIRONMENT ?? 'dev';
const KEY_ALIAS = `alias/delegare-${ENV}`;

const kms = new KMSClient({ region: process.env.AWS_REGION ?? 'us-east-2' });

/**
 * Bind ciphertext to a specific mandate. KMS Decrypt requires the exact same
 * context map that was used at Encrypt time — mismatched context throws.
 */
function contextFor(mandateId: string): Record<string, string> {
  return {
    service: 'delegare-vault',
    purpose: 'session-key',
    mandateId,
  };
}

/**
 * Encrypt a session key private key for a specific mandate.
 * Returns a base64-encoded KMS ciphertext blob safe to store in DynamoDB.
 */
export async function encryptSessionKey(
  privateKey: string,
  mandateId: string,
): Promise<string> {
  if (!privateKey.startsWith('0x')) {
    throw new Error('Session key must be a 0x-prefixed hex string');
  }

  const { CiphertextBlob } = await kms.send(
    new EncryptCommand({
      KeyId: KEY_ALIAS,
      Plaintext: Buffer.from(privateKey, 'utf-8'),
      EncryptionContext: contextFor(mandateId),
    }),
  );

  if (!CiphertextBlob) {
    throw new Error('KMS Encrypt returned no ciphertext');
  }

  return Buffer.from(CiphertextBlob).toString('base64');
}

/**
 * Decrypt a session key ciphertext for a specific mandate.
 * Throws if the encryption context does not match the mandateId —
 * this prevents cross-mandate ciphertext reuse.
 */
export async function decryptSessionKey(
  ciphertextB64: string,
  mandateId: string,
): Promise<string> {
  const { Plaintext } = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertextB64, 'base64'),
      EncryptionContext: contextFor(mandateId),
    }),
  );

  if (!Plaintext) {
    throw new Error('KMS Decrypt returned no plaintext');
  }

  const key = Buffer.from(Plaintext).toString('utf-8');

  if (!key.startsWith('0x')) {
    // Defensive — if something was stored without the expected format we
    // want a clear error, not a mysterious viem rejection downstream.
    logger.error({ mandateId }, 'Decrypted session key is not 0x-prefixed hex');
    throw new Error('Decrypted session key has invalid format');
  }

  return key;
}
