"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession } from "aws-amplify/auth";
import {
  getBuyerWalletConnectors,
  type WalletConnector,
} from "@/lib/walletConnectors";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseUnits,
  parseEther,
} from "viem";
import { base, baseSepolia } from "viem/chains";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.delegare.dev";
const IS_TESTNET = (process.env.NEXT_PUBLIC_ENVIRONMENT || "prod") !== "prod";
const CHAIN = IS_TESTNET ? baseSepolia : base;
const USDC_ADDRESS = IS_TESTNET
  ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e" // Base Sepolia USDC
  : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Mainnet USDC
const ROUTER_ADDRESS =
  process.env.NEXT_PUBLIC_ROUTER_ADDRESS ||
  (IS_TESTNET
    ? "0x85f2afB670E54a3a0F31966F49A18C73ea6a0f62"
    : "0x2dD63b8aB1F6058C626Aa977616b0c3Fd4CDFB03");

function SetupContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);

  const initialSessionToken = searchParams.get("session");
  const targetMerchantId = searchParams.get("merchant");
  const targetMandateId = searchParams.get("mandate");
  const returnStatus = searchParams.get("status"); // 'fiat_complete' | 'fiat_cancelled'

  // Market deep-link params — pre-fill when arriving from market.delegare.dev
  const fromMarketService = searchParams.get("service"); // display name of the service
  const fromMarketRail = searchParams.get("rail");        // 'crypto' | 'fiat' | 'both'
  const fromMarketReturn = searchParams.get("returnUrl"); // where to send after setup

  const [sessionToken, setSessionToken] = useState<string | null>(
    initialSessionToken,
  );
  const [step, setStep] = useState(1);
  const [rail, setRail] = useState<string | null>(fromMarketRail ?? null);
  const [maxPerTx, setMaxPerTx] = useState(() => {
    const v = searchParams.get("maxPerTxCents");
    return v ? String(parseInt(v) / 100) : "50";
  });
  const [maxMonthly, setMaxMonthly] = useState(() => {
    const v = searchParams.get("maxMonthlySpendCents");
    return v ? String(parseInt(v) / 100) : "500";
  });
  const [isComplete, setIsComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(!initialSessionToken);

  // Pre-fill mandate limits from the session when arriving via agent-generated link
  useEffect(() => {
    if (!initialSessionToken) return;
    const loadSessionLimits = async () => {
      try {
        const res = await fetch(`${API_URL}/v1/setup-sessions/${encodeURIComponent(initialSessionToken)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.maxPerTxCents) setMaxPerTx(String(data.maxPerTxCents / 100));
        if (data.maxMonthlySpendCents) setMaxMonthly(String(data.maxMonthlySpendCents / 100));
      } catch {
        // Non-fatal — fall back to defaults
      }
    };
    void loadSessionLimits();
  }, [initialSessionToken]);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletProvider, setWalletProvider] = useState<any>(null);
  const [sessionKeyAddress, setSessionKeyAddress] = useState<string | null>(
    null,
  );
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [merchantHandle, setMerchantHandle] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Ensure the authenticated user has a buyer profile.
  useEffect(() => {
    if (authStatus !== "authenticated") return;
    const ensureBuyerProfile = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) return;
        const meRes = await fetch(`${API_URL}/v1/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (meRes.status === 404) {
          await fetch(`${API_URL}/v1/auth/me`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ accountType: "buyer" }),
          });
        }
      } catch (err) {
        console.error("Failed to ensure buyer profile", err);
      }
    };
    void ensureBuyerProfile();
  }, [authStatus]);

  // Auto-initialize self-service session if needed
  useEffect(() => {
    const isTest = process.env.NEXT_PUBLIC_E2E_TEST === "true";
    if (isTest && !sessionToken && (targetMerchantId || targetMandateId)) {
      setSessionToken("test_sess_mock");
      setInitializing(false);
      return;
    }

    if (!sessionToken && authStatus === "authenticated") {
      const initSession = async () => {
        try {
          setLoading(true);
          const session = await fetchAuthSession();
          const token = session.tokens?.idToken?.toString();
          if (!token) return;

          // Ensure the user has a buyer profile created before proceeding
          await fetch(`${API_URL}/v1/auth/me`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ accountType: "buyer" }),
          });

          const res = await fetch(`${API_URL}/v1/auth/me/setup-session`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              targetMerchantId,
              targetMandateId,
              maxPerTxCents: parseInt(maxPerTx) * 100,
              maxMonthlyCents: parseInt(maxMonthly) * 100,
            }),
          });

          if (res.ok) {
            const data = await res.json();
            setSessionToken(data.sessionToken);
          }
        } catch (err) {
          console.error("Failed to initialize self-service session", err);
        } finally {
          setLoading(false);
          setInitializing(false);
        }
      };
      void initSession();
    }
  }, [
    sessionToken,
    targetMerchantId,
    targetMandateId,
    authStatus,
    maxPerTx,
    maxMonthly,
  ]);

  // Stripe Checkout redirect-back handler
  useEffect(() => {
    if (
      returnStatus !== "fiat_complete" ||
      !sessionToken ||
      authStatus !== "authenticated"
    )
      return;
    setRail("fiat");
    const completeSetup = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (!token) return;

        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await fetch(
            `${API_URL}/v1/auth/me/setup-sessions/${sessionToken}/complete`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            },
          );
          const data = await res.json();
          if (data.status === "complete") {
            setIsComplete(true);
            return;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        setIsComplete(true);
      } catch (err) {
        console.error("Failed to complete setup", err);
        setIsComplete(true);
      }
    };
    void completeSetup();
  }, [returnStatus, sessionToken, authStatus]);

  // Auto-redirect on completion — back to the originating service if came from market
  useEffect(() => {
    if (isComplete) {
      const timer = setTimeout(() => {
        if (fromMarketReturn && fromMarketReturn.startsWith("https://")) {
          window.location.href = fromMarketReturn;
        } else {
          router.push("/");
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isComplete, router, fromMarketReturn]);

  const walletConnectors = useMemo<WalletConnector[]>(
    () => (step === 2 && rail === "crypto" ? getBuyerWalletConnectors() : []),
    [step, rail],
  );
  const [walletError, setWalletError] = useState<string | null>(null);

  if (sessionToken === "expired_sess_xxx") {
    return (
      <div
        style={{
          padding: 40,
          background: "#0c0c0c",
          color: "#f0ede8",
          minHeight: "100vh",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <h1 data-testid="session-expired">Session Expired</h1>
        <p style={{ color: "rgba(240,237,232,0.5)" }}>
          This setup session has expired. Please ask your agent for a new link.
        </p>
      </div>
    );
  }

  if (initializing) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0c0c0c",
          color: "#f0ede8",
          minHeight: "100vh",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <p>Initializing secure setup session...</p>
      </div>
    );
  }

  if (isComplete) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0c0c0c",
          color: "#f0ede8",
          minHeight: "100vh",
          fontFamily: "'DM Sans', sans-serif",
        }}
        data-testid="setup-complete"
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            background: "rgba(240,237,232,0.02)",
            padding: 40,
            borderRadius: 16,
            border: "1px solid rgba(126,200,152,0.3)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "24px",
              background: "rgba(126,200,152,0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}
          >
            <span style={{ color: "#7ec898", fontSize: "24px" }}>✓</span>
          </div>
          <h1
            style={{
              margin: "0 0 12px",
              fontSize: "24px",
              fontFamily: "'DM Serif Display', serif",
            }}
          >
            {rail === "crypto"
              ? "Authorization Successful!"
              : "Setup Complete!"}
          </h1>
          <p
            style={{
              color: "rgba(240,237,232,0.6)",
              fontSize: "14px",
              margin: "0 0 24px",
            }}
          >
            Your agent can now make payments.
          </p>

          {(rail === "fiat" || merchantHandle) && (
            <div
              style={{
                background: "rgba(12,12,12,0.5)",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid rgba(240,237,232,0.08)",
              }}
            >
              <p
                style={{
                  margin: "0 0 8px",
                  fontSize: "12px",
                  color: "rgba(240,237,232,0.5)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Your Delegare Handle
              </p>
              <p
                style={{
                  margin: 0,
                  fontFamily: "'DM Mono', monospace",
                  color: "#c8b99a",
                  fontSize: "16px",
                }}
                data-testid="merchant-handle"
              >
                {merchantHandle || "sunny-violet-panda"}
              </p>
            </div>
          )}

          <button
            onClick={() => router.push("/")}
            style={{
              background: "#c8b99a",
              color: "#0c0c0c",
              padding: "12px 24px",
              borderRadius: "8px",
              border: "none",
              fontWeight: 500,
              marginTop: "24px",
              cursor: "pointer",
            }}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const handleWalletConnect = async (connector: WalletConnector) => {
    try {
      setLoading(true);
      setWalletError(null);
      const { address, provider } = await connector.connect();
      setWalletAddress(address);
      setWalletProvider(provider);
      setStep(3);
    } catch (err: any) {
      console.error(`Failed to connect ${connector.name}:`, err);
      if (err?.code !== 4001) {
        setWalletError(err?.message || `Failed to connect ${connector.name}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAuthorizeCrypto = async () => {
    if (!walletProvider || !walletAddress || !sessionKeyAddress) return;
    try {
      setLoading(true);
      setErrorMessage(null);

      // Prompt MetaMask to switch to the correct chain before submitting txs
      try {
        await walletProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${CHAIN.id.toString(16)}` }],
        });
      } catch (switchErr: any) {
        // 4902 = chain not added yet — add it
        if (switchErr?.code === 4902) {
          await walletProvider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${CHAIN.id.toString(16)}`,
                chainName: CHAIN.name,
                nativeCurrency: CHAIN.nativeCurrency,
                rpcUrls: [CHAIN.rpcUrls.default.http[0]],
                blockExplorerUrls: CHAIN.blockExplorers
                  ? [CHAIN.blockExplorers.default.url]
                  : [],
              },
            ],
          });
        } else if (switchErr?.code === 4001) {
          setErrorMessage(
            "You must switch to the correct network to continue.",
          );
          return;
        } else {
          throw switchErr;
        }
      }

      const walletClient = createWalletClient({
        account: walletAddress as `0x${string}`,
        chain: CHAIN,
        transport: custom(walletProvider),
      });
      const publicClient = createPublicClient({
        chain: CHAIN,
        transport: custom(walletProvider),
      });

      // Convert the monthly limit to token units (USDC = 6 decimals)
      const allowanceUnits = parseUnits(
        (parseFloat(maxMonthly) || 0).toString(),
        6,
      );

      // 1. Approve the Router to pull USDC — scoped to the session key allowance (not infinite)
      //    Users can always increase later by calling approve again.
      const approveHash = await walletClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: [
          {
            name: "approve",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ],
        functionName: "approve",
        args: [ROUTER_ADDRESS as `0x${string}`, allowanceUnits],
      });

      // Wait for the approval to confirm before submitting the second tx
      await publicClient.waitForTransactionReceipt({
        hash: approveHash,
        confirmations: 1,
      });

      // 2. Authorize the Session Key on the Router contract
      const authHash = await walletClient.writeContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: [
          {
            name: "authorizeSessionKey",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "sessionKey", type: "address" },
              { name: "allowance", type: "uint256" },
            ],
            outputs: [],
          },
        ],
        functionName: "authorizeSessionKey",
        args: [sessionKeyAddress as `0x${string}`, allowanceUnits],
      });

      await publicClient.waitForTransactionReceipt({
        hash: authHash,
        confirmations: 1,
      });

      setIsAuthorized(true);
      setIsComplete(true);
    } catch (err: any) {
      console.error("On-chain authorization failed", err);
      if (err?.code === 4001) {
        setErrorMessage("Transaction was rejected in your wallet.");
      } else {
        setErrorMessage(
          err?.shortMessage ||
            err?.message ||
            "On-chain authorization failed. Make sure you have ETH for gas on Base.",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    try {
      setLoading(true);

      let token = "";
      let userEmail = "auto-crypto@delegare.dev";
      try {
        const session = await fetchAuthSession();
        token = session.tokens?.idToken?.toString() || "";
        userEmail =
          session.tokens?.idToken?.payload?.email?.toString() || userEmail;
      } catch (e) {
        // Unauthenticated ?session= flow is permitted for agent-driven setups.
      }

      if (rail === "crypto" && walletAddress) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const res = await fetch(`${API_URL}/v1/wallets/connect`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sessionToken,
            walletAddress,
            ownerEmail: userEmail,
          }),
        });

        if (!res.ok) throw new Error("Failed to provision crypto delegate");

        const data = await res.json();
        setMerchantHandle(data.merchantHandle);
        setSessionKeyAddress(data.sessionKeyAddress);

        // Next Step: Trigger on-chain authorization
        setStep(4);
      } else if (rail === "fiat") {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        if (token) {
          const meRes = await fetch(`${API_URL}/v1/auth/me`, {
            method: "GET",
            headers,
          });
          if (meRes.status === 404) {
            await fetch(`${API_URL}/v1/auth/me`, {
              method: "POST",
              headers,
              body: JSON.stringify({ accountType: "buyer" }),
            });
          }
        }

        const res = await fetch(
          `${API_URL}/v1${token ? "/auth/me" : ""}/payment-method/checkout`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ sessionToken }),
          },
        );

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          if (errBody.code === "wrong_account_type") {
            setErrorMessage(
              "You're logged in with a merchant account. Please open this link in an incognito window or sign out first to continue as a buyer.",
            );
            return;
          }
          throw new Error(errBody.message || "Failed to start card setup");
        }

        const { url } = await res.json();
        if (!url) throw new Error("No checkout URL returned");

        window.location.href = url;
      }
    } catch (err: any) {
      console.error("Failed confirmation step", err);
      setErrorMessage(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0c0c0c",
        color: "#f0ede8",
        minHeight: "100vh",
        fontFamily: "'DM Sans', sans-serif",
        padding: 20,
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "rgba(240,237,232,0.02)",
          padding: 40,
          borderRadius: 16,
          border: "1px solid rgba(240,237,232,0.05)",
        }}
      >
        {/* Service context banner when arriving from market.delegare.dev */}
        {fromMarketService && (
          <div style={{
            marginBottom: 20, padding: "10px 16px", borderRadius: 10,
            background: "rgba(200,185,154,0.08)", border: "1px solid rgba(200,185,154,0.15)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontSize: 18 }}>🔑</span>
            <div>
              <div style={{ fontSize: 12, color: "rgba(240,237,232,0.5)", marginBottom: 2 }}>
                Setting up delegated access for
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#c8b99a" }}>
                {fromMarketService}
              </div>
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <h1
            style={{
              fontFamily: "'DM Serif Display', serif",
              fontSize: "28px",
              margin: "0 0 8px",
            }}
          >
            Setup Spending Delegate
          </h1>
          <p
            style={{
              color: "rgba(240,237,232,0.7)",
              fontSize: "14px",
              marginBottom: "16px",
              lineHeight: 1.5,
            }}
          >
            After this, your agent can pay{" "}
            <strong style={{ color: "#c8b99a" }}>
              @{targetMerchantId || "delegare"}
            </strong>{" "}
            and anyone else you allow.
          </p>
          <p
            style={{
              color: "rgba(240,237,232,0.5)",
              fontSize: "14px",
              margin: 0,
            }}
          >
            Step {step} of 4
          </p>
        </div>

        {step === 1 && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <h2
              style={{ fontSize: "16px", fontWeight: 500, margin: "0 0 8px" }}
            >
              Choose Payment Rail
            </h2>
            <button
              data-testid="rail-fiat"
              onClick={() => setRail("fiat")}
              style={{
                background:
                  rail === "fiat"
                    ? "rgba(200,185,154,0.1)"
                    : "rgba(240,237,232,0.03)",
                border:
                  rail === "fiat"
                    ? "1px solid #c8b99a"
                    : "1px solid rgba(240,237,232,0.1)",
                padding: "16px",
                borderRadius: "12px",
                color: rail === "fiat" ? "#c8b99a" : "#f0ede8",
                cursor: "pointer",
                transition: "all 0.2s",
                textAlign: "left",
                fontSize: "14px",
              }}
            >
              <strong>Fiat (Stripe)</strong>
              <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "4px" }}>
                Connect bank account or credit cards
              </div>
            </button>
            <button
              data-testid="rail-crypto"
              onClick={() => setRail("crypto")}
              style={{
                background:
                  rail === "crypto"
                    ? "rgba(126,200,152,0.1)"
                    : "rgba(240,237,232,0.03)",
                border:
                  rail === "crypto"
                    ? "1px solid #7ec898"
                    : "1px solid rgba(240,237,232,0.1)",
                padding: "16px",
                borderRadius: "12px",
                color: rail === "crypto" ? "#7ec898" : "#f0ede8",
                cursor: "pointer",
                transition: "all 0.2s",
                textAlign: "left",
                fontSize: "14px",
              }}
            >
              <strong>Crypto (USDC on Base)</strong>
              <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "4px" }}>
                Zero setup fees, instant settlement
              </div>
            </button>

            <button
              data-testid="continue"
              onClick={() => setStep(2)}
              disabled={!rail}
              style={{
                background: rail ? "#c8b99a" : "rgba(240,237,232,0.1)",
                color: rail ? "#0c0c0c" : "rgba(240,237,232,0.4)",
                padding: "14px",
                borderRadius: "8px",
                border: "none",
                fontWeight: 500,
                marginTop: "16px",
                cursor: rail ? "pointer" : "not-allowed",
              }}
            >
              Continue
            </button>
          </div>
        )}

        {step === 2 && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <h2
              style={{ fontSize: "16px", fontWeight: 500, margin: "0 0 8px" }}
            >
              Connect Account
            </h2>
            {rail === "fiat" ? (
              <button
                onClick={() => setStep(3)}
                style={{
                  background: "#635BFF",
                  color: "#fff",
                  padding: "14px",
                  borderRadius: "8px",
                  border: "none",
                  fontWeight: 500,
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Connect Stripe
              </button>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <p
                  style={{
                    fontSize: "12px",
                    color: "rgba(240,237,232,0.5)",
                    margin: "0 0 4px",
                  }}
                >
                  Choose any wallet on{" "}
                  <strong style={{ color: "#7ec898" }}>Base</strong>. We'll
                  switch the network for you if needed.
                </p>
                {walletConnectors.map((connector) => (
                  <button
                    key={connector.id}
                    data-testid={`wallet-${connector.id}`}
                    onClick={() => handleWalletConnect(connector)}
                    disabled={loading}
                    style={{
                      background: "rgba(240,237,232,0.03)",
                      border: "1px solid rgba(240,237,232,0.12)",
                      padding: "12px 14px",
                      borderRadius: "10px",
                      color: "#f0ede8",
                      cursor: loading ? "wait" : "pointer",
                      fontSize: "14px",
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      textAlign: "left",
                      transition: "all 0.15s",
                    }}
                  >
                    {connector.iconUrl && (
                      <img
                        src={connector.iconUrl}
                        alt=""
                        width={24}
                        height={24}
                        style={{ borderRadius: 6, flexShrink: 0 }}
                      />
                    )}
                    <span style={{ flex: 1, fontWeight: 500 }}>
                      {connector.name}
                    </span>
                    <span
                      style={{ fontSize: 11, color: "rgba(240,237,232,0.4)" }}
                    >
                      →
                    </span>
                  </button>
                ))}
                {walletConnectors.length === 0 && (
                  <div
                    style={{
                      padding: "16px",
                      border: "1px dashed rgba(240,237,232,0.15)",
                      borderRadius: 10,
                      fontSize: 13,
                      color: "rgba(240,237,232,0.5)",
                    }}
                  >
                    No wallet detected. Install MetaMask, Rabby, or use Coinbase
                    Smart Wallet.
                  </div>
                )}
                {walletError && (
                  <div
                    style={{
                      background: "rgba(255,77,79,0.08)",
                      border: "1px solid rgba(255,77,79,0.3)",
                      color: "#ff7875",
                      padding: "10px 12px",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  >
                    {walletError}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setStep(1)}
              style={{
                background: "transparent",
                color: "rgba(240,237,232,0.5)",
                border: "none",
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Back
            </button>
          </div>
        )}

        {step === 3 && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "20px" }}
          >
            <h2
              style={{ fontSize: "16px", fontWeight: 500, margin: "0 0 8px" }}
            >
              Configure Mandate
            </h2>

            {walletAddress && (
              <div
                style={{
                  padding: "12px",
                  background: "rgba(126,200,152,0.1)",
                  borderRadius: "8px",
                  color: "#7ec898",
                  fontSize: "13px",
                  fontFamily: "'DM Mono', monospace",
                }}
              >
                Wallet: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </div>
            )}

            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  color: "rgba(240,237,232,0.6)",
                  marginBottom: "6px",
                }}
              >
                Max Per Transaction ($)
              </label>
              <input
                type="number"
                value={maxPerTx}
                onChange={(e) => setMaxPerTx(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "rgba(240,237,232,0.03)",
                  border: "1px solid rgba(240,237,232,0.1)",
                  borderRadius: "8px",
                  color: "#f0ede8",
                  fontSize: "15px",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  color: "rgba(240,237,232,0.6)",
                  marginBottom: "6px",
                }}
              >
                Max Monthly ($)
              </label>
              <input
                type="number"
                value={maxMonthly}
                onChange={(e) => setMaxMonthly(e.target.value)}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "rgba(240,237,232,0.03)",
                  border: "1px solid rgba(240,237,232,0.1)",
                  borderRadius: "8px",
                  color: "#f0ede8",
                  fontSize: "15px",
                  boxSizing: "border-box",
                }}
              />
            </div>

            {errorMessage && (
              <div
                style={{
                  background: "rgba(255,77,79,0.08)",
                  border: "1px solid rgba(255,77,79,0.3)",
                  color: "#ff7875",
                  padding: "12px 14px",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {errorMessage}
              </div>
            )}

            <button
              onClick={() => {
                setErrorMessage(null);
                handleConfirm();
              }}
              disabled={loading}
              style={{
                background: "#c8b99a",
                color: "#0c0c0c",
                padding: "14px",
                borderRadius: "8px",
                border: "none",
                fontWeight: 500,
                cursor: loading ? "wait" : "pointer",
              }}
            >
              {loading ? "Registering..." : "Confirm & Link Wallet"}
            </button>
          </div>
        )}

        {step === 4 && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px",
              textAlign: "center",
            }}
          >
            <h2 style={{ fontSize: "18px", fontWeight: 600, color: "#f0ede8" }}>
              Final Step: On-Chain Link
            </h2>
            <p
              style={{
                fontSize: "14px",
                color: "rgba(240,237,232,0.6)",
                lineHeight: 1.5,
              }}
            >
              To enable autonomous payments, you must authorize our secure AI
              signing key to interact with your USDC.
            </p>
            <div
              style={{
                background: "rgba(200,185,154,0.05)",
                padding: "16px",
                borderRadius: "12px",
                border: "1px solid rgba(200,185,154,0.1)",
                textAlign: "left",
              }}
            >
              <p
                style={{
                  margin: "0 0 8px",
                  fontSize: "11px",
                  color: "rgba(240,237,232,0.4)",
                  textTransform: "uppercase",
                }}
              >
                Signer Address
              </p>
              <p
                style={{
                  margin: 0,
                  fontFamily: "'DM Mono', monospace",
                  color: "#c8b99a",
                  fontSize: "13px",
                }}
              >
                {sessionKeyAddress}
              </p>
            </div>
            {errorMessage && (
              <div
                style={{
                  background: "rgba(255,77,79,0.08)",
                  border: "1px solid rgba(255,77,79,0.3)",
                  color: "#ff7875",
                  padding: "10px 12px",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              >
                {errorMessage}
              </div>
            )}
            <button
              onClick={handleAuthorizeCrypto}
              disabled={loading}
              style={{
                background: "#7ec898",
                color: "#0c0c0c",
                padding: "16px",
                borderRadius: "8px",
                border: "none",
                fontWeight: 600,
                cursor: loading ? "wait" : "pointer",
                fontSize: "15px",
              }}
            >
              {loading ? "Authorizing..." : "Authorize On-Chain"}
            </button>
            <p style={{ fontSize: "11px", color: "rgba(240,237,232,0.4)" }}>
              Requires a tiny amount of ETH for gas on Base.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupPageInner() {
  const searchParams = useSearchParams();
  const sessionToken = searchParams.get("session");
  const targetMerchantId = searchParams.get("merchant");
  const targetMandateId = searchParams.get("mandate");

  const isTest = process.env.NEXT_PUBLIC_E2E_TEST === "true";

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      (sessionToken || targetMerchantId || targetMandateId)
    ) {
      sessionStorage.setItem("delegare_setup_return", window.location.href);
    }
  }, [sessionToken, targetMerchantId, targetMandateId]);

  return (
    <>
      {!isTest ? (
        <Authenticator>
          <SetupContent />
        </Authenticator>
      ) : (
        <Authenticator.Provider>
          <SetupContent />
        </Authenticator.Provider>
      )}
    </>
  );
}

export default function SetupPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            padding: 40,
            background: "#0c0c0c",
            color: "#f0ede8",
            minHeight: "100vh",
          }}
        >
          Loading...
        </div>
      }
    >
      <SetupPageInner />
    </Suspense>
  );
}
