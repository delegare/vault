# Delegare vs x402 vs MPP — Positioning & Scope

## Are we already in scope for both?

**x402:** ✅ Fully implemented
- `@delegare/x402` middleware handles x402 challenges (`X-PAYMENT-REQUIRED` header)
- CDP Bazaar indexing done (2/7 endpoints live)
- `/.well-known/x402.json` serving

**MPP:** 🟡 Partially — x402 subset works, MPP-native headers missing
- MPP is a superset of x402. x402 clients work with MPP servers (backward compatible).
- MPP-native clients (`WWW-Authenticate: Payment` / `Authorization: Payment`) won't work
  with our current x402 middleware.
- Missing: sessions, multi-method challenge format, RFC 9457 error format

---

## Feature Comparison

| Capability | x402 | MPP | Delegare today | Delegare gap |
|---|---|---|---|---|
| Stablecoin payments | ✅ | ✅ | ✅ | — |
| Fiat/card payments | ❌ | ✅ | ✅ (via AP2 mandate) | Need MPP header |
| Multi-method 402 challenge | ❌ | ✅ | 🟡 (separate rails) | Unify in one header |
| Payment sessions (streaming) | ❌ | ✅ | ❌ | Future |
| Agent identity / auth | ❌ | ❌ | ✅ **AP2 mandate** | **Unique to Delegare** |
| Spending limits | ❌ | ❌ | ✅ | **Unique to Delegare** |
| Merchant scoping | ❌ | ❌ | ✅ | **Unique to Delegare** |
| RFC 7235 compliant headers | ❌ | ✅ | ❌ | Add MPP headers |
| CDP Bazaar indexing | ✅ | ❌ | 🟡 (2/7 done) | Finish indexing |
| mpp.dev indexing | ❌ | ✅ | ❌ | Add MPP support |

**The key insight:** MPP adds multi-method and sessions on top of x402.
Delegare adds identity/auth/scoping on top of both. They're complementary layers.

---

## Does it make sense to align with MPP?

**Yes — for three reasons:**

### 1. MPP is becoming the standard
MPP is IETF-backed (paymentauth.org), RFC 7235-compliant, and already has 70+ services.
Coinbase's x402 is excellent for crypto but MPP handles the full payment spectrum
(stablecoins + cards + Lightning + bank). Being MPP-compatible means any MPP client
(Tempo wallet, future wallets) can discover and pay Delegare-protected endpoints
without any changes.

### 2. MPP + AP2 = complete stack
MPP solves the *what to pay and how* problem.
AP2 solves the *who is paying and why* problem — which MPP doesn't have.

```
Standard MPP client:
  Agent → WWW-Authenticate: Payment → pay → Authorization: Payment → access

Delegare-enhanced MPP client:
  Agent → WWW-Authenticate: Payment → pay via AP2 mandate → Authorization: Payment
          └─ mandate includes: spending limits, merchant scope, intent proof
```

Delegare can be an MPP-compatible server that additionally validates AP2 mandate
headers as a premium auth layer. Non-mandate clients still work via standard MPP.

### 3. One 402 response, all methods
MPP allows advertising multiple payment methods in a single `WWW-Authenticate` header.
This means one endpoint can say: "pay me in USDC, or Stripe card, or via your AP2 mandate"
— and the client picks what it supports.

---

## What needs to change to be MPP-compliant

### Minimal change (add MPP headers alongside x402):

In `@delegare/x402` middleware, emit both challenge formats on 402:

```typescript
// Current (x402 only)
res.setHeader('X-PAYMENT-REQUIRED', JSON.stringify(challenge));

// MPP-compatible (both)
res.setHeader('X-PAYMENT-REQUIRED', JSON.stringify(challenge)); // x402 clients
res.setHeader('WWW-Authenticate',
  `Payment id="${challengeId}", realm="${host}", ` +
  `method="delegare", intent="charge", ` +
  `request="${base64EncodeChallenge(challenge)}"`
);
```

And accept MPP credentials:
```typescript
// Current (x402 only)
const xPayment = req.header('x-payment');

// MPP-compatible (both)
const xPayment = req.header('x-payment');
const authPayment = req.header('authorization')?.startsWith('Payment ')
  ? req.header('authorization').slice(8)
  : null;
const credential = xPayment || authPayment;
```

This is a small change to `@delegare/x402` — 2-3 hours. Makes Delegare work with
both x402 clients (ChatGPT, Coinbase x402 SDK) and MPP clients (Tempo wallet, future).

### Full MPP support (Phase 2):

- Payment sessions (streaming sub-cent payments for long-running agent tasks)
- RFC 9457 error format
- mpp.dev service registration
- `/.well-known/mpp.json`

---

## Recommended approach

**Phase 1 (now):** Add MPP header compatibility to `@delegare/x402` middleware.
Dual-mode: emit both `X-PAYMENT-REQUIRED` (x402) and `WWW-Authenticate: Payment` (MPP).
Accept both `X-PAYMENT` and `Authorization: Payment` credentials.
Zero breaking changes — existing x402 clients unaffected.

**Phase 2 (next sprint):** Add `/.well-known/mpp.json`, submit to mpp.dev registry,
implement MPP payment sessions for streaming use cases.

**Phase 3 (roadmap):** AP2 mandate as an MPP payment method — Tempo wallet can hold
an AP2 credential and present it as an MPP `Authorization: Payment` header.
This makes Delegare AP2 natively discoverable by any MPP client.

---

## TL;DR

Delegare is already x402-compatible and partially MPP-compatible (x402 is a subset of MPP).
Adding full MPP support is ~2-3 hours of header changes in `@delegare/x402`.
The strategic position is clear: MPP + AP2 = complete agentic payment stack.
Neither x402 (Coinbase) nor MPP (mpp.dev/Tempo) has identity/auth scoping.
That's the Delegare moat.
