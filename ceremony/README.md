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
Hermez PPOT phase 1 (`powersOfTau28_hez_final_14.ptau`, sha256 `489be9e5…`) and a drand-only
phase-2 beacon (League of Entropy round 6000000, randomness `642f13b2…a38114`, 10 iterations)
applied directly to `shielded_withdraw_v3_0000.zkey`. Full record: `shielded_withdraw_v3/transcript_v3.json`.

| file | sha256 |
|---|---|
| `shielded_withdraw_v3.r1cs` | `261a711512701a9e38dba2ef86c29d628a5b594b7c275dd6e3a428c398daa128` |
| `shielded_withdraw_v3_0000.zkey` | `8042e728e8e8b3107482ee0f46198c4ba5ae9df12bade7bba8e3eaf14d8dc5ed` |
| `shielded_withdraw_v3_final.zkey` | `3ed892ceed31f6be1fc9ffc46fc29bdc41091c1dc94393b28a11aaf30ee246f5` |
| `shielded_withdraw_v3_vk.json` | `d1cb06d3956a7c1c7bc51289a395db4f6cc7341304a39405c447048acde1f60c` |

Beacon contribution hash: `9eb6d33c b0cc29bf bcdacbc0 5e1c41e8 aa57c82e 5fe26c43 6a220cdf 60110a10 8413c79b 0e12a4ba d4702a11 d933118f faef25e3 f0f09668 7941b9c5 3cd85feb`.
`vk.json` sha256 equals the header of `crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs`,
i.e. the VK compiled into the program. Reproduce (snarkjs 0.7.5):

```bash
cd ceremony/shielded_withdraw_v3
snarkjs zkey beacon shielded_withdraw_v3_0000.zkey shielded_withdraw_v3_final.zkey \
  642f13b2933302bbdec93259cdd269cbddd9c637fda4b29dd975703723a38114 10 \
  -n="drand Final Beacon (fixed round 6000000)"
snarkjs zkey export verificationkey shielded_withdraw_v3_final.zkey shielded_withdraw_v3_vk.json
sha256sum shielded_withdraw_v3_vk.json      # d1cb06d3…
snarkjs zkey verify shielded_withdraw_v3.r1cs powersOfTau28_hez_final_14.ptau shielded_withdraw_v3_final.zkey   # ZKey Ok!
```

The VK does not depend on the `-n` name; the final zkey sha256 does. `_0001` … `_0004.zkey` are
from an earlier dry run (simulated contributions) and are not in the chain of the final key.
