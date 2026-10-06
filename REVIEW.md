# Review guide: dna-x402

A short reading path for people and AI reviewers. It says what this repository contains, what has been
demonstrated, where it runs, and what is not established. The capability table is generated from
[`evidence/claims.json`](./evidence/claims.json) and checked in CI by
[`scripts/check-claims-registry.mjs`](./scripts/check-claims-registry.mjs).

| Snapshot | |
|---|---|
| Commit checked | `8743fd7f3e5d4ee3150cda25d2544e706661c1da` (`main`, observed 2026-10-06 08:23 UTC) |
| npm registry checked | 2026-10-06 08:23 UTC |
| Devnet checked | 2026-10-06 08:26 UTC |

Read in this order: this page, then [`docs/DARK_CRATES_STATUS.md`](./docs/DARK_CRATES_STATUS.md) for the
Rust library, then the source paths named in the table. Package publication, Git source and deployments
are recorded separately; a version in `package.json` is not proof of an npm release.

## What it is

An x402 payment rail for AI agents on Solana: a seller answers `402 Payment Required` with a quote, the buyer
pays in USDC, the seller verifies the payment by RPC and returns the resource with an Ed25519-signed receipt.
The repository also holds companion TypeScript packages, 28 Solana programs and a large Rust crate library of
uneven maturity.

## Component boundaries

| Component | Path | What it is | Runs where |
|---|---|---|---|
| x402 server, SDKs, CLI | `x402/` | The product. Quote, verify, receipt | Your server; Solana RPC for verification |
| liquefy-receipts | `packages/liquefy-receipts/` | Off-chain library: compress, encrypt, net, Merkle-commit receipt batches | Local; produces anchor instruction bytes only |
| Other packages | `packages/*` | Companion libraries; publication varies per package | Local |
| Programs | `programs/` (28) | Native Solana programs; 21 deployed on devnet on 2026-10-06 | Devnet |
| Rust crates | `crates/` (332) | Library crates; most model flows with SHA-256 | Not deployed |
| Context Capsule | `packages/context-capsule/` | Lossless archive, prompt pointer, caller-invoked retrieval; see [`docs/CONTEXT_CAPSULE_DATAFLOW.md`](./docs/CONTEXT_CAPSULE_DATAFLOW.md) | Local |
| Dark Null privacy pool | separate repository [`Dark-Null-Protocol`](https://github.com/Parad0x-Labs/Dark-Null-Protocol) | Anchor program `35GMe13…` with its own Groth16 verifier. No Rust dependency in either direction | Devnet |
| OpenClaw skills, Liquefy vault | separate repository [`openclaw-skills`](https://github.com/Parad0x-Labs/openclaw-skills) | Agent skills and the Python vault appliance | Local |

## Capability table

Columns: **Exists in source** is the implementation status and main path at the snapshot commit.
**Demonstrated** is what code or a recorded run shows. **Where it runs** names the network for anything
deployed. **Not established** lists what a reader should not infer.

<!-- claims-table:start (generated from evidence/claims.json; edit the registry, then run scripts/check-claims-registry.mjs --write) -->
| ID | Capability | Exists in source | Demonstrated | Where it runs | Not established |
|---|---|---|---|---|---|
| `x402.transfer-verification` | In transfer mode the x402 server verifies an SPL token payment on-chain before serving the resource. | implemented: `x402/src/paymentVerifier.ts` | transaction must exist without error at the configured commitment (default confirmed; finalized can be required); recipient balance increase for the quoted mint must cover the quote total; payment proof older than 900 s is refused; a reused proof is refused within one running process (test: partial 2026-10-06) | local / off-chain; `@parad0x_labs/x402` git 0.2.0, npm 0.1.1 | replay rejection across restarts or instances (ReplayStore is an in-process Map even when a database URL is set); binding of the payment to the quote nonce unless REQUIRE_PAYMENT_MEMO is enabled (off by default); binding of the transaction sender to the buyer; native SOL payments |
| `x402.signed-receipts` | Every paid response carries an Ed25519-signed receipt that links to the previous receipt hash. | implemented: `x402/src/receipts.ts` | signature over sha256(JSON of prevHash and payload); per-signer hash chain via prevHash (test: partial 2026-10-06) | local / off-chain | that the served content is correct; a receipt attests what the seller signed; stable key ordering: JSON.stringify does not sort keys; a persistent signing key in the SDK seller and paywall, which generate an ephemeral key when none is supplied |
| `x402.netting-ledger` | Netting mode records per payer-provider charges in an off-chain ledger for development use. | prototype: `x402/src/nettingLedger.ts` | sums payer to provider totals and fees; refused unless UNSAFE_UNVERIFIED_NETTING_ENABLED=1, which the server rejects when NODE_ENV=production (test: partial 2026-10-06) | local / off-chain | offsetting obligations in the reverse direction; any verification of the netting claim; a production guard in the SDK seller and paywall; netting off by default in the init seller starter (it is on unless DNA_TRUSTED_LOCAL_NETTING=0) |
| `x402.net-settlement` | Net obligations computed by netting are discharged by an on-chain payment. | missing: `x402/src/server.ts` | none recorded | n/a (not implemented) | POST /settlements/flush returns and clears due totals as JSON; no code builds or sends a transfer for them |
| `x402.stream-verification` | Stream mode accepts a Streamflow stream as payment when the seller verifies it. | prototype: `x402/src/verifier/streamflow.ts` | checks mint, recipient, open stream and remaining deposit against the quote (SDK, when a streamflowClient is passed) (test: partial 2026-10-06) | local / off-chain | stream payments through the bundled x402 server, which advertises stream mode but passes no Streamflow client, so stream proofs are refused; protection against the sender cancelling the stream (streams are created cancelable by sender) |
| `x402.refund-escrow` | A refund-escrow program holds a SOL bond and releases it on a signed receipt or refunds on timeout. | prototype: `programs/x402_refund_escrow/src/processor.rs` | instructions: OpenEscrow, PostBond, SettleSuccess (ed25519 receipt via instructions sysvar), RefundOnTimeout, ProveEquivocation, CloseAfterDispute | local / off-chain | any deployment (not part of the 2026-10-06 devnet set); a TypeScript client or use in the x402 payment flow; USDC or other SPL tokens (lamports only) |
| `x402.receipt-anchoring` | Receipt anchoring is opt-in and refuses to run unless the operator names a receipt_anchor deployment. | implemented: `x402/src/onchain/receiptAnchorClient.ts` | server anchoring needs ANCHORING_ENABLED, RECEIPT_ANCHOR_PROGRAM_ID and ANCHORING_KEYPAIR_PATH (all unset by default); liquefy-receipts 0.3.0 has no default program and throws RECEIPT_ANCHOR_UNAVAILABLE; deployed devnet bytes match the 2026-10-06 build output (test: pending) | devnet `HSdE…mhXs` | that one anchor proves a single receipt: the program folds each 32-byte value into an hourly hash chain (root = sha256(prev_root \|\| value)); inclusion needs the ordered list of anchors in that bucket; that the receipt hash is anchored: the server anchors the commit's payer commitment; a deployment configured as default in source (none, by design) |
| `x402.mainnet-pilot` | A DNA x402 mainnet pilot ran from 2026-05-29 and was retired on 2026-07-14. | retired: `evidence/mainnet/programs.json` | receipt_anchor program account reported closed by mainnet RPC on 2026-10-06 | mainnet-beta `6HSR…CMRN` | any active DNA x402 mainnet deployment |
| `liquefy-receipts.compression` | liquefy-receipts compresses a receipt batch with a columnar transform and DEFLATE. | implemented: `packages/liquefy-receipts/src/compress.ts` | delta, dictionary and raw-string column encodings, DEFLATE per column; test asserts a ratio above 10x (test: pass 2026-10-06) | local / off-chain; `@parad0x_labs/liquefy-receipts` git 0.3.0, npm 0.2.0 | lossless round trip for every receipt shape: non-integer numbers throw, bigint above 2^53 loses precision, null becomes 0 or empty string, keys missing from some rows are added; the README figure of 62x (no committed measurement); a ratio on real production receipts |
| `liquefy-receipts.encryption` | liquefy-receipts can encrypt a compressed batch with AES-256-GCM under a caller-supplied key. | implemented: `packages/liquefy-receipts/src/encrypt.ts` | AES-256-GCM via WebCrypto with a random 12-byte nonce; opt-in (caller calls encryptBlob) (test: pass 2026-10-06) | local / off-chain | key agreement between counterparties; the README example, which passes raw key bytes where a CryptoKey is required |
| `liquefy-receipts.merkle-commitment` | liquefy-receipts reduces a receipt batch of any size to a 32-byte SHA-256 Merkle root. | implemented: `packages/liquefy-receipts/src/merkle.ts` | RFC 6962 style leaf/node prefixes; optional salted leaves derived with HKDF from a batch secret; 34-byte anchor instruction data for one 32-byte commitment (test: pass 2026-10-06) | local / off-chain | storage of receipts on-chain: the 32-byte root is a commitment; receipt data stays off-chain with the caller; that this SHA-256 root is the root a Groth16 circuit proves against (the ZK path uses a separate Poseidon root); Arweave archiving: archiveReceipts is not exported and fails at runtime |
| `liquefy-receipts.bilateral-netting` | liquefy-receipts computes one net balance per counterparty pair from a list of receipts. | implemented: `packages/liquefy-receipts/src/net.ts` | pure arithmetic: gross flows per ordered pair netted against the reverse direction (test: pass 2026-10-06) | local / off-chain | signatures or counterparty agreement on the result; multilateral netting; the README figure of about 4,950 settlements for 1M receipts (that is N(N-1)/2 for 100 agents, not a measurement) |
| `liquefy-receipts.onchain-settlement` | liquefy-receipts settles netted receipt obligations on-chain. | missing: `packages/liquefy-receipts/src/index.ts` | none recorded | n/a (not implemented) | any token movement: the package builds anchor instruction bytes and sends nothing; no custody, collateral or finality rules exist |
| `programs.devnet-set-2026-10-06` | 21 of the 28 programs in programs/ are deployed on devnet under one upgrade authority as of 2026-10-06. | prototype: `programs` | each program account exists on devnet and its deployed bytes match the 2026-10-06 build output (per-program SHA-256 in the proof file) (test: pending) | devnet (21 programs) | reproducible build from a public commit: the build used program-ID constants and a devnet cargo feature not committed at the snapshot; instruction-level behaviour on devnet for this deployment (results pending); mainnet deployment |
| `programs.dark-shielded-pool` | The dark_shielded_pool program verifies a Groth16 withdraw proof over the alt_bn128 syscalls. | prototype: `programs/dark_shielded_pool/src/processor.rs` | Groth16 pairing check wired through dark-groth16-core in source; historical: 2026-06-09 devnet run (v2 circuit, program since closed) with valid withdraw and double-spend, wrong-root and wrong-recipient rejections (test: pending) | devnet `FmLW…BSZ3` | withdrawals from a build of this commit: the mainnet_ready guard is active and Cargo.toml declares no devnet feature, so every proof is refused; a multi-party trusted setup; that this program shares code or a deployment with Dark-Null-Protocol (it does not) |
| `crates.dark-library` | The crates/ library holds 332 Rust crates; most model flows with SHA-256 and only a listed subset call real cryptographic dependencies. | scaffold: `crates` | real dependencies in the subset listed in docs/DARK_CRATES_STATUS.md (alt_bn128, light-poseidon, curve25519-dalek, ed25519-dalek, hmac) | local / off-chain | that a crate name describes a working primitive; check its row in docs/DARK_CRATES_STATUS.md; use by any deployed program for most crates |
| `context-capsule.dataflow` | Context Capsule stores session history as a lossless zlib archive, gives the model a short pointer, and returns matching messages only when the caller runs a keyword search. | implemented: `packages/context-capsule/src/index.ts` | zlib level 9 archive of the JSONL history, lossless (3.1x on the bundled 109-message fixture); initial prompt pointer of about 53 estimated tokens versus 7,919 for the full fixture (retrieval not counted); deterministic topic extraction; no model call; searchCapsule decompresses and keyword-matches; the caller must invoke it | local / off-chain; `@parad0x_labs/context-capsule` git 1.1.0, npm 1.0.0 | end-to-end task token or cost savings; the earlier unqualified 83x and 98% figures; that the model can use details it was not given (omitted history must be retrieved and placed in the prompt); npm publication of 1.1.0 (npm latest is 1.0.0) |
<!-- claims-table:end -->

## x402 payment modes, as implemented

| Mode | Default | What the code does | What it does not do |
|---|---|---|---|
| Transfer verification | On (transfer mode) | RPC check of an SPL transfer: status, commitment (confirmed by default, finalized optional), mint, recipient balance change, 900 s age limit | Durable replay store (in-process only); quote-nonce memo binding unless `REQUIRE_PAYMENT_MEMO`; sender binding |
| Signed receipts | On | Ed25519 over sha256 of `{prevHash, payload}`; per-signer hash chain | Attest correctness of the served content |
| Netting calculation | Off; dev-only flag | Sums payer to provider charges in an off-chain ledger, accepted without verification | Reverse-direction offsetting; any payment |
| Net-obligation settlement | Not implemented | `/settlements/flush` returns and clears totals as JSON | Move funds. There is no clearinghouse, custody or collateral |
| Streaming | Verifier exists | Checks a Streamflow stream when a Streamflow client is supplied (SDK) | Work in the bundled server, which supplies no client |
| Refund escrow | Not wired | `programs/x402_refund_escrow`: SOL bond, receipt-based release, timeout refund | Deployment, TypeScript client, SPL tokens |
| Anchoring | Off; opt-in | Folds a 32-byte value into an hourly on-chain hash chain in `receipt_anchor`. Refuses to run without an operator-named program | Store receipts on-chain; prove a single receipt without the bucket's ordered anchors |

## Liquefy Receipts (`packages/liquefy-receipts`)

Five separate things, often described together:

1. **Compression**: columnar transform plus DEFLATE. 66x and 83x are recorded on synthetic batches in
   [`evidence/demo/`](./evidence/demo); round-trip is exact only for integer and string fields present on every receipt.
2. **Encryption**: AES-256-GCM with a key the caller manages; opt-in; no key exchange.
3. **Merkle commitment**: a 32-byte SHA-256 root for a batch of any size. The root commits to the receipts;
   it does not contain them. Receipt data stays off-chain.
4. **Bilateral netting**: arithmetic producing one net balance per counterparty pair. Not signed, not
   enforced.
5. **On-chain settlement**: none. The package builds anchor instruction bytes and sends nothing.
   Anchoring has no default program in 0.3.0 (Git) and fails closed; npm `latest` is still 0.2.0.

## Deployments

- **Devnet, 2026-10-06**: 21 programs under one upgrade authority. IDs, slots and deployed-bytes SHA-256 in
  [`evidence/devnet-programs-2026-10-06.json`](./evidence/devnet-programs-2026-10-06.json). Instruction-level
  test results for this deployment are pending. The build used program-ID constants and a `devnet` feature
  not yet committed at the snapshot, so it is not reproducible from a public commit yet.
- **Mainnet**: none active. The mainnet pilot (2026-05-29 to 2026-07-14) is retired; its programs are closed.
- Earlier devnet program IDs in older docs and evidence files are retired.

## Reproduce

```bash
git clone https://github.com/Parad0x-Labs/dna-x402 && cd dna-x402
node scripts/check-claims-registry.mjs                       # registry and this table

npm --prefix x402 ci --ignore-scripts
npm --prefix x402 run build && npm --prefix x402 test       # 1,576 tests; 3 need git, python3 and cargo

npm --prefix packages/liquefy-receipts install --ignore-scripts
npm --prefix packages/liquefy-receipts test                  # 48 tests

cargo test --manifest-path programs/receipt_anchor/Cargo.toml
cargo test --manifest-path programs/x402_refund_escrow/Cargo.toml

solana program show HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs --url devnet   # one of the 21
```

A green CI run shows the tests pass at a commit. It is not an external security review, and no external
security review of this repository is claimed.
