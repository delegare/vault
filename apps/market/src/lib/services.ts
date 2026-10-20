export type Protocol = "x402" | "MPP" | "both";
export type Rail = "crypto" | "fiat" | "both";

// Known currencies with display metadata
export type Currency =
  | "USDC"       // x402, Base L2
  | "USDT"       // Delegare extended
  | "pathUSD"    // MPP/Tempo chain (TIP-20 stablecoin, ~500ms finality)
  | "USD"        // MPP/Stripe fiat
  | "BTC"        // MPP/Lightning
  | "SOL"        // MPP/Solana
  | "ETH";

export const CURRENCY_META: Record<Currency, { label: string; color: string; bg: string; note?: string }> = {
  USDC:    { label: "USDC",    color: "#2775CA", bg: "rgba(39,117,202,0.12)", note: "Base L2" },
  USDT:    { label: "USDT",    color: "#26A17B", bg: "rgba(38,161,123,0.12)", note: "Base L2" },
  pathUSD: { label: "pathUSD", color: "#a78bfa", bg: "rgba(167,139,250,0.12)", note: "Tempo chain" },
  USD:     { label: "USD",     color: "#4ade80", bg: "rgba(74,222,128,0.12)", note: "Card / Stripe" },
  BTC:     { label: "BTC",     color: "#f7931a", bg: "rgba(247,147,26,0.12)", note: "Lightning" },
  SOL:     { label: "SOL",     color: "#9945FF", bg: "rgba(153,69,255,0.12)", note: "Solana" },
  ETH:     { label: "ETH",     color: "#627EEA", bg: "rgba(98,126,234,0.12)" },
};

export interface Service {
  id: string;
  name: string;
  description: string;
  category: string;
  logoUrl?: string;
  website?: string;
  protocols: Protocol[];
  rails: Rail[];
  currencies: Currency[];   // explicit currency list — shown as chips
  endpoints: ServiceEndpoint[];
  source: "mppscan" | "bazaar" | "delegare";
  payTo?: string;
  network?: string;
  totalPayments?: number;
  featuredAt?: string;
}

export interface ServiceEndpoint {
  path: string;
  method: string;
  description: string;
  priceUsd: number;       // human-readable e.g. 0.50
  priceAtomic?: string;   // e.g. "500000" (USDC 6 decimals)
  rail: Rail;
}

// ── MPP Services ─────────────────────────────────────────────────────────────
// Static snapshot from mpp.dev/api/services — updated at build time.
// mpp.dev blocks server-side fetches (403), so we bake in the data and
// attempt a runtime refresh on each deploy.
import staticMppServices from "./mpp-services.json";

async function fetchMppScanServices(): Promise<Service[]> {
  try {
    // Try to get fresh data at runtime; fall back to static snapshot
    let servers: any[] = staticMppServices as any[];

    const freshRes = await fetch("https://mpp.dev/api/services", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DelegareMarket/1.0; +https://market.delegare.dev)",
        "Accept": "application/json",
      },
      next: { revalidate: 3600 }, // try hourly
    }).catch(() => null);

    if (freshRes?.ok) {
      const fresh = await freshRes.json();
      const freshServices = fresh.services ?? (Array.isArray(fresh) ? fresh : null);
      if (freshServices?.length > 0) servers = freshServices;
    }

    return servers.map((s: any) => {
      // MPP services can support multiple currencies depending on configured methods
      const currencies: Currency[] = [];
      // methods is an object: { tempo: {...}, stripe: {...} }
      const methodKeys = Object.keys(s.methods ?? {});
      if (methodKeys.includes("tempo") || methodKeys.length === 0) currencies.push("pathUSD");
      if (methodKeys.includes("stripe")) currencies.push("USD");
      if (methodKeys.includes("lightning")) currencies.push("BTC");
      if (methodKeys.includes("usdc")) currencies.push("USDC");
      if (currencies.length === 0) currencies.push("pathUSD");

      // mpp.dev uses 'url' or 'serviceUrl'; MPPScan may use 'url' too
      const website = s.url ?? s.serviceUrl ?? s.baseUrl ?? "";
      // mpp.dev uses 'categories' array; MPPScan may use 'category' string
      const category = s.category ?? s.categories?.[0] ?? "general";
      // logo from various possible fields
      const logoUrl = s.logo ?? s.logoUrl ?? s.icon ?? undefined;

      return {
        id: `mpp-${s.id ?? website}`,
        name: s.name ?? (website ? new URL(website).hostname : "MPP Service"),
        description: s.description ?? "MPP-compatible service",
        category,
        logoUrl,
        website,
        protocols: ["MPP"] as Protocol[],
        rails: currencies.includes("USD") ? ["fiat", "crypto"] as Rail[] : ["crypto"] as Rail[],
        currencies,
        endpoints: (s.endpoints ?? [])
          .filter((ep: any) => ep.payment) // only show paid endpoints
          .map((ep: any) => ({
            path: ep.path ?? "/",
            method: ep.method ?? "POST",
            description: ep.description ?? ep.payment?.description ?? "",
            priceUsd: ep.payment?.amount
              ? parseInt(ep.payment.amount) / Math.pow(10, ep.payment.decimals ?? 6)
              : 0,
            rail: ep.payment?.method === "stripe" ? "fiat" as Rail : "crypto" as Rail,
          })),
        source: "mppscan" as const,
        payTo: s.payTo ?? s.walletAddress,
        network: s.network ?? "tempo",
        totalPayments: s.totalPayments,
      };
    });
  } catch {
    return [];
  }
}

// ── CDP Bazaar (agentic.market) ───────────────────────────────────────────────

async function fetchBazaarServices(): Promise<Service[]> {
  try {
    // CDP Bazaar paginated catalog — returns ALL indexed services, no auth needed.
    // GET /platform/v2/x402/discovery/resources?limit=1000
    const allResources: any[] = [];
    let offset = 0;
    const limit = 100;

    // Fetch up to 500 resources (5 pages) to avoid long load times
    for (let page = 0; page < 5; page++) {
      const res = await fetch(
        `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=${limit}&offset=${offset}`,
        { next: { revalidate: 300 } }
      ).catch(() => null);
      if (!res?.ok) break;
      const data = await res.json();
      // CDP returns { items: [...] } not { resources: [...] }
      const resources: any[] = data.items ?? data.resources ?? [];
      allResources.push(...resources);
      if (resources.length < limit) break; // last page
      offset += limit;
    }

    if (allResources.length === 0) return [];

    // Group resources by domain → one service card per merchant domain
    const byDomain = new Map<string, any[]>();
    for (const r of allResources) {
      try {
        const domain = new URL(r.resource).hostname;
        const arr = byDomain.get(domain) ?? [];
        arr.push(r);
        byDomain.set(domain, arr);
      } catch { /* skip malformed URLs */ }
    }

    const services: any[] = Array.from(byDomain.entries()).map(([domain, items]) => {
      const first = items[0];
      // Prefer EVM Base accepts over Solana
      const evmAccept = first?.accepts?.find((a: any) => a.network?.startsWith("eip155:"));
      const anyAccept = evmAccept ?? first?.accepts?.[0];
      // CDP extensions.bazaar carries name/description/logoUrl if declared
      const bazaar = first?.extensions?.bazaar ?? {};
      return {
        name: bazaar.name ?? domain,
        description: bazaar.description ?? first?.description ?? `x402 service on ${domain}`,
        resource: `https://${domain}`,
        logoUrl: bazaar.logoUrl ?? bazaar.input?.logoUrl ?? undefined,
        category: bazaar.input?.category ?? "general",
        payTo: anyAccept?.payTo,
        network: anyAccept?.network ?? "eip155:8453",
        items,
      };
    });

    return services.map((s: any) => {
      // Determine currencies from accepts across all items
      const currencies = new Set<Currency>();
      for (const item of (s.items ?? [])) {
        for (const a of (item.accepts ?? [])) {
          if (a.network?.startsWith("eip155:")) currencies.add("USDC");
          if (a.network?.startsWith("solana:")) currencies.add("USDC"); // USDC on Solana
        }
      }
      if (currencies.size === 0) currencies.add("USDC");

      return ({
      id: `bazaar-${s.resource ?? s.payTo}`,
      name: s.name,
      description: s.description,
      category: s.category ?? "general",
      logoUrl: s.logoUrl ?? undefined,
      website: s.resource,
      protocols: ["x402"] as Protocol[],
      rails: ["crypto"] as Rail[],
      currencies: [...currencies] as Currency[],
      // Each item = one endpoint. Use EVM accept for price.
      endpoints: (s.items ?? []).map((item: any) => {
        const evmAccept = item.accepts?.find((a: any) => a.network?.startsWith("eip155:"))
          ?? item.accepts?.[0];
        const atomic = parseInt(evmAccept?.amount ?? "0");
        return {
          path: (() => { try { return new URL(item.resource).pathname; } catch { return item.resource ?? "/"; } })(),
          method: "POST",
          description: item.description ?? "",
          priceUsd: atomic / 1_000_000, // USDC has 6 decimals
          priceAtomic: evmAccept?.amount,
          rail: "crypto" as Rail,
        };
      }),
      source: "bazaar" as const,
      payTo: s.payTo,
      network: "base",
    });});
  } catch {
    return [];
  }
}

// ── Delegare-featured / own services ─────────────────────────────────────────
// Hardcoded for now — will be driven by Delegare merchant registry later

const DELEGARE_FEATURED: Service[] = [
  {
    id: "delegare-example",
    name: "Example Agent",
    description: "Placeholder listing. Replace with a merchant from the Delegare registry before going live.",
    category: "example",
    website: "https://example.com",
    protocols: ["x402", "MPP"],
    rails: ["crypto", "fiat"],
    currencies: ["USDC", "USDT", "USD"], // USDC/USDT on Base L2; USD via Stripe fiat mandate
    endpoints: [
      { path: "/example", method: "POST", description: "Example paid endpoint", priceUsd: 0.01, priceAtomic: "10000", rail: "crypto" },
    ],
    source: "delegare",
    payTo: "0x0000000000000000000000000000000000000000",
    network: "base",
  },
];

// ── Aggregator ────────────────────────────────────────────────────────────────

export async function getAllServices(opts?: {
  protocol?: Protocol | "all";
  rail?: Rail | "all";
  search?: string;
  category?: string;
}): Promise<Service[]> {
  const [mpp, bazaar] = await Promise.all([
    fetchMppScanServices(),
    fetchBazaarServices(),
  ]);

  // Merge: Delegare-featured first, then bazaar, then MPP
  // Deduplicate by website domain — merge protocols/rails when same service appears in both
  const byKey = new Map<string, Service>();

  for (const s of [...DELEGARE_FEATURED, ...bazaar, ...mpp]) {
    const key = s.website ? new URL(s.website).hostname : s.id;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...s });
    } else {
      // Merge protocols, rails, currencies — shows [x402] [MPP] + all currency chips on one card
      const merged = { ...existing };
      for (const p of s.protocols) {
        if (!merged.protocols.includes(p)) merged.protocols = [...merged.protocols, p];
      }
      for (const r of s.rails) {
        if (!merged.rails.includes(r)) merged.rails = [...merged.rails, r];
      }
      for (const c of (s.currencies ?? [])) {
        if (!merged.currencies.includes(c)) merged.currencies = [...merged.currencies, c];
      }
      byKey.set(key, merged);
    }
  }

  const all = [...byKey.values()];

  let result = all;

  if (opts?.protocol && opts.protocol !== "all") {
    result = result.filter(s =>
      s.protocols.includes(opts.protocol as Protocol) || s.protocols.includes("both" as any)
    );
  }
  if (opts?.rail && opts.rail !== "all") {
    result = result.filter(s =>
      s.rails.includes(opts.rail as Rail) || s.rails.includes("both")
    );
  }
  if (opts?.search) {
    const q = opts.search.toLowerCase();
    result = result.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
    );
  }
  if (opts?.category && opts.category !== "all") {
    result = result.filter(s => s.category === opts.category);
  }

  return result;
}

export function getCategories(services: Service[]): string[] {
  return [...new Set(services.map(s => s.category))].sort();
}

export function getStats(services: Service[]) {
  return {
    total: services.length,
    x402: services.filter(s => s.protocols.includes("x402")).length,
    mpp: services.filter(s => s.protocols.includes("MPP")).length,
    both: services.filter(s => s.protocols.length > 1).length,
  };
}
