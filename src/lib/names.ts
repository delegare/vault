import { keccak256, toBytes } from 'viem';

const ADJECTIVES_1 = [
  'sunny', 'quiet', 'wild', 'cosmic', 'lazy',
  'brave', 'swift', 'golden', 'silver', 'tiny',
  'clever', 'lucky', 'happy', 'fuzzy', 'bold'
];

const ADJECTIVES_2 = [
  'violet', 'amber', 'crimson', 'jade', 'azure',
  'coral', 'teal', 'onyx', 'ivory', 'indigo',
  'ruby', 'pearl', 'sapphire', 'emerald', 'topaz'
];

const NOUNS = [
  'panda', 'walrus', 'falcon', 'otter', 'lynx',
  'gecko', 'lemur', 'narwhal', 'capybara', 'axolotl',
  'badger', 'koala', 'wombat', 'alpaca', 'quokka'
];

/**
 * Generates a deterministic three-word handle (e.g. sunny-violet-panda)
 * from an Ethereum wallet address.
 * 
 * @param walletAddress The Ethereum wallet address (0x...)
 * @returns A formatted string handle
 */
export function generateMerchantName(walletAddress: string): string {
  // Normalize the address to lower case for consistent hashing
  const normalized = walletAddress.toLowerCase();
  const hash = keccak256(toBytes(normalized)).slice(2); // remove '0x'

  // Convert hex segments to integers to use as array indices
  const i1 = parseInt(hash.slice(0, 4), 16) % ADJECTIVES_1.length;
  const i2 = parseInt(hash.slice(4, 8), 16) % ADJECTIVES_2.length;
  const i3 = parseInt(hash.slice(8, 12), 16) % NOUNS.length;

  return `${ADJECTIVES_1[i1]}-${ADJECTIVES_2[i2]}-${NOUNS[i3]}`;
}
