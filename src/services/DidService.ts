import * as jose from 'jose';
import { getSecret, vaultSecretId } from '../lib/secrets';
import { logger } from '../lib/logger';

/**
 * Service to manage Decentralized Identifiers (DIDs) for Delegare and its users.
 * Supports did:web for Delegare and did:key for users.
 */
export class DidService {
  private static cachedIssuerPrivateKey: any = null;
  private static cachedIssuerPublicKey: any = null;

  /**
   * Returns the canonical DID for the Delegare platform.
   */
  static getPlatformDid(): string {
    const domain = process.env.BASE_DOMAIN || 'delegare.dev';
    // did:web:delegare.dev
    return `did:web:${domain}`;
  }

  /**
   * Generates a new did:key for a user.
   */
  static async generateUserDid(): Promise<{ did: string; privateKey: string }> {
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const publicJwk = await jose.exportJWK(publicKey);
    
    const thumbprint = await jose.calculateJwkThumbprint(publicJwk);
    const did = `did:key:z${thumbprint}`; 
    
    const exportedPrivateKey = await jose.exportPKCS8(privateKey);
    return { did, privateKey: exportedPrivateKey };
  }

  /**
   * Gets the platform's private signing key from Secrets Manager.
   */
  private static async getPlatformSigningKey(): Promise<any> {
    const secrets = await getSecret(vaultSecretId());
    const privateKeyPem = secrets['PLATFORM_DID_PRIVATE_KEY'];

    if (!privateKeyPem) {
      if (this.cachedIssuerPrivateKey) return this.cachedIssuerPrivateKey;
      logger.warn('PLATFORM_DID_PRIVATE_KEY not found in secrets, generating transient key for development');
      const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
      this.cachedIssuerPrivateKey = privateKey;
      this.cachedIssuerPublicKey = publicKey;
      return privateKey;
    }

    return await jose.importPKCS8(privateKeyPem, 'ES256');
  }

  /**
   * Signs a payload to produce a Verifiable Credential (JWT format).
   */
  static async signCredential(payload: any): Promise<string> {
    const privateKey = await this.getPlatformSigningKey();
    const platformDid = this.getPlatformDid();

    return await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: `${platformDid}#owner` })
      .setIssuedAt()
      .setIssuer(platformDid)
      .setExpirationTime('1y')
      .sign(privateKey);
  }

  /**
   * Verifies a JWT-based credential.
   */
  static async verifyCredential(jwt: string, expectedIssuer?: string): Promise<any> {
    // In did:web, we'd resolve the DID to get the JWKS.
    // For now, we verify against our own key if issuer matches.
    const platformDid = this.getPlatformDid();
    const decoded = jose.decodeJwt(jwt);

    if (decoded.iss === platformDid) {
      // In dev/test, if we generated a transient key, we must derive its public key
      // If we are in production, we pull the public key from secrets.
      const secrets = await getSecret(vaultSecretId());
      let publicKey;

      const publicKeyPem = secrets['PLATFORM_DID_PUBLIC_KEY'];
      if (publicKeyPem) {
        publicKey = await jose.importSPKI(publicKeyPem, 'ES256');
      } else if (this.cachedIssuerPublicKey) {
        publicKey = this.cachedIssuerPublicKey;
      } else {
        throw new Error('Platform public key not configured for verification');
      }
      
      const { payload } = await jose.jwtVerify(jwt, publicKey);
      return payload;
    }

    throw new Error(`Verification for external issuer ${decoded.iss} not yet implemented`);
  }

  /**
   * Produces the /.well-known/did.json document.
   */
  static async getDidDocument(): Promise<any> {
    const platformDid = this.getPlatformDid();
    const secrets = await getSecret(vaultSecretId());
    const publicKeyJwk = JSON.parse(secrets['PLATFORM_DID_PUBLIC_JWK'] || '{}');

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1'
      ],
      id: platformDid,
      verificationMethod: [
        {
          id: `${platformDid}#owner`,
          type: 'JsonWebKey2020',
          controller: platformDid,
          publicKeyJwk: publicKeyJwk
        }
      ],
      assertionMethod: [`${platformDid}#owner`],
      authentication: [`${platformDid}#owner`]
    };
  }

  /**
   * Produces the /.well-known/jwks.json document.
   */
  static async getJwks(): Promise<{ keys: jose.JWK[] }> {
    const secrets = await getSecret(vaultSecretId());
    const publicKeyJwk = JSON.parse(secrets['PLATFORM_DID_PUBLIC_JWK'] || 'null');
    
    if (!publicKeyJwk) {
       return { keys: [] };
    }

    return {
      keys: [
        {
          ...publicKeyJwk,
          kid: `${this.getPlatformDid()}#owner`,
          use: 'sig',
          alg: 'ES256'
        }
      ]
    };
  }
}
