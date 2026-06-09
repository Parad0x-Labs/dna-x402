# Contributor guide — shielded_withdraw_v3 trusted-setup ceremony (DARK RELAY RAIL)

This is how **anyone** contributes to the multi-party ceremony that makes the V3
verifying key **trustless**. The Groth16 setup is sound as long as **≥1 contributor
was honest and destroyed their secret randomness** — so the more visibly-independent
contributors, the stronger the guarantee. You do **not** need to trust the
coordinator, the other contributors, or Parad0x — only yourself.

> Scope today: the on-chain devnet pilot uses a single-party VK
> (`mainnet_ready=false`). `ceremony/run-ceremony-v3.mjs` runs the full pipeline as a
> **dry run** (simulated-independent contributions + a **real drand beacon**) to prove
> the machinery and transcript format. The steps below are the **real** flow — replace
> the simulated contributors with independent humans to make it genuinely trustless.

## What you need
- `node` 18+ and `snarkjs@0.7.5` (`npm i -g snarkjs@0.7.5`).
- The current `shielded_withdraw_v3_{k-1}.zkey` from the previous contributor (the
  coordinator publishes a link; verify its SHA-256 against the transcript first).
- The published `shielded_withdraw_v3.r1cs` and its SHA-256 (so you can confirm you are
  contributing to the **exact** circuit in `circuits/shielded_withdraw_v3.circom`).

## Phase 1 — DO NOT run your own
Phase-1 ("powers of tau") is universal and the riskiest to self-generate. We reuse a
**public** one: Hermez `powersOfTau28_hez_final_14.ptau` (54+ independent contributions).
Verify it once:
```bash
snarkjs powersoftau verify powersOfTau28_hez_final_14.ptau   # -> "Powers Of Tau Ok!"
```

## Phase 2 — your contribution (run on YOUR machine, with YOUR entropy)
```bash
# 0. confirm you have the right circuit + previous zkey
sha256sum shielded_withdraw_v3.r1cs                 # must match the published r1cs_sha256
sha256sum shielded_withdraw_v3_{k-1}.zkey           # must match the transcript's previous entry

# 1. contribute (snarkjs will prompt for entropy — bash the keyboard AND add OS randomness)
snarkjs zkey contribute shielded_withdraw_v3_{k-1}.zkey shielded_withdraw_v3_{k}.zkey \
  --name="<your handle / org>"

# 2. publish your Contribution Hash (printed by snarkjs) as an attestation:
#    a signed note / Gist / tweet stating: your handle, contribution index k,
#    and the 64-byte hex Contribution Hash. This is what makes your step auditable.
```
**Destroy your entropy and machine state afterwards** (close the terminal, wipe scratch
files). Your secret must not survive.

Hand `shielded_withdraw_v3_{k}.zkey` to the next contributor (or back to the coordinator).

## Beacon — pre-committed public randomness (coordinator, final step)
**Before** the ceremony starts the coordinator publicly commits to a future drand round
number (announced + timestamped). When that round publishes, it is applied as the final,
deterministic, verifiable contribution — nobody can grind it because it was fixed in
advance:
```bash
# BEACON_HEX = the drand round's `randomness` (32-byte hex), round pre-committed
snarkjs zkey beacon shielded_withdraw_v3_{N}.zkey shielded_withdraw_v3_final.zkey \
  <BEACON_HEX> 10 -n="drand Final Beacon"
```
The dry-run script fetches a **real** drand round live to prove this end-to-end; a real
run uses the **pre-committed** round.

## Verify — anyone, independently
```bash
snarkjs zkey verify shielded_withdraw_v3.r1cs powersOfTau28_hez_final_14.ptau \
  shielded_withdraw_v3_final.zkey                   # -> "ZKey Ok!"
```
Then cross-check, against `ceremony/shielded_withdraw_v3/transcript_v3.json`:
1. `r1cs_sha256` matches the published `circuits/shielded_withdraw_v3.circom` build.
2. Every contribution's `zkey_sha256` matches that contributor's published attestation.
3. The `beacon.round` matches the **pre-committed** drand round, and the randomness
   matches `https://api.drand.sh/<chain>/public/<round>`.
4. `verify` reproduces `ZKey Ok!`.

## Flip to mainnet (only after this ceremony + an external audit)
1. Regenerate the on-chain VK from the **ceremony's** final zkey:
   `node build/zk/vk-to-rust-v3.mjs ceremony/shielded_withdraw_v3/shielded_withdraw_v3_vk.json "<ceremony label>"`
2. Only after an external audit, set `mainnet_ready: true` and upgrade the program.
3. Only then claim "trustless setup".
