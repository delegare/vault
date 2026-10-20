"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchAuthSession } from 'aws-amplify/auth';
import { getBuyerWalletConnectors, type WalletConnector } from "@/lib/walletConnectors";
import { createWalletClient, createPublicClient, custom, parseUnits } from "viem";
import { base, baseSepolia } from "viem/chains";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.delegare.dev';
const IS_TESTNET = (process.env.NEXT_PUBLIC_ENVIRONMENT || 'prod') !== 'prod';
const CHAIN = IS_TESTNET ? baseSepolia : base;
const USDC_ADDRESS = IS_TESTNET
  ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"  // Base Sepolia USDC
  : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Mainnet USDC
const ROUTER_ADDRESS = process.env.NEXT_PUBLIC_ROUTER_ADDRESS
  || (IS_TESTNET ? "0x85f2afB670E54a3a0F31966F49A18C73ea6a0f62" : "0x2dD63b8aB1F6058C626Aa977616b0c3Fd4CDFB03");

type OnboardingStep = 'role' | 'connect' | 'show_live_key' | 'wallet_picker' | 'authorize_crypto' | 'success';
type AccountType = 'merchant' | 'buyer';

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const typeParam = searchParams.get('type') as AccountType | null;

  const [step, setStep] = useState<OnboardingStep>(typeParam ? 'connect' : 'role');
  const [accountType, setAccountType] = useState<AccountType>(typeParam || 'merchant');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wallet connection state
  const [walletConnectors, setWalletConnectors] = useState<WalletConnector[]>([]);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletProvider, setWalletProvider] = useState<any>(null);
  const [sessionKeyAddress, setSessionKeyAddress] = useState<string | null>(null);

  // Live API key returned from POST /v1/auth/me (merchant flow).
  // Shown once on the 'show_live_key' step, then cleared from state.
  const [liveApiKey, setLiveApiKey] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [pendingStripeUrl, setPendingStripeUrl] = useState<string | null>(null);

  useEffect(() => {
    if (step === 'wallet_picker') {
      setWalletConnectors(getBuyerWalletConnectors());
    }
  }, [step]);

  // Provision profile and proceed
  const handleProvisionProfile = async (type: AccountType, usdcWalletAddress?: string) => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error("No active session");

      const res = await fetch(`${API_URL}/v1/auth/me`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
          accountType: type,
          usdcWalletAddress 
        }) 
      });

      if (!res.ok) throw new Error("Failed to save profile");
      return await res.json();
    } catch (err: any) {
      console.error(err);
      setError(err.message);
      return null;
    }
  };

  const handleRoleSelection = (type: AccountType) => {
    if (type === 'buyer') {
      router.push('/setup');
      return;
    }
    setAccountType(type);
    setStep('connect');
  };

  const handleSkip = async () => {
    setLoading(true);
    const profile = await handleProvisionProfile(accountType);
    if (profile) router.push("/");
    else setLoading(false);
  };

  const handleStripeConnect = async () => {
    setLoading(true);
    try {
      if (accountType === 'merchant') {
        // MERCHANTS: Signup for Stripe Connect (Payouts)
        const profile = await handleProvisionProfile('merchant');
        if (!profile) return;

        // Prefer the environment-specific client ID; fall back to the shared one.
        // Set NEXT_PUBLIC_STRIPE_TEST_CLIENT_ID in Amplify sandbox env vars to route
        // merchants through Stripe's test Connect flow (generates ac_test_… codes).
        const clientId = (IS_TESTNET
          ? (process.env.NEXT_PUBLIC_STRIPE_TEST_CLIENT_ID || process.env.NEXT_PUBLIC_STRIPE_CLIENT_ID)
          : process.env.NEXT_PUBLIC_STRIPE_CLIENT_ID);
        if (!clientId) throw new Error("Stripe Client ID is not configured on this environment.");

        const redirectUri = encodeURIComponent(`${API_URL}/v1/webhooks/stripe-connect/callback`);
        const stripeUrl = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&state=merchant_${profile.merchantId}&redirect_uri=${redirectUri}`;

        // If the server returned a fresh liveApiKey (new merchant), pause here
        // and force the user to save it before handing off to Stripe. If no key
        // came back (profile already existed), skip straight to Stripe.
        if (profile.liveApiKey) {
          setLiveApiKey(profile.liveApiKey);
          setMerchantId(profile.merchantId);
          setPendingStripeUrl(stripeUrl);
          setStep('show_live_key');
          setLoading(false);
          return;
        }

        window.location.href = stripeUrl;
      } else {
        // BUYERS: Connect Credit Card via Stripe Checkout (Payments)
        await handleProvisionProfile('buyer');
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        const res = await fetch(`${API_URL}/v1/auth/me/payment-method/checkout`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            successPath: "/?paymentMethod=fiat_added",
            cancelPath: "/onboarding?error=fiat_cancelled"
          })
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || "Failed to start card setup");
        }
        const { url } = await res.json();
        window.location.href = url;
      }
    } catch(err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleWalletConnect = async (connector: WalletConnector) => {
    setLoading(true);
    setError(null);
    try {
      const { address, provider } = await connector.connect();
      setWalletAddress(address);
      setWalletProvider(provider);
      
      // Merchants don't need a session key, just save the address to their new profile
      await handleProvisionProfile('merchant', address);
      setStep('success');
    } catch (err: any) {
      console.error('Wallet connection failed:', err);
      setError(err.message || 'Failed to connect wallet');
    } finally {
      setLoading(false);
    }
  };

  const handleOnChainAuthorize = async () => {
    if (!walletProvider || !walletAddress || !sessionKeyAddress) return;
    setLoading(true);
    setError(null);
    try {
      const walletClient = createWalletClient({
        account: walletAddress as `0x${string}`,
        chain: CHAIN,
        transport: custom(walletProvider),
      });
      const publicClient = createPublicClient({
        chain: CHAIN,
        transport: custom(walletProvider),
      });

      // Default allowance for onboarding: $500
      const allowanceUnits = parseUnits("500", 6);

      // 1. Approve Router
      const approveHash = await walletClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
        functionName: "approve",
        args: [ROUTER_ADDRESS as `0x${string}`, allowanceUnits],
      });

      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      // 2. Authorize Session Key
      const authHash = await walletClient.writeContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: [{ name: "authorizeSessionKey", type: "function", stateMutability: "nonpayable", inputs: [{ name: "sessionKey", type: "address" }, { name: "allowance", type: "uint256" }], outputs: [] }],
        functionName: "authorizeSessionKey",
        args: [sessionKeyAddress as `0x${string}`, allowanceUnits],
      });

      await publicClient.waitForTransactionReceipt({ hash: authHash });
      
      // Update profile with the address
      await handleProvisionProfile('buyer', walletAddress);
      setStep('success');
    } catch (err: any) {
      console.error("On-chain authorization failed", err);
      setError(err.shortMessage || err.message || "On-chain authorization failed. Make sure you have ETH for gas on Base.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: "#0c0c0c", color: "#f0ede8", fontFamily: "'DM Sans', sans-serif", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ maxWidth: 480, width: "100%", background: "rgba(240,237,232,0.02)", padding: 40, borderRadius: 16, border: "1px solid rgba(240,237,232,0.08)", textAlign: "center" }}>
        
        {step === 'role' && (
          <>
            <h1 style={{ margin: "0 0 12px", fontSize: "28px", fontFamily: "'DM Serif Display', serif" }}>How will you use Delegare?</h1>
            <p style={{ color: "rgba(240,237,232,0.5)", fontSize: "14px", margin: "0 0 32px", lineHeight: 1.5 }}>Choose the path that best describes your intention.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
              <button onClick={() => handleRoleSelection('merchant')} style={{ background: "rgba(240,237,232,0.03)", color: "#f0ede8", border: "1px solid rgba(240,237,232,0.1)", padding: "24px", borderRadius: "12px", textAlign: "left", cursor: "pointer", transition: "all 0.2s" }}>
                <div style={{ fontWeight: 600, fontSize: "16px", marginBottom: 4, color: "#c8b99a" }}>I am a Developer / Merchant</div>
                <div style={{ fontSize: "13px", color: "rgba(240,237,232,0.45)" }}>I want to receive payments from AI agents in my application or shop.</div>
              </button>
              <button onClick={() => handleRoleSelection('buyer')} style={{ background: "rgba(240,237,232,0.03)", color: "#f0ede8", border: "1px solid rgba(240,237,232,0.1)", padding: "24px", borderRadius: "12px", textAlign: "left", cursor: "pointer", transition: "all 0.2s" }}>
                <div style={{ fontWeight: 600, fontSize: "16px", marginBottom: 4, color: "#c8b99a" }}>I am a User / Buyer</div>
                <div style={{ fontSize: "13px", color: "rgba(240,237,232,0.45)" }}>I want to authorize my AI agents to spend money on my behalf.</div>
              </button>
            </div>
          </>
        )}

        {step === 'connect' && (
          <>
            <h1 style={{ margin: "0 0 12px", fontSize: "28px", fontFamily: "'DM Serif Display', serif" }}>{accountType === 'merchant' ? 'Setup Payouts' : 'Connect Payment'}</h1>
            <p style={{ color: "rgba(240,237,232,0.5)", fontSize: "14px", margin: "0 0 32px", lineHeight: 1.5 }}>{accountType === 'merchant' ? 'To start receiving agent payments, connect your payout method.' : 'Connect a wallet or card to fund your agent transactions.'}</p>
            {error && <div style={{ background: "rgba(232,124,124,0.1)", color: "#e87c7c", padding: "12px", borderRadius: "8px", marginBottom: "20px", fontSize: "13px" }}>{error}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
              <button onClick={handleStripeConnect} disabled={loading} style={{ background: "#c8b99a", color: "#0c0c0c", border: "none", padding: "14px", borderRadius: "8px", fontSize: "14px", fontWeight: 500, cursor: loading ? "not-allowed" : "pointer" }}>
                {accountType === 'merchant' ? 'Connect Stripe Connect' : 'Connect Credit Card (Stripe)'}
              </button>
              <button onClick={() => setStep('wallet_picker')} disabled={loading} style={{ background: "rgba(126,200,152,0.1)", color: "#7ec898", border: "1px solid rgba(126,200,152,0.15)", padding: "14px", borderRadius: "8px", fontSize: "14px", fontWeight: 500, cursor: loading ? "not-allowed" : "pointer" }}>
                Connect Crypto Wallet (USDC)
              </button>
            </div>
            <button onClick={handleSkip} disabled={loading} style={{ background: "transparent", color: "rgba(240,237,232,0.4)", border: "none", fontSize: "13px", cursor: "pointer", textDecoration: "underline" }}>Skip for now</button>
          </>
        )}

        {step === 'show_live_key' && liveApiKey && (
          <>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>🔑</div>
            <h1 style={{ margin: "0 0 12px", fontSize: "26px", fontFamily: "'DM Serif Display', serif" }}>Save your live API key</h1>
            <p style={{ color: "rgba(240,237,232,0.55)", fontSize: "14px", margin: "0 0 24px", lineHeight: 1.55 }}>
              Store this key somewhere safe — a secrets manager, password manager, or <code>.env</code> file. For security we never store it in plaintext, so <strong style={{ color: "#e87c7c" }}>this is the only time you&apos;ll see it</strong>. Lost it? You can always rotate to a new one from the dashboard.
            </p>
            <div style={{ textAlign: "left", marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,232,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Merchant ID</div>
              <div style={{ background: "rgba(240,237,232,0.04)", border: "1px solid rgba(240,237,232,0.08)", padding: "10px 14px", borderRadius: "8px", fontFamily: "'DM Mono', 'Fira Code', monospace", fontSize: "13px", color: "#f0ede8", wordBreak: "break-all", marginBottom: 14 }}>
                {merchantId}
              </div>
              <div style={{ fontSize: 11, color: "rgba(240,237,232,0.4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Live API Key</div>
              <div style={{ background: "rgba(240,237,232,0.04)", border: "1px solid rgba(126,200,152,0.25)", padding: "12px 14px", borderRadius: "8px", fontFamily: "'DM Mono', 'Fira Code', monospace", fontSize: "13px", color: "#c8b99a", wordBreak: "break-all", lineHeight: 1.5 }}>
                {liveApiKey}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(liveApiKey);
                    setKeyCopied(true);
                    setTimeout(() => setKeyCopied(false), 2000);
                  } catch (e) { console.error(e); }
                }}
                style={{ flex: 1, background: "transparent", color: "#f0ede8", border: "1px solid rgba(240,237,232,0.2)", padding: "12px", borderRadius: "8px", fontSize: "13px", fontWeight: 500, cursor: "pointer" }}
              >
                {keyCopied ? "✓ Copied" : "Copy key"}
              </button>
              <button
                onClick={() => {
                  if (!pendingStripeUrl) return;
                  // Clear sensitive state before navigating away.
                  setLiveApiKey(null);
                  window.location.href = pendingStripeUrl;
                }}
                disabled={!pendingStripeUrl}
                style={{ flex: 1, background: "#7ec898", color: "#0c0c0c", border: "none", padding: "12px", borderRadius: "8px", fontSize: "13px", fontWeight: 600, cursor: pendingStripeUrl ? "pointer" : "not-allowed" }}
              >
                I saved it — continue to Stripe
              </button>
            </div>
            <p style={{ fontSize: 11, color: "rgba(240,237,232,0.3)", margin: 0, lineHeight: 1.5 }}>
              Note: we&apos;ll redirect you to Stripe Connect to finish payout setup.
            </p>
          </>
        )}

        {step === 'wallet_picker' && (
          <>
            <h1 style={{ margin: "0 0 12px", fontSize: "28px", fontFamily: "'DM Serif Display', serif" }}>Connect Wallet</h1>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 24 }}>
              {walletConnectors.map(c => (
                <button key={c.id} onClick={() => handleWalletConnect(c)} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px", background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.1)", borderRadius: 12, color: "#f0ede8", cursor: "pointer", textAlign: "left" }}>
                  {c.iconUrl && <img src={c.iconUrl} alt="" width={24} height={24} style={{ borderRadius: 6 }} />}
                  <span style={{ flex: 1, fontWeight: 500 }}>{c.name}</span>
                  <span style={{ fontSize: 14, color: "rgba(240,237,232,0.3)" }}>→</span>
                </button>
              ))}
            </div>
            <button onClick={() => setStep('connect')} style={{ marginTop: 20, background: "transparent", border: "none", color: "rgba(240,237,232,0.4)", cursor: "pointer" }}>← Back</button>
          </>
        )}

        {step === 'authorize_crypto' && (
          <>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>⚡</div>
            <h1 style={{ margin: "0 0 12px", fontSize: "28px", fontFamily: "'DM Serif Display', serif" }}>Authorize Agent</h1>
            <p style={{ color: "rgba(240,237,232,0.5)", fontSize: "14px", margin: "0 0 24px", lineHeight: 1.5 }}>You need to sign two transactions in your wallet to authorize Delegare to spend USDC on your behalf (up to $500/mo).</p>
            {error && <div style={{ background: "rgba(232,124,124,0.1)", color: "#e87c7c", padding: "12px", borderRadius: "8px", marginBottom: "20px", fontSize: "13px" }}>{error}</div>}
            <button onClick={handleOnChainAuthorize} disabled={loading} style={{ background: "#7ec898", color: "#0c0c0c", border: "none", padding: "14px", width: "100%", borderRadius: "8px", fontSize: "15px", fontWeight: 600, cursor: loading ? "wait" : "pointer" }}>
              {loading ? 'Confirming...' : 'Authorize on Base'}
            </button>
          </>
        )}

        {step === 'success' && (
          <>
            <div style={{ fontSize: "48px", marginBottom: "20px" }}>✅</div>
            <h1 style={{ margin: "0 0 12px", fontSize: "28px", fontFamily: "'DM Serif Display', serif" }}>Success!</h1>
            <p style={{ color: "rgba(240,237,232,0.5)", fontSize: "14px", margin: "0 0 32px", lineHeight: 1.5 }}>Your {accountType} profile is ready.</p>
            <button onClick={() => router.push("/")} style={{ background: "#c8b99a", color: "#0c0c0c", border: "none", padding: "14px 32px", borderRadius: "8px", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>Go to Dashboard</button>
          </>
        )}

      </div>
    </div>
  );
}

import { Authenticator } from "@aws-amplify/ui-react";

export default function Onboarding() {
  const isTest = process.env.NEXT_PUBLIC_E2E_TEST === "true";

  useEffect(() => {
    if (typeof window !== "undefined") {
      sessionStorage.setItem("delegare_onboarding_return", window.location.href);
    }
  }, []);

  return (
    <Suspense fallback={<div style={{ background: "#0c0c0c", minHeight: "100vh" }} />}>
      {!isTest ? (
        <Authenticator>
          <OnboardingContent />
        </Authenticator>
      ) : (
        <Authenticator.Provider>
          <OnboardingContent />
        </Authenticator.Provider>
      )}
    </Suspense>
  );
}

