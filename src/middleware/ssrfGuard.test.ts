import { Request, Response } from 'express';
import { ssrfGuard } from './ssrfGuard';

describe('ssrfGuard', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let nextFunction: jest.Mock;

  beforeEach(() => {
    mockReq = {
      headers: {},
      body: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
  });

  describe('X-Forwarded-For check', () => {
    it('allows public IPs', () => {
      mockReq.headers!['x-forwarded-for'] = '203.0.113.195';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('blocks RFC 1918 (10.x)', () => {
      mockReq.headers!['x-forwarded-for'] = '10.0.0.1';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it('blocks RFC 1918 (192.168.x)', () => {
      mockReq.headers!['x-forwarded-for'] = '192.168.1.1';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('blocks link-local / AWS metadata (169.254.x)', () => {
      mockReq.headers!['x-forwarded-for'] = '169.254.169.254';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('blocks loopback (127.x)', () => {
      mockReq.headers!['x-forwarded-for'] = '127.0.0.1';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });

  describe('webhookUrl validation', () => {
    it('allows legitimate external URLs', () => {
      mockReq.body.webhookUrl = 'https://api.stripe.com/v1/webhook';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });

    it('blocks internal hostnames', () => {
      mockReq.body.webhookUrl = 'http://metadata.google.internal/computeMetadata/v1/';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_webhook_url' }));
    });

    it('blocks internal IPs in webhook URL', () => {
      mockReq.body.webhookUrl = 'http://10.0.0.1/probe';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('blocks invalid protocols', () => {
      mockReq.body.webhookUrl = 'ftp://attacker.com/file';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('blocks malformed URLs', () => {
      mockReq.body.webhookUrl = 'not-a-url';
      ssrfGuard(mockReq as Request, mockRes as Response, nextFunction);
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });
});
