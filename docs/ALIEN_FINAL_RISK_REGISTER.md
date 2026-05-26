# Dark Null — ALIEN_FINAL_BOSS Risk Register

**Branch:** codex/mainnet-hardening
**Date:** 2026-05-26
**Network:** Solana Devnet only

This register covers all known risks introduced or exposed by the ALIEN_FINAL_BOSS build phase. Each risk must be resolved or formally accepted before mainnet consideration.

---

## Risk Table

| # | Risk | Impact | Likelihood | Current State | Mitigation | Evidence Required |
|---|------|--------|------------|---------------|------------|-------------------|
| 1 | ZK backend not production | **Critical** — privacy claims would be false if publicly asserted | High (it is mock) | `MockProofVerifier` returns `Ok(())` for valid-shaped inputs; typed trait stubs only | Non-claim documented in audit packet (Section 6); gate script blocks mainnet if ZK claimed without evidence | `dist/alien-final/evidence/zk_verifier_real.json` with verifier identity and test vector confirmation |
| 2 | Poseidon feature environment-gated | **High** — Poseidon cannot run in std Rust without BPF syscall; silently falls back to SHA-256 placeholder if feature flag misused | High (BPF runtime required) | `dark-hash-core` has `poseidon` feature gate; non-BPF environments compile the stub without error | Feature flag documented; non-claim stated explicitly; claim checker script blocks docs asserting "Poseidon on-chain live" | `dist/alien-final/evidence/poseidon_real.json` with on-chain test tx |
| 3 | x402 flow mock-only unless devnet tx verified | **High** — if x402 payment receipts are claimed as real, they are not; mock round-trip does not verify Solana state | High (async RPC not wired) | `dark-x402-server-mock` and `dark-x402-client-mock` provide full pipeline test coverage; no real devnet RPC call made | Non-claim documented; gate script blocks mainnet if x402 claimed without devnet evidence | `dist/alien-final/evidence/x402_devnet_real.json` with devnet tx signatures |
| 4 | Compression simulator is not real Light Protocol | **High** — compressed receipts in production would require Light Protocol SDK; local simulator behavior may diverge | High (SDK not installed) | Local simulator passes shape and API tests; Light Protocol `@lightprotocol/stateless.js` not imported | Non-claim documented; simulator labeled `LocalZkCompressionSimulator` throughout; gate script checks evidence | `dist/alien-final/evidence/zk_compression_real.json` with Light Protocol version and test account |
| 5 | Bonsol/RISC0 adapter is typed stub | **High** — any claim of RISC Zero or Bonsol proof generation would be false | High (external toolchain absent) | Both adapters are fail-closed: all operations return `Err(AdapterError::ExternalToolchainRequired)` when not mocked | Adapters documented as stubs; `BLOCKED_EXTERNAL_TOOLCHAIN` sentinel in SCORECARD; gate script checks | `dist/alien-final/evidence/bonsol_real.json` and/or `risc0_real.json` with proof tx hashes |
| 6 | HMAC-lite pre-Phase-9 (resolved) | **High** — SHA256(key\|\|msg) is vulnerable to length extension; macaroon chain integrity could be forged | Was: High. Post-fix: Low | **Resolved in Phase 9** — upgraded to RFC 2104 HMAC-SHA256 (`HMAC-SHA256(key, msg)` with proper ipad/opad) | Fix committed; evidence file at `dist/alien-final/evidence/hmac_rfc2104.json`; gate script verifies evidence present | `dist/alien-final/evidence/hmac_rfc2104.json` (must be present) |
| 7 | No third-party audit | **Critical** — on-chain programs handling value have not been reviewed by an independent security researcher | High (audit not started) | Audit packet prepared (this document + `ALIEN_FINAL_AUDIT_PACKET.md`); no auditor engaged | Gate script blocks mainnet without `audit_signed.json`; blockers list explicit | `dist/alien-final/evidence/audit_signed.json` with auditor name, scope, date, and findings hash |
| 8 | No mainnet evidence | **Critical** — all program IDs and tx links are devnet; mainnet behavior is untested | Certain (by design at this stage) | Devnet deploy confirmed; mainnet deploy explicitly blocked by gate script | Gate requires `ALLOW_MAINNET_DEPLOY=YES` and all 16 gate conditions satisfied | Signed deploy plan + gate script passage |
| 9 | Off-chain services not trustless | **Medium** — relay routing, session netting, and kill-switch rearm all depend on off-chain services that can be censored or manipulated | Medium | Off-chain components documented as trust assumptions; not claimed to be trustless | Architecture documentation clearly states off-chain trust boundary; no on-chain enforcement for routing scores | Architecture review by auditor; explicit trust model statement in audit report |
| 10 | User funds not tested live (devnet only, no real SOL in mock flow) | **High** — mock flow does not exercise real lamport transfers, rent, or account lifecycle edge cases | Certain at this stage | All fund flows use mock accounts and simulated balances; no real SOL at risk in testing | Devnet testing with real (worthless) SOL required before mainnet consideration; documented in gate conditions | Devnet test run logs showing actual lamport transfers and account creation |
| 11 | rbpf 0.8.3 Windows ASLR crash | **Low** — program tests that invoke BPF VM crash on Windows due to ASLR incompatibility | High on Windows CI | Tests are conditionally skipped on Windows (`#[cfg(not(target_os = "windows"))]`); Linux CI unaffected | Known upstream issue; documented in Section 9 of audit packet; CI runs on Linux | Upstream rbpf fix or Solana 1.18.x patch that resolves ASLR issue |
| 12 | ed25519-dalek v1 pinned for Solana 1.18.26 compat | **Medium** — v1 has known issues with zeroize integration; upgrade to v2 blocked by Solana dependency chain | Low (Solana pins it) | Pinned via Solana's own dependency; cannot upgrade without upgrading Solana SDK | `cargo audit` advisory acknowledged; upgrade path depends on Solana SDK releasing v2 support | `cargo audit` run and advisory formally accepted or resolved |
| 13 | dark_proof_gate_lite is NOT a ZK verifier | **Critical** — if claimed as ZK verification, the claim is false; program only records externally-verified assertions | Certain (by design) | Program documented throughout as "external claim recorder"; non-claim explicit in audit packet Section 6 | Non-claim documented; claim checker script blocks "ZK verified" in docs without evidence; auditor must confirm | Auditor finding confirming program's authority model is understood and acceptable |
| 14 | Agent kill switch rearm: only user can rearm, not tested on-chain | **Medium** — if kill switch fires erroneously, user must manually rearm; no on-chain rearm path exists | Low | Kill switch rearm is off-chain user action; design documented | Rearm procedure documented in runbook; on-chain enforcement of kill switch state is in scope for future audit phase | Runbook accepted by auditor; or on-chain rearm path added and audited |
| 15 | Session loss fuse: only off-chain, no on-chain enforcement | **Medium** — session loss fuse (circuit breaker for session netting failures) is not enforced by any on-chain program | Low | Fuse is implemented as off-chain service check; on-chain programs do not enforce fuse state | Design documented as off-chain trust boundary; auditor must assess whether this is acceptable for production use | Auditor assessment of off-chain fuse trust model |
| 16 | Copy-sniper poisoning: combinatorial but not cryptographic | **Medium** — decoy leaves in `poison-receipts` make copy-sniping expensive but not cryptographically infeasible given unlimited compute | Low | Decoy leaves use domain separation to prevent trivial filtering; combinatorial cost documented | Non-claim that poisoning is cryptographically unbreakable; documented as cost-based deterrent only | Auditor assessment of poisoning effectiveness under adversarial compute budget |

---

## Risk Summary

| Severity | Count | Resolved | Remaining |
|----------|-------|----------|-----------|
| Critical | 3 | 0 | 3 (no audit, no mainnet evidence, proof gate claim risk) |
| High | 7 | 1 (HMAC) | 6 |
| Medium | 4 | 0 | 4 |
| Low | 2 | 0 | 2 |

**All Critical and High risks must be resolved before mainnet consideration.**

---

## Risk Acceptance Policy

Risks in this register may be accepted (not mitigated) only if:
1. The risk is explicitly documented in the third-party audit report
2. The auditor recommends acceptance
3. A project governance decision (documented and signed) accepts the risk
4. The accepted risk and its rationale are added to `docs/ACCEPTED_RISKS.md` (to be created before mainnet)

No risks are currently formally accepted.
