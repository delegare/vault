import React from "react";
import { useToolInfo, mountWidget } from "skybridge/web";

export default function BalanceWidget() {
  const { output, isPending } = useToolInfo<"get_balance">();

  if (isPending) {
    return (
      <div style={{ padding: "16px", background: "#0c0c0c", color: "#f0ede8", borderRadius: "12px", border: "1px solid rgba(240,237,232,0.1)" }}>
        <p style={{ margin: 0, fontSize: "14px", opacity: 0.5 }}>Loading allowance...</p>
      </div>
    );
  }

  const data = output as any;

  if (!data) return null;

  const spentPercent = (data.currentMonthlySpendCents / data.maxMonthlySpendCents) * 100;
  const remaining = (data.remainingMonthlySpendCents / 100).toFixed(2);
  const total = (data.maxMonthlySpendCents / 100).toFixed(2);

  return (
    <div style={{ 
      padding: "20px", 
      background: "#0c0c0c", 
      color: "#f0ede8", 
      borderRadius: "16px", 
      border: "1px solid rgba(200,185,154,0.2)",
      fontFamily: "system-ui, -apple-system, sans-serif"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "16px" }}>
        <div>
          <p style={{ margin: 0, fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "rgba(240,237,232,0.4)", marginBottom: "4px" }}>
            Monthly Allowance
          </p>
          <p style={{ margin: 0, fontSize: "24px", fontWeight: 700, color: "#c8b99a" }}>
            ${remaining} <span style={{ fontSize: "14px", fontWeight: 400, color: "rgba(240,237,232,0.3)" }}>available</span>
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ margin: 0, fontSize: "12px", color: "rgba(240,237,232,0.4)" }}>of ${total}</p>
        </div>
      </div>

      <div style={{ width: "100%", background: "rgba(240,237,232,0.1)", borderRadius: "4px", height: "8px", overflow: "hidden", marginBottom: "16px" }}>
        <div style={{ 
          width: `${Math.min(spentPercent, 100)}%`, 
          background: spentPercent > 90 ? "#ff7875" : "#c8b99a", 
          height: "100%",
          borderRadius: "4px",
          transition: "width 0.5s ease-out"
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "rgba(240,237,232,0.3)" }}>
        <span>Status: <span style={{ color: "#7ec898" }}>● Active</span></span>
      </div>
    </div>
  );
}

mountWidget(<BalanceWidget />);
