import React from "react";
import { useToolInfo, mountWidget } from "skybridge/web";

export default function PollSetupWidget() {
  const { output, isPending } = useToolInfo<"poll_setup_session">();

  if (isPending) {
    return (
      <div style={{ padding: "16px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "12px", border: "1px solid rgba(240,237,232,0.1)" }}>
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.5 }}>Checking setup status...</p>
      </div>
    );
  }

  const data = output as any;

  if (!data) return null;

  const isComplete = data.status === "complete";
  const isExpired = data.status === "expired";

  return (
    <div style={{ 
      padding: "20px", 
      background: "#0c0c0c", 
      color: "#f0ede8", 
      borderRadius: "16px", 
      border: `1px solid ${isComplete ? "#7ec898" : isExpired ? "#e87c7c" : "rgba(240,237,232,0.1)"}`,
      fontFamily: "system-ui, -apple-system, sans-serif"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ 
          width: "32px", height: "32px", borderRadius: "16px", 
          background: isComplete ? "rgba(126,200,152,0.1)" : isExpired ? "rgba(232,124,124,0.1)" : "rgba(240,237,232,0.05)",
          color: isComplete ? "#7ec898" : isExpired ? "#e87c7c" : "rgba(240,237,232,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px"
        }}>
          {isComplete ? "✓" : isExpired ? "!" : "⏳"}
        </div>
        <div>
          <p style={{ margin: 0, fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "rgba(240,237,232,0.4)" }}>
            Setup Status
          </p>
          <p style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
            {isComplete ? "Authorization Successful" : isExpired ? "Session Expired" : "Waiting for User..."}
          </p>
        </div>
      </div>
      
      {isComplete && (
        <div style={{ marginTop: "16px", padding: "12px", background: "rgba(126,200,152,0.05)", borderRadius: "8px", border: "1px solid rgba(126,200,152,0.1)" }}>
          <p style={{ margin: 0, fontSize: "12px", color: "rgba(240,237,232,0.7)", lineHeight: 1.4 }}>
            The spending mandate has been generated and saved to your account. Your agent can now execute payments automatically.
          </p>
        </div>
      )}

      {isExpired && (
        <p style={{ marginTop: "12px", margin: 0, fontSize: "12px", color: "#e87c7c" }}>
          The authorization session has timed out. Please request a new link.
        </p>
      )}
    </div>
  );
}

mountWidget(<PollSetupWidget />);
