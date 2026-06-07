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
