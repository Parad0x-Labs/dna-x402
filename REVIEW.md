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
| Local fixes after the snapshot | `e45f173` (2026-10-06, not yet on GitHub): durable replay store, quote binding on by default, netting off in the starter, no default anchor program, HMAC blind oracle. Claims that cite it say so in `source_sha` |
| Devnet evidence after the snapshot | `9ff95ee` (2026-10-06, not yet on GitHub): program-ID binding (`121109d`), five program fixes upgraded in place, regenerated v3 ceremony, test runs in [`evidence/devnet-2026-10-06/`](./evidence/devnet-2026-10-06/README.md). Devnet re-read 2026-10-06 10:12 UTC |

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
| Programs | `programs/` (28) | Native Solana programs; 21 deployed on devnet on 2026-10-06 and exercised by recorded test runs | Devnet |
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
| `x402.transfer-verification` | In transfer mode the x402 server verifies an SPL token payment on-chain before serving the resource. | implemented: `x402/src/paymentVerifier.ts` | transaction must exist without error at the configured commitment (default confirmed; finalized can be required); recipient balance increase for the quoted mint must cover the quote total; payment proof older than 900 s is refused; an SPL Memo equal to the quote's memoHash is required by default (REQUIRE_PAYMENT_MEMO, explicit opt-out), binding the transfer to one quote; replay keys are stored in Postgres when X402_DATABASE_URL or DATABASE_URL is set; a proof used before a restart is refused after it (live Postgres test); header-compat requirements are accepted only when they match an unexpired quote this server issued for the resource (test: pass 2026-10-06) | local / off-chain; `@parad0x_labs/x402` git 0.2.1, npm 0.2.0 | replay protection across restarts without a database: the store is then in-process only (warning at start; refused when NODE_ENV=production); quote binding when the operator sets REQUIRE_PAYMENT_MEMO=0; binding of the transaction sender to the buyer; native SOL payments |
| `x402.signed-receipts` | Every paid response carries an Ed25519-signed receipt that links to the previous receipt hash. | implemented: `x402/src/receipts.ts` | signature over sha256(JSON of prevHash and payload); per-signer hash chain via prevHash (test: partial 2026-10-06) | local / off-chain | that the served content is correct; a receipt attests what the seller signed; stable key ordering: JSON.stringify does not sort keys; a persistent signing key in the SDK seller and paywall, which generate an ephemeral key when none is supplied |
| `x402.netting-ledger` | Netting mode records per payer-provider charges in an off-chain ledger for development use. | prototype: `x402/src/nettingLedger.ts` | sums payer to provider totals and fees; refused unless UNSAFE_UNVERIFIED_NETTING_ENABLED=1, which the server rejects when NODE_ENV=production; dnaSeller and dnaPaywall refuse unsafeUnverifiedNettingEnabled when NODE_ENV=production; the init seller starter leaves netting off unless DNA_TRUSTED_LOCAL_NETTING=1 and labels it development-only (test: pass 2026-10-06) | local / off-chain | offsetting obligations in the reverse direction; any verification of the netting claim |
| `x402.net-settlement` | Net obligations computed by netting are discharged by an on-chain payment. | missing: `x402/src/server.ts` | none recorded | n/a (not implemented) | POST /settlements/flush returns and clears due totals as JSON; no code builds or sends a transfer for them |
| `x402.stream-verification` | Stream mode accepts a Streamflow stream as payment when the seller verifies it. | prototype: `x402/src/verifier/streamflow.ts` | checks mint, recipient, open stream and remaining deposit against the quote (SDK, when a streamflowClient is passed) (test: partial 2026-10-06) | local / off-chain | stream payments through the bundled x402 server, which advertises stream mode but passes no Streamflow client, so stream proofs are refused; protection against the sender cancelling the stream (streams are created cancelable by sender) |
| `x402.refund-escrow` | A refund-escrow program holds a SOL bond and releases it on a signed receipt or refunds on timeout. | prototype: `programs/x402_refund_escrow/src/processor.rs` | instructions: OpenEscrow, PostBond, SettleSuccess (ed25519 receipt via instructions sysvar), RefundOnTimeout, ProveEquivocation, CloseAfterDispute | local / off-chain | any deployment (not part of the 2026-10-06 devnet set); a TypeScript client or use in the x402 payment flow; USDC or other SPL tokens (lamports only) |
| `x402.receipt-anchoring` | Receipt anchoring is opt-in and refuses to run unless the operator names a receipt_anchor deployment. | implemented: `x402/src/onchain/receiptAnchorClient.ts` | server anchoring needs ANCHORING_ENABLED, RECEIPT_ANCHOR_PROGRAM_ID and ANCHORING_KEYPAIR_PATH (all unset by default); with ANCHORING_ENABLED set, a missing program id or keypair, or an anchor client that cannot be built, stops server start-up with RECEIPT_ANCHOR_UNAVAILABLE (x402 test, 2026-10-06); the x402 transaction builders have no default program id and throw RECEIPT_ANCHOR_UNAVAILABLE without one; liquefy-receipts 0.3.x has no default program and throws RECEIPT_ANCHOR_UNAVAILABLE; wormhole-x402 resolves devnet to HSdE…mhXs and refuses mainnet-beta (no configured program); a receipt-dag root anchored on devnet HSdE…mhXs on 2026-10-06 and was read back by the accountability and proof-of-agency verifiers; deployed devnet bytes equal the build of committed source 121109d (SHA-256 in the proof file) (test: pass 2026-10-06) | devnet `HSdE…mhXs` | that one anchor proves a single receipt: the program folds each 32-byte value into an hourly hash chain (root = sha256(prev_root \|\| value)); inclusion needs the ordered list of anchors in that bucket; that the receipt hash is anchored: the server anchors the commit's payer commitment; a deployment configured as default in source (none, by design) |
| `x402.mainnet-pilot` | A DNA x402 mainnet pilot ran from 2026-05-29 and was retired on 2026-07-14. | retired: `evidence/mainnet/programs.json` | receipt_anchor program account reported closed by mainnet RPC on 2026-10-06 | mainnet-beta `6HSR…CMRN` | any active DNA x402 mainnet deployment |
| `liquefy-receipts.compression` | liquefy-receipts compresses a receipt batch with a columnar transform and DEFLATE. | implemented: `packages/liquefy-receipts/src/compress.ts` | delta, dictionary and raw-string column encodings, DEFLATE per column; test asserts a ratio above 10x; the run prints 66.1x (1,000 receipts) and 62.4x (500) on the package's synthetic batches, as the README now states (test: pass 2026-10-06) | local / off-chain; `@parad0x_labs/liquefy-receipts` git 0.3.1, npm 0.3.0 | lossless round trip for every receipt shape: non-integer numbers throw, bigint above 2^53 loses precision, null becomes 0 or empty string, keys missing from some rows are added; a ratio on real production receipts |
| `liquefy-receipts.encryption` | liquefy-receipts can encrypt a compressed batch with AES-256-GCM under a caller-supplied key. | implemented: `packages/liquefy-receipts/src/encrypt.ts` | AES-256-GCM via WebCrypto with a random 12-byte nonce; opt-in (caller calls encryptBlob); the README example converts the generated raw key with importKey before encryptBlob (test: pass 2026-10-06) | local / off-chain | key agreement between counterparties |
| `liquefy-receipts.merkle-commitment` | liquefy-receipts reduces a receipt batch of any size to a 32-byte SHA-256 Merkle root. | implemented: `packages/liquefy-receipts/src/merkle.ts` | RFC 6962 style leaf/node prefixes; optional salted leaves derived with HKDF from a batch secret; 34-byte anchor instruction data for one 32-byte commitment (test: pass 2026-10-06) | local / off-chain | storage of receipts on-chain: the 32-byte root is a commitment; receipt data stays off-chain with the caller; that this SHA-256 root is the root a Groth16 circuit proves against (the ZK path uses a separate Poseidon root); Arweave archiving: archiveReceipts is not exported and fails at runtime |
| `liquefy-receipts.bilateral-netting` | liquefy-receipts computes one net balance per counterparty pair from a list of receipts. | implemented: `packages/liquefy-receipts/src/net.ts` | pure arithmetic: gross flows per ordered pair netted against the reverse direction; the README states the entry count depends on counterparty pairs (at most N(N-1)/2), not on receipt count (test: pass 2026-10-06) | local / off-chain | signatures or counterparty agreement on the result; multilateral netting |
| `liquefy-receipts.onchain-settlement` | liquefy-receipts settles netted receipt obligations on-chain. | missing: `packages/liquefy-receipts/src/index.ts` | none recorded | n/a (not implemented) | any token movement: the package builds anchor instruction bytes and sends nothing; no custody, collateral or finality rules exist |
| `programs.devnet-set-2026-10-06` | 21 of the 28 programs in programs/ are deployed on devnet under one upgrade authority as of 2026-10-06. | prototype: `programs` | each program account exists on devnet under upgrade authority 9Jkp…pU2q and its deployed bytes equal the cargo-build-sbf output of committed source (121109d; 1157630 for the five programs upgraded first on 2026-10-06; aabb759 for dark_secp256k1_auth and 7439dde for dark_null_lottery after their later upgrades); per-program SHA-256 in the proof file; instruction-level suites recorded for all 21 programs with signatures and slots read back from the ledger; dark_secp256r1_vault and dark_secp256k1_auth reject a wrong key, wrong address and wrong message via the precompile binding (0x4009, 0x400b, 0x5008, 0x5009); dark_null_lottery refuses non-admin CommitRound, AnchorTickets and RevealDraw (0x6008); dark_secp256k1_auth refuses an ETH signature replayed by another Solana key to register the same address (0x500A BindingMessageMismatch); the intended agent then registers it (passport 03 10/10); dark_null_lottery pays a Drawn round only to the owner of an anchored ticket carrying the drawn numbers, and a FallbackDrawn round only to the owner of the selected anchored ticket (14/14 and 41/41); receipt_commitment_tree settles to recipients whose keys exceed the BN254 modulus; null_registrar pay-by-name to a one-time stealth address, swept with the recovered scalar (8/8); dark_fedimint_redeem_program held 22 of 22 adversarial cases; attack-replay suite T1–T10 passes against the new null_token_hook, dark_nullifier_banks, receipt_commitment_tree and dark_null_mint_gate (13/13) (test: partial 2026-10-06) | devnet (21 programs) | dark_reputation_gate positive path: no committed zkey matches the compiled track_record VK; passkey browser flows (Face ID / WebAuthn on a device); runs use scripted P-256 keys; membership proofs in dark_semaphore and the BLS pairing in dark_bls12_381_credential (IS_MAINNET_READY = false in these builds); a multi-party trusted setup for any verifying key; mainnet deployment |
| `programs.dark-secp256k1-auth.eth-binding` | On devnet, dark_secp256k1_auth binds an ETH address only to the Solana agent key that the ETH key signed for, so a signature replayed by another key is refused. | implemented: `programs/dark_secp256k1_auth/src/binding.rs` | the precompile-verified message must equal the EIP-191 binding message naming the program id, agent signer, ETH address, domain_hash and auth_hash (0x500A BindingMessageMismatch otherwise); a signature made for one agent and replayed by another Solana key is refused and creates no record; the pre-fix bare 32-byte message format is refused (0x500A); wrong ETH address (0x5008) and msg_hash not keccak256 of the verified message (0x5009) are refused; deployed bytes equal the cargo-build-sbf output of aabb759 (SHA-256 3af9a00d…, zero tail after the build length) (test: pass 2026-10-06) | devnet `7dF2…eiWu` | a MetaMask browser signing session (the run signs with a scripted key); the agent_credential_mint CPI on registration (not deployed); mainnet deployment |
| `programs.dark-null-lottery.claim-binding` | On devnet, dark_null_lottery records a jackpot claim only for the owner of the winning anchored ticket, on a Drawn round or after a FallbackDraw. | prototype: `programs/null_lottery/src/ticket.rs` | tickets_root is a SHA-256 Merkle tree of ticket leaves committing to round id, owner key, numbers and nullifier; a Drawn-round claim needs the claimant's own anchored ticket with the drawn numbers: nullifier-only 0x600B, losing ticket 0x600A, relabelled ticket 0x600B, another signer's copy 0x600B; FallbackDraw takes three consecutive Drawn rounds and the third round's committed seed and anchored pool: non-admin 0x6008, wrong seed 0x6004, wrong pool 0x600C, rounds out of order 0x600E; after FallbackDraw only the selected ticket's owner claims; an unselected ticket with the drawn numbers 0x600D; the old synthetic nullifier 0x600B; a second claim 0x6005; claims on a NoWinner round and a repeated FallbackDraw 0x6007; deployed bytes equal the cargo-build-sbf output of 7439dde (SHA-256 d7048db0…, zero tail after the build length) (test: pass 2026-10-06) | devnet `Ecs5…fLXd` | ticket order in the admin-run lottery is set by the admin, who also commits the seed; null_lottery v1 has no claim window; the claim record PDA is keyed by nullifier only; SPL token payout: ClaimJackpot records the claim and makes no token transfer; mainnet deployment |
| `programs.dark-shielded-pool` | The dark_shielded_pool program verifies a Groth16 withdraw proof over the alt_bn128 syscalls. | prototype: `programs/dark_shielded_pool/src/processor.rs` | Groth16 withdraw proofs from the committed ceremony/shielded_withdraw_v3 zkey verify on devnet FmLW…BSZ3 (2026-10-06); double-spend Custom(3), wrong root Custom(12), wrong recipient Custom(4) and relayer mismatch Custom(4) rejected on-chain; over-fee rejected by the circuit; relay-rail buckets are PDA-keyed and only the admin can Pause/Resume (InitBucketPool, 30a0ce6) (test: pass 2026-10-06) | devnet `FmLW…BSZ3` | a multi-party trusted setup: the verifying key comes from a single-party setup plus a drand beacon; withdrawals from a mainnet build: without the devnet feature the mainnet_ready guard refuses every proof; that this program shares code or a deployment with Dark-Null-Protocol (it does not) |
| `crates.dark-library` | The crates/ library holds 332 Rust crates; most model flows with SHA-256 and only a listed subset call real cryptographic dependencies. | scaffold: `crates` | real dependencies in the subset listed in docs/DARK_CRATES_STATUS.md (alt_bn128, light-poseidon, curve25519-dalek, ed25519-dalek, hmac); dark-blind-oracle attestations are HMAC-SHA256 under the oracle secret (15 of 15 crate tests, 2026-10-06, rust 1.86 container, offline) | local / off-chain | that a crate name describes a working primitive; check its row in docs/DARK_CRATES_STATUS.md; use by any deployed program for most crates |
| `context-capsule.dataflow` | Context Capsule stores session history as a lossless zlib archive, gives the model a short pointer, and returns matching messages only when the caller runs a keyword search. | implemented: `packages/context-capsule/src/index.ts` | zlib level 9 archive of the JSONL history, lossless (3.1x on the bundled 109-message fixture); initial prompt pointer of about 53 estimated tokens versus 7,919 for the full fixture (retrieval not counted); deterministic topic extraction; no model call; searchCapsule decompresses and keyword-matches; the caller must invoke it | local / off-chain; `@parad0x_labs/context-capsule` git 1.2.1, npm 1.2.0 | end-to-end task token or cost savings; the earlier unqualified 83x and 98% figures; that the model can use details it was not given (omitted history must be retrieved and placed in the prompt) |
<!-- claims-table:end -->

## x402 payment modes, as implemented

| Mode | Default | What the code does | What it does not do |
|---|---|---|---|
| Transfer verification | On (transfer mode) | RPC check of an SPL transfer: status, commitment (confirmed by default, finalized optional), mint, recipient balance change, 900 s age limit; SPL Memo equal to the quote's `memoHash` required by default (`REQUIRE_PAYMENT_MEMO=0` opts out); replay keys in Postgres when a database URL is set | Durable replay without a database (in-process only; refused in production); sender binding |
| Signed receipts | On | Ed25519 over sha256 of `{prevHash, payload}`; per-signer hash chain | Attest correctness of the served content |
| Netting calculation | Off; dev-only flag (server, SDK and init starter; refused in production) | Sums payer to provider charges in an off-chain ledger, accepted without verification | Reverse-direction offsetting; any payment |
| Net-obligation settlement | Not implemented | `/settlements/flush` returns and clears totals as JSON | Move funds. There is no clearinghouse, custody or collateral |
| Streaming | Verifier exists | Checks a Streamflow stream when a Streamflow client is supplied (SDK) | Work in the bundled server, which supplies no client |
| Refund escrow | Not wired | `programs/x402_refund_escrow`: SOL bond, receipt-based release, timeout refund | Deployment, TypeScript client, SPL tokens |
| Anchoring | Off; opt-in | Folds a 32-byte value into an hourly on-chain hash chain in `receipt_anchor` (devnet `HSdE…mhXs`). No default program in the server or SDKs; with `ANCHORING_ENABLED` set, a missing program id or keypair or an unbuildable client stops start-up | Store receipts on-chain; prove a single receipt without the bucket's ordered anchors |

## Liquefy Receipts (`packages/liquefy-receipts`)

Five separate things, often described together:

1. **Compression**: columnar transform plus DEFLATE. The package test run prints 66.1x (1,000) and 62.4x (500)
   on synthetic batches; 66x and 83x are recorded on synthetic batches in [`evidence/demo/`](./evidence/demo);
   round-trip is exact only for integer and string fields present on every receipt.
2. **Encryption**: AES-256-GCM with a key the caller manages; opt-in; no key exchange.
3. **Merkle commitment**: a 32-byte SHA-256 root for a batch of any size. The root commits to the receipts;
   it does not contain them. Receipt data stays off-chain.
4. **Bilateral netting**: arithmetic producing one net balance per counterparty pair. Not signed, not
   enforced.
5. **On-chain settlement**: none. The package builds anchor instruction bytes and sends nothing.
   Anchoring has no default program in 0.3.0 (Git) and fails closed; npm `latest` is still 0.2.0.

## Deployments

- **Devnet, 2026-10-06 (fresh key)**: 21 programs under one upgrade authority, listed in
  [`configs/devnet.oss.json`](./configs/devnet.oss.json). IDs, slots and deployed-bytes SHA-256 in
  [`evidence/devnet-programs-2026-10-06.json`](./evidence/devnet-programs-2026-10-06.json): every program's
  bytes equal the build of committed source (`121109d`; `1157630` for the five programs fixed and upgraded
  first; `aabb759` for `dark_secp256k1_auth` and `7439dde` for `dark_null_lottery` after their later upgrades).
  Test runs, with signatures and slots, in
  [`evidence/devnet-2026-10-06/`](./evidence/devnet-2026-10-06/README.md): first run 158 pass / 8 fail across
  26 suites, all 8 failures in programs fixed and upgraded afterwards; rerun 43 / 43 across 8 suites. Rerun 2:
  passport 03 10 / 10 with an ETH signature replayed by another Solana key refused (0x500A), lottery claim
  binding 14 / 14. Rerun 3: lottery FallbackDraw selection 41 / 41. Not run: the `dark_reputation_gate`
  positive path and passkey flows in a real browser.
- **Mainnet**: none active. The mainnet pilot (2026-05-29 to 2026-07-14) is retired; its programs are closed.
- Earlier devnet program IDs in older docs and evidence files are retired.

## Reproduce

```bash
git clone https://github.com/Parad0x-Labs/dna-x402 && cd dna-x402
node scripts/check-claims-registry.mjs                       # registry and this table

npm --prefix x402 ci --ignore-scripts
npm --prefix x402 run build && npm --prefix x402 test       # 1,599 tests (1,587 pass, 12 need X402_DATABASE_URL); polyglot tests need git, python3 and cargo
(cd x402 && X402_DATABASE_URL=postgres://... npx vitest run tests/replay.durable.test.ts)   # replay across a restart

npm --prefix packages/liquefy-receipts install --ignore-scripts
npm --prefix packages/liquefy-receipts test                  # 48 tests

cargo test --manifest-path programs/receipt_anchor/Cargo.toml
cargo test --manifest-path programs/x402_refund_escrow/Cargo.toml

solana program show HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs --url devnet   # one of the 21
solana program dump HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs anchor.so --url devnet   # first 83,120 bytes hash to so_sha256
```

A green CI run shows the tests pass at a commit. It is not an external security review, and no external
security review of this repository is claimed.
