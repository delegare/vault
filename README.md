# Delegare Vault

Delegare Vault is the payment-authorization service behind [Delegare](https://delegare.dev).
It issues bounded spending mandates for AI agents and settles those mandates on
two rails: USDC on Base (x402 / EIP-3009) and fiat card-on-file (Stripe).

Agents hold a signed intent mandate. They do not hold buyer cards or private keys.

The published client SDKs live in [delegare/delegare](https://github.com/delegare/delegare).
This tree is the vault service, the merchant and buyer dashboards, the market
app, and the on-chain router.

## License

[MIT](LICENSE). Copyright (c) 2026 delegare. This is the same license as the
public SDK repository. Do not relicense contributions.

## What is not in this tree

Deployment internals stay out of the source tree:

- CDK application, synthesized assets, and `cdk.context.json`
- Deploy workflows and cloud account identifiers
- Local secret-upload or token-verification scripts
- Foundry build cache

Configure keys, webhook secrets, and relayer keys through environment variables
or a secret manager. Never commit them. See [SECURITY.md](SECURITY.md).

## Layout

| Path | Role |
| --- | --- |
| `src/` | Vault HTTP service (mandates, charges, x402, webhooks) |
| `apps/dashboard/` | Merchant and buyer dashboard |
| `apps/market/` | Agentic service directory |
| `packages/mcp-server/` | MCP server and widgets |
| `packages/contracts/` | `DelegareRouter` (Solidity, Foundry) |
| `docs/` | Product notes for discovery, ramps, and the market |

## Develop

Requirements: Node.js 24 or newer, pnpm 10.28.0.

```bash
pnpm install
pnpm test
pnpm lint
```

`pnpm dev` starts the vault from `src/app.ts`. The service expects its signing
keys, Stripe credentials, and chain configuration from the environment. Copy
nothing from a live deployment into the repo.

Contract builds use Foundry. `packages/contracts/lib/forge-std` is a submodule:

```bash
git submodule update --init --recursive
cd packages/contracts && forge build
```

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).
