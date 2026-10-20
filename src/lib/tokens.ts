import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

interface DelegateTokenPayload {
  ownerId: string;
  merchantId: string;
  createdAt: string;
  version: number;
}

export function generateDelegateToken(
  payload: DelegateTokenPayload,
  secret: string,
): string {
  const raw = JSON.stringify({ ...payload, nonce: randomBytes(16).toString('hex') });
  const b64 = Buffer.from(raw).toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('base64url');
  return `dtok_${b64}.${sig}`;
}

export function verifyDelegateToken(
  token: string,
  secret: string,
): DelegateTokenPayload | null {
  if (!token.startsWith('dtok_')) return null;
  const rest = token.slice(5); // strip 'dtok_'
  const dot = rest.lastIndexOf('.');
  if (dot === -1) return null;

  const b64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);

  const expectedSig = createHmac('sha256', secret).update(b64).digest('base64url');

  // Constant-time comparison
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const raw = Buffer.from(b64, 'base64url').toString('utf8');
    return JSON.parse(raw) as DelegateTokenPayload;
  } catch {
    return null;
  }
}

export function generateSessionToken(): string {
  return `sess_${randomBytes(24).toString('base64url')}`;
}

export function generateReceiptId(): string {
  return `rcpt_${randomBytes(16).toString('hex')}`;
}

export function generateMerchantApiKey(env: 'live' | 'test' = 'live'): { raw: string; prefix: string } {
  const prefixStr = env === 'test' ? 'dk_test_' : 'dk_live_';
  const raw = `${prefixStr}${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 16) };
}

export function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
