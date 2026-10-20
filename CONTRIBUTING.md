# Contributing to Delegare Vault

Thanks for helping improve Delegare. This repository is the vault service.
Client SDKs are developed in [delegare/delegare](https://github.com/delegare/delegare).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), the same license as the rest of this tree and the
public Delegare SDK. Do not add a different license header that contradicts MIT.

## Setup

- Node.js 24 or newer
- pnpm 10.28.0 (`corepack enable && corepack prepare pnpm@10.28.0 --activate`)
- Foundry, only if you change `packages/contracts`

```bash
pnpm install
pnpm test
pnpm lint
```

`pnpm lint` is `tsc --noEmit`.

## Pull requests

- Open a focused pull request against the default branch.
- Describe the behavior change and how you tested it.
- Keep commits free of generated install output, Playwright reports, and
  Foundry cache.
- Do not commit `.env` files, API keys, JWTs, private keys, webhook secrets,
  relayer keys, or cloud account identifiers. Tests must use obviously fake
  values such as `example-hmac-secret-do-not-use-000000000000` or
  `dk_live_oss_example_not_a_secret`.

## Secrets in tests

If a test needs a digest, derive it in the test from the fake input. Do not
paste a live key or a captured production token and hash it.

## Contracts

Router changes belong in `packages/contracts/src`. Run `forge test` from that
package. Deployment keys are read from the environment at deploy time. Do not
hardcode them in `script/` or broadcast a key into the repository.

## Security issues

Do not file a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
