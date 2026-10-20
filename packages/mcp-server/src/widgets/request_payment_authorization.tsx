import React from "react";
import { useToolInfo } from "skybridge/web";

export default function AuthorizationWidget() {
  const { output, isPending } = useToolInfo<"request_payment_authorization">();

  if (isPending) {
    return (
      <div style={{ padding: "16px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "12px", border: "1px solid rgba(240,237,232,0.1)" }}>
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.5 }}>Generating secure authorization link...</p>
      </div>
    );
  }

  const data = output as any;

  if (!data || data.status === "error") {
     return (
        <div style={{ padding: "16px", background: "rgba(232,124,124,0.1)", color: "#e87c7c", borderRadius: "12px", border: "1px solid rgba(232,124,124,0.2)" }}>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 500 }}>Failed to Request Authorization</p>
          <p style={{ margin: "4px 0 0", fontSize: "12px", opacity: 0.8 }}>{data?.error || "Unknown error"}</p>
        </div>
     );
  }

  return (
    <div style={{ 
      padding: "24px", 
      background: "#0c0c0c", 
      color: "#f0ede8", 
      borderRadius: "16px", 
      border: "1px solid #c8b99a",
      fontFamily: "system-ui, -apple-system, sans-serif",
      position: "relative",
      overflow: "hidden",
      textAlign: "center"
    }}>
      <div style={{ 
        position: "absolute", top: "-40px", left: "50%", transform: "translateX(-50%)",
        width: "120px", height: "120px", background: "rgba(200,185,154,0.1)", 
        borderRadius: "50%", filter: "blur(30px)" 
      }} />

      <div style={{ marginBottom: "20px", position: "relative", zIndex: 1 }}>
        <div style={{ width: "48px", height: "48px", borderRadius: "24px", background: "rgba(200,185,154,0.1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <span style={{ fontSize: "20px" }}>🛡️</span>
        </div>
        <h3 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 600, color: "#f0ede8" }}>Payment Authorization Required</h3>
        <p style={{ margin: 0, fontSize: "14px", color: "rgba(240,237,232,0.6)", lineHeight: 1.5 }}>
          Your AI agent needs permission to spend money on your behalf. Please review and approve the requested limits.
        </p>
      </div>

      <div style={{ background: "rgba(240,237,232,0.03)", borderRadius: "12px", padding: "16px", marginBottom: "24px", textAlign: "left", border: "1px solid rgba(240,237,232,0.05)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
          <span style={{ fontSize: "12px", color: "rgba(240,237,232,0.4)" }}>Max Per Transaction</span>
          <span style={{ fontSize: "13px", fontWeight: 500, color: "#c8b99a" }}>${((data.maxPerTxCents || data.requestedLimits?.maxPerTxCents || 0) / 100).toFixed(2)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: "12px", color: "rgba(240,237,232,0.4)" }}>Max Monthly Spend</span>
          <span style={{ fontSize: "13px", fontWeight: 500, color: "#c8b99a" }}>${((data.maxMonthlySpendCents || data.requestedLimits?.maxMonthlySpendCents || 0) / 100).toFixed(2)}</span>
        </div>
      </div>

      <a 
        href={data.setupUrl} 
        target="_blank" 
        rel="noopener noreferrer"
        style={{ 
          display: "block",
          width: "100%", 
          padding: "12px", 
          background: "#c8b99a", 
          color: "#0c0c0c", 
          borderRadius: "8px", 
          fontSize: "14px", 
          fontWeight: 600, 
          textDecoration: "none",
          transition: "opacity 0.2s"
        }}
        onMouseOver={e => e.currentTarget.style.opacity = "0.9"}
        onMouseOut={e => e.currentTarget.style.opacity = "1"}
      >
        Review & Approve
      </a>

      <p style={{ margin: "16px 0 0", fontSize: "11px", color: "rgba(240,237,232,0.3)" }}>
        Session expires in 30 minutes.
      </p>
    </div>
  );
}

import { mountWidget } from "skybridge/web";

mountWidget(<AuthorizationWidget />);
