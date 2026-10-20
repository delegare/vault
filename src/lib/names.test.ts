import { generateMerchantName } from './names';

describe('generateMerchantName', () => {
  it('generates a 3-word dashed string', () => {
    const handle = generateMerchantName('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
    const parts = handle.split('-');
    expect(parts).toHaveLength(3);
  });

  it('is deterministic', () => {
    const addr = '0x1234567890123456789012345678901234567890';
    const h1 = generateMerchantName(addr);
    const h2 = generateMerchantName(addr);
    expect(h1).toEqual(h2);
  });

  it('is case-insensitive', () => {
    const lower = '0x1234567890abcdef1234567890abcdef12345678';
    const upper = '0x1234567890ABCDEF1234567890ABCDEF12345678';
    expect(generateMerchantName(lower)).toEqual(generateMerchantName(upper));
  });

  it('generates different handles for different addresses', () => {
    const h1 = generateMerchantName('0x1111111111111111111111111111111111111111');
    const h2 = generateMerchantName('0x2222222222222222222222222222222222222222');
    expect(h1).not.toEqual(h2);
  });
});
