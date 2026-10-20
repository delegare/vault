import request from 'supertest';

// Mock the MCP server before importing app
jest.mock('@delegare/mcp-server/middleware', () => ({
  mcp: () => (req: any, res: any, next: any) => next(),
}));
jest.mock('@delegare/mcp-server', () => ({
  __esModule: true,
  default: {},
}));

// Mock DynamoDB
jest.mock('../../lib/dynamodb', () => ({
  ddb: {
    send: jest.fn(),
  },
  TABLE: {
    MERCHANTS: 'Merchants-Test',
  },
}));

// Mock Cognito Auth Middleware to inject a test email
jest.mock('../../middleware/auth', () => {
  const originalModule = jest.requireActual('../../middleware/auth');
  return {
    ...originalModule,
    authenticateCognito: (req: any, res: any, next: any) => {
      req.cognitoEmail = 'test@example.com';
      next();
    },
  };
});

// Mock MerchantService
jest.mock('../../controllers/MerchantController', () => {
  return {
    MerchantService: jest.fn().mockImplementation(() => {
      return {
        getMerchantByEmail: jest.fn().mockResolvedValue({
          merchantId: 'm_123',
          name: 'Test Merchant',
          stripeConnectedAccountId: 'acct_123',
          usdcWalletAddress: '0xabc123',
        }),
      };
    }),
  };
});

import app from '../../app';
import { ddb, TABLE } from '../../lib/dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

describe('DELETE /v1/auth/me/payout-method/:type', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes stripe connected account', async () => {
    const res = await request(app)
      .delete('/v1/auth/me/payout-method/stripe')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(ddb.send).toHaveBeenCalledTimes(1);
    expect(ddb.send).toHaveBeenCalledWith(
      expect.any(UpdateCommand)
    );
    
    const commandCall = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(commandCall.input.TableName).toBe(TABLE.MERCHANTS);
    expect(commandCall.input.Key).toEqual({ merchantId: 'm_123' });
    expect(commandCall.input.UpdateExpression).toBe('REMOVE stripeConnectedAccountId');
  });

  it('removes usdc wallet address when type is crypto', async () => {
    const res = await request(app)
      .delete('/v1/auth/me/payout-method/crypto')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const commandCall = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(commandCall.input.UpdateExpression).toBe('REMOVE usdcWalletAddress');
  });

  it('removes usdc wallet address when type is usdc', async () => {
    const res = await request(app)
      .delete('/v1/auth/me/payout-method/usdc')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const commandCall = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(commandCall.input.UpdateExpression).toBe('REMOVE usdcWalletAddress');
  });

  it('returns 400 for invalid type', async () => {
    const res = await request(app)
      .delete('/v1/auth/me/payout-method/invalid')
      .set('Authorization', 'Bearer fake-token');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_type');
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
