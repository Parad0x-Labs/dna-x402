<p align="center"><img src=".github/readme/banner.svg" alt="DNA x402 — Pay-per-call payment rails for AI agents on Solana" width="100%"></p>

**DNA x402 is a pay-per-call payment rail on Solana for AI agents and the APIs they buy from.**

An agent asks for a resource, the API answers with a price, the agent pays in USDC, and the API serves the
response together with a signed receipt. No accounts, API keys or invoices sit between buyer and seller, and
every paid call leaves a receipt both sides can check later.

## At a glance

| **1,568** | **T1–T10** | **3 settlement modes** |
|---|---|---|
| x402 tests passing in the `mainnet-readiness` CI workflow, alongside site-agent Playwright tests (9/9) and Rust program tests | Devnet attack-replay suite: forged-authority and re-init attacks rejected with the expected program error, prefund grief absorbed; finding F1 recorded | Settle in USDC by on-chain transfer, Streamflow stream, or off-chain netting |

[![mainnet-readiness](https://img.shields.io/github/actions/workflow/status/Parad0x-Labs/dna-x402/security-scan.yml?branch=main&label=mainnet-readiness&style=flat&labelColor=0a0a0a)](https://github.com/Parad0x-Labs/dna-x402/actions/workflows/security-scan.yml)
[![x402 tests](https://img.shields.io/badge/x402_tests-1%2C568_passing-92aa7c?style=flat&color=92aa7c&labelColor=0a0a0a)](https://github.com/Parad0x-Labs/dna-x402/actions/workflows/security-scan.yml)
[![devnet attack-replay](https://img.shields.io/badge/devnet_attack--replay-T1--T10_pass-303030?style=flat&color=303030&labelColor=0a0a0a)](./devnet-tests/RESULTS.md)
![chain](https://img.shields.io/badge/chain-Solana-303030?style=flat&color=303030&labelColor=0a0a0a)
[![license](https://img.shields.io/badge/license-MIT-303030?style=flat&color=303030&labelColor=0a0a0a)](./LICENSE)

## How it works

DNA x402 follows the x402 pattern: HTTP status `402 Payment Required` carries a price quote, and the retried
request carries proof of payment. The whole loop is **quote, pay, verify, receipt**.

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#111111','primaryTextColor':'#f0efeb','primaryBorderColor':'#92aa7c','lineColor':'#a3a3a3','secondaryColor':'#0a0a0a','tertiaryColor':'#0a0a0a','fontFamily':'JetBrains Mono, monospace'}}}%%
sequenceDiagram
    participant A as AI agent (buyer)
    participant S as Paid API (seller)
    participant L as Solana (USDC)
    A->>S: Request a resource
    S-->>A: 402 Payment Required + price quote
    A->>L: Pay the quote in USDC
    A->>S: Retry with payment proof
    S->>L: Verify the payment settled
    S-->>A: 200 OK + response + signed receipt
```

- **Quote.** The seller names the price, the recipient wallet and an expiry.
- **Pay.** The buyer settles by USDC transfer or stream; trusted local setups can net many calls off-chain.
- **Verify.** The seller checks the amount, the mint and the recipient against the quote, and refuses any
  proof it has already seen.
- **Receipt.** The response carries an ed25519-signed receipt. Each receipt includes the hash of the one before
  it, so a seller's receipts form a tamper-evident chain.

## Quickstart

Run a paid API and a paying agent locally, with no wallet needed (Node.js 22):

```bash
git clone https://github.com/Parad0x-Labs/dna-x402
cd dna-x402/x402
npm ci --ignore-scripts
npm run build
node dist/cli.js demo seller --mode netting --port 3000
```

In a second terminal, from the same folder:

```bash
node dist/cli.js demo buyer --mode netting --base-url http://127.0.0.1:3000
```

The buyer calls three paid endpoints, answers each 402, and prints the receipts it collected. Run both
commands with `--mode transfer` or `--mode stream` to walk the other settlement paths (the demo wallet supplies
stand-in payment proofs, so no funds move). To build your own buyer (`fetchWith402`) or seller (`dnaSeller`),
start from [`x402/README.md`](./x402/README.md); agents should read [`x402/AGENTS.md`](./x402/AGENTS.md).

## Status

| Component | Status | Notes |
|---|---|---|
| `x402/` server, buyer and seller SDKs, CLI | `Usable today` | Transfer, stream and netting modes; 1,568 tests in CI |
| `/agent` front door ([`site-agent/`](./site-agent)) | `Usable today` | Onboarding and control-room UI; Playwright 9/9 in CI |
| Dark Null private receipt path (SDK) | `Usable today` | Optional hash-only request after a DNA receipt; fails closed without settlement evidence |
| NULL token | `Usable today` | Token-2022 mint on mainnet `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump`, fixed supply (mint and freeze authority revoked) |
| Security-fix program builds | `Devnet` | Attack-replay suite T1–T10 passes against five programs (2026-08-25); informational finding F1 recorded in [`devnet-tests/RESULTS.md`](./devnet-tests/RESULTS.md) |
| `receipt_anchor` (on-chain receipt anchoring) | `Built · redeploy pending` | Anchoring is unavailable until the redeploy under a fresh key; the client refuses with a clear error until then |
| Deploy-profile programs on devnet | `Built · redeploy pending` | The earlier devnet deployment is withdrawn; a redeploy under a fresh key is pending |
| Pay-by-name to a one-time stealth address | `Built · redeploy pending` | Implemented in code with tests; devnet redeploy under a fresh key pending |
| Mainnet pilot programs | `Retired (mainnet 2026, records readable)` | Ran from 2026-05-29, retired 2026-07-14 (ProgramData closed). No active DNA x402 mainnet deployment |
| Legacy `.null` registrar | `Retired (mainnet 2026, records readable)` | Ran June–August 2026; [`@parad0x_labs/null-mcp`](https://www.npmjs.com/package/@parad0x_labs/null-mcp) still resolves legacy records read-only |
| Frontier primitives | `Planned` | Ten research directions in [`docs/DARK_NULL_FRONTIER.md`](./docs/DARK_NULL_FRONTIER.md) |

Program-by-program detail, the deploy profiles and the pilot record are in
[`docs/PROJECT_DETAIL.md`](./docs/PROJECT_DETAIL.md).

## For developers

### Repo map

| Path | What lives there |
|---|---|
| [`x402/`](./x402) | The product: x402 server, buyer and seller SDKs, verifier, x402 Doctor diagnostics, CLI |
| [`packages/`](./packages) | Companion TypeScript packages: server-side 402 gate, spend-capped payer, receipt DAG, MCP server and more |
| [`programs/`](./programs) | Solana programs, including `receipt_anchor` and `x402_refund_escrow` |
| [`crates/`](./crates) | Rust primitives library: receipts, nullifiers, stealth addresses, shielded-pool tree (libraries, not deployed programs) |
| [`site-agent/`](./site-agent) | The `/agent` onboarding and control-room UI |
| [`examples/`](./examples) | Runnable buyer, seller, webhook and receipt-verifier examples |
| [`devnet-tests/`](./devnet-tests) | The devnet attack-replay suite and its recorded results |
| [`docs/`](./docs) | API reference, quickstarts, proof, deploy and design docs |

### Architecture

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#111111','primaryTextColor':'#f0efeb','primaryBorderColor':'#92aa7c','lineColor':'#a3a3a3','secondaryColor':'#0a0a0a','tertiaryColor':'#0a0a0a','fontFamily':'JetBrains Mono, monospace'}}}%%
flowchart LR
    subgraph TS[TypeScript]
        SA["site-agent/<br/>/agent front door"]
        X["x402/<br/>server, SDKs, CLI"]
        PK["packages/<br/>gate, payer, receipts"]
    end
    subgraph RS[Rust]
        PR["programs/<br/>Solana programs"]
        CR["crates/<br/>primitives library"]
    end
    SA -->|HTTP API| X
    PK -.->|same 402 flow| X
    X -->|receipt anchoring client| PR
    CR -->|linked into| PR
```

The hot path stays fast: no zero-knowledge proving happens per request. Privacy settlement is a separate
lane, [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol), reachable through the
optional Dark Null receipt path.

### Run the tests

These mirror the `mainnet-readiness` workflow:

```bash
npm --prefix x402 ci && npm --prefix x402 run build && npm --prefix x402 test
npm --prefix site-agent ci && npm --prefix site-agent exec -- playwright install chromium
npm --prefix site-agent test
cargo test --manifest-path programs/receipt_anchor/Cargo.toml
cargo test --manifest-path programs/x402_refund_escrow/Cargo.toml
```

The devnet attack-replay suite lives in [`devnet-tests/`](./devnet-tests) (`node devnet-tests/suite.ts`).

### Docs

| Read | For |
|---|---|
| [`docs/PROJECT_DETAIL.md`](./docs/PROJECT_DETAIL.md) | Full project detail: packages, deploy profiles, pilot record, frontier research, stack map |
| [`docs/API_REFERENCE.md`](./docs/API_REFERENCE.md) | HTTP API reference |
| [`docs/BUILDER_QUICKSTART.md`](./docs/BUILDER_QUICKSTART.md) · [`docs/AGENT_QUICKSTART.md`](./docs/AGENT_QUICKSTART.md) | Building a paid API or a paying agent |
| [`docs/X402_COMPAT.md`](./docs/X402_COMPAT.md) | Compatibility with other x402 dialects |
| [`docs/DARK_NULL_PRIVACY_PATH.md`](./docs/DARK_NULL_PRIVACY_PATH.md) | The optional private receipt path |
| [`docs/PUBLIC_FRONTIER_WORKSPACE.md`](./docs/PUBLIC_FRONTIER_WORKSPACE.md) | Inventory of the Rust workspace |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Deploy profiles and scripts |

Related public repos: [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) (privacy
settlement), [`vool`](https://github.com/Parad0x-Labs/vool) (local-first AI runtime),
[`liquefy-openclaw-integration`](https://github.com/Parad0x-Labs/liquefy-openclaw-integration) (Solana-anchored
audit trails).

## Security

Payment gates verify ed25519 payer signatures, treat every payment proof as single-use, and check amount, mint
and recipient before unlocking a resource; server-side callbacks reject loopback and private-range targets.
CI runs a secret and path scan plus dependency checks on every push. To report a vulnerability, follow
[`SECURITY.md`](./SECURITY.md) and keep exploit details out of public issues.

MIT licensed. Parad0x Labs · [parad0xlabs.com](https://parad0xlabs.com)
