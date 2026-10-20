export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  environment: process.env.ENVIRONMENT || 'dev',
  isDevelopment: (process.env.ENVIRONMENT || 'dev') === 'dev',
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
  },
  services: {
    vault: {
      url: process.env.VAULT_URL || 'http://localhost:3000',
    },
  },
};
