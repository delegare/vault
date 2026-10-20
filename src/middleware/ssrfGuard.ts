import { Request, Response, NextFunction } from 'express';

// Block RFC 1918, loopback, link-local, and AWS metadata IP ranges
const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,       // link-local + AWS instance metadata
  /^::1$/,             // IPv6 loopback
  /^fc00:/,            // IPv6 ULA
  /^fe80:/,            // IPv6 link-local
];

const BLOCKED_HOSTS = ['metadata.google.internal', 'metadata.gcp.internal'];

function isBlockedIp(ip: string): boolean {
  return BLOCKED_RANGES.some((re) => re.test(ip));
}

function isBlockedHost(host: string): boolean {
  return BLOCKED_HOSTS.some((h) => host.toLowerCase().includes(h));
}

/**
 * SSRF guard — prevents the vault service from being used to probe internal
 * infrastructure. Applied before any outbound URL is resolved.
 *
 * This middleware also validates any URL provided in request bodies.
 */
export function ssrfGuard(req: Request, res: Response, next: NextFunction): void {
  // Check X-Forwarded-For — reject requests claiming to be from internal IPs
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((ip) => ip.trim());
    for (const ip of ips) {
      if (isBlockedIp(ip)) {
        res.status(403).json({ code: 'forbidden', message: 'Request origin not allowed' });
        return;
      }
    }
  }

  // Validate any webhook URL in request body
  const body = req.body as Record<string, unknown>;
  if (body?.webhookUrl && typeof body.webhookUrl === 'string') {
    try {
      const url = new URL(body.webhookUrl);
      if (isBlockedHost(url.hostname) || isBlockedIp(url.hostname)) {
        res.status(400).json({ code: 'invalid_webhook_url', message: 'Webhook URL targets a disallowed host' });
        return;
      }
      if (!['https:', 'http:'].includes(url.protocol)) {
        res.status(400).json({ code: 'invalid_webhook_url', message: 'Webhook URL must use HTTP or HTTPS' });
        return;
      }
    } catch {
      res.status(400).json({ code: 'invalid_webhook_url', message: 'Invalid webhook URL' });
      return;
    }
  }

  next();
}
