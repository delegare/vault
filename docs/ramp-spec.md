# Delegare On/Off Ramp — Product Spec

## Overview

Delegare adds on/off ramp flows as **first-class actions** in the Vault API and dashboard.
Every ramp transaction carries a flat **$0.30 Delegare fee** on top of whatever the
underlying provider (Coinbase, Stripe/Bridge) charges for FX and their own fees.

---

## 1. Ramp Types

| Type | Direction | Who uses it | Provider |
|------|-----------|-------------|----------|
| **Onramp** | Fiat → USDC | Buyer with no crypto wallet | Coinbase Onramp |
| **Offramp** | USDC → Fiat | Merchant receiving USDC, wants bank payout | Stripe/Bridge or Coinbase Offramp |
| **Auto-offramp** | USDC → Bank | Merchant setting: sweep every settlement | Stripe/Bridge |

---

## 2. Fee Structure

| Layer | Who charges | Amount |
|-------|-------------|--------|
| Delegare platform | Delegare | **$0.30 flat per ramp action** |
| Provider FX spread | Coinbase or Stripe | ~0.5–1.5% of amount (pass-through) |
| Provider network fee | Coinbase or Stripe | ~$0–2 depending on method |

The $0.30 is charged to:
- **Onramp**: the buyer (deducted from fiat before USDC is delivered)
- **Offramp**: the merchant (deducted from USDC before bank transfer)

Provider costs are pass-through — Delegare does not mark them up. The merchant/buyer
sees a transparent breakdown: `delegareFee: 30`, `providerFee: <actual>`, `fxRate: <actual>`.

---

## 3. API Design

### 3.1 Onramp — `POST /v1/ramp/onramp/initiate`

Buyer wants to convert fiat → USDC to fund their mandate.

**Request:**
```json
{
  "amountFiat": 50.00,
  "currency": "usd",
  "destinationWallet": "0x...",     // buyer's smart wallet
  "provider": "coinbase" | "auto",
  "mandateId": "mandate_..."         // optional — links ramp to mandate
}
```

**Response:**
```json
{
  "rampId": "ramp_...",
  "provider": "coinbase",
  "widgetUrl": "https://pay.coinbase.com/buy?...",  // embed or redirect
  "sessionToken": "...",
  "estimatedUsdc": 49.20,           // after provider fees
  "delegareFee": 0.30,
  "providerFeeEstimate": 0.50,
  "expiresAt": "...",
  "status": "pending"
}
```

**Flow:**
1. Vault calls Coinbase Onramp API to mint a signed session URL
2. Adds $0.30 Delegare fee to the fiat amount (buyer pays $50.30 total)
3. Returns `widgetUrl` — Delegare setup UI embeds the Coinbase widget
4. Coinbase delivers USDC to `destinationWallet` on Base
5. Vault receives webhook from Coinbase → updates ramp status → triggers mandate activation if `mandateId` provided

---

### 3.2 Offramp — `POST /v1/ramp/offramp/initiate`

Merchant wants to convert USDC → bank account.

**Request:**
```json
{
  "amountUsdc": 100.00,
  "sourceWallet": "0x...",           // merchant's USDC wallet
  "provider": "stripe" | "coinbase" | "auto",
  "bankAccountId": "ba_..."          // Stripe bank account on file, or Coinbase ACH
}
```

**Response:**
```json
{
  "rampId": "ramp_...",
  "provider": "stripe",
  "estimatedFiat": 99.20,
  "delegareFee": 0.30,
  "providerFeeEstimate": 0.50,
  "fxRate": 1.00,
  "estimatedArrival": "1-2 business days",
  "status": "pending"
}
```

**Flow:**
1. Vault calls Bridge.xyz (via Stripe) or Coinbase Offramp API
2. Deducts $0.30 Delegare fee from USDC before initiating transfer
3. Records `RampTransaction` in DynamoDB
4. Provider webhook updates status on settlement

---

### 3.3 Auto-offramp — Merchant Setting

Merchant can set `autoOfframp: true` in their merchant settings. Every time a USDC
payment settles to their wallet, Vault automatically initiates an offramp.

**Merchant settings fields (additions to `MerchantAccount`):**
```typescript
autoOfframp?: boolean;              // default false
autoOfframpProvider?: 'stripe' | 'coinbase';
autoOfframpBankAccountId?: string;  // Stripe bank or Coinbase ACH
autoOfframpThresholdCents?: number; // only offramp if balance > threshold (default: 0)
```

---

## 4. New DynamoDB Table: `delegare-ramp-transactions`

```typescript
interface RampTransaction {
  rampId: string;          // PK: ramp_...
  type: 'onramp' | 'offramp';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  provider: 'coinbase' | 'stripe';
  
  ownerId: string;         // merchantId or buyerId
  mandateId?: string;      // if linked to a mandate
  
  amountCents: number;     // fiat amount
  amountUsdc: number;      // USDC amount
  delegareFeeCents: number; // always 30
  providerFeeCents: number; // actual provider fee (filled on completion)
  fxRate: number;          // USD/USDC rate at time of execution
  
  destinationWallet?: string;  // onramp
  sourceTxHash?: string;       // onramp — Coinbase on-chain tx
  bankAccountId?: string;      // offramp
  
  providerRampId: string;  // Coinbase/Stripe internal ID
  createdAt: string;
  completedAt?: string;
  ttl: number;             // 90 days
}
```

---

## 5. Provider Integration

### 5.1 Coinbase Onramp
- **API**: `POST https://api.developer.coinbase.com/onramp/v1/buy/options`
- **Auth**: CDP API key (already have for Bazaar indexing)
- **Widget**: `https://pay.coinbase.com/buy?appId=...&addresses=...&assets=USDC&preset Fiat Amount=...`
- **Webhook**: `X-Coinbase-Signature` header — verify with HMAC-SHA256
- **Fee model**: Coinbase charges ~1.49% spread + network fee. Delegare adds $0.30 flat on top.

### 5.2 Stripe/Bridge Offramp
- **API**: Stripe `POST /v1/treasury/outbound_transfers` (Bridge via Stripe Financial Connections)
- **Auth**: Stripe secret key (already have for fiat rail)
- **Bank linking**: Stripe Financial Connections or manual IBAN/routing
- **Fee model**: Stripe charges ~0.25% + $0.25. Delegare adds $0.30 flat.

### 5.3 Coinbase Offramp
- **API**: `POST https://api.developer.coinbase.com/offramp/v1/sell/options`
- **Auth**: Same CDP API key
- **Fee model**: Coinbase charges ~1.49% spread. Delegare adds $0.30 flat.

---

## 6. Dashboard UI Changes

### 6.1 Merchant Settings — new "Settlement" section

```
Payment Rail Preference
  ○ Accept Any          (recommended — maximises payment volume)
  ○ Fiat (Stripe) only
  ○ Crypto (USDC) only

Auto-Offramp
  [ ] Automatically convert USDC to fiat after each settlement
      Provider: [Stripe ▾]  Threshold: [$0 — always]
      Bank: [**** 4242 ▾]   [+ Add bank account]
```

### 6.2 Buyer Dashboard — "Fund Wallet" button

When buyer has no USDC wallet funded, show onramp CTA:
```
Fund your wallet
Buy USDC with a card or bank transfer via Coinbase.
$0.30 Delegare fee + Coinbase fees apply.
[Buy USDC →]
```

### 6.3 Transaction history — ramp entries

Show ramp transactions inline with payments:
```
↓ Onramp   +49.20 USDC   $50.00 paid   via Coinbase   2026-05-09
↑ Offramp  -99.20 USDC   $99.20 bank   via Stripe     2026-05-09
```

---

## 7. Implementation Phases

### Phase 1 — Merchant Settings UI (no ramp yet)
- Add `railRequirement` toggle to dashboard merchant settings
- Wire `PATCH /v1/merchants/:id` with `railRequirement` field (API already exists)
- Estimated: 1 day

### Phase 2 — Offramp for merchants
- New `RampController.ts` + `RampService.ts` in vault
- Stripe Treasury outbound transfer (Bridge)
- `POST /v1/ramp/offramp/initiate`
- Auto-offramp hook in `PaymentController` after settlement
- Dashboard: auto-offramp toggle + bank account linking
- Estimated: 3 days

### Phase 3 — Onramp for buyers
- Coinbase Onramp widget integration
- `POST /v1/ramp/onramp/initiate`
- Embed in Delegare setup flow ("No USDC? Buy some here")
- Mandate auto-activation on completion
- Estimated: 2 days

### Phase 4 — Coinbase Offramp alternative
- Add Coinbase as offramp option alongside Stripe
- Estimated: 1 day

---

## 8. Open Questions

1. **KYC**: Coinbase and Stripe both require KYC for ramp. Does Delegare pass through the
   provider's KYC flow, or does Delegare need its own KYC layer first?
   → Recommendation: pass-through. Both providers handle KYC themselves in their hosted UI.

2. **Auto-offramp timing**: Sweep immediately on settlement, or batch daily at midnight?
   → Recommendation: immediate for amounts > $100, daily batch for smaller amounts.

3. **Multi-currency**: Spec covers USD↔USDC. Extend to EUR/GBP↔USDC later via Bridge.

4. **Delegare fee billing**: How is the $0.30 collected from buyers on onramp?
   → Recommendation: add to the fiat amount before initiating (buyer pays $X + $0.30).
   For offramp: deduct from USDC before transfer (merchant receives $X - $0.30).
