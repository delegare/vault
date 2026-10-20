# Delegare Aggregator Dashboard — Product Spec (v2)

## Vision

Delegare becomes the **identity and auth layer for all agentic payments**.
Merchants register once. Agents get one AP2 mandate. Delegare routes to the right
payment rail (crypto stablecoin or fiat) using whichever discovery protocol
(x402, MPP) the ecosystem supports.

`delegare.dev/market` = unified view of agentic.market + MPPScan + Delegare merchants
in one place — both protocols, one dashboard.

---

## Correction to Previous Spec

**Rails are always crypto or fiat. Period.**
x402 and MPP are *discovery and payment challenge protocols*, not rails.
They both settle on-chain (USDC/stablecoin) or via card/bank (fiat).

```
WRONG:  rail = 'fiat' | 'crypto' | 'mpp' | 'virtual_card'
RIGHT:  rail = 'fiat' | 'crypto' | 'both'
        protocol = 'x402' | 'mpp'   ← how the mandate/payment was negotiated
```

The PaymentRouter stays exactly as-is. Protocol is just a metadata field on receipts.

---

## Market Context

| Platform | Protocol | Rail | Auth | Discovery |
|---|---|---|---|---|
| CDP/Coinbase | x402 | Crypto (USDC/Base) | API key | agentic.market |
| mpp.dev / Tempo | MPP | Crypto + Fiat | MPP_SECRET_KEY | mpp.dev, MPPScan |
| Stripe | Custom | Fiat only | Connect OAuth | None |
| **Delegare** | **x402 + MPP** | **Crypto + Fiat** | **AP2 mandate** | **All of the above** |

Delegare is the only one with intent-scoped authorization (AP2). Neither x402 nor MPP
has spending limits, merchant scoping, or cryptographic proof of intent. That's the moat.

---

## Phase 1: Register a merchant on MPPScan

### 1a. Submit to mppscan.com/register
- URL: the merchant's public agent origin (example: `https://example.com`)
- MPPScan crawls `/.well-known/mpp.json`
- Once submitted, the merchant appears in the MPPScan explorer + API
- MPPScan begins tracking transaction activity

### 1b. Submit to mpp.dev services directory
- mpp.dev has a services API at `https://mpp.dev/api/services`
- Contact mpp.dev / Tempo Labs via their Telegram for manual listing
- OR implement `GET /openapi.json` (MPP discovery spec) for auto-crawl

### 1c. /.well-known/mpp.json
Serve this document on the merchant origin so crawlers can index the service.

---

## Phase 2: delegare.dev/market — Unified Agentic Marketplace

A page Delegare operates that aggregates both protocol indexes into one view.

### Data sources
- **agentic.market** — crawl/API (CDP Bazaar public index)
- **MPPScan API** — `https://mppscan.com/api/servers` (public after registration)
- **Delegare merchants** — any merchant with active wallet/Stripe + public profile

### UI
```
delegare.dev/market

Search: [___________________________]  Filter: [All ▾] [Crypto ▾] [Fiat ▾]

Protocol badges: [x402] [MPP]  Sort: [Most Active ▾]

┌─────────────────────────────────────────────────────────────────┐
│ 🏦 Example Agent                     [x402] [MPP]              │
│ Placeholder merchant listing                                   │
│ From $0.01 · USDC on Base · Fiat via Stripe                    │
│ 1 endpoint · example volume                   [Pay with AP2 ▶] │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 🤖 Anthropic Claude API              [MPP]                     │
│ LLM completions, embeddings                                     │
│ From $0.003/1k tokens · USDC                                   │
│ 2 endpoints · 1,420 payments today            [Pay with AP2 ▶] │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 Exa Search                        [x402] [MPP]              │
│ Web search and content extraction                               │
│ From $0.01/query · USDC                                        │
│ 3 endpoints · 89 payments today               [Pay with AP2 ▶] │
└─────────────────────────────────────────────────────────────────┘
```

### "Pay with AP2" button
When a Delegare user clicks this, they get:
1. A mandate pre-scoped to that merchant (spending limits pre-filled)
2. One-click setup flow → AP2 mandate issued → agent can pay immediately

This is the distribution wedge — discovery happens on Delegare, payment setup
flows through Delegare, AP2 mandate ties them together.

---

## Phase 3: delegare.dev/market as a Product

### For merchants (free)
- Multi-protocol listing (x402 + MPP) from one place
- Analytics: which agents discovered you, payment volume per protocol
- AP2 mandate setup link auto-generated for each endpoint

### For agents / developers (free)
- Browse 70+ MPP services + CDP Bazaar services in one view
- One-click AP2 mandate creation for any listed service
- Protocol-agnostic: mandate works regardless of whether merchant uses x402 or MPP

### Revenue model (future)
- Premium analytics (conversion funnels, agent demographics)
- Verified merchant badges
- Featured placement

---

## Implementation Plan

### Now (1-2 hours)
1. Submit the merchant origin to mppscan.com/register
2. Add `GET /openapi.json` on the merchant server (MPP discovery spec) for auto-crawl

### Sprint 1 (2-3 days)
3. Build `delegare.dev/market` page in vault/apps/dashboard or new Next.js app
4. Crawl agentic.market (public API / scrape)
5. Integrate MPPScan API for MPP services

### Sprint 2 (1 week)
6. "Pay with AP2" button → mandate creation flow
7. Merchant analytics panel: payments by protocol, discovery source
8. Auto-submit new Delegare merchants to both MPPScan and CDP Bazaar on onboarding

---

## /openapi.json for MPP auto-discovery

MPP servers expose `GET /openapi.json` for crawlers. Add to mcp-agents:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Example Agent",
    "version": "1.0.0",
    "description": "Placeholder merchant. Replace with the real service name and description.",
    "x-mpp": {
      "payTo": "0x0000000000000000000000000000000000000000",
      "network": "base",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    }
  },
  "paths": {
    "/example": {
      "post": {
        "summary": "Example paid endpoint",
        "x-mpp-price": "0.01"
      }
    }
  }
}
```
