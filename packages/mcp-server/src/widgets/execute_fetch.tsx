import React from "react";
import { useToolInfo, mountWidget } from "skybridge/web";

export default function FetchWidget() {
  const { output, isPending } = useToolInfo<"execute_fetch">();

  if (isPending) {
    return (
      <div style={{ padding: "16px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "12px", border: "1px solid rgba(240,237,232,0.1)" }}>
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.5 }}>Fetching resource...</p>
      </div>
    );
  }

  const data = output as any;

  if (!data) return null;

  const isSuccess = data.status >= 200 && data.status < 300;

  return (
    <div style={{ 
      padding: "20px", 
      background: "#0c0c0c", 
      color: "#f0ede8", 
      borderRadius: "16px", 
      border: `1px solid ${isSuccess ? "rgba(126,200,152,0.2)" : "rgba(232,124,124,0.2)"}`,
      fontFamily: "system-ui, -apple-system, sans-serif"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
        <div>
          <p style={{ margin: 0, fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "rgba(240,237,232,0.4)", marginBottom: "4px" }}>
            Secure Fetch
          </p>
          <p style={{ margin: 0, fontSize: "14px", fontWeight: 500, color: "#f0ede8", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.url}
          </p>
        </div>
        <div style={{ 
          padding: "4px 8px", 
          background: isSuccess ? "rgba(126,200,152,0.1)" : "rgba(232,124,124,0.1)", 
          borderRadius: "4px", 
          color: isSuccess ? "#7ec898" : "#e87c7c", 
          fontSize: "10px", 
          fontWeight: 700 
        }}>
          HTTP {data.status}
        </div>
      </div>

      {data.paymentExecuted && (
        <div style={{ marginBottom: "16px", padding: "12px", background: "rgba(200,185,154,0.05)", borderRadius: "8px", border: "1px solid rgba(200,185,154,0.1)", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#c8b99a" }}>💰</span>
          <p style={{ margin: 0, fontSize: "11px", color: "#c8b99a", fontWeight: 500 }}>
            Automatic x402 payment executed
          </p>
        </div>
      )}

      <div style={{ 
        maxHeight: "120px", 
        overflowY: "auto", 
        background: "rgba(0,0,0,0.2)", 
        borderRadius: "8px", 
        padding: "12px",
        fontSize: "12px",
        fontFamily: "monospace",
        color: "rgba(240,237,232,0.8)",
        border: "1px solid rgba(240,237,232,0.05)"
      }}>
        {typeof data.content === 'object' ? JSON.stringify(data.content, null, 2) : String(data.content)}
      </div>
    </div>
  );
}

mountWidget(<FetchWidget />);
