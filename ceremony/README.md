# Trusted-setup ceremony — DNA x402 ZK gates

The multi-party Groth16 phase-2 ceremony that makes the ZK gates **mainnet-trustworthy**.

## Why
A Groth16 proving/verifying key is derived from secret randomness ("toxic waste"). Whoever knows
it can **forge proofs**. Our current devnet keys are **single-party** (one machine generated them) →
forgeable → devnet only. A multi-party ceremony fixes this: each contributor adds secret randomness
and destroys it; the setup is sound as long as **≥1 contributor was honest**. Credibility scales
with the number of visibly-independent contributors.

**Circuits covered (run the ceremony once per circuit):**
- `x402_access` — `dark_x402_access_gate` (3 public inputs)
- `track_record` — `dark_reputation_gate` (6 public inputs)

## Phase 1 — reuse a public ptau (do NOT run your own)
Phase-1 ("powers of tau") is universal and the riskiest to self-generate. **Reuse a published one:**
- Hermez `ppot_0080_*.ptau` (54+ contributions) or PSE Perpetual Powers of Tau.
- Pick the smallest power ≥ the circuit's constraints (`track_record` ≈ 12.1k → power 14+;
  `x402_access` ≈ 3.5k → power 12+).
- Verify it before use: `snarkjs powersoftau verify <ptau>` MUST print `Powers Of Tau Ok!`.

> The devnet POC used a locally-generated `pot16` — fine for devnet, **not** for mainnet trust.
> Swap in the public ptau for the real run.

## Phase 2 — sequential independent contributions
A coordinator initialises, then passes the `.zkey` from contributor to contributor. **Each
contributor runs ONE command on their OWN machine** (never the coordinator's):

```bash
# coordinator, once:
snarkjs groth16 setup <circuit>.r1cs <public_ptau> <circuit>_0000.zkey

# contributor k (on their own machine, with their own entropy):
snarkjs zkey contribute <circuit>_{k-1}.zkey <circuit>_{k}.zkey \
  --name="<your handle / org>"        # snarkjs prompts for entropy — type randomly + add OS randomness
# then publish your Contribution Hash (printed) as an attestation (Gist / tweet / signed note):
#   handle, contribution index k, the 64-byte hex Contribution Hash.
```

**Soundness needs only 1 honest contributor** — but recruit 7–15 visibly-independent ones
(devs, advisors, community, a validator). Each MUST destroy their entropy + machine state.

## Beacon — finalise with PRE-COMMITTED public randomness
**Before** the ceremony starts, publicly commit to a future randomness source (so no one can grind it):
e.g. "the Solana block hash at slot H" or "drand round R", announced + timestamped in advance.
When that value is known, apply it as the final, deterministic, verifiable contribution:

```bash
snarkjs zkey beacon <circuit>_{N}.zkey <circuit>_final.zkey <BEACON_HEX> 10 -n="Final Beacon"
```

## Verify (anyone, independently)
```bash
snarkjs zkey verify <circuit>.r1cs <public_ptau> <circuit>_final.zkey   # -> "ZKey Ok!"
```
Then check: the `r1cs` SHA-256 matches the published circuit source; the contribution chain matches
each contributor's published attestation; the beacon hex matches the pre-committed value.

## Publish the transcript
`ceremony/transcript/<circuit>/` holds: `r1cs_sha256`, every contribution's `zkey_sha256` +
attestation, the beacon, the `final_zkey_sha256`, the `vk_sha256`, and the `ZKey Ok!` result.
A third party reproduces `snarkjs zkey verify` and gets the same.

## Flip to mainnet (only after this + an external audit)
1. Regenerate the on-chain VK from the **ceremony's** `*_final.zkey`:
   - `track_record` → `node scripts/zk/track-record-vk-to-rust.mjs`
   - `x402_access`  → its VK codegen
2. Set `mainnet_ready: true` in the generated VK module.
3. Upgrade the gate programs with the ceremony VK.
4. Only then claim "trustless setup".

## This repo's helper
`ceremony/run-ceremony.mjs` runs the full flow end-to-end in **DEMO mode** (simulated
contributions + placeholder beacon + local ptau) to prove the machinery and the transcript format
— it is NOT a trustless ceremony. The real run replaces the three DEMO pieces above with independent
humans, a public ptau, and a committed beacon.

## shielded_withdraw_v3 — committed artifacts (dark_shielded_pool)
Current key: v3.1, a single-party contribution with discarded entropy plus public beacon; devnet only;
a multi-party phase 2 is required before mainnet. Full record: `shielded_withdraw_v3/transcript_v3_1.json`.

Chain: Hermez PPOT phase 1 (`powersOfTau28_hez_final_14.ptau`, sha256 `489be9e5…`) →
`groth16 setup` (`0000.zkey`) → drand round 6000000 beacon → one operator contribution (entropy from
`/dev/urandom` in a tmpfs container with no network, discarded) → drand round 6529525 beacon
(randomness `a0e36451…7589d3e`, 10 iterations), chosen after the contribution hash was fixed.

| file | sha256 |
|---|---|
| `shielded_withdraw_v3.r1cs` | `261a711512701a9e38dba2ef86c29d628a5b594b7c275dd6e3a428c398daa128` |
| `shielded_withdraw_v3_0000.zkey` | `8042e728e8e8b3107482ee0f46198c4ba5ae9df12bade7bba8e3eaf14d8dc5ed` |
| `shielded_withdraw_v3_final.zkey` (v3.1) | `c8c9d31044b4a034d86074e47c2a88ba15b69b283e98dd113c517c2df3c11f13` |
| `shielded_withdraw_v3_vk.json` (v3.1) | `4a1f265acac87fe528b2a63882c6429df68c12180478a9d499c098d89479c375` |
| `shielded_withdraw_v3_beacon_only_final.zkey` (v3, retired) | `3ed892ceed31f6be1fc9ffc46fc29bdc41091c1dc94393b28a11aaf30ee246f5` |
| `shielded_withdraw_v3_beacon_only_vk.json` (v3, retired) | `d1cb06d3956a7c1c7bc51289a395db4f6cc7341304a39405c447048acde1f60c` |

Contribution hashes: #1 beacon round 6000000 `9eb6d33c…3cd85feb`, #2 operator `28a5e4f9…526a14a8`,
#3 beacon round 6529525 `bf83d740…224306d9` (full values in the transcript and
`shielded_withdraw_v3/v3_1/zkey-verify.txt`). `vk.json` sha256 equals the header of
`crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs`, the VK compiled into the program.

Verify (snarkjs 0.7.5):

```bash
cd ceremony/shielded_withdraw_v3
snarkjs zkey verify shielded_withdraw_v3.r1cs powersOfTau28_hez_final_14.ptau shielded_withdraw_v3_final.zkey   # ZKey Ok!
snarkjs zkey export verificationkey shielded_withdraw_v3_final.zkey vk.json && sha256sum vk.json        # 4a1f265a…
# delta is not derivable from either public beacon (exit 0); on the v3 key it is (exit 3)
node ../check-beacon-delta.mjs --vk shielded_withdraw_v3_vk.json \
  --beacon a0e36451c3db3c675342740d2a5de2a59b4577bde0b5424c8a940d7647589d3e --iter 10
```

The v3 key (`transcript_v3.json`, kept as history) was the round 6000000 beacon applied directly to
`0000.zkey` with no secret contribution, so its delta was computable from public data and withdraw
proofs could be forged; see `shielded_withdraw_v3/ERRATA_v3.md`. `_0001` … `_0004.zkey` are from an
earlier dry run (simulated contributions) and are not in the chain of either key.
