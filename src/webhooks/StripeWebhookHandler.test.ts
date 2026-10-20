import { Request, Response } from 'express';
import Stripe from 'stripe';
import { UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/dynamodb';
import { getSecret } from '../lib/secrets';
import { handleStripeWebhook } from './StripeWebhookHandler';

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      webhooks: {
        constructEvent: jest.fn(),
      },
    };
  });
});

jest.mock('../lib/secrets', () => ({
  getSecret: jest.fn(),
  vaultSecretId: jest.fn().mockReturnValue('test-secret-id'),
}));

jest.mock('../lib/dynamodb', () => ({
  ddb: {
    send: jest.fn(),
  },
  TABLE: {
    TRANSACTIONS: 'test-transactions',
  },
}));

describe('StripeWebhookHandler', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockStripe: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      headers: {
        'stripe-signature': 'sig_123',
      },
      body: Buffer.from('raw_body'),
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    mockStripe = new Stripe('key', { apiVersion: '2024-06-20' });
    (Stripe as any).mockReturnValue(mockStripe);

    (getSecret as jest.Mock).mockResolvedValue({
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    });
  });

  it('returns 400 if signature is missing', async () => {
    mockReq.headers = {};
    await handleStripeWebhook(mockReq as Request, mockRes as Response);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ code: 'missing_signature' });
  });

  it('returns 400 if signature is invalid', async () => {
    mockStripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error('invalid signature');
    });

    await handleStripeWebhook(mockReq as Request, mockRes as Response);
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ code: 'invalid_signature' });
  });

  it('updates transaction on payment_intent.succeeded', async () => {
    const mockEvent = {
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_123' },
      },
    };
    mockStripe.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

    (ddb.send as jest.Mock).mockResolvedValueOnce({
      Items: [{ receiptId: 'rcpt_123' }],
    });

    await handleStripeWebhook(mockReq as Request, mockRes as Response);

    expect(ddb.send).toHaveBeenCalledWith(expect.any(QueryCommand));
    expect(ddb.send).toHaveBeenCalledWith(expect.any(UpdateCommand));
    expect(mockRes.json).toHaveBeenCalledWith({ received: true });
  });

  it('updates transaction with failure reason on payment_intent.payment_failed', async () => {
    const mockEvent = {
      type: 'payment_intent.payment_failed',
      data: {
        object: { 
          id: 'pi_123',
          last_payment_error: { message: 'Card declined' }
        },
      },
    };
    mockStripe.webhooks.constructEvent.mockReturnValueOnce(mockEvent);

    (ddb.send as jest.Mock).mockResolvedValueOnce({
      Items: [{ receiptId: 'rcpt_123' }],
    });

    await handleStripeWebhook(mockReq as Request, mockRes as Response);

    expect(ddb.send).toHaveBeenCalledWith(expect.any(UpdateCommand));
    const updateCall = (ddb.send as jest.Mock).mock.calls[1][0];
    expect(updateCall.input.ExpressionAttributeValues[':reason']).toBe('Card declined');
  });
});
