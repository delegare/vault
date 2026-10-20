import * as jose from 'jose';

async function main() {
  console.log('Generating ES256 platform key pair for Delegare DID...');
  
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
  
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  const publicKeyPem = await jose.exportSPKI(publicKey);
  const publicKeyJwk = await jose.exportJWK(publicKey);
  
  console.log('\n--- PLATFORM_DID_PRIVATE_KEY (PKCS8 PEM) ---');
  console.log(privateKeyPem);
  
  console.log('\n--- PLATFORM_DID_PUBLIC_KEY (SPKI PEM) ---');
  console.log(publicKeyPem);
  
  console.log('\n--- PLATFORM_DID_PUBLIC_JWK (JSON) ---');
  console.log(JSON.stringify(publicKeyJwk, null, 2));
  
  console.log('\n--- AWS SECRETS MANAGER JSON FORMAT ---');
  const secretsJson = {
    PLATFORM_DID_PRIVATE_KEY: privateKeyPem,
    PLATFORM_DID_PUBLIC_KEY: publicKeyPem,
    PLATFORM_DID_PUBLIC_JWK: JSON.stringify(publicKeyJwk)
  };
  console.log(JSON.stringify(secretsJson, null, 2));
}

main().catch(console.error);
