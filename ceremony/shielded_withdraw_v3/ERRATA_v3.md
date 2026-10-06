# Errata: shielded_withdraw_v3 setup recorded in `transcript_v3.json`

`transcript_v3.json` is kept unchanged as the record of the v3 key. Two statements in it are wrong.

## What was wrong

The v3 phase 2 was a single drand beacon (round 6000000) applied to `shielded_withdraw_v3_0000.zkey`,
the deterministic output of `snarkjs groth16 setup`. No secret contribution was made.

- `0000.zkey` has delta = 1.
- `snarkjs zkey beacon` derives its scalar from the beacon value alone (2^10 rounds of SHA-256, then
  ChaCha seeded with the digest, initial field draw).
- So the final delta is a scalar anyone can compute from public data, and snarkjs keys have
  gamma_2 = g2. With delta known, a proof for any public inputs is
  `A = alpha_1, B = beta_2, C = -(vk_x) / delta`, made without a witness.

The transcript's `security_model` says forging "requires breaking BN254 discrete log". That is wrong:
it requires only the published beacon value. Its `mode` line says the phase-2 entropy is the drand
output; that output is public, so the phase-2 randomness was public as well.

## Impact

Anyone could forge a withdraw proof for any nullifier, recipient, relayer and fee against the v3
verifying key (`shielded_withdraw_v3_vk.json` at the time, sha256 `d1cb06d3…`). That key was compiled
into `dark_shielded_pool` on devnet (`FmLWnMKAM834GdqMr7Z22HrAdtJNhiaF2NTEPcpdBSZ3`), so a forged proof
against a known root could have withdrawn from any devnet pool of that program. The mainnet build of
the program refuses every proof while the key has `mainnet_ready = false`.

Reproduced offline on 2026-10-06 with `ceremony/check-beacon-delta.mjs`: delta equals the round
6000000 scalar times g2, and the forged proof passes `snarkjs groth16 verify`. No forged proof was
sent to any cluster.

## Fix

v3.1 (`transcript_v3_1.json`) adds one secret contribution on top of the v3 key, made by a single
operator with entropy from `/dev/urandom` in a throwaway tmpfs container with no network, entropy
discarded, followed by a fresh drand beacon (round 6529525) fixed after the contribution hash. This is
a single-party contribution with discarded entropy plus public beacon; devnet only; a multi-party
phase 2 is required before mainnet.

The v3 files were renamed `shielded_withdraw_v3_beacon_only_final.zkey` and
`shielded_withdraw_v3_beacon_only_vk.json`; `shielded_withdraw_v3_final.zkey` and
`shielded_withdraw_v3_vk.json` are now the v3.1 key. With the v3.1 verifying key the program rejects
proofs from the v3 key, including the forged one (`programs/dark_shielded_pool/tests/withdraw_vk_v3_1.rs`,
native and against the built `.so`).
