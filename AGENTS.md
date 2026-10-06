# AGENTS.md

Build and test guidance for coding agents working in this repository.

## Review path

Read [REVIEW.md](./REVIEW.md) first when you need to know what each component does, what has been
demonstrated, and where it runs. The machine-readable source for that table is
[`evidence/claims.json`](./evidence/claims.json). If you change a capability, a package version or a
deployment, update the registry in the same change and run:

```bash
node scripts/check-claims-registry.mjs          # validate the registry and the REVIEW.md table
node scripts/check-claims-registry.mjs --write  # regenerate the REVIEW.md table after editing the registry
```

## Layout

| Path | Contents |
|---|---|
| `x402/` | `@parad0x_labs/x402`: server, buyer and seller SDKs, verifier, CLI. Its own guide is [`x402/AGENTS.md`](./x402/AGENTS.md) |
| `packages/` | Companion TypeScript packages (each has its own `package.json` and tests) |
| `programs/` | Solana programs (Rust) |
| `crates/` | Rust library crates. Maturity varies by crate; see [`docs/DARK_CRATES_STATUS.md`](./docs/DARK_CRATES_STATUS.md) |
| `site-agent/`, `site/` | Web front ends |
| `devnet-tests/` | Devnet attack-replay suite |

## Build and test

Node.js 22. Install with lifecycle scripts disabled.

```bash
npm --prefix x402 ci --ignore-scripts
npm --prefix x402 run build
npm --prefix x402 test

# packages/* have no lockfile: install inside a disposable container, scripts disabled
npm --prefix packages/liquefy-receipts install --ignore-scripts
npm --prefix packages/liquefy-receipts test

cargo test --manifest-path programs/receipt_anchor/Cargo.toml
cargo test --manifest-path programs/x402_refund_escrow/Cargo.toml
```

## Rules for changes

- Program IDs come from configuration (`configs/`, environment variables); do not hardcode new ones.
- Receipt anchoring must stay fail-closed: with no `RECEIPT_ANCHOR_PROGRAM_ID` configured, anchoring
  refuses with an error instead of falling back to a default deployment.
- Do not describe a crate as a working primitive unless its cryptographic operation is implemented and
  tested; record the status in `docs/DARK_CRATES_STATUS.md`.
- Keep Git version and npm publication separate: a version bump in `package.json` is not a release.
