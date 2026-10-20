import { MerchantService } from './MerchantController';
import { ddb } from '../lib/dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

jest.mock('../lib/dynamodb', () => ({
  ddb: {
    send: jest.fn()
  },
  TABLE: {
    MERCHANTS: 'test-merchants'
  }
}));

describe('MerchantService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMerchantByEmail', () => {
    it('should prefer the primary account over the auto-created P2P alias account', async () => {
      const mockPrimaryAccount = {
        merchantId: 'primary_id',
        contactEmail: 'user@test.com',
        accountType: 'buyer',
        autoCreated: undefined // falsey means primary
      };
      
      const mockAliasAccount = {
        merchantId: 'funny-alias-panda',
        contactEmail: 'user@test.com',
        accountType: 'buyer',
        autoCreated: true // true means P2P alias
      };

      (ddb.send as jest.Mock).mockResolvedValue({
        Items: [mockAliasAccount, mockPrimaryAccount] // DynamoDB might return the alias first
      });

      const svc = new MerchantService();
      const result = await svc.getMerchantByEmail('user@test.com');

      expect(result).toBe(mockPrimaryAccount);
      expect(ddb.send).toHaveBeenCalledWith(expect.any(QueryCommand));
    });

    it('should return the first account if no clear primary account is found', async () => {
      const mockAliasAccount = {
        merchantId: 'funny-alias-panda',
        contactEmail: 'user@test.com',
        accountType: 'buyer',
        autoCreated: true
      };

      (ddb.send as jest.Mock).mockResolvedValue({
        Items: [mockAliasAccount]
      });

      const svc = new MerchantService();
      const result = await svc.getMerchantByEmail('user@test.com');

      expect(result).toBe(mockAliasAccount);
    });

    it('should return null if no items found', async () => {
      (ddb.send as jest.Mock).mockResolvedValue({ Items: [] });
      const svc = new MerchantService();
      const result = await svc.getMerchantByEmail('missing@test.com');
      expect(result).toBeNull();
    });
  });
});
