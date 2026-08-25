# Devnet Attack-Replay Results — dna-x402 `security-fixes`

Run date: 2026-08-25 · RPC `https://api.devnet.solana.com` · suite: `node suite.ts` (Node 22.23, @solana/web3.js 1.98.4)

| # | Test | Result | Evidence |
|---|------|--------|----------|
| T1 | credential-mint IssueCredential happy path (nonzero receipt hash) | PASS | tx `3b6E6Tw5BWZQ7uZA5WWsFdkkntCUozrP9EqgtURdAXnvYqGAtCLThNj5ZvmejnYh8hvYtyxvmGdozPv8PVvAa2vG`; CredentialRecord PDA verified: disc `CR`, status active, 155 B |
| T2 | REVOKE ATTACK — protocol-authority PDA passed as `authority_info` WITHOUT signature | PASS | rejected `Unauthorized` custom `0x9007`. Failed tx landed; error observed from program logs |
| T3 | UPGRADE ATTACK — agent_wallet matches record but not a signer | PASS | rejected `Unauthorized` custom `0x9007` |
| T4a | dark_nullifier_banks InitBank first call (shard=7, epoch=777) | PASS | tx `4VUt44CUTn7Vo8BXTgpXLbgW3ctd6N7xAD47VzkjRJyqCe67i5YM3SootL65w3B7Ji1zsSQ3EnZVGDNKoz5pge5X` |
| T4b | REINIT ATTACK — InitBank twice on same shard/epoch | PASS | rejected `BankAlreadyInitialized` custom `0x9` |
| T5a | FORGED ADMIN step 1 — InitConfig against canonical `[b"hook-config"]` PDA when UNINITIALIZED | PASS (with finding) | tx `52TE6WiAW46RHxVgmnghEakeTQMdeGJXGi4tMsm7uY6MuXU9vLCTae4JmvSsMmQ38gUdDbJ7wBqsUtcnatvWcEGi` — **succeeded** (see Finding F1) |
| T5b | FORGED ADMIN step 2 — second attacker InitConfig on canonical PDA | PASS | rejected `ConfigAlreadyExists` custom `0x3005` |
| T5c | FORGED ADMIN step 3 — attacker AddToAllowlist with self-appointed admin | PASS | rejected `NotAdmin` custom `0x3006` (canonical config account[4] enforced) |
| T6 | receipt_commitment_tree PREFUND-GRIEF — 1-lamport top-up of tree PDA before Initialize | PASS | tx `55Usajk5i9ARP6ch4X93Nc26eQoGGuX45vz7XDGtYQzuEQz5AJn1QnK7zu18QgegUBqX2YAcTiDsNraQhuTMdi68`; top-up/allocate/assign path succeeded; tree owner=program, 938 B |

## Findings

- **F1 (discrepancy, informational):** At test time the canonical hook-config PDA (`find([b"hook-config"], hrCdqUDG…)`) was **uninitialized**, so `InitConfig` is permissionless first-come: `test-user-1`'s call succeeded and that wallet is now the stored admin of the canonical config on devnet. The `[b"hook-config"]` fix fully blocks *forging an existing* admin (T5b/T5c prove it), but does not prevent *claiming an unclaimed* config. On devnet this means the deployer can no longer initialize config itself; if a specific admin must own it, initialize immediately after deployment (or add a deployer-gated init).
- T2/T3 confirm the security-fixes branch behavior: key equality alone no longer grants revoke/upgrade authority — a real signer check gates both.
- T6 confirms prefund hardening: a 1-lamport grief top-up no longer bricks initialization (rent-exempt min for 938 B = 7,419,360 lamports).

## SOL spent per wallet (final run + earlier partial runs included in balances)

| Wallet | Spent | Balance after |
|--------|-------|---------------|
| deployer | 0 (untouched) | ~0.0938 SOL |
| test-agent-1 (2cjG…) | 0.00197468 | 0.498025 |
| test-agent-2 (94za…) | 0.00127868 | 0.498721 |
| test-user-1 (GU5J…) | 0.00861256 (incl. one earlier T6 run of 0.00742436) | 0.483963 |

## Layout / discriminant notes used by the suite (from Rust source)

- agent_credential_mint: 1-byte tags 0x01/0x02/0x03; cred PDA `[b"cred", agent_pubkey]`, 155 B; errors base 0x9001.
- dark_nullifier_banks: tags 0x00/0x01; bank PDA `[b"null_bank", shard, epoch_le]`, 55 B; DarkNullError enum index → custom code (`BankAlreadyInitialized` = 9).
- null_token_hook: tags 0x02 InitConfig `[limit u64le]`, 0x03 AddToAllowlist `[flags u64le]`; config PDA `[b"hook-config"]` (canonical post-fix), allowlist PDA `[b"allowlist", target]`; HookError base 0x3001.
- receipt_commitment_tree: tag 0x00 Initialize `[tree_id u64]`; tree PDA `[b"receipt_tree", tree_id]`, 938 B.

---

# dark_null_mint_gate (`Tncf2ZwE3CtyEourUxPzL1Jkknw6sAt2A7SdtM8c4up`) — C5 operator-gate verification

Run date: 2026-08-25 · RPC `https://api.devnet.solana.com` · `MINT_GATE_ONLY=1 node suite.ts` (tests T7–T10 added to `suite.ts`)

Source facts used: tags `0x01 InitEmission [null_mint[32], max u64le, dur u64le, cap u64le]`, `0x02 ClaimEmission [nullifier[32], commitment[32], amount u64le]`, `0x03 AdvanceEpoch [new_epoch u64le]`; config PDA `[b"emission-config"]` (106 B, disc 0xD1, admin@1, epoch_minted@97, is_active@105); record PDA `[b"emission", nullifier_hash]` (121 B, disc 0xD2, agent@89); errors base 0x7001, `NotAdmin` = 0x7007. The SPL mint CPI in `process_claim` is **compile-time stubbed** — under the default build `IS_MAINNET_READY=false` skips it entirely; even with `--features mainnet` its body is an unimplemented TODO. No mint/ATA accounts are read at all, so there is no CPI to fail.

| # | Test | Result | Evidence |
|---|------|--------|----------|
| T7 | InitEmission by deployer | PASS | tx `avZLD4XZwuHP2aQy9XtsNZqxsBRZyNVUg2AHRpZQtbDfEqX6Bh1iTJpqe7c2Nw12pCcf3XtkJjP7YqcBGCe9pYo` — config PDA verified on-chain: 106 B, disc 0xD1, admin=deployer HKBH…jfje, is_active=1 |
| T8 | UNAUTHORIZED CLAIM ATTACK — agent-only ClaimEmission with wrong trailing authority (C5 fix) | PASS | rejected `NotAdmin` custom 0x7007; failed tx observed from program logs. The authority account must be a signer AND equal cfg.admin |
| T9 | OPERATOR CLAIM — ClaimEmission with deployer co-signing as config authority | PASS | tx `5Ue7QhWtuEiTRn4zHyauUZfDCutHnk1xzzyqUoZk9LUXeNjz3yCNsLa7D4x5uoAB9Jv6Pa3QpxPC1UfjQ7Wsif5f` (first claim, from a harness-interrupted run) + tx `3iXjz6R1qeV4N6sp7axC4NnwyScRMqLS2aJW65mq2hYLzm1Zc7Ut8r5nLdzScj7JyAquJuo1S49t6w3An2CX6TKB` (rerun) — both fully succeeded; record PDAs verified (121 B, disc 0xD2, agent=test-agent-1); counter accumulated 250k+250k=500000 exactly as intended. **No CPI failure possible**: CPI is stubbed out of the deployed binary (see note above) — nothing "up to the CPI", the instruction completes end-to-end |
| T10 | AdvanceEpoch 0 → 1 by deployer | PASS | tx `2vjJ341BPRqmvF1B95gPxJEmff9bo3Jq8iC8w96XDszZhYQPnSciCSs8Aj3s4XTTBNMVMYh9f5Utz3qpsqushYbV` — config now current_epoch=1, epoch_null_minted_atomic reset to 0 |

**Result: 4/4 PASS. No discrepancies vs Rust source intent.** The C5 fix holds: without the stored config admin co-signing, every claim is rejected with NotAdmin (0x7007).

Notes:
- An initial run crashed in *harness verification code* (`Uint8Array.readBigUInt64LE` not a function) after T9's tx had already landed; fixed by adding a plain-JS `u64le()` helper and re-running. That is why two successful claims exist for T9.
- Emission record rent (~0.0015 SOL incl. fees) was paid by test-agent-1; deployer only spent tx fees.
- Remaining gap vs production intent (documented in source, not a test failure): SPL mint-to CPI unimplemented and gated behind IS_MAINNET_READY; claims are entirely client-supplied data with no proof linkage, hence the operator gate itself is load-bearing until real proof verification lands.

## SOL spent this run (T7–T10)

| Wallet | Spent | Balance after |
|--------|-------|---------------|
| deployer (HKBH…) | 0.001638 total across both runs (T7 config rent-exempt min ~0.001548 + fees) | 0.553236 |
| test-agent-1 (2cjG…) | 0.003486 (two T9 record-PDA creations + fees) | 0.494539 |
| test-agent-2 (94za…) | 0.000005 (T8 fee-payer, failed tx fee only) | 0.498721 |
| test-user-1 (GU5J…) | 0 (untouched) | 0.483963 |
