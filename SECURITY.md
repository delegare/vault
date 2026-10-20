# Security Policy

Delegare Vault issues spending mandates and settles agent payments. A flaw here
can expose mandates, buyer or merchant credentials, or funds. Reports are
triaged privately.

## Supported versions

Security fixes target the current tree of this service and the production
facilitator. Older snapshots are not patched independently.

| Component | Supported |
| --- | --- |
| This vault service | Current source |
| `api.delegare.dev` | Production |
| Published SDKs (`@delegare/sdk`, `@delegare/x402`, and the packages listed in [delegare/delegare](https://github.com/delegare/delegare)) | Latest minor, per that repository's security policy |

## Reporting a vulnerability

Do not open a public GitHub issue for a vulnerability. Report privately via
one of the channels below:

- **Preferred:** GitHub Private Vulnerability Reporting
  → https://github.com/delegare/vault/security/advisories/new
  (or https://github.com/delegare/delegare/security/advisories/new for SDKs)
- **Email:** `security@securelend.ai` (PGP available on request)

Include what you can:

- Affected component (vault route, package and version, or facilitator endpoint)
- Reproduction steps or a proof of concept
- Impact (data exposed, funds at risk, who is affected)
- A suggested fix, if you have one

If you do not hear back within 48 hours, re-send the email with subject prefix
`[ESCALATE]`.

## Response targets

| Stage | Target |
| --- | --- |
| Acknowledgement | 48 hours |
| Initial triage | 5 business days |
| Critical severity patch | 7 days |
| High severity patch | 30 days |
| Medium or low severity patch | Next scheduled release |

Patches ship before vulnerability details are disclosed. Reporters are credited
in the advisory unless they opt out. There is no monetary bug bounty today.

## In scope

- Mandate issuance, verification, and revocation
- x402 verify and settle, including receipt binding
- Merchant authentication and API keys
- Dashboard and market apps in this tree
- `DelegareRouter` authorization checks
- `api.delegare.dev` and the sandbox facilitator

## Out of scope

- Third-party dependencies. Report those upstream and tell us so we can pin a fix.
- Issues that need physical access to a buyer's device, or social engineering of a wallet provider
- Volumetric denial of service
- Scanner output with no working proof of concept
- Cloud account layout and deployment configuration, which are intentionally not in this tree

## Handling secrets

Signing keys, relayer keys, Stripe secrets, and session keys are not source.
Load them from the environment or a secret manager. If you find key material,
a live JWT, or a cloud account identifier in this tree, report it through the
channel above and do not open a pull request that copies the value.

## Cryptography

- Mandates are signed with ES256. Production verification keys are published at
  https://api.delegare.dev/.well-known/jwks.json.
- On-chain settlement uses USDC EIP-3009 `receiveWithAuthorization` on Base.
  The facilitator signs the relayer transaction. It does not custody buyer or
  merchant keys.
- Fiat fallback uses Stripe Connect. Stripe holds card data and KYC.
