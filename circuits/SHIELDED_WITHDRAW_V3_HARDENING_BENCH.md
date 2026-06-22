# shielded_withdraw_v3 hardening — held-out adversarial benchmark

Closes the two soundness findings the P1 adversarial ZK audit (wqknkjp8x) raised against
`shielded_withdraw_v3.circom`. The benchmark is **differential**: it compiles the vulnerable
circuit (git HEAD) and the fixed circuit, which differ by **exactly** the two security changes,
and proves at the math layer (snarkjs `fullprove`/`verify`, no chain) that each attack is
present on the vulnerable circuit and closed on the fixed one, while a legit withdraw still
verifies. `poseidon-lite == circomlib == on-chain sol_poseidon`, so the off-circuit tree can't
drift from the real one (the legit case is itself that cross-check).

## The two holes

### A1 — Nullifier malleability (CRITICAL, double-spend)
- **Before:** `nullifier = Poseidon(DOMAIN_NULLIF, secret, pool_key_field)`, where `pool_key_field`
  is a **free private witness** constrained nowhere. One real note → unlimited distinct valid
  nullifiers → unlimited double-spend within a single pool. The public `pool_id` was only a dead
  `_ <==` sink.
- **Fix:** `nullifier = Poseidon(DOMAIN_NULLIF, secret, pool_id)` — `pool_id` is the **public**
  pool PDA. The nullifier becomes a deterministic function of `(secret, pool_id)`: exactly one
  valid nullifier per note per pool, so the on-chain nullifier-uniqueness check blocks the replay.
- **Enforcing constraint:** `nullifier === computed_nullifier` (line 162).

### A2 — Non-boolean Merkle path selector (medium, soundness)
- **Before:** `MultiMux1.s <== path_index[i]` with no boolean constraint. `MultiMux1` computes a
  linear blend `out = (c1 - c0)·s + c0`, so a non-boolean `s` (e.g. `2`) blends the two siblings
  instead of selecting one — a prover can bend the Merkle path.
- **Fix:** `path_index[i] * (path_index[i] - 1) === 0` at every level forces each selector into
  `{0,1}`.
- **Enforcing constraint:** `path_index[i] * (path_index[i] - 1) === 0` (MerkleProof, line 93).

## Cases (grade PASS iff all 7)

| # | Case | Expectation |
|---|------|-------------|
| L | legit withdraw | VERIFIES on FIXED (and on VULN — apples-to-apples) |
| A1 | VULN: two `pool_key_field` for one note | two DISTINCT valid nullifiers (double-spend PRESENT) |
| A1 | FIXED: submit a non-canonical nullifier | witness UNSAT (rejected) |
| A1 | FIXED: prove the same note twice | identical nullifier (deterministic → replay caught on-chain) |
| A2 | VULN: `path_index[0] = 2` | proof ACCEPTED (hole PRESENT) |
| A2 | FIXED: `path_index[0] = 2` | witness UNSAT (rejected) |

Result on 2026-06-22: **PASS (7/7)**. Constraints: FIXED 5696, VULN 5676 (Δ = 20 = the depth-20
boolean selector constraints). See `evidence/zk/shielded-withdraw-v3-hardening-devnet.json`.

## Run

```bash
# from the repo root
docker build -t x402v2-bench sandbox/x402v2          # if not already built
git show HEAD:circuits/shielded_withdraw_v3.circom > /tmp/vuln/shielded_withdraw_v3.circom
docker run --rm --network none \
  -v "$PWD/circuits:/mnt/fixed:ro" -v "/tmp/vuln:/mnt/vuln:ro" \
  -v "$PWD/build:/mnt/build:ro"   -v "$PWD/sandbox/x402v2:/mnt/run:ro" \
  -v "$PWD/out:/out" \
  --entrypoint bash x402v2-bench /mnt/run/run-swv3.sh
```

## Status / next

The circuit fix is **proven at the math layer**. The single-party VK produced here is a devnet
**grading** key only — not the deployed key. To make the pool's withdraw path live again:
1. regenerate the verifying key from this fixed circuit via the **trustless multi-party ceremony**
   (`ceremony/run-ceremony-v3.mjs` — public ptau + multiple independent contributions + drand beacon),
2. redeploy `dark_shielded_pool` with the new VK and a `devnet` cargo feature (the fail-closed
   `mainnet_ready` guard currently rejects every proof — finding [HIGH] liveness),
3. run the on-chain e2e.

Until then the pool stays fail-closed; no live withdraw path is affected by this change.
