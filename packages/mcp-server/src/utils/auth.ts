/**
 * Mocked token validation for now.
 * In a real scenario, this would use 'jose' or 'aws-jwt-verify' to validate the Cognito JWT.
 */
export async function validateToken(token: string) {
  if (!token) return null;
  
  // Mock claims
  return {
    sub: 'mock-user-id',
    email: 'test@delegare.dev',
    tenantId: 'mock-merchant-id',
    groups: ['merchants'],
  };
}
