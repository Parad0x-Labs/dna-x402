# Dark Null — FRONTIER_FINAL Audit Sign-Off Packet

**Commit:** 66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186 (baseline; FRONTIER_FINAL changes staged)
**Branch:** mainnet-hardening
**Date:** 2026-05-26
**Network:** Solana Devnet only

---

## Section 1: Deployed Devnet Programs

| Program | Program ID | Deploy Tx |
|---------|------------|-----------|
| dark_nullifier_banks | 7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj | [Solscan](https://solscan.io/tx/5xr7XJ5XjN7xSc3BYepNmhbxoKGo1m1dGCEJQTu2e4eYpAJw5g6uuoYaNJjDWGZXvkxmCC5f2M714S7mNrk2WXt8?cluster=devnet) |
| dark_compressed_receipts | FRmjJsZsLMcKKXBnpR9BkApfH8GWybkuX5Rkf7veSM7g | [Solscan](https://solscan.io/tx/4uht4nvFELfXwDpRhSecLKgoStDAW5Vg2c2LYDoJG2RDU9wh4dMRvNhv1dPTG6pZ9znLj1ngdJKZumeEk4qSfTMT?cluster=devnet) |
| dark_chaff | 5TTFREweFj3tJ6K3zL9fKkULA35iMSjUX3nheiMLmtYk | [Solscan](https://solscan.io/tx/22Fr5CaCiwqQwSkRf4Vdjtvy4swLGeJ4SsRn8Jbqv8sC9qeeZ9ZJt8DNrpcq2KnXscP3H7bg9qLcDhbDeMJw6ZKt?cluster=devnet) |

---

## Section 2: Scope (In-Scope)

### On-Chain Programs (4 baseline)
- `dark_nullifier_banks` — nullifier PDA registration and double-spend prevention
- `dark_compressed_receipts` — compressed receipt ledger with nullifier binding
- `dark_chaff` — epoch-isolated chaff PDA generation for traffic obfuscation
- `dark_scratch` — ephemeral scratch-pad PDA for intermediate state

### FRONTIER_FINAL On-Chain (1)
- `dark_proof_gate_lite` — typed external-claim recorder (NOT a ZK verifier; records externally-verified assertions under authority signature)

### Core Crates (original 22 + Night Cook 25 = ~25 in scope)
- `dark-nullifier-core`
- `dark-receipt-core`
- `dark-session-netting`
- `dark-relay-router`
- `dark-caveat-engine`
- `dark-macaroon-core`
- `dark-ghost-spl-ledger`
- `dark-poison-receipts`
- `dark-chaff-core`
- `dark-note-core`
- `dark-fee-waterfall`
- `dark-tip-core`
- `dark-batch-auditor`
- `dark-agent-kill-switch`
- `dark-session-loss-fuse`
- `dark-copy-ledger`
- `dark-reputation`
- `dark-builder-registry`
- `dark-operator-core`
- `dark-settlement-core`
- `dark-compliance-core`
- `dark-audit-log`
- `dark-night-cook-core`
- `dark-night-cook-ledger`
- `dark-night-cook-relay`

### FRONTIER_FINAL Crates (~13)
- `dark-hash-core` — SHA-256 domain-prefixed hash primitives + Poseidon typed stub
- `dark-proof-core` — typed proof verification trait + mock backend
- `dark-proof-receipts` — proof-backed receipt binding
- `dark-batch-auditor-core` — batch audit trait + test harness
- `dark-bonsol-adapter` — Bonsol typed fail-closed adapter
- `dark-risc0-adapter` — RISC Zero typed fail-closed adapter
- `dark-x402-core` — x402 payment flow core types and pipeline
- `dark-x402-server-mock` — x402 server mock for testing
- `dark-x402-client-mock` — x402 client mock for testing
- `dark-compression-core` — ZK compression trait + local simulator
- `dark-compressed-receipt-ledger` — compression-backed receipt indexing
- `dark-frontier-final-demo` — integration demo wiring all FRONTIER_FINAL crates

---

## Section 3: Out of Scope

- `x402/` TypeScript server — separate codebase, separate audit scope
- `zkvm/dark_batch_guest/` — RISC Zero guest program; requires `rzup` toolchain, not in standard Rust build
- `programs/receipt_anchor/` — covered by separate external audit packet (see `docs/EXTERNAL_AUDIT_PACKET.md`)
- Any mainnet deployment — none exists; devnet only

---

## Section 4: Threat Model

**Who is the adversary?**
Chain-analysis firms, copy-snipers, MEV bots, and sophisticated observers with full mempool access.

**What do they want?**
- Link payer to recipient across transactions
- Replay receipts to double-claim
- Copy agent strategies from on-chain activity
- Front-run or sandwich agent actions

**What can they do?**
- Observe all on-chain transactions and their metadata
- Submit arbitrary transactions to the network
- Front-run pending transactions in the mempool
- Correlate timing and amounts across addresses

**What are they blocked from?**
- Linking nullifier to payer: domain-separated hash (SHA-256 with domain prefix) makes pre-image recovery infeasible
- Double-spending: PDA uniqueness in `dark_nullifier_banks` — PDA derivation from nullifier hash prevents duplicate creation
- Forging authority signature: `dark_compressed_receipts` authority binding enforced on-chain
- Triggering double-redeem: nullifier PDA in `dark_compressed_receipts` marks receipts as spent at the program level

---

## Section 5: Security Claims

Each claim includes its verification method.

| # | Claim | Verification Method |
|---|-------|---------------------|
| 1 | Nullifier double-spend impossible | PDA uniqueness in `dark_nullifier_banks` — `init` constraint prevents duplicate PDA creation |
| 2 | Receipt double-redeem impossible | `dark_compressed_receipts` nullifier PDA — checked and marked spent in single instruction |
| 3 | Chaff PDAs epoch-isolated | `dark_chaff` epoch guard — PDA includes epoch in seed, cross-epoch reuse rejected |
| 4 | Authority-only root updates | `dark_compressed_receipts` authority binding — `has_one = authority` Anchor constraint |
| 5 | Caveat engine: denied scope wins over allowed | `caveat-engine` test `test_denied_scope_wins` — deny list checked before allow list |
| 6 | Session netting: no per-note PDA | `dark-session-netting` design — netting computed off-chain, single net PDA committed |
| 7 | Macaroon tampering detected | HMAC-SHA256 chain (RFC 2104, post Phase 9 fix) — each caveat extends the chain |
| 8 | Copy-sniper poisoned by decoy leaves | `poison-receipts` domain separation — decoy leaves indistinguishable from real without key |
| 9 | Ghost SPL: no token account until exit | `ghost-spl-ledger` design — token account created only at claim time, not at deposit |
| 10 | Relay route scored for privacy | `dark-relay-router` composite score — entropy, timing, and fee components weighted |

---

## Section 6: Non-Claims (Explicit)

The following are NOT claimed and must not be inferred from this codebase:

- **No ZK proof verification in production** — all ZK backends are mocks; typed traits exist but no real verifier is wired
- **No Poseidon syscall** — SHA-256 with domain prefix only; Poseidon is a typed stub behind a feature flag, requiring BPF syscall runtime
- **No Bonsol/RISC Zero integration** — adapters are typed fail-closed stubs; external toolchain (Bonsol CLI / rzup) not installed
- **No Light Protocol ZK Compression** — local simulator only; real Light Protocol SDK not integrated
- **No end-to-end privacy guarantee** — chaff and domain separation reduce linkability; they do not provide cryptographic unlinkability
- **No mainnet evidence** — all deploy transactions referenced are devnet; no mainnet program exists
- **No third-party audit sign-off** — this document is the handoff packet to auditors, not the result of an audit
- **Mock proof verifier is not a real ZK verifier** — `MockProofVerifier` always returns `Ok(())` for valid-shaped inputs; it does not verify any cryptographic statement
- **`dark_proof_gate_lite` is not a ZK verifier** — it records externally-verified claims under authority signature; verification happens off-chain

---

## Section 7: Test Coverage

- **Before FRONTIER_FINAL:** 304 tests, 0 failures (baseline commit 66765c9)
- **After FRONTIER_FINAL:** see `dist/frontier-final/FRONTIER_FINAL_SCORECARD.json`
- **Full test run:** `cargo test --workspace`

Individual module test counts (FRONTIER_FINAL additions):
- `dark-hash-core`: 10 tests (SHA-256 domain separation, Poseidon stub)
- `dark-proof-core`: 18 tests (mock verifier, typed proof shapes)
- `dark-x402-core` / mocks: 28 tests (pipeline, mock round-trip)
- `dark-bonsol-adapter` / `dark-risc0-adapter`: 22 tests (fail-closed behavior)
- `dark-compression-core`: 18 tests (local simulator, adapter)

---

## Section 8: Reproduction

```bash
git clone <repo>
cd "DNA x402"
cargo build --workspace
cargo test --workspace
```

Note: Some tests are conditionally compiled on non-Windows platforms due to rbpf ASLR behavior (see Section 9).

---

## Section 9: Dependency Audit Status

- **`cargo audit`:** not yet run against FRONTIER_FINAL additions — run before mainnet consideration
- **`cargo deny`:** not yet run — run before mainnet consideration
- **Recommended:** run both `cargo audit` and `cargo deny check` as part of CI before any mainnet consideration

**Known issues:**
- `ed25519-dalek` v1 pinned for Solana 1.18.26 compatibility (conflicts with v2/zeroize); upgrade blocked by upstream Solana dependency chain
- `rbpf` 0.8.3 Windows ASLR crash: program tests that invoke the BPF VM are skipped on Windows (`#[cfg(not(target_os = "windows"))]`)

---

## Section 10: Red-Gap Status After FRONTIER_FINAL

| Gap | Before FRONTIER_FINAL | After FRONTIER_FINAL | Remaining Blocker |
|-----|--------------------|-------------------|-------------------|
| ZK proof verification | None | Mock + typed traits | Real backend not wired |
| Poseidon syscall | SHA-256 placeholder | Trait + mock backend | BPF syscall required; Poseidon not available in std Rust |
| x402 flow | TS server only | Rust mock full pipeline | Real devnet tx verification requires async RPC client |
| Bonsol/RISC Zero | Skeleton only | Typed fail-closed adapters | External toolchain (Bonsol CLI / rzup) not installed |
| ZK Compression | PDAs only | Local simulator + adapter | Light Protocol SDK not integrated |
| Audit packet | None | This document | Third-party auditor review |
| Mainnet gate | None | Gate script + blockers listed | All above + audit sign-off |
| HMAC-lite | SHA256(key\|\|msg) | RFC 2104 HMAC-SHA256 | Fixed in Phase 9 |

---

## Section 11: Mainnet Blockers (Complete List)

The following must ALL be resolved before mainnet deployment is considered:

1. Third-party audit of all in-scope on-chain programs and crates
2. `cargo audit` — no critical or high vulnerabilities
3. `cargo deny check` — licenses and duplicate crates clean
4. Real ZK proof verification wired (if ZK is publicly claimed)
5. Real Poseidon backend tested on-chain (if Poseidon is publicly claimed)
6. Real x402 devnet transaction verification (if x402 is publicly claimed)
7. HMAC-SHA256 RFC 2104 upgrade (completed in Phase 9)
8. `dark_proof_gate_lite` — on-chain authority policy reviewed by auditor
9. Upgrade authority policy defined for all programs (multisig, rotation procedure)
10. Rollback/pause procedure documented and tested
11. No `ProgramError::Custom` without documented, exhaustive error code table
12. Signed deploy plan with all program IDs and budget within approved limits
13. Max SOL deploy budget approved by project governance

---

## Section 12: Required Auditor Deliverables

The following findings are required from the third-party auditor before mainnet authorization:

- [ ] Report covering all in-scope programs and crates (Sections 2 and 5)
- [ ] Confirmation of nullifier uniqueness logic in `dark_nullifier_banks`
- [ ] Confirmation of authority binding in `dark_compressed_receipts`
- [ ] Finding on HMAC-SHA256 implementation (RFC 2104 compliance, post Phase 9)
- [ ] Finding on mock verifier vs real verifier gap (Section 6 non-claims)
- [ ] Finding on epoch isolation in `dark_chaff`
- [ ] Recommendation on mainnet upgrade authority policy for all three programs
- [ ] Assessment of `dark_proof_gate_lite` authority model
- [ ] Verification that `test_denied_scope_wins` correctly reflects runtime behavior
- [ ] Dependency risk assessment covering `ed25519-dalek` v1 and `rbpf` 0.8.3 issues
