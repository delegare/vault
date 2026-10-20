import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-2' });

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const env = process.env.ENVIRONMENT ?? 'dev';
export const TABLE = {
  MANDATES: `${env}-delegare-mandates`,
  TRANSACTIONS: `${env}-delegare-transactions`,
  MERCHANTS: `${env}-delegare-merchants`,
  SETUP_SESSIONS: `${env}-delegare-setup-sessions`,
  RATE_LIMITS: `${env}-delegare-rate-limits`,
  RAMP_TRANSACTIONS: `${env}-delegare-ramp-transactions`,
} as const;
