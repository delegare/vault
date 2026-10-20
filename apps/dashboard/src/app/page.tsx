"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Authenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession } from 'aws-amplify/auth';
import { getBuyerWalletConnectors, type WalletConnector } from "@/lib/walletConnectors";

const NAV_ITEMS = [
  "Overview",
  "Transactions",
  "Mandates",
  "Payment Methods",
  "API Keys",
  "Settings",
];

const fmt = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.delegare.dev';
const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL || 'https://delegare.dev';

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthReqId = searchParams.get('oauthReqId');
  const [isApprovingOauth, setIsApprovingOauth] = useState(!!oauthReqId);

  // ── Redirect Setup Context ──
  useEffect(() => {
    const merchant = searchParams.get('merchant');
    const mandate = searchParams.get('mandate');
    if (merchant || mandate) {
      const params = new URLSearchParams();
      if (merchant) params.set('merchant', merchant);
      if (mandate) params.set('mandate', mandate);
      router.push(`/setup?${params.toString()}`);
    }
  }, [searchParams, router]);

  // ── Return-from-Stripe-Checkout context ──
  // When the buyer adds a card from the Payment Methods panel, Stripe redirects
  // back to /?paymentMethod=fiat_added. Auto-open the Payment Methods tab so
  // they immediately see the new "Connected ••4242" state.
  useEffect(() => {
    const pm = searchParams.get('paymentMethod');
    if (pm === 'fiat_added' || pm === 'fiat_cancelled') {
      setActiveNav("Payment Methods");
    }
  }, [searchParams]);

  const [activeNav, setActiveNav] = useState("Overview");
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [isRotatingKey, setIsRotatingKey] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  // Plaintext live key — only ever populated immediately after rotation.
  // Shown once in a modal, then cleared. Never read from the server.
  const [freshLiveKey, setFreshLiveKey] = useState<string | null>(null);
  const [copiedFreshKey, setCopiedFreshKey] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [sandboxMode, setSandboxMode] = useState(true);
  const [merchant, setMerchant] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [mandates, setMandates] = useState<any[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [webhookSaveStatus, setWebhookSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [railRequirement, setRailRequirement] = useState<"any" | "fiat_only" | "crypto_only">("any");
  const [savingRail, setSavingRail] = useState(false);
  const [railSaveStatus, setRailSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [autoOfframp, setAutoOfframp] = useState(false);
  const [autoOfframpBankAccountId, setAutoOfframpBankAccountId] = useState("");
  const [autoOfframpThresholdCents, setAutoOfframpThresholdCents] = useState(0);
  const [savingOfframp, setSavingOfframp] = useState(false);
  const [offrampSaveStatus, setOfframpSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [linkedBankAccounts, setLinkedBankAccounts] = useState<Array<{id: string; bankName: string; last4: string; currency: string; isDefault: boolean}>>([]);

  // Mandate revocation state
  const [mandateToRevoke, setMandateToRevoke] = useState<any | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [copiedMandateId, setCopiedMandateId] = useState<string | null>(null);

  const [showChatGptModal, setShowChatGptModal] = useState(false);
  const mcpUrl = API_URL.replace('/v1', '') + '/mcp';

  const isBuyer = merchant?.accountType === 'buyer';

  const visibleNavItems = NAV_ITEMS.filter(item => {
    if (isBuyer) return ["Overview", "Transactions", "Mandates", "Payment Methods", "Settings"].includes(item);
    return item !== "Payment Methods";
  });

  // Payment Methods panel state — used by buyers to add a missing rail
  // (e.g. started with a card and later wants USDC for P2P, or vice-versa).
  const [pmConnecting, setPmConnecting] = useState<"fiat" | "crypto" | null>(null);
  const [pmError, setPmError] = useState<string | null>(null);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [walletConnectors, setWalletConnectors] = useState<WalletConnector[]>([]);

  const hasFiatRail = !!(merchant?.stripeBuyerPaymentMethodId || merchant?.stripeBuyerCustomerId);
  const hasCryptoRail = !!merchant?.usdcWalletAddress;

  // Spending enablement state — shown when wallet is connected but has no mandate/session key
  const [spendingSetup, setSpendingSetup] = useState<{
    step: 'idle' | 'config' | 'provisioning' | 'authorize' | 'done';
    maxPerTx: string;
    maxMonthly: string;
    sessionKeyAddress: string | null;
    mandateId: string | null;
    error: string | null;
  }>({ step: 'idle', maxPerTx: '50', maxMonthly: '500', sessionKeyAddress: null, mandateId: null, error: null });

  const handleCopyKey = () => {
    // In production, the live key is only shown once at creation or rotation.
    // The test key is safe to display/copy at any time.
    navigator.clipboard.writeText(
      sandboxMode
        ? (merchant?.testApiKey || "dk_test_••••••••••••••••1a2b")
        : "dk_live_•••••••••••••••• (Hidden for security)"
    );
  };

  const handleRotateKey = async () => {
    setIsRotatingKey(true);
    setRotateError(null);
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("No active session");

      const res = await fetch(`${API_URL}/v1/auth/me/rotate-key`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Rotation failed (${res.status})`);
      }

      const { liveApiKey } = await res.json();
      if (!liveApiKey) throw new Error("Server did not return a new key.");

      setShowRotateDialog(false);
      setFreshLiveKey(liveApiKey);
      // Flip to Live view so the user can see the just-rotated production key.
      setSandboxMode(false);
    } catch (err: any) {
      console.error("Failed to rotate API key", err);
      setRotateError(err?.message || "Rotation failed. Try again.");
    } finally {
      setIsRotatingKey(false);
    }
  };

  const handleCopyFreshKey = async () => {
    if (!freshLiveKey) return;
    try {
      await navigator.clipboard.writeText(freshLiveKey);
      setCopiedFreshKey(true);
      setTimeout(() => setCopiedFreshKey(false), 2000);
    } catch (err) {
      console.error("Clipboard write failed", err);
    }
  };

  const isTest = process.env.NEXT_PUBLIC_E2E_TEST === "true";

  const handleSwitchAccountType = async (type: "merchant" | "buyer") => {
    try {
      setIsLoading(true);
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      const res = await fetch(`${API_URL}/v1/auth/me`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ accountType: type })
      });
      if (res.ok) {
        const profile = await res.json();
        setMerchant(profile);
        if (type === 'buyer' && activeNav === 'API Keys') {
          setActiveNav('Overview');
        }
      }
    } catch (err) {
      console.error("Failed to switch account type", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevokeMandate = async () => {
    if (!mandateToRevoke) return;
    try {
      setIsRevoking(true);
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      const res = await fetch(`${API_URL}/v1/mandates/${mandateToRevoke.mandateId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        // Success: update UI
        setMandates(prev => prev.filter(m => m.mandateId !== mandateToRevoke.mandateId));
        setMandateToRevoke(null);
      }
    } catch (err) {
      console.error("Failed to revoke mandate", err);
    } finally {
      setIsRevoking(false);
    }
  };

  const handleCopyMandateToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedMandateId(id);
    setTimeout(() => setCopiedMandateId(null), 2000);
  };

  const handleStripeConnect = async () => {
    try {
      if (!merchant) return;
      const isTestnet = (process.env.NEXT_PUBLIC_ENVIRONMENT || 'prod') !== 'prod';
      // Prefer the environment-specific client ID; fall back to the shared one.
      const clientId = (isTestnet
        ? (process.env.NEXT_PUBLIC_STRIPE_TEST_CLIENT_ID || process.env.NEXT_PUBLIC_STRIPE_CLIENT_ID)
        : process.env.NEXT_PUBLIC_STRIPE_CLIENT_ID)?.trim();
      if (!clientId) {
        throw new Error("Stripe Client ID is not configured on this environment. Contact support.");
      }
      const redirectUri = encodeURIComponent(`${API_URL}/v1/webhooks/stripe-connect/callback`);
      window.location.href = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&state=merchant_${merchant.merchantId}&redirect_uri=${redirectUri}`;
    } catch(err: any) {
      console.error(err.message);
    }
  };

  const [showMerchantWalletPicker, setShowMerchantWalletPicker] = useState(false);

  const handleMerchantAddCrypto = async (connector: WalletConnector) => {
    try {
      setPmError(null);
      setPmConnecting("crypto");
      const { address } = await connector.connect();
      if (!address) throw new Error("No wallet account returned");

      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;

      const res = await fetch(`${API_URL}/v1/auth/me`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ usdcWalletAddress: address })
      });

      if (res.ok) {
        const profile = await res.json();
        setMerchant(profile);
        setShowMerchantWalletPicker(false);
      } else {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || "Failed to update profile");
      }
    } catch(err: any) {
      console.error('Failed to connect wallet:', err);
      setPmError(err.message || 'Failed to connect wallet');
    } finally {
      setPmConnecting(null);
    }
  };

  const handleDisconnect = async (type: 'stripe' | 'crypto') => {
    if (!confirm(`Are you sure you want to disconnect this payout method?`)) return;
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;

      const res = await fetch(`${API_URL}/v1/auth/me/payout-method/${type}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${token}` }
      });
      
      if (res.ok) {
        const updatedRes = await fetch(`${API_URL}/v1/auth/me`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        if (updatedRes.ok) {
          setMerchant(await updatedRes.json());
        }
      } else {
        const err = await res.json();
        alert(err.message || 'Failed to disconnect payout method.');
      }
    } catch(err: any) {
      console.error(err.message);
    }
  };

  // ── Buyer: disconnect a payment rail (fiat or crypto) ───────────────────
  const handleBuyerDisconnect = async (type: 'stripe' | 'crypto') => {
    const label = type === 'stripe' ? 'card on file' : 'crypto wallet';
    if (!confirm(`Disconnect your ${label}? Your agent will lose access to this rail until you reconnect.`)) return;
    try {
      setPmError(null);
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;

      const res = await fetch(`${API_URL}/v1/auth/me/payout-method/${type}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        // Re-fetch the full profile so every derived state (hasFiatRail, hasCryptoRail, etc.) updates atomically
        const meRes = await fetch(`${API_URL}/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (meRes.ok) setMerchant(await meRes.json());
      } else {
        const body = await res.json().catch(() => ({}));
        setPmError(body.message || `Failed to disconnect ${label}.`);
      }
    } catch (err: any) {
      setPmError(err.message || 'Unexpected error.');
    }
  };

  // ── Buyer: add fiat rail (Stripe Checkout in setup mode w/ Link) ─────────
  const handleBuyerAddFiat = async () => {
    try {
      setPmError(null);
      setPmConnecting("fiat");
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(`${API_URL}/v1/auth/me/payment-method/checkout`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        // No sessionToken — server mints an add_rail session targeting the
        // buyer's existing mandate.
        body: JSON.stringify({
          successPath: "/?paymentMethod=fiat_added",
          cancelPath: "/?paymentMethod=fiat_cancelled"
        })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to start card setup");
      }
      const { url } = await res.json();
      if (!url) throw new Error("No checkout URL returned");
      window.location.href = url;
    } catch (err: any) {
      console.error(err);
      setPmError(err.message || String(err));
      setPmConnecting(null);
    }
  };

  // ── Buyer: open the wallet picker (broad selection: MetaMask, Rabby,
  //    Brave, Coinbase extension, Phantom EVM, Coinbase Smart Wallet…) ────
  const openWalletPicker = () => {
    setPmError(null);
    // Snapshot whatever EIP-6963 wallets have announced themselves so far.
    setWalletConnectors(getBuyerWalletConnectors());
    setShowWalletPicker(true);
  };

  // ── Buyer: add crypto rail using the chosen connector ────────────────────
  const handleBuyerAddCrypto = async (connector: WalletConnector) => {
    try {
      setPmError(null);
      setPmConnecting("crypto");
      const { address: walletAddress } = await connector.connect();
      if (!walletAddress) throw new Error("No wallet account returned");

      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(`${API_URL}/v1/auth/me/payment-method/wallet`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ walletAddress })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to attach wallet");
      }

      // Refresh the merchant profile so the UI reflects the new rail + handle.
      const meRes = await fetch(`${API_URL}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (meRes.ok) {
        const profile = await meRes.json();
        setMerchant(profile);
      }
      setShowWalletPicker(false);
    } catch (err: any) {
      console.error(err);
      // 4001 = user rejected the request, don't surface as a scary error.
      if (err?.code !== 4001) {
        setPmError(err.message || String(err));
      }
    } finally {
      setPmConnecting(null);
    }
  };

  // ── Enable spending: provision mandate + session key, then on-chain auth ──
  const handleEnableSpending = async () => {
    try {
      setSpendingSetup(s => ({ ...s, step: 'provisioning', error: null }));
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(`${API_URL}/v1/auth/me/spending/enable`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          maxPerTxCents: Math.round(parseFloat(spendingSetup.maxPerTx) * 100),
          maxMonthlyCents: Math.round(parseFloat(spendingSetup.maxMonthly) * 100),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to provision spending mandate");
      }

      const data = await res.json();
      setSpendingSetup(s => ({
        ...s,
        step: 'authorize',
        sessionKeyAddress: data.sessionKeyAddress,
        mandateId: data.mandateId,
      }));
    } catch (err: any) {
      console.error(err);
      setSpendingSetup(s => ({ ...s, step: 'config', error: err.message || String(err) }));
    }
  };

  const handleOnChainAuthorize = async () => {
    if (!spendingSetup.sessionKeyAddress || !merchant?.usdcWalletAddress) return;
    try {
      setSpendingSetup(s => ({ ...s, error: null }));

      // Dynamic import viem to avoid bundling it for non-crypto users
      const { createWalletClient, createPublicClient, custom, parseUnits, parseEther } = await import('viem');
      const { baseSepolia, base } = await import('viem/chains');

      const isTestnet = (process.env.NEXT_PUBLIC_ENVIRONMENT || 'prod') !== 'prod';
      const chain = isTestnet ? baseSepolia : base;
      const USDC = isTestnet
        ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
        : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      const ROUTER = process.env.NEXT_PUBLIC_ROUTER_ADDRESS
        || (isTestnet ? '0x85f2afB670E54a3a0F31966F49A18C73ea6a0f62' : '0x2dD63b8aB1F6058C626Aa977616b0c3Fd4CDFB03');

      // Get the wallet provider from the connected wallet
      const connectors = getBuyerWalletConnectors();
      let provider: any = null;
      for (const c of connectors) {
        try {
          const result = await c.connect();
          if (result.address.toLowerCase() === merchant.usdcWalletAddress.toLowerCase()) {
            provider = result.provider;
            break;
          }
        } catch { /* skip */ }
      }
      if (!provider) throw new Error("Could not reconnect to your wallet. Please ensure your wallet extension is unlocked.");
      // Note: connector.connect() already called ensureBaseChain() — no duplicate switch needed.

      const walletClient = createWalletClient({
        account: merchant.usdcWalletAddress as `0x${string}`,
        chain,
        transport: custom(provider),
      });
      const publicClient = createPublicClient({ chain, transport: custom(provider) });

      const allowanceUnits = parseUnits(spendingSetup.maxMonthly || '500', 6);

      // 1. Approve Router to pull USDC
      const approveHash = await walletClient.writeContract({
        address: USDC as `0x${string}`,
        abi: [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
        functionName: 'approve',
        args: [ROUTER as `0x${string}`, allowanceUnits],
        gas: BigInt(100_000), // explicit gas to bypass MetaMask eth_estimateGas failures on fresh contracts
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });

      // 2. Authorize session key on Router
      const authHash = await walletClient.writeContract({
        address: ROUTER as `0x${string}`,
        abi: [{ name: 'authorizeSessionKey', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'sessionKey', type: 'address' }, { name: 'allowance', type: 'uint256' }], outputs: [] }],
        functionName: 'authorizeSessionKey',
        args: [spendingSetup.sessionKeyAddress as `0x${string}`, allowanceUnits],
        gas: BigInt(100_000), // authorizeSessionKey uses ~45k gas; 100k is safe headroom
      });
      await publicClient.waitForTransactionReceipt({ hash: authHash, confirmations: 1 });

      setSpendingSetup(s => ({ ...s, step: 'done' }));
    } catch (err: any) {
      console.error(err);
      if (err?.code === 4001) {
        setSpendingSetup(s => ({ ...s, error: "Transaction rejected in your wallet." }));
      } else {
        setSpendingSetup(s => ({ ...s, error: err?.shortMessage || err?.message || "On-chain authorization failed." }));
      }
    }
  };

  const handleSaveRail = async (value: "any" | "fiat_only" | "crypto_only") => {
    try {
      setSavingRail(true);
      setRailSaveStatus("idle");
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token || !merchant) return;
      const res = await fetch(`${API_URL}/v1/merchants/${merchant.merchantId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ railRequirement: value }),
      });
      if (res.ok) {
        setRailRequirement(value);
        setRailSaveStatus("success");
        setTimeout(() => setRailSaveStatus("idle"), 3000);
      } else {
        setRailSaveStatus("error");
      }
    } catch (err) {
      console.error(err);
      setRailSaveStatus("error");
    } finally {
      setSavingRail(false);
    }
  };

  const handleSaveOfframp = async (enabled: boolean, bankId?: string, thresholdCents?: number) => {
    try {
      setSavingOfframp(true);
      setOfframpSaveStatus("idle");
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token || !merchant) return;
      const res = await fetch(`${API_URL}/v1/merchants/${merchant.merchantId}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          autoOfframp: enabled,
          ...(bankId !== undefined ? { autoOfframpBankAccountId: bankId } : {}),
          ...(thresholdCents !== undefined ? { autoOfframpThresholdCents: thresholdCents } : {}),
          autoOfframpProvider: "stripe",
        }),
      });
      if (res.ok) {
        setAutoOfframp(enabled);
        if (bankId !== undefined) setAutoOfframpBankAccountId(bankId);
        if (thresholdCents !== undefined) setAutoOfframpThresholdCents(thresholdCents);
        setOfframpSaveStatus("success");
        setTimeout(() => setOfframpSaveStatus("idle"), 3000);
      } else {
        setOfframpSaveStatus("error");
      }
    } catch (err) {
      console.error(err);
      setOfframpSaveStatus("error");
    } finally {
      setSavingOfframp(false);
    }
  };

  const handleSaveWebhook = async () => {
    try {
      setSavingWebhook(true);
      setWebhookSaveStatus("idle");
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token || !merchant) return;

      const res = await fetch(`${API_URL}/v1/merchants/${merchant.merchantId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ webhookUrl: webhookUrl || null }) 
      });

      if (res.ok) {
        setWebhookSaveStatus("success");
        setTimeout(() => setWebhookSaveStatus("idle"), 3000);
      } else {
        setWebhookSaveStatus("error");
      }
    } catch (err) {
      console.error(err);
      setWebhookSaveStatus("error");
    } finally {
      setSavingWebhook(false);
    }
  };

  useEffect(() => {
    if (isTest) {
      const isTestBuyer = searchParams.get('buyer') === 'true';
      // Mock data for Playwright to ensure UI renders statically
      setMerchant({
        merchantId: sandboxMode ? (isTestBuyer ? "b_test_123" : "m_test_123") : "m_live_123",
        accountType: isTestBuyer ? "buyer" : "merchant",
        name: sandboxMode ? (isTestBuyer ? "Test Buyer" : "Sandbox Merchant") : "Example Merchant",
        totalVolumeCents: sandboxMode ? 1245000 : 12450000,
        totalTransactions: sandboxMode ? 312 : 4231,
        autoCreated: false,
        status: "active"
      });
      
      if (sandboxMode) {
        setTransactions([
          { id: "rcpt_sandbox_1", mandateId: "eyJhbGciOiJ...", description: "Sandbox Test Charge", amount: 1000, rail: "crypto", status: "completed", ts: "5 min ago" },
          { id: "rcpt_sandbox_2", mandateId: "eyJhbGciOiJ...", description: "Failed Sandbox Attempt", amount: 5000, rail: "fiat", status: "failed", ts: "10 min ago" }
        ]);
      } else {
        setTransactions([
          { id: "rcpt_7f8a9b2c", mandateId: "eyJhbGciOiJ...", description: "Pro plan · Jan 2026", amount: 4500, rail: "fiat", status: "completed", ts: "2 min ago" },
          { id: "rcpt_2e3b4c5d", mandateId: "eyJhbGciOiJ...", description: "Enterprise tier · Feb", amount: 15000, rail: "fiat", status: "failed", ts: "1 hr ago" },
          { id: "rcpt_3p2q1r0s", mandateId: "eyJhbGciOiJ...", description: "Data export pack", amount: 990, rail: "crypto", status: "completed", ts: "3 hr ago" },
          { id: "rcpt_5t6u7v8w", mandateId: "eyJhbGciOiJ...", description: "Starter plan · Jan 2026", amount: 2900, rail: "fiat", status: "completed", ts: "5 hr ago" },
          { id: "rcpt_8x9y0z1a", mandateId: "eyJhbGciOiJ...", description: "API credits · 500 units", amount: 1250, rail: "crypto", status: "completed", ts: "6 hr ago" }
        ]);
      }
      setIsLoading(false);
      return;
    }

    async function loadDashboardData() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) {
          setIsLoading(false);
          return;
        }

        // ── OAuth Approval Flow Interception ──
        if (oauthReqId) {
          setIsApprovingOauth(true);
          try {
            const authRes = await fetch(`${API_URL}/v1/oauth2/approve`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ oauthReqId })
            });
            
            const authData = await authRes.json();
            if (authData.redirectUri) {
              window.location.href = authData.redirectUri;
              return; // Halt execution and wait for redirect
            } else {
              console.error("OAuth Approval Failed:", authData);
            }
          } catch (e) {
            console.error("OAuth API Exception:", e);
          }
          // If we reach here, it failed. Fall back to loading the dashboard.
          setIsApprovingOauth(false);
        }

        // In a real implementation, we would pass sandboxMode as a query param
        const meRes = await fetch(`${API_URL}/v1/auth/me?mode=${sandboxMode ? 'sandbox' : 'live'}`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (meRes.status === 404) {
          // If the user was in a buyer setup flow (Google OAuth redirected here),
          // send them back to the setup page instead of merchant onboarding.
          const setupReturn = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('delegare_setup_return');
          const onboardingReturn = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('delegare_onboarding_return');

          // If the user has a setup return URL, they are a buyer coming from an external flow
          if (setupReturn) {
            sessionStorage.removeItem('delegare_setup_return');
            window.location.href = setupReturn;
            return;
          }
          
          if (onboardingReturn) {
            sessionStorage.removeItem('delegare_onboarding_return');
            window.location.href = onboardingReturn;
            return;
          }

          // Determine where they came from by checking the query params or referrer
          // If they came specifically to sign up as a merchant, redirect to onboarding
          const isMerchantSignup = window.location.search.includes('merchant=true') || window.location.hash.includes('merchant');
          
          if (isMerchantSignup) {
            router.push('/onboarding?type=merchant');
          } else {
            // Default to buyer setup
            router.push('/setup');
          }
          return;
        }

        if (!meRes.ok) {
          throw new Error('Failed to fetch merchant profile');
        }

        const profile = await meRes.json();
        setMerchant(profile);
        if (profile.webhookUrl) {
          setWebhookUrl(profile.webhookUrl);
        }
        if (profile.railRequirement) {
          setRailRequirement(profile.railRequirement);
        }
        if (profile.autoOfframp !== undefined) setAutoOfframp(profile.autoOfframp);
        if (profile.autoOfframpBankAccountId) setAutoOfframpBankAccountId(profile.autoOfframpBankAccountId);
        if (profile.autoOfframpThresholdCents !== undefined) setAutoOfframpThresholdCents(profile.autoOfframpThresholdCents);

        // Fetch linked bank accounts from Stripe connected account
        if (profile.stripeConnectedAccountId) {
          try {
            const bankRes = await fetch(`${API_URL}/v1/ramp/bank-accounts`, {
              headers: { "Authorization": `Bearer ${token}` }
            });
            if (bankRes.ok) {
              const bankData = await bankRes.json();
              if (bankData.bankAccounts?.length > 0) {
                setLinkedBankAccounts(bankData.bankAccounts);
                // Auto-select default bank if none set
                if (!profile.autoOfframpBankAccountId) {
                  const defaultBank = bankData.bankAccounts.find((b: any) => b.isDefault) ?? bankData.bankAccounts[0];
                  if (defaultBank) setAutoOfframpBankAccountId(defaultBank.id);
                }
              }
            }
          } catch (_) { /* non-fatal */ }
        }

        // 2. Fetch Transactions from API
        try {
          const txRes = await fetch(`${API_URL}/v1/auth/me/transactions?limit=20`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (txRes.ok) {
            const data = await txRes.json();
            const apiTxs = data.items.map((tx: any) => ({
              id: tx.receiptId,
              mandateId: tx.mandateId, 
              description: tx.description,
              amount: tx.amountCents,
              rail: tx.rail,
              status: tx.status,
              ts: new Date(tx.requestedAt).toLocaleString()
            }));
            setTransactions(apiTxs);
          } else {
            console.error('Failed to fetch transactions from API');
            setTransactions([]);
          }
        } catch (txErr) {
          console.error("Failed to load transactions", txErr);
          setTransactions([]);
        }

        // 3. Fetch Mandates from API
        try {
          const mandateRes = await fetch(`${API_URL}/v1/auth/me/mandates?limit=50`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (mandateRes.ok) {
            const data = await mandateRes.json();
            setMandates(data.items || []);
          } else {
            setMandates([]);
          }
        } catch (mandateErr) {
          console.error("Failed to load mandates", mandateErr);
          setMandates([]);
        }

      } catch (err) {
        console.error("Dashboard data load error:", err);
      } finally {
        if (!oauthReqId) {
          setIsLoading(false);
        }
      }
    }

    loadDashboardData();
  }, [isTest, router, sandboxMode, oauthReqId]);


  const renderDashboard = (user?: any, signOut?: any) => {
    if (isApprovingOauth) {
      return (
        <div style={{ background: "#0c0c0c", color: "#f0ede8", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif", flexDirection: "column", gap: "16px" }}>
          <div style={{ width: "48px", height: "48px", borderRadius: "24px", background: "rgba(126,200,152,0.1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#7ec898", fontSize: "24px" }}>✓</span>
          </div>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 500 }}>Authentication Successful</h2>
          <p style={{ color: "rgba(240,237,232,0.5)", margin: 0 }}>Connecting your AI agent to Delegare...</p>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div style={{ background: "#0c0c0c", color: "#f0ede8", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
          <p style={{ color: "rgba(240,237,232,0.5)" }}>Loading dashboard...</p>
        </div>
      );
    }

    return (
      <div
        style={{
          background: "#0c0c0c",
          color: "#f0ede8",
          fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
          <style>{`
            @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@400&display=swap');
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

            /* HEADER */
            .dash-header {
              border-bottom: 1px solid rgba(240,237,232,0.07);
              padding: 0 40px;
              display: flex; align-items: center; justify-content: space-between;
              height: 60px;
              background: rgba(12,12,12,0.95);
              position: sticky; top: 0; z-index: 50;
              backdrop-filter: blur(12px);
            }
            .dash-logo {
              font-family: 'DM Serif Display', serif;
              font-size: 19px; color: #f0ede8;
              text-decoration: none; letter-spacing: -0.3px;
              display: flex; align-items: center; gap: 12px;
            }
            .dash-logo span { color: #c8b99a; }
            .dash-logo-sep {
              width: 1px; height: 18px;
              background: rgba(240,237,232,0.12);
            }
            .dash-logo-sub {
              font-family: 'DM Sans', sans-serif;
              font-size: 12px; font-weight: 400;
              color: rgba(240,237,232,0.3); letter-spacing: 0.05em;
            }
            .dash-nav { display: flex; align-items: center; gap: 4px; }
            .dash-nav-item {
              font-size: 13px; font-weight: 400;
              color: rgba(240,237,232,0.4);
              padding: 6px 14px; border-radius: 8px;
              cursor: pointer; transition: color 0.15s, background 0.15s;
              border: none; background: none;
            }
            .dash-nav-item:hover { color: #f0ede8; background: rgba(240,237,232,0.05); }
            .dash-nav-item.active {
              color: #f0ede8;
              background: rgba(240,237,232,0.08);
            }
            .dash-header-right { display: flex; align-items: center; gap: 16px; }
            .dash-merchant-pill {
              display: flex; align-items: center; gap: 8px;
              padding: 6px 14px;
              border: 1px solid rgba(240,237,232,0.09);
              border-radius: 100px;
              font-size: 12px; color: rgba(240,237,232,0.5);
              cursor: pointer;
            }
            .dash-merchant-pill:hover {
              background: rgba(240,237,232,0.05);
            }
            .dash-merchant-dot {
              width: 7px; height: 7px; border-radius: 50%;
              background: #7ec898; flex-shrink: 0;
              box-shadow: 0 0 6px rgba(126,200,152,0.5);
              animation: glow 2s infinite;
            }
            @keyframes glow {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.5; }
            }

            /* MAIN */
            .dash-main {
              flex: 1; padding: 40px;
              max-width: 1200px; margin: 0 auto; width: 100%;
            }

            /* PAGE HEADER */
            .page-header {
              display: flex; align-items: flex-end; justify-content: space-between;
              margin-bottom: 36px;
            }
            .page-title {
              font-family: 'DM Serif Display', serif;
              font-size: 36px; color: #f0ede8;
              line-height: 1; letter-spacing: -0.8px;
            }
            .page-title em { font-style: italic; color: #c8b99a; }
            .page-period {
              font-size: 12px; font-weight: 500; letter-spacing: 0.08em;
              text-transform: uppercase; color: rgba(240,237,232,0.25);
              display: flex; align-items: center; gap: 8px;
            }
            .page-period-dot {
              width: 6px; height: 6px; border-radius: 50%;
              background: #7ec898;
              animation: glow 2s infinite;
            }

            /* STAT CARDS */
            .stats-grid {
              display: grid; grid-template-columns: repeat(4, 1fr);
              gap: 16px; margin-bottom: 36px;
            }
            .stat-card {
              border: 1px solid rgba(240,237,232,0.08);
              border-radius: 16px; padding: 28px;
              background: rgba(240,237,232,0.02);
              transition: border-color 0.2s;
              position: relative; overflow: hidden;
            }
            .stat-card:hover { border-color: rgba(240,237,232,0.14); }
            .stat-card::before {
              content: '';
              position: absolute; top: 0; left: 0; right: 0;
              height: 1px;
              background: linear-gradient(90deg, transparent, rgba(200,185,154,0.3), transparent);
              opacity: 0; transition: opacity 0.2s;
            }
            .stat-card:hover::before { opacity: 1; }
            .stat-label {
              font-size: 11px; font-weight: 500; letter-spacing: 0.1em;
              text-transform: uppercase; color: rgba(240,237,232,0.25);
              margin-bottom: 14px;
            }
            .stat-value {
              font-family: 'DM Serif Display', serif;
              font-size: 36px; letter-spacing: -1px; color: #f0ede8;
              line-height: 1; margin-bottom: 10px;
            }
            .stat-value.green { color: #7ec898; }
            .stat-value.gold { color: #c8b99a; }
            .stat-delta {
              font-size: 12px; font-weight: 300;
              color: rgba(240,237,232,0.3);
              display: flex; align-items: center; gap: 4px;
            }
            .stat-delta-up { color: #7ec898; }
            .stat-delta-down { color: #e87c7c; }

            /* TWO COLUMN */
            .two-col {
              display: grid; grid-template-columns: 1fr 320px;
              gap: 16px;
            }

            /* PANEL */
            .panel {
              border: 1px solid rgba(240,237,232,0.08);
              border-radius: 16px;
              background: rgba(240,237,232,0.02);
              overflow: hidden;
            }
            .panel-header {
              padding: 22px 28px;
              border-bottom: 1px solid rgba(240,237,232,0.06);
              display: flex; align-items: center; justify-content: space-between;
            }
            .panel-title {
              font-size: 13px; font-weight: 500; color: #f0ede8; letter-spacing: 0.01em;
            }
            .panel-action {
              font-size: 12px; color: rgba(240,237,232,0.3);
              cursor: pointer; transition: color 0.15s;
              border: none; background: none;
              display: flex; align-items: center; gap: 4px;
            }
            .panel-action:hover { color: #c8b99a; }

            /* TABLE */
            .tx-table { width: 100%; border-collapse: collapse; }
            .tx-th {
              text-align: left; padding: 12px 28px;
              font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
              text-transform: uppercase; color: rgba(240,237,232,0.2);
              border-bottom: 1px solid rgba(240,237,232,0.05);
            }
            .tx-row {
              border-bottom: 1px solid rgba(240,237,232,0.04);
              transition: background 0.15s;
              cursor: default;
            }
            .tx-row:last-child { border-bottom: none; }
            .tx-row.hovered { background: rgba(240,237,232,0.025); }
            .tx-td {
              padding: 16px 28px;
              font-size: 14px; font-weight: 300;
              color: rgba(240,237,232,0.55);
              vertical-align: middle;
            }
            .tx-id {
              font-family: 'DM Mono', monospace;
              font-size: 12px; color: rgba(240,237,232,0.4);
            }
            .tx-desc { color: rgba(240,237,232,0.7); font-weight: 400; }
            .tx-amount {
              font-family: 'DM Serif Display', serif;
              font-size: 16px; color: #f0ede8; letter-spacing: -0.3px;
            }
            .rail-badge {
              display: inline-flex; align-items: center; gap: 5px;
              padding: 4px 10px; border-radius: 100px;
              font-size: 11px; font-weight: 500; letter-spacing: 0.04em;
            }
            .rail-fiat {
              background: rgba(200,185,154,0.1); color: #c8b99a;
              border: 1px solid rgba(200,185,154,0.15);
            }
            .rail-crypto {
              background: rgba(126,200,152,0.1); color: #7ec898;
              border: 1px solid rgba(126,200,152,0.15);
            }
            .status-badge {
              display: inline-flex; align-items: center; gap: 5px;
              padding: 4px 10px; border-radius: 100px;
              font-size: 11px; font-weight: 500;
            }
            .status-completed {
              background: rgba(126,200,152,0.08); color: #7ec898;
              border: 1px solid rgba(126,200,152,0.15);
            }
            .status-failed {
              background: rgba(232,124,124,0.08); color: #e87c7c;
              border: 1px solid rgba(232,124,124,0.15);
            }
            .status-dot {
              width: 5px; height: 5px; border-radius: 50%; background: currentColor;
            }

            /* RIGHT PANEL */
            .right-panel { display: flex; flex-direction: column; gap: 16px; }
            .mini-stat {
              border: 1px solid rgba(240,237,232,0.08);
              border-radius: 14px; padding: 22px 24px;
              background: rgba(240,237,232,0.02);
              transition: border-color 0.2s;
            }
            .mini-stat:hover { border-color: rgba(240,237,232,0.14); }
            .mini-stat-label {
              font-size: 11px; font-weight: 500; letter-spacing: 0.08em;
              text-transform: uppercase; color: rgba(240,237,232,0.25);
              margin-bottom: 10px;
            }
            .mini-stat-value {
              font-family: 'DM Serif Display', serif;
              font-size: 28px; letter-spacing: -0.5px; color: #f0ede8;
              margin-bottom: 6px;
            }
            .mini-stat-sub {
              font-size: 12px; font-weight: 300; color: rgba(240,237,232,0.3);
            }

            /* API KEY PANEL */
            .api-key-block {
              padding: 22px 24px;
            }
            .api-key-row {
              display: flex; align-items: center; justify-content: space-between;
              margin-bottom: 14px;
            }
            .api-key-name {
              font-size: 13px; font-weight: 400; color: rgba(240,237,232,0.6);
            }
            .api-key-status {
              font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
              text-transform: uppercase;
              padding: 3px 8px; border-radius: 100px;
              background: rgba(126,200,152,0.1); color: #7ec898;
              border: 1px solid rgba(126,200,152,0.15);
            }
            .api-key-value {
              font-family: 'DM Mono', monospace;
              font-size: 12px; color: rgba(240,237,232,0.25);
              background: rgba(240,237,232,0.03);
              border: 1px solid rgba(240,237,232,0.07);
              border-radius: 8px; padding: 10px 14px;
              letter-spacing: 0.02em;
              margin-bottom: 14px;
            }
            .api-key-actions { display: flex; gap: 8px; }
            .api-key-btn {
              flex: 1; font-size: 12px; font-weight: 500;
              padding: 8px 14px; border-radius: 8px; cursor: pointer;
              transition: background 0.15s, color 0.15s;
              border: none;
            }
            .api-key-btn-primary {
              background: rgba(240,237,232,0.08); color: rgba(240,237,232,0.7);
            }
            .api-key-btn-primary:hover {
              background: rgba(240,237,232,0.13); color: #f0ede8;
            }
            .api-key-btn-danger {
              background: rgba(232,124,124,0.07); color: rgba(232,124,124,0.6);
            }
            .api-key-btn-danger:hover {
              background: rgba(232,124,124,0.13); color: #e87c7c;
            }

            /* RAIL SPLIT BAR */
            .rail-split { padding: 22px 24px; }
            .rail-split-label {
              font-size: 11px; font-weight: 500; letter-spacing: 0.08em;
              text-transform: uppercase; color: rgba(240,237,232,0.25);
              margin-bottom: 16px;
            }
            .rail-bar-track {
              height: 6px; border-radius: 100px;
              background: rgba(240,237,232,0.06);
              overflow: hidden; margin-bottom: 14px;
            }
            .rail-bar-fill {
              height: 100%; border-radius: 100px;
              background: linear-gradient(90deg, #c8b99a 0%, #7ec898 100%);
            }
            .rail-legend { display: flex; justify-content: space-between; }
            .rail-legend-item { font-size: 12px; font-weight: 300; }
            .rail-legend-fiat { color: #c8b99a; }
            .rail-legend-crypto { color: #7ec898; }

            @media (max-width: 900px) {
              .dash-main { padding: 24px; }
              .stats-grid { grid-template-columns: 1fr 1fr; }
              .two-col { grid-template-columns: 1fr; }
              .right-panel { flex-direction: row; flex-wrap: wrap; }
              .mini-stat { flex: 1; min-width: 200px; }
            }
            @media (max-width: 600px) {
              .dash-header { height: auto; flex-direction: column; padding: 16px; gap: 16px; position: relative; }
              .dash-nav { overflow-x: auto; width: 100%; justify-content: flex-start; padding-bottom: 8px; }
              .dash-nav::-webkit-scrollbar { display: none; }
              .dash-user { align-self: flex-end; position: absolute; top: 16px; right: 16px; }
              .stats-grid { grid-template-columns: 1fr; }
              .page-header { flex-direction: column; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
              .page-title { font-size: 28px; }
              .tx-table { display: block; overflow-x: auto; white-space: nowrap; }
            }
          `}</style>

      {/* HEADER */}
      <header className="dash-header">
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Link href="/" className="dash-logo">
            delegare<span>.</span>
          </Link>
          <div className="dash-logo-sep" />
          <span className="dash-logo-sub">{isBuyer ? 'Dashboard' : 'Merchant Dashboard'}</span>
        </div>

        <nav className="dash-nav">
          {visibleNavItems.map((item) => (
            <button
              key={item}
              className={`dash-nav-item${activeNav === item ? " active" : ""}`}
              onClick={() => setActiveNav(item)}
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="dash-header-right dash-user">
          {merchant?.contactEmail && (
            <div style={{
              width: 32, height: 32, borderRadius: 16,
              background: "rgba(200,185,154,0.1)", color: "#c8b99a",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 500, textTransform: "uppercase"
            }}>
              {merchant.contactEmail[0]}
            </div>
          )}
          <button
            className="dash-merchant-pill"
            onClick={() => signOut && signOut()}
            style={{
              background: "transparent",
              border: "1px solid rgba(240,237,232,0.09)",
              color: "rgba(240,237,232,0.5)",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              cursor: "pointer",
            }}
          >
            <div className="dash-merchant-dot" />
            {user?.signInDetails?.loginId || "Sign Out"}
          </button>
        </div>
</header>

          {/* MAIN */}
          <main className="dash-main">
            {merchant?.accountType !== 'buyer' && !merchant?.stripeConnectedAccountId && !merchant?.usdcWalletAddress && activeNav !== "Settings" && (
              <div style={{
                background: "rgba(200,185,154,0.1)",
                border: "1px solid rgba(200,185,154,0.2)",
                borderRadius: "12px",
                padding: "16px 24px",
                marginBottom: "32px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "16px"
              }}>
                <div>
                  <h3 style={{ fontSize: "14px", fontWeight: 600, color: "#c8b99a", margin: "0 0 4px" }}>Action Required: Connect a Payout Method</h3>
                  <p style={{ fontSize: "13px", color: "rgba(240,237,232,0.6)", margin: 0 }}>
                    You cannot accept live agent payments until you connect Stripe or a Coinbase Wallet.
                  </p>
                </div>
                <button
                  onClick={() => router.push("/onboarding?type=merchant")}
                  style={{
                    background: "#c8b99a",
                    color: "#0c0c0c",
                    border: "none",
                    padding: "8px 16px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                >
                  Complete Onboarding
                </button>
              </div>
            )}

            {/* PAGE HEADER */}
            <div className="page-header">
              <h1 className="page-title">
                Overview,
                <br />
                <em>{merchant?.name || "Loading..."}</em>
              </h1>
              <div className="page-period">
                <div className="page-period-dot" />
                Last 30 days · Live
              </div>
            </div>

            {/* DYNAMIC CONTENT */}
            {activeNav === "Overview" && (
              <>
                {/* STAT CARDS */}
                <div className="stats-grid">
                  {[
                    {
                      label: isBuyer ? "Total Spend" : "Total Volume",
                      value: merchant ? fmt(merchant.totalVolumeCents || 0) : "$0.00",
                      delta: "all time",
                      up: true,
                      sub: isBuyer ? "Total spent" : "Total processed",
                    },
                    {
                      label: "Transactions",
                      value: merchant ? (merchant.totalTransactions || 0).toLocaleString() : "0",
                      delta: "all time",
                      up: true,
                      sub: isBuyer ? "Total payments" : "Total initiated",
                    },
                    {
                      label: isBuyer ? "Active Agents" : "Active Mandates",
                      value: mandates.length > 0 ? mandates.length.toString() : "0",
                      delta: "new this mo",
                      up: true,
                      sub: isBuyer ? "Authorized delegates" : "Spending agents",
                    },
                    {
                      label: "System Status",
                      value: "Active",
                      delta: "Optimal",
                      up: true,
                      sub: "Rail health",
                      green: true,
                    },
                  ].map((s) => (
                    <div key={s.label} className="stat-card">
                      <div className="stat-label">{s.label}</div>
                      <div className={`stat-value${s.green ? " green" : ""}`}>
                        {s.value}
                      </div>
                      <div className="stat-delta">
                        <span className={s.up ? "stat-delta-up" : "stat-delta-down"}>
                          {s.delta}
                        </span>
                        <span>{s.sub}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* FULL WIDTH COLUMN */}
                <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                  {/* TRANSACTIONS TABLE */}
                  <div className="panel">
                    <div className="panel-header">
                      <span className="panel-title">Recent transactions</span>
                      <button className="panel-action" onClick={() => setActiveNav("Transactions")}>View all →</button>
                    </div>
                    <table className="tx-table">
                      <thead>
                        <tr>
                          <th className="tx-th">Receipt</th>
                          <th className="tx-th">Description</th>
                          <th className="tx-th">Amount</th>
                          <th className="tx-th">Rail</th>
                          <th className="tx-th">Status</th>
                          <th className="tx-th">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((tx) => (
                          <tr
                            key={tx.id}
                            className={`tx-row${hoveredRow === tx.id ? " hovered" : ""}`}
                            onMouseEnter={() => setHoveredRow(tx.id)}
                            onMouseLeave={() => setHoveredRow(null)}
                          >
                            <td className="tx-td">
                              <span className="tx-id">{tx.id}</span>
                            </td>
                            <td className="tx-td">
                              <div className="tx-desc">{tx.description}</div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "rgba(240,237,232,0.2)",
                                  marginTop: 2,
                                  fontFamily: "DM Mono, monospace",
                                }}
                              >
                                {tx.mandateId}
                              </div>
                            </td>
                            <td className="tx-td">
                              <span className="tx-amount">{fmt(tx.amount || tx.amountCents)}</span>
                            </td>
                            <td className="tx-td">
                              <span className={`rail-badge rail-${tx.rail}`}>
                                {tx.rail === "fiat" ? "Stripe" : "Base USDC"}
                              </span>
                            </td>
                            <td className="tx-td">
                              <span className={`status-badge status-${tx.status}`}>
                                <span className="status-dot" />
                                {tx.status === "completed"
                                  ? "Completed"
                                  : "Failed · Limit"}
                              </span>
                            </td>
                            <td
                              className="tx-td"
                              style={{ color: "rgba(240,237,232,0.25)", fontSize: 12 }}
                            >
                              {tx.ts || new Date(tx.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* BOTTOM ROW */}
                  <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
                    {!isBuyer && (
                      <>
                        {hasCryptoRail ? (
                          <div
                            style={{
                              flex: 1,
                              border: "1px solid rgba(200,185,154,0.15)",
                              borderRadius: 12,
                              padding: "20px",
                              background: "rgba(200,185,154,0.05)",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "center",
                            }}
                          >
                            <h4 style={{ margin: "0 0 8px 0", fontSize: 14, color: "#c8b99a", fontWeight: 500 }}>
                              Your Public P2P Profile
                            </h4>
                            <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "rgba(240,237,232,0.6)", lineHeight: 1.5 }}>
                              Because you connected a crypto wallet, anyone with an AI agent can now instantly "buy you a coffee" by sending USDC to your funny handle!
                            </p>
                            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#000", border: "1px solid rgba(240,237,232,0.1)", padding: "12px 16px", borderRadius: 8 }}>
                              <span style={{ color: "#7ec898", fontFamily: "'DM Mono', monospace", fontSize: 13, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                                @{merchant?.merchantHandle || merchant?.merchantId}
                                <button
                                  onClick={(e) => {
                                    const handleStr = merchant?.merchantHandle || merchant?.merchantId;
                                    navigator.clipboard.writeText(`${WEB_URL}/@${handleStr}`);
                                    const btn = e.currentTarget;
                                    const originalHTML = btn.innerHTML;
                                    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7ec898" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
                                    setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
                                  }}
                                  style={{ 
                                    padding: 4, 
                                    background: "transparent", 
                                    border: "none", 
                                    color: "rgba(240,237,232,0.4)", 
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    transition: "color 0.2s"
                                  }}
                                  onMouseOver={(e) => e.currentTarget.style.color = "#f0ede8"}
                                  onMouseOut={(e) => e.currentTarget.style.color = "rgba(240,237,232,0.4)"}
                                  title="Copy URL"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                </button>
                              </span>
                              <a
                                href={`${WEB_URL}/@${merchant?.merchantHandle || merchant?.merchantId}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  fontSize: 12, color: "#0c0c0c", background: "#c8b99a", padding: "6px 12px", borderRadius: 6, fontWeight: 600, textDecoration: "none"
                                }}
                              >
                                View Profile ↗
                              </a>
                            </div>
                          </div>
                        ) : (
                          <div className="mini-stat" style={{ flex: 1, margin: 0 }}>
                            <div className="mini-stat-label">Transactions (all time)</div>
                            <div className="mini-stat-value">
                              {(merchant?.totalTransactions || 0).toLocaleString()}
                            </div>
                            <div className="mini-stat-sub">
                              Fee: $0.005 floor · 3% under $1 · 3¢ cap above $1
                            </div>
                          </div>
                        )}

                        {/* Docs CTA */}
                        <div
                          style={{
                            flex: 1,
                            border: "1px solid rgba(200,185,154,0.15)",
                            borderRadius: 14,
                            padding: "20px 24px",
                            background: "rgba(200,185,154,0.04)",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                              color: "#c8b99a",
                              marginBottom: 8,
                            }}
                          >
                            $0.005 floor · 3% · 3¢ cap
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 300,
                              color: "rgba(240,237,232,0.4)",
                              lineHeight: 1.6,
                              marginBottom: 14,
                            }}
                          >
                            Predictable. Forever. No volume tiers, no surprise costs.
                          </div>
                          <a
                            href="https://docs.delegare.dev"
                            target="_blank"
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              color: "#c8b99a",
                              textDecoration: "none",
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                              borderBottom: "1px solid rgba(200,185,154,0.3)",
                              paddingBottom: 2,
                              width: "fit-content",
                              transition: "border-color 0.2s",
                            }}
                          >
                            Read the docs →
                          </a>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}


            {activeNav === "Transactions" && (
              <div className="panel">
                <div className="panel-header">
                  <span className="panel-title">All transactions</span>
                </div>
                <table className="tx-table">
                  <thead>
                    <tr>
                      <th className="tx-th">Receipt</th>
                      <th className="tx-th">Description</th>
                      <th className="tx-th">Amount</th>
                      <th className="tx-th">Rail</th>
                      <th className="tx-th">Status</th>
                      <th className="tx-th">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr
                        key={tx.id}
                        className={`tx-row${hoveredRow === tx.id ? " hovered" : ""}`}
                        onMouseEnter={() => setHoveredRow(tx.id)}
                        onMouseLeave={() => setHoveredRow(null)}
                      >
                        <td className="tx-td">
                          <span className="tx-id">{tx.id}</span>
                        </td>
                        <td className="tx-td">
                          <div className="tx-desc">{tx.description}</div>
                          <div style={{ fontSize: 11, color: "rgba(240,237,232,0.2)", marginTop: 2, fontFamily: "DM Mono, monospace" }}>
                            {tx.mandateId}
                          </div>
                        </td>
                        <td className="tx-td">
                          <span className="tx-amount">{fmt(tx.amount || tx.amountCents)}</span>
                        </td>
                        <td className="tx-td">
                          <span className={`rail-badge rail-${tx.rail}`}>
                            {tx.rail === "fiat" ? "Stripe" : "Base USDC"}
                          </span>
                        </td>
                        <td className="tx-td">
                          <span className={`status-badge status-${tx.status}`}>
                            <span className="status-dot" />
                            {tx.status === "completed" ? "Completed" : "Failed"}
                          </span>
                        </td>
                        <td className="tx-td" style={{ color: "rgba(240,237,232,0.25)", fontSize: 12 }}>
                          {tx.ts || new Date(tx.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeNav === "API Keys" && (
              <div className="panel" style={{ maxWidth: 600 }}>
                <div className="panel-header">
                  <span className="panel-title">API Credentials</span>
                  <button 
                    onClick={() => setSandboxMode(!sandboxMode)} 
                    style={{ 
                      background: sandboxMode ? "rgba(232,124,124,0.1)" : "rgba(126,200,152,0.1)", 
                      color: sandboxMode ? "#e87c7c" : "#7ec898",
                      border: "none", padding: "4px 10px", borderRadius: "100px", fontSize: "11px", fontWeight: 600, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase" 
                    }}
                  >
                    {sandboxMode ? "Sandbox" : "Live"}
                  </button>
                </div>
                <div className="api-key-block" style={{ borderBottom: "1px solid rgba(240,237,232,0.08)" }}>
                  <div className="api-key-row">
                    <span className="api-key-name">Merchant ID</span>
                  </div>
                  <div className="api-key-value">
                    {merchant?.merchantId || "Loading..."}
                  </div>
                  <p style={{ fontSize: 12, color: "rgba(240,237,232,0.4)", marginBottom: 16, lineHeight: 1.5 }}>
                    Your public merchant identifier. Required by the SDK to identify your account.
                  </p>
                  <div className="api-key-actions">
                    <button className="api-key-btn api-key-btn-primary" onClick={() => navigator.clipboard.writeText(merchant?.merchantId || "")}>
                      Copy ID
                    </button>
                  </div>
                </div>
                <div className="api-key-block">
                  <div className="api-key-row">
                    <span className="api-key-name">{sandboxMode ? "Test API Key" : "Production API Key"}</span>
                    <span className="api-key-status" style={sandboxMode ? { background: "rgba(232,124,124,0.1)", color: "#e87c7c", borderColor: "rgba(232,124,124,0.15)" } : {}}>Active</span>
                  </div>
                  <div className="api-key-value">
                    {sandboxMode 
                      ? (merchant?.testApiKey || "dk_test_••••••••••••••••1a2b") 
                      : "dk_live_•••••••••••••••• (Hidden for security)"}
                  </div>
                  <p style={{ fontSize: 12, color: "rgba(240,237,232,0.4)", marginBottom: 16, lineHeight: 1.5 }}>
                    {sandboxMode
                      ? "This test key can be used to simulate transactions without real money."
                      : "For security, live keys are never stored in plaintext on our servers. If you lost yours, rotate to generate a new one — it will be shown once."}
                  </p>
                  <div className="api-key-actions">
                    <button className="api-key-btn api-key-btn-primary" onClick={handleCopyKey}>
                      Copy Key
                    </button>
                    <button className="api-key-btn api-key-btn-primary" onClick={() => setShowRotateDialog(true)}>
                      Rotate Key
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showRotateDialog && (
              <div role="dialog" style={{
                position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
              }}>
                <div style={{ background: "#0c0c0c", padding: "32px", borderRadius: "16px", border: "1px solid rgba(240,237,232,0.1)", maxWidth: "400px" }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: "18px", color: "#f0ede8" }}>Rotate API Key?</h3>
                  <p style={{ margin: "0 0 16px", color: "rgba(240,237,232,0.5)", fontSize: "14px", lineHeight: 1.5 }}>
                    A new <strong>dk_live_</strong> key will be generated and shown to you once. The current key is invalidated immediately — any integrations using it will stop working until you update them.
                  </p>
                  {rotateError && (
                    <div style={{ background: "rgba(232,124,124,0.1)", color: "#e87c7c", padding: "10px 12px", borderRadius: "8px", marginBottom: "16px", fontSize: "13px" }}>
                      {rotateError}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                    <button onClick={() => { setShowRotateDialog(false); setRotateError(null); }} disabled={isRotatingKey} style={{ padding: "8px 16px", background: "transparent", border: "1px solid rgba(240,237,232,0.2)", color: "#f0ede8", borderRadius: "8px", cursor: isRotatingKey ? "wait" : "pointer" }}>Cancel</button>
                    <button onClick={handleRotateKey} disabled={isRotatingKey} style={{ padding: "8px 16px", background: "#c8b99a", border: "none", color: "#0c0c0c", borderRadius: "8px", cursor: isRotatingKey ? "wait" : "pointer", fontWeight: 500, opacity: isRotatingKey ? 0.6 : 1 }}>
                      {isRotatingKey ? "Rotating…" : "Confirm Rotate"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {freshLiveKey && (
              <div role="dialog" style={{
                position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20
              }}>
                <div style={{ background: "#0c0c0c", padding: "32px", borderRadius: "16px", border: "1px solid rgba(126,200,152,0.25)", maxWidth: "560px", width: "100%" }}>
                  <h3 style={{ margin: "0 0 12px", fontSize: "20px", color: "#f0ede8", fontFamily: "'DM Serif Display', serif" }}>Your new live API key</h3>
                  <p style={{ margin: "0 0 20px", color: "rgba(240,237,232,0.55)", fontSize: "14px", lineHeight: 1.5 }}>
                    Copy this key and store it in a secure location (e.g. a secrets manager or <code>.env</code>). <strong style={{ color: "#e87c7c" }}>It will not be shown again.</strong>
                  </p>
                  <div style={{ background: "rgba(240,237,232,0.04)", border: "1px solid rgba(240,237,232,0.1)", padding: "14px 16px", borderRadius: "10px", fontFamily: "'DM Mono', 'Fira Code', monospace", fontSize: "13px", color: "#c8b99a", wordBreak: "break-all", marginBottom: 16, lineHeight: 1.6 }}>
                    {freshLiveKey}
                  </div>
                  <div style={{ display: "flex", gap: "12px", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: copiedFreshKey ? "#7ec898" : "rgba(240,237,232,0.3)" }}>
                      {copiedFreshKey ? "✓ Copied to clipboard" : "This dialog will not reopen."}
                    </span>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button onClick={handleCopyFreshKey} style={{ padding: "10px 18px", background: "transparent", border: "1px solid rgba(240,237,232,0.2)", color: "#f0ede8", borderRadius: "8px", cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
                        Copy key
                      </button>
                      <button onClick={() => { setFreshLiveKey(null); setCopiedFreshKey(false); }} style={{ padding: "10px 18px", background: "#7ec898", border: "none", color: "#0c0c0c", borderRadius: "8px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                        I saved it
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeNav === "Mandates" && (
              <>
                <div className="panel">
                  <div className="panel-header">
                    <span className="panel-title">Active Intent Mandates</span>
                  </div>
                  {mandates.length === 0 ? (
                    <div style={{ padding: 40, textAlign: "center" }}>
                      <div style={{ fontSize: 40, marginBottom: 16 }}>🤖</div>
                      <h3 style={{ fontSize: 18, color: "#f0ede8", marginBottom: 8 }}>No active mandates</h3>
                      <p style={{ fontSize: 14, color: "rgba(240,237,232,0.5)", maxWidth: 400, margin: "0 auto" }}>
                        {isBuyer 
                          ? "Mandates authorize AI agents to spend money on your behalf. Connect your agent through a supported merchant to create one."
                          : "Mandates authorize AI agents to spend money on your behalf. Generate an Intent Mandate via the API to see them here."}
                      </p>
                    </div>
                  ) : (
                    <table className="tx-table">
                      <thead>
                        <tr>
                          <th className="tx-th">Mandate ID</th>
                          <th className="tx-th">Monthly Limit</th>
                          <th className="tx-th">Spent (Mo)</th>
                          <th className="tx-th">Status</th>
                          <th className="tx-th">Expires</th>
                          <th className="tx-th" style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mandates.map((m) => (
                          <tr key={m.mandateId} className="tx-row">
                            <td className="tx-td">
                              <span className="tx-id" style={{ fontFamily: 'DM Mono, monospace' }}>{m.mandateId}</span>
                              {m.encodedMandate && (
                                <div style={{ marginTop: 6 }}>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(m.encodedMandate);
                                      setCopiedMandateId(m.mandateId);
                                      setTimeout(() => setCopiedMandateId(null), 2000);
                                    }}
                                    className="api-key-btn"
                                    style={{ 
                                      padding: '2px 8px', 
                                      fontSize: 10,
                                      background: copiedMandateId === m.mandateId ? 'rgba(126,200,152,0.15)' : 'rgba(240,237,232,0.08)',
                                      color: copiedMandateId === m.mandateId ? '#7ec898' : 'rgba(240,237,232,0.7)',
                                      border: copiedMandateId === m.mandateId ? '1px solid rgba(126,200,152,0.2)' : 'none',
                                      transition: 'all 0.2s ease',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      width: 'fit-content'
                                    }}
                                    title="Copy Intent Mandate Token"
                                  >
                                    {copiedMandateId === m.mandateId ? (
                                      <>
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                        Copied!
                                      </>
                                    ) : 'Copy Token'}
                                  </button>
                                </div>
                              )}
                            </td>
                            <td className="tx-td">
                              <span className="tx-amount">{fmt(m.maxMonthlySpendCents)}</span>
                            </td>
                            <td className="tx-td">
                              <span className="tx-amount">{fmt(m.currentMonthSpendCents)}</span>
                            </td>
                            <td className="tx-td">
                              <span className={`status-badge status-${m.status}`}>
                                <span className="status-dot" />
                                {m.status === 'active' ? 'Active' : 'Revoked'}
                              </span>
                            </td>
                            <td className="tx-td" style={{ color: "rgba(240,237,232,0.25)", fontSize: 12 }}>
                              {m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : 'Never'}
                            </td>
                            <td className="tx-td" style={{ textAlign: 'right' }}>
                              {m.status === 'active' && (
                                <button 
                                  onClick={() => setMandateToRevoke(m)}
                                  className="api-key-btn api-key-btn-danger"
                                  style={{ padding: '4px 12px', fontSize: 11, width: 'auto' }}
                                >
                                  Revoke
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {isBuyer && (
                  <div className="panel" style={{ marginTop: 24 }}>
                    <div className="panel-header" style={{ borderBottom: "1px solid rgba(240,237,232,0.08)" }}>
                      <span className="panel-title">Start using your mandates by connecting the AI Agent of your choice</span>
                    </div>
                    <div style={{ padding: "24px", display: "flex", gap: 16 }}>
                      <a
                        href="https://claude.ai/settings/integrations"
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 12,
                          padding: "16px",
                          background: "rgba(240,237,232,0.03)",
                          border: "1px solid rgba(240,237,232,0.1)",
                          borderRadius: 12,
                          color: "#f0ede8",
                          textDecoration: "none",
                          fontWeight: 500,
                          fontSize: 14,
                          transition: "background 0.2s"
                        }}
                        onMouseOver={(e) => e.currentTarget.style.background = "rgba(240,237,232,0.06)"}
                        onMouseOut={(e) => e.currentTarget.style.background = "rgba(240,237,232,0.03)"}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                        Add Connector on Claude.ai
                      </a>
                      
                      <button
                        onClick={() => setShowChatGptModal(true)}
                        style={{
                          flex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 12,
                          padding: "16px",
                          background: "rgba(240,237,232,0.03)",
                          border: "1px solid rgba(240,237,232,0.1)",
                          borderRadius: 12,
                          color: "#f0ede8",
                          fontWeight: 500,
                          fontSize: 14,
                          cursor: "pointer",
                          transition: "background 0.2s"
                        }}
                        onMouseOver={(e) => e.currentTarget.style.background = "rgba(240,237,232,0.06)"}
                        onMouseOut={(e) => e.currentTarget.style.background = "rgba(240,237,232,0.03)"}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        Add App on ChatGPT
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {mandateToRevoke && (
              <div role="dialog" style={{
                position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
                background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
              }}>
                <div style={{ background: "#0c0c0c", padding: "32px", borderRadius: "16px", border: "1px solid rgba(240,237,232,0.1)", maxWidth: "440px", width: "100%" }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: "18px", color: "#f0ede8" }}>Revoke Mandate?</h3>
                  <p style={{ margin: "0 0 8px", color: "rgba(240,237,232,0.7)", fontSize: "14px", lineHeight: 1.5 }}>
                    Are you sure you want to revoke this spending mandate? 
                  </p>
                  <p style={{ margin: "0 0 24px", color: "rgba(240,237,232,0.4)", fontSize: "12px", fontFamily: 'DM Mono, monospace', wordBreak: 'break-all', background: 'rgba(240,237,232,0.03)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(240,237,232,0.08)' }}>
                    {mandateToRevoke.mandateId}
                  </p>
                  <p style={{ margin: "0 0 24px", color: "#e87c7c", fontSize: "13px", fontWeight: 500 }}>
                    This will immediately stop your AI agent from being able to spend funds using this authorization.
                  </p>
                  <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                    <button 
                      onClick={() => setMandateToRevoke(null)} 
                      disabled={isRevoking}
                      style={{ padding: "8px 16px", background: "transparent", border: "1px solid rgba(240,237,232,0.2)", color: "#f0ede8", borderRadius: "8px", cursor: "pointer" }}
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleRevokeMandate} 
                      disabled={isRevoking}
                      style={{ padding: "8px 16px", background: "#e87c7c", border: "none", color: "#0c0c0c", borderRadius: "8px", cursor: isRevoking ? "wait" : "pointer", fontWeight: 600 }}
                    >
                      {isRevoking ? "Revoking..." : "Revoke Mandate"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showChatGptModal && (
              <div style={{
                position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
                padding: 16, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(4px)"
              }}>
                <div style={{ position: "relative", maxWidth: 440, width: "100%", background: "#111111", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 16, padding: 24, boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)" }}>
                  <button 
                    onClick={() => setShowChatGptModal(false)}
                    style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", color: "rgba(240,237,232,0.3)", cursor: "pointer", padding: 4 }}
                    onMouseOver={(e) => e.currentTarget.style.color = "#f0ede8"}
                    onMouseOut={(e) => e.currentTarget.style.color = "rgba(240,237,232,0.3)"}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                  </button>
                  
                  <h2 style={{ fontSize: 20, fontWeight: 500, margin: "0 0 24px", display: "flex", alignItems: "center", gap: 8, color: "#f0ede8" }}>
                    <span style={{ width: 32, height: 32, background: "rgba(255,255,255,0.05)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: "bold" }}>GPT</span>
                    ChatGPT Setup
                  </h2>
                  
                  <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div style={{ display: "flex", gap: 16 }}>
                      <div style={{ flexShrink: 0, width: 24, height: 24, background: "rgba(200,185,154,0.2)", color: "#c8b99a", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold" }}>1</div>
                      <div>
                        <h4 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", color: "#f0ede8" }}>Enable Developer Mode</h4>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", margin: 0, lineHeight: 1.5 }}>Go to <strong>Settings</strong> → <strong>Apps</strong> and enable <strong>Developer mode</strong>.</p>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 16 }}>
                      <div style={{ flexShrink: 0, width: 24, height: 24, background: "rgba(200,185,154,0.2)", color: "#c8b99a", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold" }}>2</div>
                      <div>
                        <h4 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", color: "#f0ede8" }}>Add the MCP Server</h4>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", margin: "0 0 12px", lineHeight: 1.5 }}>Click <strong>Add app</strong> and paste the URL below:</p>
                        <div style={{ background: "#000", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: 8, display: "flex", alignItems: "center", gap: 8 }}>
                          <code style={{ fontSize: 11, color: "#7ec898", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mcpUrl}</code>
                          <button 
                            onClick={() => {
                              navigator.clipboard.writeText(mcpUrl);
                              alert("MCP URL Copied!");
                            }}
                            style={{ padding: 6, background: "transparent", border: "none", color: "rgba(240,237,232,0.4)", cursor: "pointer", borderRadius: 4 }}
                            onMouseOver={(e) => { e.currentTarget.style.color = "#f0ede8"; e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                            onMouseOut={(e) => { e.currentTarget.style.color = "rgba(240,237,232,0.4)"; e.currentTarget.style.background = "transparent"; }}
                            title="Copy URL"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                          </button>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 16 }}>
                      <div style={{ flexShrink: 0, width: 24, height: 24, background: "rgba(200,185,154,0.2)", color: "#c8b99a", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: "bold" }}>3</div>
                      <div>
                        <h4 style={{ fontSize: 14, fontWeight: 500, margin: "0 0 4px", color: "#f0ede8" }}>Start a conversation</h4>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", margin: 0, lineHeight: 1.5 }}>Open a new chat, click the <span style={{ color: "#fff" }}>+</span> button, select <strong>Delegare</strong>, and start prompting!</p>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 32, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <a
                      href="https://docs.delegare.dev/sdk-tools/mcp-tools"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "#c8b99a", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}
                      onMouseOver={(e) => e.currentTarget.style.textDecoration = "underline"}
                      onMouseOut={(e) => e.currentTarget.style.textDecoration = "none"}
                    >
                      View full documentation
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
                    </a>
                    <button
                      onClick={() => setShowChatGptModal(false)}
                      style={{ padding: "8px 16px", background: "#c8b99a", color: "#0c0c0c", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer" }}
                    >
                      Got it
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeNav === "Payment Methods" && (
              <div className="panel" style={{ maxWidth: 640 }}>
                <div className="panel-header">
                  <span className="panel-title">Payment Methods</span>
                </div>
                <div style={{ padding: "24px 28px" }}>
                  <p style={{ fontSize: 13, color: "rgba(240,237,232,0.55)", lineHeight: 1.6, marginBottom: 24 }}>
                    Connect one or both rails so your AI agent can pay any merchant. {" "}
                    <strong style={{ color: "#7ec898" }}>USDC on Base</strong> is required for P2P
                    payments to other Delegare handles — connecting it also gives you your own
                    funny @handle to receive money.
                  </p>

                  {pmError && (
                    <div style={{ background: "rgba(255,77,79,0.08)", border: "1px solid rgba(255,77,79,0.3)", color: "#ff7875", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                      {pmError}
                    </div>
                  )}

                  {/* ── Fiat (Card via Stripe Link) ─────────────────────── */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 18px", background: "rgba(99,91,255,0.05)", border: "1px solid rgba(99,91,255,0.2)", borderRadius: 12, marginBottom: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(99,91,255,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "#a5a0ff", fontWeight: 600, fontSize: 14 }}>$</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, color: "#f0ede8", fontWeight: 500 }}>Card on File</div>
                      <div style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginTop: 2 }}>
                        Stripe + Link · charges your card off-session when your agent spends
                      </div>
                    </div>
                    {hasFiatRail ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#7ec898", fontFamily: "'DM Mono', monospace", padding: "6px 10px", background: "rgba(126,200,152,0.08)", borderRadius: 6 }}>
                          ✓ Connected{merchant?.stripeBuyerPaymentMethodLast4 ? ` ••${merchant.stripeBuyerPaymentMethodLast4}` : ""}
                        </span>
                        <button
                          onClick={() => handleBuyerDisconnect('stripe')}
                          style={{ background: "transparent", color: "rgba(240,237,232,0.4)", border: "1px solid rgba(240,237,232,0.1)", padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 500, transition: "color 0.2s, border-color 0.2s" }}
                          onMouseOver={e => { e.currentTarget.style.color = "#ff4d4f"; e.currentTarget.style.borderColor = "rgba(255,77,79,0.3)"; }}
                          onMouseOut={e => { e.currentTarget.style.color = "rgba(240,237,232,0.4)"; e.currentTarget.style.borderColor = "rgba(240,237,232,0.1)"; }}
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={handleBuyerAddFiat}
                        disabled={pmConnecting !== null}
                        style={{
                          background: "#635BFF", color: "#fff", border: "none",
                          padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                          cursor: pmConnecting !== null ? "wait" : "pointer", opacity: pmConnecting !== null ? 0.6 : 1
                        }}
                      >
                        {pmConnecting === "fiat" ? "Connecting…" : "Connect Card"}
                      </button>
                    )}
                  </div>

                  {/* ── Crypto (Coinbase Smart Wallet on Base) ──────────── */}
                  <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 18px", background: "rgba(126,200,152,0.05)", border: "1px solid rgba(126,200,152,0.2)", borderRadius: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(126,200,152,0.12)", display: "flex", alignItems: "center", justifyContent: "center", color: "#7ec898", fontWeight: 600, fontSize: 14 }}>₿</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, color: "#f0ede8", fontWeight: 500 }}>USDC on Base</div>
                      <div style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginTop: 2 }}>
                        Coinbase Smart Wallet · enables P2P send + receive with a funny @handle
                      </div>
                    </div>
                    {hasCryptoRail ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#7ec898", fontFamily: "'DM Mono', monospace", padding: "6px 10px", background: "rgba(126,200,152,0.08)", borderRadius: 6 }}>
                          ✓ {merchant?.usdcWalletAddress?.slice(0, 6)}…{merchant?.usdcWalletAddress?.slice(-4)}
                        </span>
                        <button
                          onClick={() => handleBuyerDisconnect('crypto')}
                          style={{ background: "transparent", color: "rgba(240,237,232,0.4)", border: "1px solid rgba(240,237,232,0.1)", padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontWeight: 500, transition: "color 0.2s, border-color 0.2s" }}
                          onMouseOver={e => { e.currentTarget.style.color = "#ff4d4f"; e.currentTarget.style.borderColor = "rgba(255,77,79,0.3)"; }}
                          onMouseOut={e => { e.currentTarget.style.color = "rgba(240,237,232,0.4)"; e.currentTarget.style.borderColor = "rgba(240,237,232,0.1)"; }}
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={openWalletPicker}
                        disabled={pmConnecting !== null}
                        style={{
                          background: "#0052FF", color: "#fff", border: "none",
                          padding: "8px 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                          cursor: pmConnecting !== null ? "wait" : "pointer", opacity: pmConnecting !== null ? 0.6 : 1
                        }}
                      >
                        {pmConnecting === "crypto" ? "Connecting…" : "Connect Wallet"}
                      </button>
                    )}
                  </div>

                  {/* ── P2P Handle Display ──────────────────────────────── */}
                  {isBuyer && hasCryptoRail && merchant?.merchantHandle && (
                    <div style={{ marginTop: 24, padding: 20, background: "rgba(200,185,154,0.05)", border: "1px solid rgba(200,185,154,0.15)", borderRadius: 12 }}>
                      <h4 style={{ margin: "0 0 8px 0", fontSize: 14, color: "#c8b99a", fontWeight: 500 }}>Your Public P2P Profile</h4>
                      <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "rgba(240,237,232,0.6)", lineHeight: 1.5 }}>
                        Because you connected a crypto wallet, anyone with an AI agent can now instantly "buy you a coffee" by sending USDC to your funny handle!
                      </p>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#000", border: "1px solid rgba(240,237,232,0.1)", padding: "12px 16px", borderRadius: 8 }}>
                        <span style={{ color: "#7ec898", fontFamily: "'DM Mono', monospace", fontSize: 13, flex: 1 }}>
                          @{merchant.merchantHandle}
                        </span>
                        <a 
                          href={`${WEB_URL}/@${merchant.merchantHandle}`}
                          target="_blank" 
                          rel="noopener noreferrer"
                          style={{
                            fontSize: 12, color: "#0c0c0c", background: "#c8b99a", padding: "6px 12px", borderRadius: 6, fontWeight: 600, textDecoration: "none"
                          }}
                        >
                          View Profile ↗
                        </a>
                      </div>
                    </div>
                  )}

                  {/* Wallet picker — shown after the user clicks Connect Wallet */}
                  {showWalletPicker && !hasCryptoRail && (
                    <div style={{ marginTop: 16, padding: 16, background: "rgba(126,200,152,0.03)", border: "1px solid rgba(126,200,152,0.15)", borderRadius: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <span style={{ fontSize: 13, color: "#7ec898", fontWeight: 500 }}>Choose a wallet on Base</span>
                        <button
                          onClick={() => setShowWalletPicker(false)}
                          style={{ background: "transparent", border: "none", color: "rgba(240,237,232,0.4)", cursor: "pointer", fontSize: 12 }}
                        >
                          Cancel
                        </button>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {walletConnectors.map(connector => (
                          <button
                            key={connector.id}
                            onClick={() => handleBuyerAddCrypto(connector)}
                            disabled={pmConnecting !== null}
                            style={{
                              display: "flex", alignItems: "center", gap: 12,
                              padding: "10px 12px",
                              background: "rgba(240,237,232,0.03)",
                              border: "1px solid rgba(240,237,232,0.1)",
                              borderRadius: 8,
                              color: "#f0ede8",
                              cursor: pmConnecting !== null ? "wait" : "pointer",
                              fontSize: 13,
                              textAlign: "left",
                            }}
                          >
                            {connector.iconUrl && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={connector.iconUrl} alt="" width={22} height={22} style={{ borderRadius: 5, flexShrink: 0 }} />
                            )}
                            <span style={{ flex: 1, fontWeight: 500 }}>{connector.name}</span>
                            <span style={{ fontSize: 11, color: "rgba(240,237,232,0.4)" }}>→</span>
                          </button>
                        ))}
                        {walletConnectors.length === 0 && (
                          <div style={{ padding: 12, fontSize: 12, color: "rgba(240,237,232,0.5)" }}>
                            No wallet detected. Install MetaMask, Rabby, or use Coinbase Smart Wallet.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── Enable Spending flow (wallet connected, no mandate yet) ── */}
                  {hasCryptoRail && spendingSetup.step !== 'done' && (
                    <div style={{ marginTop: 16, padding: 20, background: "rgba(200,185,154,0.04)", border: "1px solid rgba(200,185,154,0.15)", borderRadius: 12 }}>
                      {spendingSetup.step === 'idle' && (
                        <>
                          <div style={{ fontSize: 14, fontWeight: 500, color: "#f0ede8", marginBottom: 8 }}>Enable autonomous spending</div>
                          <p style={{ fontSize: 13, color: "rgba(240,237,232,0.5)", lineHeight: 1.6, marginBottom: 16 }}>
                            Your wallet is connected for receiving. To let your AI agent spend USDC on your behalf, set spending limits and authorize on-chain.
                          </p>
                          <button
                            onClick={() => setSpendingSetup(s => ({ ...s, step: 'config' }))}
                            style={{ background: "#c8b99a", color: "#0c0c0c", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                          >
                            Set up spending limits
                          </button>
                        </>
                      )}

                      {spendingSetup.step === 'config' && (
                        <>
                          <div style={{ fontSize: 14, fontWeight: 500, color: "#f0ede8", marginBottom: 16 }}>Configure spending limits</div>
                          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", display: "block", marginBottom: 4 }}>Max per transaction ($)</label>
                              <input
                                type="number"
                                value={spendingSetup.maxPerTx}
                                onChange={e => setSpendingSetup(s => ({ ...s, maxPerTx: e.target.value }))}
                                style={{ width: "100%", padding: "10px 12px", background: "rgba(240,237,232,0.04)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, color: "#f0ede8", fontSize: 14 }}
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <label style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", display: "block", marginBottom: 4 }}>Monthly cap ($)</label>
                              <input
                                type="number"
                                value={spendingSetup.maxMonthly}
                                onChange={e => setSpendingSetup(s => ({ ...s, maxMonthly: e.target.value }))}
                                style={{ width: "100%", padding: "10px 12px", background: "rgba(240,237,232,0.04)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, color: "#f0ede8", fontSize: 14 }}
                              />
                            </div>
                          </div>
                          {spendingSetup.error && (
                            <div style={{ fontSize: 12, color: "#ff7875", marginBottom: 12, padding: "8px 10px", background: "rgba(255,77,79,0.08)", borderRadius: 6 }}>{spendingSetup.error}</div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={handleEnableSpending}
                              style={{ background: "#c8b99a", color: "#0c0c0c", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
                            >
                              Create mandate &amp; session key
                            </button>
                            <button
                              onClick={() => setSpendingSetup(s => ({ ...s, step: 'idle', error: null }))}
                              style={{ background: "transparent", color: "rgba(240,237,232,0.5)", border: "none", fontSize: 13, cursor: "pointer" }}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}

                      {spendingSetup.step === 'provisioning' && (
                        <div style={{ textAlign: "center", padding: "20px 0" }}>
                          <div style={{ fontSize: 14, color: "#c8b99a", marginBottom: 8 }}>Provisioning mandate &amp; session key...</div>
                          <div style={{ fontSize: 12, color: "rgba(240,237,232,0.4)" }}>This takes a few seconds</div>
                        </div>
                      )}

                      {spendingSetup.step === 'authorize' && (
                        <>
                          <div style={{ fontSize: 14, fontWeight: 500, color: "#f0ede8", marginBottom: 8 }}>Authorize on-chain</div>
                          <p style={{ fontSize: 13, color: "rgba(240,237,232,0.5)", lineHeight: 1.6, marginBottom: 12 }}>
                            Your mandate is created. Now sign two transactions to authorize the session key on-chain:
                          </p>
                          <div style={{ padding: 12, background: "rgba(200,185,154,0.06)", borderRadius: 8, marginBottom: 16, fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#c8b99a", wordBreak: "break-all" }}>
                            Session key: {spendingSetup.sessionKeyAddress}
                          </div>
                          {spendingSetup.error && (
                            <div style={{ fontSize: 12, color: "#ff7875", marginBottom: 12, padding: "8px 10px", background: "rgba(255,77,79,0.08)", borderRadius: 6 }}>{spendingSetup.error}</div>
                          )}
                          <button
                            onClick={handleOnChainAuthorize}
                            style={{ background: "#7ec898", color: "#0c0c0c", border: "none", padding: "12px 24px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%" }}
                          >
                            Approve USDC &amp; authorize session key
                          </button>
                          <p style={{ fontSize: 11, color: "rgba(240,237,232,0.3)", marginTop: 8, textAlign: "center" }}>
                            Requires a small amount of ETH for gas on Base.
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  {spendingSetup.step === 'done' && hasCryptoRail && (
                    <div style={{ marginTop: 16, padding: 16, background: "rgba(126,200,152,0.08)", border: "1px solid rgba(126,200,152,0.25)", borderRadius: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: "#7ec898", marginBottom: 4 }}>&#x2713; Spending enabled</div>
                      <div style={{ fontSize: 12, color: "rgba(240,237,232,0.5)" }}>
                        Your agent can now spend up to ${spendingSetup.maxMonthly}/month from your wallet.
                      </div>
                    </div>
                  )}

                  {/* Helpful empty/upgrade hints */}
                  {hasFiatRail && !hasCryptoRail && (
                    <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginTop: 16, lineHeight: 1.6 }}>
                      You can pay any fiat merchant today. <strong style={{ color: "#7ec898" }}>Add USDC</strong> if you also want to send money P2P to other Delegare users (e.g. <span style={{ fontFamily: "'DM Mono', monospace" }}>@swift-amber-narwhal</span>).
                    </p>
                  )}
                  {hasCryptoRail && !hasFiatRail && spendingSetup.step === 'done' && (
                    <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginTop: 16, lineHeight: 1.6 }}>
                      You can send USDC to any wallet or Delegare handle. <strong style={{ color: "#a5a0ff" }}>Add a card</strong> if you want your agent to also pay merchants that only accept fiat.
                    </p>
                  )}
                </div>
              </div>
            )}

            {activeNav === "Settings" && (
              <div className="panel" style={{ maxWidth: 600 }}>
                <div className="panel-header">
                  <span className="panel-title">{isBuyer ? 'Account Settings' : 'Merchant Settings'}</span>
                </div>
                <div style={{ padding: "24px 28px" }}>
                  <div style={{ marginBottom: 32 }}>
                    <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "#f0ede8", marginBottom: 12 }}>Account Type</label>
                    <div style={{ display: "flex", gap: 12 }}>
                      <button
                        onClick={() => handleSwitchAccountType('merchant')}
                        style={{
                          flex: 1, padding: "16px", borderRadius: "12px", border: "1px solid",
                          background: !isBuyer ? "rgba(200,185,154,0.1)" : "transparent",
                          borderColor: !isBuyer ? "#c8b99a" : "rgba(240,237,232,0.1)",
                          color: !isBuyer ? "#c8b99a" : "rgba(240,237,232,0.4)",
                          cursor: "pointer", textAlign: "left", transition: "all 0.2s"
                        }}
                      >
                        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: 2 }}>Merchant</div>
                        <div style={{ fontSize: "11px" }}>Receive payments from agents</div>
                      </button>
                      <button
                        onClick={() => handleSwitchAccountType('buyer')}
                        style={{
                          flex: 1, padding: "16px", borderRadius: "12px", border: "1px solid",
                          background: isBuyer ? "rgba(200,185,154,0.1)" : "transparent",
                          borderColor: isBuyer ? "#c8b99a" : "rgba(240,237,232,0.1)",
                          color: isBuyer ? "#c8b99a" : "rgba(240,237,232,0.4)",
                          cursor: "pointer", textAlign: "left", transition: "all 0.2s"
                        }}
                      >
                        <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: 2 }}>Buyer</div>
                        <div style={{ fontSize: "11px" }}>Authorize your agents to spend</div>
                      </button>
                    </div>
                  </div>

                  <div style={{ marginBottom: 24 }}>
                    <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 8 }}>{isBuyer ? 'Display Name' : 'Merchant Name'}</label>
                    <input type="text" value={merchant?.name || ""} readOnly style={{ width: "100%", background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 14px", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif" }} />
                  </div>
                  <div style={{ marginBottom: 24 }}>
                    <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 8 }}>Contact Email</label>
                    <input type="text" value={merchant?.contactEmail || ""} readOnly style={{ width: "100%", background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 14px", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif" }} />
                  </div>
                  
                  {!isBuyer && (
                    <>
                      <div>
                        <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 8 }}>Connected Payout Methods</label>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "rgba(200,185,154,0.05)", border: "1px solid rgba(200,185,154,0.1)", borderRadius: 8, marginBottom: 12 }}>
                          <span style={{ fontSize: 14, color: "#c8b99a", flex: 1 }}>Stripe (Fiat)</span>
                          {merchant?.stripeConnectedAccountId ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 12, color: "rgba(240,237,232,0.4)" }}>Connected ({merchant.stripeConnectedAccountId.slice(0, 8)}...)</span>
                              <button onClick={() => handleDisconnect('stripe')} style={{ background: "transparent", color: "rgba(240,237,232,0.4)", border: "1px solid rgba(240,237,232,0.1)", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: 500, transition: "color 0.2s" }} onMouseOver={(e) => e.currentTarget.style.color = "#ff4d4f"} onMouseOut={(e) => e.currentTarget.style.color = "rgba(240,237,232,0.4)"}>
                                Disconnect
                              </button>
                            </div>
                          ) : (
                            <button onClick={handleStripeConnect} style={{ background: "rgba(200,185,154,0.15)", color: "#c8b99a", border: "none", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: 500 }}>
                              Connect
                            </button>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "rgba(126,200,152,0.05)", border: "1px solid rgba(126,200,152,0.1)", borderRadius: 8 }}>
                          <span style={{ fontSize: 14, color: "#7ec898", flex: 1 }}>Crypto Wallet (USDC)</span>
                          {merchant?.usdcWalletAddress ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{ fontSize: 12, color: "rgba(240,237,232,0.4)", fontFamily: "'DM Mono', monospace" }}>Connected ({merchant.usdcWalletAddress.slice(0, 6)}...{merchant.usdcWalletAddress.slice(-4)})</span>
                              <button onClick={() => handleDisconnect('crypto')} style={{ background: "transparent", color: "rgba(240,237,232,0.4)", border: "1px solid rgba(240,237,232,0.1)", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: 500, transition: "color 0.2s" }} onMouseOver={(e) => e.currentTarget.style.color = "#ff4d4f"} onMouseOut={(e) => e.currentTarget.style.color = "rgba(240,237,232,0.4)"}>
                                Disconnect
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => { setWalletConnectors(getBuyerWalletConnectors()); setShowMerchantWalletPicker(true); }} style={{ background: "rgba(126,200,152,0.15)", color: "#7ec898", border: "none", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", cursor: "pointer", fontWeight: 500 }}>
                              Connect
                            </button>
                          )}
                        </div>

                        {showMerchantWalletPicker && !merchant?.usdcWalletAddress && (
                          <div style={{ marginTop: 12, padding: 16, background: "rgba(126,200,152,0.03)", border: "1px solid rgba(126,200,152,0.15)", borderRadius: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                              <span style={{ fontSize: 13, color: "#7ec898", fontWeight: 500 }}>Choose a wallet on Base</span>
                              <button
                                onClick={() => setShowMerchantWalletPicker(false)}
                                style={{ background: "transparent", border: "none", color: "rgba(240,237,232,0.4)", cursor: "pointer", fontSize: 12 }}
                              >
                                Cancel
                              </button>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {walletConnectors.map(connector => (
                                <button
                                  key={connector.id}
                                  onClick={() => handleMerchantAddCrypto(connector)}
                                  disabled={pmConnecting !== null}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 12,
                                    padding: "10px 12px",
                                    background: "rgba(240,237,232,0.03)",
                                    border: "1px solid rgba(240,237,232,0.08)",
                                    borderRadius: 8,
                                    cursor: pmConnecting !== null ? "wait" : "pointer",
                                    color: "#f0ede8",
                                    fontSize: 13,
                                    fontWeight: 500,
                                    transition: "background 0.2s"
                                  }}
                                  onMouseOver={(e) => { if (pmConnecting === null) e.currentTarget.style.background = "rgba(240,237,232,0.08)" }}
                                  onMouseOut={(e) => { if (pmConnecting === null) e.currentTarget.style.background = "rgba(240,237,232,0.03)" }}
                                >
                                  <img src={connector.iconUrl} alt={connector.name} style={{ width: 24, height: 24, borderRadius: 6 }} />
                                  {connector.name}
                                  {pmConnecting === "crypto" && <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(240,237,232,0.5)" }}>Connecting...</span>}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* ── Payment Rail Preference ── */}
                      <div style={{ marginTop: 32, paddingTop: 28, borderTop: "1px solid rgba(240,237,232,0.06)" }}>
                        <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#f0ede8", marginBottom: 4 }}>Payment Rail</label>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 16, marginTop: 0 }}>
                          Control which payment methods your agents accept. "Any" maximises payment volume — agents will use whichever rail their buyer has connected.
                        </p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {([
                            { value: "any", label: "Accept Any", sub: "Fiat (Stripe) or Crypto (USDC) — recommended", color: "#c8b99a" },
                            { value: "fiat_only", label: "Fiat Only (Stripe)", sub: "Buyers must have a card mandate. No USDC accepted.", color: "#c8b99a" },
                            { value: "crypto_only", label: "Crypto Only (USDC)", sub: "Buyers must have a crypto wallet mandate. No Stripe.", color: "#7ec898" },
                          ] as const).map(({ value, label, sub, color }) => (
                            <button
                              key={value}
                              onClick={() => !savingRail && handleSaveRail(value)}
                              disabled={savingRail}
                              style={{
                                display: "flex", alignItems: "center", gap: 14,
                                padding: "14px 16px", borderRadius: 10, border: "1px solid",
                                background: railRequirement === value ? `rgba(${value === "crypto_only" ? "126,200,152" : "200,185,154"},0.08)` : "rgba(240,237,232,0.02)",
                                borderColor: railRequirement === value ? color : "rgba(240,237,232,0.08)",
                                cursor: savingRail ? "wait" : "pointer",
                                textAlign: "left", transition: "all 0.15s", width: "100%",
                              }}
                            >
                              <div style={{
                                width: 16, height: 16, borderRadius: "50%", border: `2px solid ${railRequirement === value ? color : "rgba(240,237,232,0.2)"}`,
                                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                              }}>
                                {railRequirement === value && <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />}
                              </div>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600, color: railRequirement === value ? color : "rgba(240,237,232,0.7)" }}>{label}</div>
                                <div style={{ fontSize: 11, color: "rgba(240,237,232,0.4)", marginTop: 2 }}>{sub}</div>
                              </div>
                              {savingRail && railRequirement !== value && <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(240,237,232,0.3)" }}>Saving...</span>}
                              {railSaveStatus === "success" && railRequirement === value && <span style={{ marginLeft: "auto", fontSize: 11, color: "#7ec898" }}>✓ Saved</span>}
                            </button>
                          ))}
                        </div>
                        {railSaveStatus === "error" && <p style={{ color: "#ff4d4f", fontSize: 12, marginTop: 8 }}>Failed to save rail preference.</p>}
                        <p style={{ fontSize: 11, color: "rgba(240,237,232,0.3)", marginTop: 10 }}>
                          Agents with a mismatched mandate will be prompted to add the required payment method before paying you.
                        </p>
                      </div>

                      {/* ── Auto-Offramp ── */}
                      <div style={{ marginTop: 32, paddingTop: 28, borderTop: "1px solid rgba(240,237,232,0.06)" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                          <label style={{ fontSize: 14, fontWeight: 500, color: "#f0ede8" }}>Auto-Offramp</label>
                          <button
                            onClick={() => handleSaveOfframp(!autoOfframp, autoOfframpBankAccountId, autoOfframpThresholdCents)}
                            disabled={savingOfframp || (!merchant?.stripeConnectedAccountId) || (!merchant?.usdcWalletAddress)}
                            style={{
                              width: 44, height: 24, borderRadius: 12, border: "none",
                              cursor: savingOfframp || !merchant?.stripeConnectedAccountId || !merchant?.usdcWalletAddress ? "not-allowed" : "pointer",
                              background: autoOfframp ? "#7ec898" : "rgba(240,237,232,0.15)",
                              position: "relative", transition: "background 0.2s",
                              opacity: (!merchant?.stripeConnectedAccountId || !merchant?.usdcWalletAddress) ? 0.4 : 1,
                            }}
                          >
                            <div style={{
                              width: 18, height: 18, borderRadius: "50%", background: "white",
                              position: "absolute", top: 3, transition: "left 0.2s",
                              left: autoOfframp ? 23 : 3,
                              boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
                            }} />
                          </button>
                        </div>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 16, marginTop: 4 }}>
                          Automatically convert USDC to fiat after each settlement via Stripe. No crypto balance sheet exposure.
                          {!merchant?.stripeConnectedAccountId && <span style={{ color: "#c8b99a" }}> Connect Stripe first to enable.</span>}
                          {merchant?.stripeConnectedAccountId && !merchant?.usdcWalletAddress && <span style={{ color: "#7ec898" }}> Connect a USDC wallet above to enable — auto-offramp sweeps USDC payments to your bank automatically.</span>}
                        </p>

                        {autoOfframp && merchant?.stripeConnectedAccountId && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <div>
                              <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 6 }}>Payout Bank Account</label>
                              {linkedBankAccounts.length > 0 ? (
                                <div style={{ display: "flex", gap: 10 }}>
                                  <select
                                    value={autoOfframpBankAccountId}
                                    onChange={e => setAutoOfframpBankAccountId(e.target.value)}
                                    style={{ flex: 1, background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 14px", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif", fontSize: 13 }}
                                  >
                                    {linkedBankAccounts.map(bank => (
                                      <option key={bank.id} value={bank.id} style={{ background: "#1a1a1a" }}>
                                        {bank.bankName} ****{bank.last4} {bank.isDefault ? "(default)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    onClick={() => handleSaveOfframp(true, autoOfframpBankAccountId, autoOfframpThresholdCents)}
                                    disabled={savingOfframp || !autoOfframpBankAccountId}
                                    style={{ background: offrampSaveStatus === "success" ? "rgba(126,200,152,0.2)" : "#c8b99a", color: offrampSaveStatus === "success" ? "#7ec898" : "#0c0c0c", border: "none", padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                                  >
                                    {savingOfframp ? "Saving..." : offrampSaveStatus === "success" ? "Saved!" : "Save"}
                                  </button>
                                </div>
                              ) : (
                                <div style={{ display: "flex", gap: 10 }}>
                                  <input
                                    type="text"
                                    placeholder="ba_1234... (from Stripe Dashboard → Payouts)"
                                    value={autoOfframpBankAccountId}
                                    onChange={e => setAutoOfframpBankAccountId(e.target.value)}
                                    style={{ flex: 1, background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 14px", color: "#f0ede8", fontFamily: "'DM Mono', monospace", fontSize: 12 }}
                                  />
                                  <button
                                    onClick={() => handleSaveOfframp(true, autoOfframpBankAccountId, autoOfframpThresholdCents)}
                                    disabled={savingOfframp || !autoOfframpBankAccountId}
                                    style={{ background: offrampSaveStatus === "success" ? "rgba(126,200,152,0.2)" : "#c8b99a", color: offrampSaveStatus === "success" ? "#7ec898" : "#0c0c0c", border: "none", padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                                  >
                                    {savingOfframp ? "Saving..." : offrampSaveStatus === "success" ? "Saved!" : "Save"}
                                  </button>
                                </div>
                              )}
                              <p style={{ fontSize: 11, color: "rgba(240,237,232,0.3)", marginTop: 6 }}>
                                {linkedBankAccounts.length > 0
                                  ? "Bank accounts linked via your connected Stripe account."
                                  : "No bank accounts found. Add one in Stripe Dashboard → Payouts → Bank accounts, then reconnect Stripe."}
                              </p>
                            </div>
                            <div>
                              <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 6 }}>Minimum sweep threshold (USD)</label>
                              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ color: "rgba(240,237,232,0.4)", fontSize: 13 }}>$</span>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={autoOfframpThresholdCents / 100}
                                  onChange={e => setAutoOfframpThresholdCents(Math.round(parseFloat(e.target.value || "0") * 100))}
                                  style={{ width: 100, background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "8px 12px", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif" }}
                                />
                                <span style={{ fontSize: 12, color: "rgba(240,237,232,0.4)" }}>— only sweep if settlement ≥ this amount. $0 = always sweep.</span>
                              </div>
                            </div>
                          </div>
                        )}

                        {!autoOfframp && (
                          <div style={{ padding: "12px 16px", background: "rgba(240,237,232,0.02)", border: "1px solid rgba(240,237,232,0.06)", borderRadius: 8 }}>
                            <div style={{ fontSize: 12, color: "rgba(240,237,232,0.4)", lineHeight: 1.6 }}>
                              When enabled, every USDC payment you receive is automatically swept to your bank via Stripe.
                              <br />Fee: <strong style={{ color: "rgba(240,237,232,0.6)" }}>$0.30 Delegare</strong> + Stripe ~0.25% + $0.25 per transfer. Estimated 1–2 business days.
                            </div>
                          </div>
                        )}
                        {offrampSaveStatus === "error" && <p style={{ color: "#ff4d4f", fontSize: 12, marginTop: 8 }}>Failed to save auto-offramp settings.</p>}
                      </div>

                      <div style={{ marginTop: 32 }}>
                        <label style={{ display: "block", fontSize: 14, fontWeight: 500, color: "#f0ede8", marginBottom: 12 }}>Webhook Settings</label>
                        <p style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 16 }}>Receive real-time notifications when your AI agent customers complete payments or refunds.</p>
                        
                        <div style={{ marginBottom: 16 }}>
                          <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 8 }}>Endpoint URL</label>
                          <div style={{ display: "flex", gap: 12 }}>
                            <input 
                              type="url" 
                              placeholder="https://your-api.com/webhooks"
                              value={webhookUrl}
                              onChange={(e) => setWebhookUrl(e.target.value)}
                              style={{ flex: 1, background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 14px", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif" }} 
                            />
                            <button 
                              onClick={handleSaveWebhook}
                              disabled={savingWebhook}
                              style={{ 
                                background: webhookSaveStatus === "success" ? "rgba(126,200,152,0.2)" : "#c8b99a", 
                                color: webhookSaveStatus === "success" ? "#7ec898" : "#0c0c0c", 
                                border: "none", padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: savingWebhook ? "wait" : "pointer" 
                              }}
                            >
                              {savingWebhook ? "Saving..." : webhookSaveStatus === "success" ? "Saved!" : "Save URL"}
                            </button>
                          </div>
                          {webhookSaveStatus === "error" && <p style={{ color: "#ff4d4f", fontSize: 12, marginTop: 8 }}>Failed to save webhook settings.</p>}
                        </div>

                        <div>
                          <label style={{ display: "block", fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 8 }}>Signing Secret</label>
                          <div style={{ position: "relative" }}>
                            <input
                              type="text"
                              value={merchant?.webhookSecret || "whsec_..."}
                              readOnly
                              style={{ width: "100%", background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 8, padding: "10px 60px 10px 14px", color: "rgba(240,237,232,0.5)", fontFamily: "'DM Mono', monospace", fontSize: 12 }}
                            />
                          <button
                          onClick={(e) => {
                            if (merchant?.webhookSecret) {
                              navigator.clipboard.writeText(merchant.webhookSecret);
                              const btn = e.currentTarget;
                              const originalHTML = btn.innerHTML;
                              btn.innerHTML = "Copied!";
                              setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
                            }
                          }}
                          style={{ position: "absolute", right: 8, top: 8, background: "rgba(255,255,255,0.1)", border: "none", color: "#f0ede8", padding: "4px 8px", borderRadius: 4, fontSize: 11, cursor: merchant?.webhookSecret ? "pointer" : "not-allowed", opacity: merchant?.webhookSecret ? 1 : 0.5 }}
                          >
                          Copy
                          </button>                      </div>
                      <p style={{ fontSize: 11, color: "rgba(240,237,232,0.4)", marginTop: 6 }}>Use this secret to verify the `X-Delegare-Signature` HMAC SHA256 header.</p>
                    </div>
                  </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* END DYNAMIC CONTENT */}
          </main>
        </div>
    );
  };

  if (isTest) {
    return renderDashboard();
  }

  return (
    <Authenticator>
      {({ signOut, user }) => renderDashboard(user, signOut)}
    </Authenticator>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<div style={{ background: "#0c0c0c", color: "#f0ede8", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>Loading...</div>}>
      <DashboardContent />
    </Suspense>
  );
}
