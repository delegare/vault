import { Request, Response, NextFunction } from 'express';
import { getSecret, vaultSecretId } from '../lib/secrets';

let cachedAdminKey: string | null = null;

async function getAdminKey(): Promise<string> {
  if (cachedAdminKey) return cachedAdminKey;
  const secrets = await getSecret(vaultSecretId());
  cachedAdminKey = secrets['ADMIN_API_KEY'] ?? '';
  return cachedAdminKey;
}

/**
 * Protects admin-only endpoints (merchant registration, etc.).
 * Requires X-Admin-Key header matching the ADMIN_API_KEY secret.
 */
export async function authenticateAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const adminKey = req.headers['x-admin-key'];

  if (!adminKey || typeof adminKey !== 'string') {
    res.status(401).json({ code: 'unauthorized', message: 'X-Admin-Key header required' });
    return;
  }

  const expectedKey = await getAdminKey();
  if (!expectedKey || adminKey !== expectedKey) {
    res.status(401).json({ code: 'unauthorized', message: 'Invalid admin key' });
    return;
  }

  next();
}
