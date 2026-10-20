"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Authenticator, useAuthenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession } from "aws-amplify/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.delegare.dev";

function ConnectContent() {
  const searchParams = useSearchParams();
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);
  const platform = searchParams.get("platform") || "agent"; // openclaw, mcp, custom

  const [token, setToken] = useState<string | null>(null);
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const platformLabels: Record<string, string> = {
    openclaw: "OpenClaw",
    mcp: "MCP Client",
    agent: "AI Agent",
  };
  const platformLabel = platformLabels[platform] || platform;

  useEffect(() => {
    if (authStatus !== "authenticated" || token) return;

    const createToken = async () => {
      setLoading(true);
      setError(null);
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        if (!idToken) throw new Error("Not authenticated");

        const res = await fetch(`${API_URL}/v1/auth/me/agent-token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            label: platform,
            ttlDays: 90,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || data.error || `Failed (${res.status})`);
        }

        const data = await res.json();
        setToken(data.accessToken);
        setMerchantId(data.merchantId);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    createToken();
  }, [authStatus, token, platform]);

  const handleCopy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const configSnippet =
    platform === "openclaw"
      ? JSON.stringify(
          {
            plugins: {
              entries: {
                delegare: {
                  config: {
                    accessToken: token || "<your-token>",
                    baseUrl: API_URL.includes("sandbox")
                      ? "https://api.sandbox.delegare.dev/v1"
                      : "https://api.delegare.dev/v1",
                  },
                },
              },
            },
          },
          null,
          2,
        )
      : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0c0c0c",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      <div
        style={{
          maxWidth: "540px",
          width: "100%",
          border: "1px solid rgba(240,237,232,0.08)",
          borderRadius: "16px",
          backgroundColor: "rgba(240,237,232,0.02)",
          padding: "2.5rem",
          boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: "2rem", textAlign: "center" }}>
          <h1
            style={{
              color: "#f0ede8",
              fontSize: "1.5rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
            }}
          >
            Connect {platformLabel}
          </h1>
          <p style={{ color: "rgba(240,237,232,0.5)", fontSize: "0.9rem" }}>
            Generate an access token to connect your {platformLabel.toLowerCase()} to Delegare
          </p>
        </div>

        {/* Loading state */}
        {loading && (
          <div style={{ textAlign: "center", padding: "2rem 0" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                border: "2px solid rgba(200,185,154,0.2)",
                borderTopColor: "#c8b99a",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
                margin: "0 auto 1rem",
              }}
            />
            <p style={{ color: "rgba(240,237,232,0.5)" }}>
              Creating your access token...
            </p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              padding: "1rem",
              borderRadius: "8px",
              backgroundColor: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#fca5a5",
              marginBottom: "1.5rem",
              fontSize: "0.9rem",
            }}
          >
            {error}
          </div>
        )}

        {/* Token display */}
        {token && (
          <>
            <div style={{ marginBottom: "1.5rem" }}>
              <label
                style={{
                  display: "block",
                  color: "rgba(240,237,232,0.5)",
                  fontSize: "0.8rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: "0.5rem",
                }}
              >
                Your Access Token
              </label>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  readOnly
                  value={token}
                  style={{
                    flex: 1,
                    padding: "0.75rem 1rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(240,237,232,0.15)",
                    backgroundColor: "rgba(0,0,0,0.3)",
                    color: "#c8b99a",
                    fontFamily: "monospace",
                    fontSize: "0.85rem",
                    outline: "none",
                  }}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={handleCopy}
                  style={{
                    padding: "0.75rem 1.25rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(200,185,154,0.3)",
                    backgroundColor: copied
                      ? "rgba(34,197,94,0.15)"
                      : "rgba(200,185,154,0.1)",
                    color: copied ? "#86efac" : "#c8b99a",
                    cursor: "pointer",
                    fontWeight: 500,
                    fontSize: "0.85rem",
                    transition: "all 0.2s",
                    whiteSpace: "nowrap",
                  }}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p
                style={{
                  color: "rgba(240,237,232,0.35)",
                  fontSize: "0.75rem",
                  marginTop: "0.5rem",
                }}
              >
                Expires in 90 days. Keep this token secret.
              </p>
            </div>

            {/* Platform-specific instructions */}
            {platform === "openclaw" && configSnippet && (
              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    color: "rgba(240,237,232,0.5)",
                    fontSize: "0.8rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: "0.5rem",
                  }}
                >
                  OpenClaw Configuration
                </label>
                <p
                  style={{
                    color: "rgba(240,237,232,0.5)",
                    fontSize: "0.85rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  Add this to your <code style={{ color: "#c8b99a" }}>openclaw.json</code> config:
                </p>
                <pre
                  style={{
                    padding: "1rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(240,237,232,0.08)",
                    backgroundColor: "rgba(0,0,0,0.3)",
                    color: "#c8b99a",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    overflowX: "auto",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {configSnippet}
                </pre>
              </div>
            )}

            {platform !== "openclaw" && (
              <div style={{ marginBottom: "1.5rem" }}>
                <label
                  style={{
                    display: "block",
                    color: "rgba(240,237,232,0.5)",
                    fontSize: "0.8rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: "0.5rem",
                  }}
                >
                  Usage
                </label>
                <p
                  style={{
                    color: "rgba(240,237,232,0.5)",
                    fontSize: "0.85rem",
                    lineHeight: 1.6,
                  }}
                >
                  Use this token in the <code style={{ color: "#c8b99a" }}>Authorization</code> header:
                </p>
                <pre
                  style={{
                    padding: "1rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(240,237,232,0.08)",
                    backgroundColor: "rgba(0,0,0,0.3)",
                    color: "#c8b99a",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    marginTop: "0.5rem",
                  }}
                >
                  {`Authorization: Bearer ${token}`}
                </pre>
              </div>
            )}

            {/* Account info */}
            <div
              style={{
                padding: "1rem",
                borderRadius: "8px",
                backgroundColor: "rgba(200,185,154,0.05)",
                border: "1px solid rgba(200,185,154,0.1)",
              }}
            >
              <p
                style={{
                  color: "rgba(240,237,232,0.5)",
                  fontSize: "0.8rem",
                  margin: 0,
                }}
              >
                Connected as{" "}
                <span style={{ color: "#c8b99a" }}>{merchantId}</span>
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ConnectAgentPage() {
  return (
    <Authenticator>
      <Suspense
        fallback={
          <div
            style={{
              minHeight: "100vh",
              backgroundColor: "#0c0c0c",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(240,237,232,0.5)",
            }}
          >
            Loading...
          </div>
        }
      >
        <ConnectContent />
      </Suspense>
    </Authenticator>
  );
}
