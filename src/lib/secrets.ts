import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-2' });

interface CacheEntry {
  value: Record<string, string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getSecret(secretId: string): Promise<Record<string, string>> {
  const cached = cache.get(secretId);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const cmd = new GetSecretValueCommand({ SecretId: secretId });
  const result = await sm.send(cmd);
  if (!result.SecretString) throw new Error(`Secret ${secretId} has no string value`);

  const value = JSON.parse(result.SecretString) as Record<string, string>;

  cache.set(secretId, {
    value,
    expiresAt: now + CACHE_TTL_MS,
  });

  return value;
}

export async function putSecret(secretId: string, value: string): Promise<void> {
  try {
    // Try to update an existing secret first (most common for rotations)
    await sm.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
  } catch (err: any) {
    if (err instanceof ResourceNotFoundException || err.name === 'ResourceNotFoundException') {
      // Secret doesn't exist yet — create it
      await sm.send(new CreateSecretCommand({ Name: secretId, SecretString: value }));
    } else {
      throw err;
    }
  }
}

export async function deleteSecret(secretId: string): Promise<void> {
  const { DeleteSecretCommand } = await import('@aws-sdk/client-secrets-manager');
  try {
    // We use a recovery window of 7 days to allow accidental revocation recovery,
    // but the API key is practically invalid immediately.
    await sm.send(new DeleteSecretCommand({ SecretId: secretId, RecoveryWindowInDays: 7 }));
    cache.delete(secretId);
  } catch (err: any) {
    if (err instanceof ResourceNotFoundException || err.name === 'ResourceNotFoundException') {
      // Ignored if it doesn't exist
    } else {
      throw err;
    }
  }
}

const env = process.env.ENVIRONMENT ?? 'dev';

export function vaultSecretId(): string {
  return `delegare/${env}/vault`;
}

export function cryptoDelegateSecretId(mandateId: string): string {
  return `delegare/${env}/delegates/${mandateId}/crypto`;
}
