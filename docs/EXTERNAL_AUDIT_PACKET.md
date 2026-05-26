# External Audit Packet

This packet is the handoff scope for an independent security review before broad public mainnet promotion.

## Scope

- `x402/src/server.ts`: quote, commit, finalize, receipt, anchoring, admin, and market mounting.
- `x402/src/client.ts`: buyer-side 402 flow, receipt verification, spend limits, market selection.
- `x402/src/sdk/seller.ts` and `x402/src/sdk/paywall.ts`: seller/paywall middleware.
- `x402/src/paymentVerifier.ts` and `x402/src/verifier/*`: Solana transfer, stream, replay, mint, recipient, amount, and age verification.
- `x402/src/receipts.ts`: receipt signing, receipt hash chain, request/response digest binding.
- `x402/src/market/*`: public shop registration, quote signing, order execution, abuse reporting, policy blocks.
- `programs/receipt_anchor`: Solana receipt anchoring program.
- `x402/test-mainnet/*`: mainnet proof scripts, key bootstrap, mayhem, recovery, report validation.
- `x402/sdk/python` and `x402/sdk/rust`: native receipt verification helpers.

## Required Audit Questions

- Can a buyer reuse one payment proof to unlock multiple paid resources?
- Can a stale, wrong-mint, wrong-recipient, underpaid, or unconfirmed transfer finalize?
- Can a receipt be forged, rebound to a different response, or accepted with a broken signature?
- Can public market registration bypass denylist/category policy?
- Can admin routes, settlement flush, pause controls, or audit exports be used without `ADMIN_SECRET` on mainnet?
- Can mainnet boot with devnet mints, test fixtures, unsafe netting, missing anchoring, or missing secrets?
- Can an interrupted mayhem run leak burner SOL/USDC?
- Can Python/Rust/JS clients independently verify the same receipt format?
- Can Solana RPC 429s or partial failures produce false-positive proof reports?

## Local Commands

Run from `<repo-root>` with G-local caches and tool paths.

```powershell
$env:npm_config_cache='<repo-root>\.npm-cache'
$env:CARGO_HOME='<repo-root>\.tools\rustup\cargo'
$env:RUSTUP_HOME='<repo-root>\.tools\rustup\rustup-home'
$env:PATH='<repo-root>\.tools\rustup\cargo\bin;' + $env:PATH

git diff --check
npm --prefix x402 run build
npm --prefix x402 test
npm --prefix x402 run test:polyglot
npm --prefix x402 run test:sdk:python
npm --prefix x402 run test:sdk:rust
npm --prefix x402 audit --audit-level=high
npm --prefix x402 run security:scan
npm --prefix site-agent run build
npm --prefix site-agent test -- --reporter=line
npm --prefix site-agent audit --audit-level=high
npm --prefix site run build
cargo test --manifest-path programs\receipt_anchor\Cargo.toml
```

## Mainnet Evidence

Latest mainnet mayhem evidence should include:

- report markdown
- structured JSON data
- independent post-run tx validation log
- transfer tx signatures
- anchor tx signatures
- drain tx signatures
- zero burner residuals
- no `/tx/undefined` links

Current local report location:

```text
<repo-root>\reports\mainnet-readiness-20260514\live-mayhem-run-3
```

## Devnet Blocker

The devnet gate requires devnet SOL in:

```text
6YKdtRvLFCvvRmMt7PAQ59gQ1xAYEViByYHayjdU8eYG
```

If the public faucet is rate-limited, fund this key manually and rerun:

```powershell
$env:GAUNTLET_FUNDER_KEYPAIR='<repo-root>\x402\test-mainnet\keys\devnet\deployer.json'
npm --prefix x402 run gauntlet:devnet:20 -- --out "<repo-root>\reports\devnet-gauntlet-20"
```

## Acceptance Standard

Release is acceptable only when:

- all local gates above pass;
- mainnet mayhem report is fresh and independently validated;
- no critical/high dependency audit findings exist;
- no key material or env secrets are tracked;
- public market policy blocks regulated wagering/gambling listings by default;
- independent audit findings are either fixed or accepted in writing by the maintainer.
