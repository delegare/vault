import { requireX402Payment } from '../../middleware/x402';
import { Request, Response, NextFunction } from 'express';

// Mock the x402 service so middleware tests don't touch DynamoDB or RPC
jest.mock('../../services/x402', () => {
  const actual = jest.requireActual('../../services/x402');
  return {
    ...actual,
    verifyX402Payment: jest.fn(),
    settleX402Payment: jest.fn(),
    settleMandateBackedX402: jest.fn(),
    // keep priceToAtomicUsdc real for atomic-units assertions
  };
});

// Mock CredentialService so we don't need a real SD-JWT signer for mandate tests
jest.mock('../../services/CredentialService', () => {
  return {
    CredentialService: jest.fn().mockImplementation(() => ({
      verifyIntentMandate: jest.fn().mockResolvedValue({ mandateId: 'mdt_test_123' }),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const x402Service = require('../../services/x402');

describe('x402 Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = {
      header: jest.fn(),
      originalUrl: '/test-resource',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('responds 402 with PaymentRequirements in atomic USDC when no X-PAYMENT header', async () => {
    (req.header as jest.Mock).mockReturnValue(undefined);

    const middleware = requireX402Payment({
      price: '0.05',
      payTo: '0xMerchantWallet',
    });

    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 1,
        accepts: expect.arrayContaining([
          expect.objectContaining({
            scheme: 'exact',
            network: 'base',
            // 0.05 USDC in 6-decimal atomic units = 50000
            maxAmountRequired: '50000',
            payTo: '0xMerchantWallet',
            extra: expect.objectContaining({ name: 'USD Coin', version: '2' }),
          }),
        ]),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('verifies and settles when X-PAYMENT header is valid', async () => {
    const mockPaymentData = { scheme: 'exact', payload: { signature: '0x123', authorization: {} } };
    const xPaymentHeader = Buffer.from(JSON.stringify(mockPaymentData)).toString('base64');
    (req.header as jest.Mock).mockImplementation((name: string) =>
      name.toLowerCase() === 'x-payment' ? xPaymentHeader : undefined,
    );

    (x402Service.verifyX402Payment as jest.Mock).mockResolvedValue({ isValid: true });
    (x402Service.settleX402Payment as jest.Mock).mockResolvedValue({
      success: true,
      transaction: '0xdef',
      network: 'base',
      payer: '0xabc',
    });

    const middleware = requireX402Payment({
      price: '0.05',
      payTo: '0xMerchantWallet',
    });

    await middleware(req as Request, res as Response, next);

    expect(x402Service.verifyX402Payment).toHaveBeenCalled();
    expect(x402Service.settleX402Payment).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-PAYMENT-RESPONSE', expect.any(String));
    expect((req as any).x402Payer).toBe('0xabc');
    expect((req as any).x402Transaction).toBe('0xdef');
    expect(next).toHaveBeenCalled();
  });

  it('returns 402 when verification fails', async () => {
    const xPaymentHeader = Buffer.from(JSON.stringify({ scheme: 'exact' })).toString('base64');
    (req.header as jest.Mock).mockImplementation((name: string) =>
      name.toLowerCase() === 'x-payment' ? xPaymentHeader : undefined,
    );

    (x402Service.verifyX402Payment as jest.Mock).mockResolvedValue({
      isValid: false,
      invalidReason: 'Bad signature',
    });

    const middleware = requireX402Payment({ price: '0.05', payTo: '0xMerchantWallet' });

    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_payment', message: 'Bad signature' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('settles via mandate path when X-DELEGARE-MANDATE header is present', async () => {
    (req.header as jest.Mock).mockImplementation((name: string) =>
      name.toLowerCase() === 'x-delegare-mandate' ? 'eyJmYWtlIjoiand0In0' : undefined,
    );

    (x402Service.settleMandateBackedX402 as jest.Mock).mockResolvedValue({
      success: true,
      transaction: '0xabc',
      network: 'base',
      payer: 'mdt_test_123',
    });

    const middleware = requireX402Payment({ price: '0.05', payTo: '0xMerchantWallet' });
    await middleware(req as Request, res as Response, next);

    expect(x402Service.settleMandateBackedX402).toHaveBeenCalledWith(
      expect.objectContaining({
        mandateId: 'mdt_test_123',
        requirements: expect.objectContaining({ price: '0.05', payTo: '0xMerchantWallet' }),
      }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-PAYMENT-RESPONSE', expect.any(String));
    expect((req as any).x402MandateId).toBe('mdt_test_123');
    expect(next).toHaveBeenCalled();
    // EIP-3009 path should NOT have been touched.
    expect(x402Service.verifyX402Payment).not.toHaveBeenCalled();
  });

  it('returns 402 when settlement fails', async () => {
    const xPaymentHeader = Buffer.from(JSON.stringify({ scheme: 'exact' })).toString('base64');
    (req.header as jest.Mock).mockImplementation((name: string) =>
      name.toLowerCase() === 'x-payment' ? xPaymentHeader : undefined,
    );

    (x402Service.verifyX402Payment as jest.Mock).mockResolvedValue({ isValid: true });
    (x402Service.settleX402Payment as jest.Mock).mockResolvedValue({
      success: false,
      errorReason: 'Relayer unreachable',
    });

    const middleware = requireX402Payment({ price: '0.05', payTo: '0xMerchantWallet' });

    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'payment_settlement_failed' }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
