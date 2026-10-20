"use client";

import { useState, useMemo } from "react";
import type { Service, Protocol, Rail, Currency } from "@/lib/services";
import { CURRENCY_META } from "@/lib/services";

const DELEGARE_SETUP = "https://app.delegare.dev";

function ProtocolBadge({ protocol }: { protocol: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    x402: { bg: "rgba(200,185,154,0.12)", text: "#c8b99a" },
    MPP:  { bg: "rgba(126,200,152,0.12)", text: "#7ec898" },
    both: { bg: "rgba(96,165,250,0.12)", text: "#60a5fa" },
  };
  const c = colors[protocol] ?? colors.x402;
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
      background: c.bg, color: c.text, letterSpacing: "0.3px",
    }}>{protocol}</span>
  );
}

function CurrencyChip({ currency }: { currency: Currency }) {
  const meta = CURRENCY_META[currency] ?? { label: currency, color: "rgba(240,237,232,0.5)", bg: "rgba(240,237,232,0.06)" };
  return (
    <span
      title={meta.note}
      style={{
        padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 500,
        background: meta.bg, color: meta.color,
        cursor: meta.note ? "help" : "default",
      }}
    >
      {meta.label}
      {meta.note && <span style={{ opacity: 0.6, fontSize: 10 }}> · {meta.note}</span>}
    </span>
  );
}

function ServiceCard({ service }: { service: Service }) {
  const [expanded, setExpanded] = useState(false);
  const minPrice = Math.min(...service.endpoints.map(e => e.priceUsd));
  const maxPrice = Math.max(...service.endpoints.map(e => e.priceUsd));
  const isFeatured = service.source === "delegare";

  // Build a Delegare setup URL pre-scoped to this merchant.
  // The setup flow creates an AP2 mandate with:
  //   - allowedMerchantIds: [payTo wallet] — scoped to this specific merchant
  //   - maxPerTxCents: max endpoint price * 2 (generous headroom)
  //   - maxMonthlySpendCents: max * 20 (reasonable monthly budget)
  // The agent then presents this mandate to ANY x402/MPP service the merchant runs
  // — Delegare settles transparently, merchant sees a valid signed payment.
  const maxPerTxCents = Math.ceil(maxPrice * 100 * 2);
  const maxMonthlySpendCents = Math.min(maxPerTxCents * 20, 50000); // cap at $500/month
  const setupParams = new URLSearchParams({
    ...(service.payTo ? { merchant: service.payTo } : {}),
    service: service.name,
    maxPerTxCents: String(maxPerTxCents),
    maxMonthlySpendCents: String(maxMonthlySpendCents),
    rail: service.rails.includes("both") ? "both" : service.rails[0] ?? "both",
    returnUrl: service.website ?? "",
  });
  const accessUrl = `${DELEGARE_SETUP}/setup?${setupParams.toString()}`;

  return (
    <div style={{
      background: isFeatured ? "rgba(200,185,154,0.04)" : "rgba(240,237,232,0.02)",
      border: `1px solid ${isFeatured ? "rgba(200,185,154,0.15)" : "rgba(240,237,232,0.07)"}`,
      borderRadius: 14,
      padding: "20px 22px",
      transition: "border-color 0.15s, background 0.15s",
      cursor: "pointer",
    }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = isFeatured ? "rgba(200,185,154,0.3)" : "rgba(240,237,232,0.15)";
        (e.currentTarget as HTMLDivElement).style.background = isFeatured ? "rgba(200,185,154,0.06)" : "rgba(240,237,232,0.03)";
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.borderColor = isFeatured ? "rgba(200,185,154,0.15)" : "rgba(240,237,232,0.07)";
        (e.currentTarget as HTMLDivElement).style.background = isFeatured ? "rgba(200,185,154,0.04)" : "rgba(240,237,232,0.02)";
      }}
    >
      {/* Top row — wraps on narrow screens */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
          {service.logoUrl ? (
            <img src={service.logoUrl} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", background: "#1a1a1a" }} />
          ) : (
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(240,237,232,0.06)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, fontWeight: 700, color: "rgba(240,237,232,0.4)" }}>
              {service.name.charAt(0)}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#f0ede8" }}>{service.name}</span>
              {isFeatured && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 3,
                background: "rgba(200,185,154,0.15)", color: "#c8b99a", fontWeight: 600 }}>FEATURED</span>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
              {service.protocols.map(p => <ProtocolBadge key={p} protocol={p} />)}
              {(service.currencies ?? []).map(c => <CurrencyChip key={c} currency={c} />)}
            </div>
          </div>
        </div>

        {/* Price + CTA */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, color: "rgba(240,237,232,0.4)" }}>from</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f0ede8" }}>
              ${minPrice.toFixed(2)}
            </div>
          </div>
          <a
            href={accessUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              background: isFeatured ? "#c8b99a" : "rgba(240,237,232,0.08)",
              color: isFeatured ? "#0c0c0c" : "#f0ede8",
              border: "none", whiteSpace: "nowrap",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.8")}
            onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
          >
            Delegated access →
          </a>
        </div>
      </div>

      {/* Description */}
      <p style={{ marginTop: 14, fontSize: 13, color: "rgba(240,237,232,0.55)", lineHeight: 1.6 }}>
        {service.description}
      </p>

      {/* Endpoints toggle */}
      {service.endpoints.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: "none", border: "none", padding: 0, fontSize: 12,
              color: "rgba(240,237,232,0.35)", cursor: "pointer",
            }}
          >
            {expanded ? "▲ Hide" : "▼ Show"} {service.endpoints.length} endpoint{service.endpoints.length !== 1 ? "s" : ""}
          </button>

          {expanded && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {service.endpoints.map((ep, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 12px", borderRadius: 8,
                  background: "rgba(240,237,232,0.03)", border: "1px solid rgba(240,237,232,0.05)",
                }}>
                  <div>
                    <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "#7ec898", marginRight: 8 }}>
                      {ep.method}
                    </span>
                    <span style={{ fontSize: 12, color: "rgba(240,237,232,0.6)", fontFamily: "var(--mono)",
                      wordBreak: "break-all" }}>
                      {ep.path}
                    </span>
                    <div style={{ fontSize: 11, color: "rgba(240,237,232,0.35)", marginTop: 2 }}>
                      {ep.description}
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#f0ede8", flexShrink: 0, marginLeft: 16 }}>
                    ${ep.priceUsd.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Source tag */}
      <div style={{ marginTop: 12, fontSize: 11, color: "rgba(240,237,232,0.2)" }}>
        {service.source === "delegare" ? "Delegare featured" :
         service.source === "bazaar" ? "via agentic.market" : "via mppscan.com"}
        {service.website && (
          <> · <a href={service.website} target="_blank" rel="noopener noreferrer"
            style={{ color: "rgba(240,237,232,0.25)" }}>{new URL(service.website).hostname}</a></>
        )}
      </div>
    </div>
  );
}

export default function MarketClient({ initialServices }: { initialServices: Service[] }) {
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState<"all" | Protocol>("all");
  const [rail, setRail] = useState<"all" | Rail>("all");

  const filtered = useMemo(() => {
    let s = initialServices;
    if (search) {
      const q = search.toLowerCase();
      s = s.filter(x => x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q));
    }
    if (protocol !== "all") s = s.filter(x => x.protocols.includes(protocol));
    if (rail !== "all") s = s.filter(x => x.rails.includes(rail) || x.rails.includes("both"));
    return s;
  }, [initialServices, search, protocol, rail]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 var(--page-px) 64px" }}>
      {/* Search */}
      <input
        type="text"
        placeholder="Search services…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: "100%", padding: "10px 16px", borderRadius: 10, marginBottom: 10,
          background: "rgba(240,237,232,0.04)", border: "1px solid rgba(240,237,232,0.1)",
          color: "#f0ede8", fontSize: 14, outline: "none",
        }}
      />

      {/* Filters — scroll horizontally on mobile rather than overflow page */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24, overflowX: "auto", paddingBottom: 4,
        WebkitOverflowScrolling: "touch" as any, scrollbarWidth: "none" as any }}>
        {/* Protocol filter */}
        <div style={{ display: "flex", gap: 2, background: "rgba(240,237,232,0.04)", borderRadius: 10,
          border: "1px solid rgba(240,237,232,0.08)", padding: 3, flexShrink: 0 }}>
          {(["all", "x402", "MPP"] as const).map(p => (
            <button key={p} onClick={() => setProtocol(p)} style={{
              padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, border: "none",
              background: protocol === p ? (p === "x402" ? "rgba(200,185,154,0.2)" : p === "MPP" ? "rgba(126,200,152,0.2)" : "rgba(240,237,232,0.08)") : "transparent",
              color: protocol === p ? (p === "x402" ? "#c8b99a" : p === "MPP" ? "#7ec898" : "#f0ede8") : "rgba(240,237,232,0.4)",
              transition: "all 0.15s", whiteSpace: "nowrap",
            }}>
              {p === "all" ? "All protocols" : p}
            </button>
          ))}
        </div>
        {/* Rail filter */}
        <div style={{ display: "flex", gap: 2, background: "rgba(240,237,232,0.04)", borderRadius: 10,
          border: "1px solid rgba(240,237,232,0.08)", padding: 3, flexShrink: 0 }}>
          {(["all", "crypto", "fiat"] as const).map(r => (
            <button key={r} onClick={() => setRail(r)} style={{
              padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 500, border: "none",
              background: rail === r ? "rgba(240,237,232,0.08)" : "transparent",
              color: rail === r ? "#f0ede8" : "rgba(240,237,232,0.4)",
              transition: "all 0.15s", whiteSpace: "nowrap",
            }}>
              {r === "all" ? "All rails" : r === "crypto" ? "⬡ Crypto" : "$ Fiat"}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <div style={{ fontSize: 13, color: "rgba(240,237,232,0.3)", marginBottom: 16 }}>
        {filtered.length} service{filtered.length !== 1 ? "s" : ""}
        {search && ` matching "${search}"`}
      </div>

      {/* Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "48px 0", color: "rgba(240,237,232,0.3)", fontSize: 14 }}>
            No services found. Try a different search or filter.
          </div>
        ) : (
          filtered.map(s => <ServiceCard key={s.id} service={s} />)
        )}
      </div>

      {/* List your service CTA */}
      <div style={{
        marginTop: 48, padding: "24px var(--page-px)", borderRadius: 16,
        background: "rgba(200,185,154,0.04)", border: "1px dashed rgba(200,185,154,0.2)",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#f0ede8", marginBottom: 4 }}>
            List your service
          </div>
          <div style={{ fontSize: 13, color: "rgba(240,237,232,0.45)" }}>
            Accept agent payments with x402 or MPP. Get discovered here, on agentic.market, and mppscan.com.
          </div>
        </div>
        <a href="https://app.delegare.dev" target="_blank" rel="noopener noreferrer"
          style={{
            padding: "10px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600,
            background: "#c8b99a", color: "#0c0c0c", border: "none", whiteSpace: "nowrap",
          }}>
          Get started →
        </a>
      </div>
    </div>
  );
}
