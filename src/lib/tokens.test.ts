import { generateDelegateToken, verifyDelegateToken, currentMonthKey } from './tokens';

describe('tokens', () => {
  const secret = 'example-hmac-secret-do-not-use-000000000000';

  describe('generateDelegateToken & verifyDelegateToken', () => {
    it('verifies a valid token', () => {
      const payload = {
        ownerId: 'usr_123',
        merchantId: 'm_456',
        createdAt: new Date().toISOString(),
        version: 1,
      };
      const token = generateDelegateToken(payload, secret);
      const verified = verifyDelegateToken(token, secret);

      expect(verified).toMatchObject({
        ownerId: 'usr_123',
        merchantId: 'm_456',
        version: 1,
      });
      expect(verified).toHaveProperty('nonce');
    });

    it('rejects a token with invalid signature', () => {
      const payload = { ownerId: 'usr_123', merchantId: 'm_456', createdAt: '2024', version: 1 };
      const token = generateDelegateToken(payload, secret);
      const tampered = token.slice(0, -5) + 'XXXXX';
      
      expect(verifyDelegateToken(tampered, secret)).toBeNull();
    });

    it('rejects a token signed with a different secret', () => {
      const payload = { ownerId: 'usr_123', merchantId: 'm_456', createdAt: '2024', version: 1 };
      const token = generateDelegateToken(payload, 'wrong-secret');
      
      expect(verifyDelegateToken(token, secret)).toBeNull();
    });

    it('rejects an invalid token format', () => {
      expect(verifyDelegateToken('not-a-token', secret)).toBeNull();
      expect(verifyDelegateToken('dtok_no_dot', secret)).toBeNull();
    });
  });

  describe('currentMonthKey', () => {
    it('returns YYYY-MM format', () => {
      const key = currentMonthKey();
      expect(key).toMatch(/^\d{4}-\d{2}$/);
      
      const now = new Date();
      const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(key).toBe(expected);
    });
  });
});
