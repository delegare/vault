import { DidService } from '../../services/DidService';
import { getSecret } from '../../lib/secrets';

jest.mock('../../lib/secrets', () => ({
  getSecret: jest.fn(),
  vaultSecretId: jest.fn().mockReturnValue('test_secret_id'),
}));

jest.mock('../../lib/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  }
}));

describe('DidService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BASE_DOMAIN = 'test.delegare.dev';
  });

  afterAll(() => {
    delete process.env.BASE_DOMAIN;
  });

  describe('getPlatformDid', () => {
    it('returns the correct did:web identifier', () => {
      expect(DidService.getPlatformDid()).toBe('did:web:test.delegare.dev');
    });
  });

  describe('generateUserDid', () => {
    it('generates a did:key and a private key', async () => {
      const result = await DidService.generateUserDid();
      
      expect(result).toHaveProperty('did');
      expect(result.did).toMatch(/^did:key:z/);
      expect(result).toHaveProperty('privateKey');
      expect(typeof result.privateKey).toBe('string');
    });
  });

  describe('signCredential & verifyCredential', () => {
    it('signs and verifies a credential payload successfully', async () => {
      // Let the DidService generate a transient key for testing
      (getSecret as jest.Mock).mockResolvedValue({});

      const payload = { testClaim: 'valid_data' };
      const jwt = await DidService.signCredential(payload);

      expect(typeof jwt).toBe('string');
      expect(jwt.split('.').length).toBe(3); // Header.Payload.Signature

      const verified = await DidService.verifyCredential(jwt);
      expect(verified.testClaim).toBe('valid_data');
      expect(verified.iss).toBe('did:web:test.delegare.dev');
    });
  });

  describe('getDidDocument', () => {
    it('returns a properly structured DID document', async () => {
      (getSecret as jest.Mock).mockResolvedValue({
        PLATFORM_DID_PUBLIC_JWK: JSON.stringify({ crv: 'P-256', kty: 'EC', x: '123', y: '456' })
      });

      const doc = await DidService.getDidDocument();

      expect(doc.id).toBe('did:web:test.delegare.dev');
      expect(doc.verificationMethod[0].id).toBe('did:web:test.delegare.dev#owner');
      expect(doc.verificationMethod[0].publicKeyJwk).toEqual({ crv: 'P-256', kty: 'EC', x: '123', y: '456' });
      expect(doc.assertionMethod).toContain('did:web:test.delegare.dev#owner');
    });
  });
});
