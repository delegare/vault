import { getAllServices, getStats } from "@/lib/services";
import MarketClient from "@/components/MarketClient";

export default async function MarketPage() {
  const services = await getAllServices();
  const stats = getStats(services);

  return (
    <div style={{ minHeight: "100vh", background: "#0c0c0c", overflowX: "hidden" }}>
      {/* Header */}
      <header style={{
        borderBottom: "1px solid rgba(240,237,232,0.06)",
        padding: "0 var(--page-px)",
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        background: "rgba(12,12,12,0.95)",
        backdropFilter: "blur(12px)",
        zIndex: 100,
        width: "100%",
      }}>
        <a href="https://delegare.dev" style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
          {["delegare", ".", "market"].map((t, i) => (
            <span key={i} style={{
              fontFamily: "var(--font-serif, 'DM Serif Display', Georgia, serif)",
              fontSize: 20, letterSpacing: "-0.3px",
              color: i === 1 ? "#c8b99a" : i === 2 ? "rgba(240,237,232,0.45)" : "#f0ede8",
            }}>{t}</span>
          ))}
        </a>
        <a href="https://app.delegare.dev" style={{
          padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: "#c8b99a", color: "#0c0c0c", border: "none", whiteSpace: "nowrap", flexShrink: 0,
        }}>Get access</a>
      </header>

      {/* Hero */}
      <div style={{ padding: "48px var(--page-px) 32px", maxWidth: 900, margin: "0 auto", textAlign: "center" }}>
        <div style={{
          display: "inline-flex", gap: 6, marginBottom: 20, padding: "4px 12px",
          background: "rgba(200,185,154,0.08)", borderRadius: 20, border: "1px solid rgba(200,185,154,0.15)",
          flexWrap: "wrap", justifyContent: "center",
        }}>
          <span style={{ fontSize: 12, color: "#c8b99a" }}>x402</span>
          <span style={{ fontSize: 12, color: "rgba(240,237,232,0.3)" }}>+</span>
          <span style={{ fontSize: 12, color: "#7ec898" }}>MPP</span>
          <span style={{ fontSize: 12, color: "rgba(240,237,232,0.3)" }}>·</span>
          <span style={{ fontSize: 12, color: "rgba(240,237,232,0.5)" }}>unified</span>
        </div>
        <h1 style={{
          fontSize: "clamp(28px, 6vw, 42px)", fontWeight: 800, lineHeight: 1.1,
          letterSpacing: "-1px", color: "#f0ede8", marginBottom: 16,
        }}>
          Services for AI agents
        </h1>
        <p style={{
          fontSize: "clamp(14px, 3vw, 17px)", color: "rgba(240,237,232,0.5)",
          lineHeight: 1.6, maxWidth: 560, margin: "0 auto 32px",
        }}>
          Discover and access {stats.total} agent-native services across x402 and MPP protocols.
          Pay per use — crypto or card, no API keys, no subscriptions.
        </p>

        {/* Stats row — wraps on mobile */}
        <div style={{ display: "flex", gap: 24, justifyContent: "center", flexWrap: "wrap" }}>
          {[
            { label: "Total services", value: stats.total, color: "#f0ede8" },
            { label: "x402 (CDP Bazaar)", value: stats.x402, color: "#c8b99a" },
            { label: "MPP (mppscan)", value: stats.mpp, color: "#7ec898" },
            { label: "Dual-protocol", value: stats.both, color: "#60a5fa" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: "clamp(20px, 5vw, 28px)", fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,232,0.4)", marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Service grid */}
      <MarketClient initialServices={services} />

      {/* Footer */}
      <footer style={{
        borderTop: "1px solid rgba(240,237,232,0.06)",
        padding: "32px var(--page-px)",
        marginTop: 64, textAlign: "center",
      }}>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
          {[
            { label: "agentic.market", href: "https://agentic.market" },
            { label: "mppscan.com", href: "https://mppscan.com" },
            { label: "mpp.dev", href: "https://mpp.dev" },
            { label: "x402.org", href: "https://x402.org" },
            { label: "delegare.dev", href: "https://delegare.dev" },
          ].map(l => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 13, color: "rgba(240,237,232,0.4)" }}>
              {l.label}
            </a>
          ))}
        </div>
        <p style={{ fontSize: 11, color: "rgba(240,237,232,0.2)", lineHeight: 1.6 }}>
          Delegare Market aggregates x402 (CDP Bazaar) and MPP (mppscan.com) services.
          <br />All payments use delegated access — your agent, your limits, your control.
        </p>
      </footer>
    </div>
  );
}
