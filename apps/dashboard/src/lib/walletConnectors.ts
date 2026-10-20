/**
 * Wallet connectors for buyer self-onboarding.
 *
 * Buyers get a broad picker (MetaMask, Rabby, Brave, Coinbase extension,
 * Phantom EVM, etc.) via EIP-6963 wallet discovery + Coinbase Smart Wallet
 * for users with no extension installed. Merchants intentionally still use
 * Coinbase-only via the existing path (see dashboard Settings panel).
 *
 * All connectors enforce Base mainnet (chainId 8453 / 0x2105).
 */

const BASE_CHAIN_ID_HEX = '0x2105'; // 8453
const BASE_CHAIN_ID_DEC = 8453;

export type WalletConnector = {
  id: string;
  name: string;
  iconUrl?: string;
  /** Trigger the wallet's connection flow and return the chosen address. */
  connect: () => Promise<{ provider: any; address: string }>;
};

// ── EIP-6963: Multi Injected Provider Discovery ──────────────────────────
// Modern wallets announce themselves on `window` via this event so dApps
// can list them all instead of fighting over `window.ethereum`.
//
// https://eips.ethereum.org/EIPS/eip-6963

interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: any; // EIP-1193 provider
}

interface EIP6963AnnounceEvent extends Event {
  detail: EIP6963ProviderDetail;
}

/**
 * Synchronously snapshots whatever EIP-6963 wallets have already announced.
 * Wallets typically announce on page load — calling this from a click
 * handler is safe because by then they've all fired.
 */
export function discoverInjectedWallets(): WalletConnector[] {
  if (typeof window === 'undefined') return [];

  const found: EIP6963ProviderDetail[] = [];
  const handler = (event: Event) => {
    const detail = (event as EIP6963AnnounceEvent).detail;
    if (detail && detail.info && detail.provider) {
      // Dedupe by uuid
      if (!found.some(d => d.info.uuid === detail.info.uuid)) {
        found.push(detail);
      }
    }
  };

  window.addEventListener('eip6963:announceProvider', handler as EventListener);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  window.removeEventListener('eip6963:announceProvider', handler as EventListener);

  return found.map(({ info, provider }) => ({
    id: `eip6963:${info.rdns}`,
    name: info.name,
    iconUrl: info.icon,
    connect: async () => {
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error('No account returned from wallet');
      await ensureBaseChain(provider);
      return { provider, address };
    },
  }));
}

// ── Coinbase Smart Wallet (no extension required) ────────────────────────
// Always available because it's a popup-based smart wallet — works on any
// browser without an installed extension. Great fallback for new users.

export function coinbaseSmartWalletConnector(): WalletConnector {
  return {
    id: 'coinbase-smart-wallet',
    name: 'Coinbase Smart Wallet',
    iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48cGF0aCBkPSJNMCA1MEMwIDIyLjM4NTggMjIuMzg1OCAwIDUwIDBTMTAwIDIyLjM4NTggMTAwIDUwIDc3LjYxNDIgMTAwIDUwIDEwMCAwIDc3LjYxNDIgMCA1MFoiIGZpbGw9IiMwMDUyRkYiLz48cGF0aCBkPSJNNjIuMjIyMyA0NS41NTU3SDU0LjQ0NDVWNTQuNDQ0Nkg2Mi4yMjIzVjQ1LjU1NTdaIiBmaWxsPSIjRkZGRkZGIi8+PHBhdGggZD0iTTM3Ljc3NzkgNDUuNTU1N0g0NS41NTU3VjU0LjQ0NDZIMzcuNzc3OVY0NS41NTU3WiIgZmlsbD0iI0ZGRkZGRiIvPjwvc3ZnPg==',
    connect: async () => {
      const { createCoinbaseWalletSDK } = await import('@coinbase/wallet-sdk');
      const sdk = createCoinbaseWalletSDK({
        appName: 'Delegare',
        appLogoUrl: 'https://delegare.dev/favicon.ico',
        appChainIds: [BASE_CHAIN_ID_DEC],
      });
      const provider = sdk.getProvider();
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      const address = accounts?.[0];
      if (!address) throw new Error('No account returned from Coinbase Smart Wallet');
      // Smart Wallet is already configured for Base via appChainIds — no
      // switch needed, but call ensureBaseChain anyway for consistency.
      try { await ensureBaseChain(provider); } catch { /* smart wallet may reject — ignore */ }
      return { provider, address };
    },
  };
}

/**
 * Returns the full ordered connector list for buyers:
 *   1. Every browser-injected wallet found via EIP-6963 (MetaMask, Rabby,
 *      Brave, Coinbase extension, Phantom EVM, Trust, etc.)
 *   2. Coinbase Smart Wallet (popup, no extension required) — always last
 *      so users with an extension default to that.
 *
 * Deduped if a Coinbase extension is also installed (the EIP-6963 entry wins).
 */
export function getBuyerWalletConnectors(): WalletConnector[] {
  const injected = discoverInjectedWallets();
  const hasCoinbaseExtension = injected.some(c =>
    c.id.includes('coinbase') || c.name.toLowerCase().includes('coinbase'),
  );
  return hasCoinbaseExtension ? injected : [...injected, coinbaseSmartWalletConnector()];
}

// ── Chain enforcement ────────────────────────────────────────────────────
// Buyers (and merchants) must be on Base. Try wallet_switchEthereumChain
// first; if the wallet doesn't know about Base yet, add it then switch.

async function ensureBaseChain(provider: any): Promise<void> {
  try {
    const currentHex = await provider.request({ method: 'eth_chainId' }) as string;
    if (currentHex?.toLowerCase() === BASE_CHAIN_ID_HEX) return;
  } catch {
    // Some providers don't implement eth_chainId — fall through to switch.
  }

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err: any) {
    // 4902 = unknown chain. Add it, then the switch is implicit.
    if (err?.code === 4902 || /unrecognized chain/i.test(err?.message ?? '')) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: BASE_CHAIN_ID_HEX,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org'],
        }],
      });
    } else {
      throw err;
    }
  }
}
