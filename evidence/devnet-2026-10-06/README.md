# Devnet test evidence: 2026-10-06 deployment (fresh key)

Recorded runs against the 21 programs deployed on devnet on 2026-10-06 under upgrade authority
`9Jkphdpu3UQKgZToacyfDkwM3ZbzPjZYuK3sDyR8pU2q`. Program IDs, slots and deployed-bytes SHA-256 are in
[`../devnet-programs-2026-10-06.json`](../devnet-programs-2026-10-06.json); the same IDs are in
[`../../configs/devnet.oss.json`](../../configs/devnet.oss.json).

Cluster: devnet (`https://api.devnet.solana.com`; two reruns used the public OnFinality devnet endpoint).
Test payer: `GTs3YgDY4Aqi67wW4zr5xZdJCwBVHiwTrRdgWpFPjXD3`. Every transaction signature in the per-suite
files was re-read from the ledger (slot and error) after the run. Scripts ran from a `git archive` of this
repository inside a tmpfs container with `npm ci --ignore-scripts`. Each per-suite file keeps the command,
program IDs, signatures, slots, on-chain errors and the graded result. Raw console logs, probe sources and
evidence builders are published for reruns 2 and 3 under [`raw/`](./raw/); the earlier runs keep the per-suite
files only.

## First run (dna-x402 `8743fd7` plus the program-ID change committed as `121109d`)

| Suite | Program(s) | Result | Pass/Total | File |
|---|---|---|---|---|
| zk nullifier record | dark_nullifier_record `CPMf…` | PASS | 3/3 | [dna-zk-nullifier-record.json](./dna-zk-nullifier-record.json) |
| kvac devnet record | dark_nullifier_record `CPMf…` | PASS | 3/3 | [dna-kvac-devnet-record.json](./dna-kvac-devnet-record.json) |
| kvac x402 gateway | dark_nullifier_record `CPMf…` | PASS | 4/4 | [dna-kvac-x402-gateway.json](./dna-kvac-x402-gateway.json) |
| passport 01 faceid | dark_secp256r1_vault `GzB2…` | FAIL | 1/4 | [dna-passport-01-faceid.json](./dna-passport-01-faceid.json) |
| passport 02 webcrypto | dark_secp256r1_vault `GzB2…` | FAIL | 1/3 | [dna-passport-02-webcrypto.json](./dna-passport-02-webcrypto.json) |
| passport 03 metamask | dark_secp256k1_auth `7dF2…` | FAIL | 1/2 | [dna-passport-03-metamask.json](./dna-passport-03-metamask.json) |
| bv7x eth passport | dark_secp256k1_auth `7dF2…` | PASS | 1/1 | [dna-bv7x-eth-passport.json](./dna-bv7x-eth-passport.json) |
| bv7x signal anchor | receipt_anchor `HSdE…` | NO-OP (no Base events in the window) | 0/0 | [dna-bv7x-signal-anchor.json](./dna-bv7x-signal-anchor.json) |
| receipt-dag anchor (`anchorDagRoot`) | receipt_anchor `HSdE…` | PASS | 1/1 | [dna-receipt-dag-anchor.json](./dna-receipt-dag-anchor.json) |
| receipt-dag verify (accountability, proof-of-agency; read-only) | receipt_anchor `HSdE…` | PASS | 3/3 | [dna-receipt-dag-verify.json](./dna-receipt-dag-verify.json) |
| null registrar init | null_registrar `3Rhy…` | PASS | 2/2 | [dna-null-registrar-init.json](./dna-null-registrar-init.json) |
| nullpay stealth pay-by-name | null_registrar `3Rhy…` | PASS | 8/8 | [dna-nullpay-stealth-pay-by-name.json](./dna-nullpay-stealth-pay-by-name.json) |
| x402 access gate v2 | dark_x402_access_gate `7P7U…`, receipt_commitment_tree `Fyp5…`, receipt_anchor `HSdE…` | PASS (recipient ground below the BN254 modulus) | 5/5 | [dna-x402-access-gate-v2.json](./dna-x402-access-gate-v2.json) |
| shard message (banks, compressed receipts, chaff) | `499r…`, `7uEL…`, `4TQ4…` | PASS | 19/19 | [dna-shard-message-banks-compressed-chaff.json](./dna-shard-message-banks-compressed-chaff.json) |
| attack-replay suite T1–T10, new IDs | null_token_hook `Fg9r…`, dark_nullifier_banks `499r…`, receipt_commitment_tree `Fyp5…`, dark_null_mint_gate `FE3P…` | PASS | 13/13 | [dna-devnet-tests-suite-newids.json](./dna-devnet-tests-suite-newids.json) |
| attack-replay suite T1–T10, 2026-08-25 builds | earlier security-fix builds (not this deployment) | PARTIAL (T1 not idempotent with fixed keys) | 12/13 | [dna-devnet-tests-suite-asis.json](./dna-devnet-tests-suite-asis.json) |
| BLS12-381 credential | dark_bls12_381_credential `C3qe…` | PASS (accept path; pairing not executed in this build) | 1/1 | [dna-zk-bls12381-credential.json](./dna-zk-bls12381-credential.json) |
| eNULL fedimint e2e | dark_fedimint_redeem_program `26v6…` | PASS | 6/6 | [dna-enull-fedimint-e2e.json](./dna-enull-fedimint-e2e.json) |
| eNULL adversarial run | dark_fedimint_redeem_program `26v6…` | PASS (22 held, 0 broke) | 22/22 | [dna-enull-mayhem.json](./dna-enull-mayhem.json) |
| shielded pool v3 relay rail | dark_shielded_pool_program `FmLW…` | PASS (fourth attempt) | 8/8 | [dna-shielded-pool-v3-relay-rail.json](./dna-shielded-pool-v3-relay-rail.json) |
| shielded pool init buckets | dark_shielded_pool_program `FmLW…` | PASS | 3/3 | [dna-shielded-pool-init-buckets.json](./dna-shielded-pool-init-buckets.json) |
| ritual gate and transfer hook | dark_ritual_gate `GdL3…`, dark_ritual_transfer_hook `9zBL…` | PASS | 11/11 | [dna-probe-ritual-gate-and-hook.json](./dna-probe-ritual-gate-and-hook.json) |
| semaphore | dark_semaphore `4Zff…` | PASS | 8/8 | [dna-probe-semaphore.json](./dna-probe-semaphore.json) |
| lottery | dark_null_lottery `Ecs5…` | FAIL (AnchorTickets accepted a non-admin signer) | 11/12 | [dna-probe-lottery.json](./dna-probe-lottery.json) |
| proof gate lite | dark_proof_gate_lite `pfvd…` | PASS | 4/4 | [dna-probe-proof-gate-lite.json](./dna-probe-proof-gate-lite.json) |
| reputation gate, rejection paths | dark_reputation_gate `Cyz7…` | PARTIAL (positive path not exercised) | 7/7 | [dna-probe-reputation-gate-negatives.json](./dna-probe-reputation-gate-negatives.json) |

Totals: 158 pass, 8 fail across 26 suites ([`summary.json`](./summary.json)).

## Rerun after the fixes (dna-x402 `9ff95ee`)

Five programs were fixed in source and upgraded in place by the upgrade authority, then the affected suites
were rerun. Fix commits, upgrade signatures, slots and the on-chain hash check are in
[`devnet-upgrades-2026-10-06.json`](./devnet-upgrades-2026-10-06.json).

| Program | Fix | Commit | Upgrade tx |
|---|---|---|---|
| dark_secp256r1_vault `GzB2…` | precompile key and challenge binding in every build | `01f5e35` | `5hJvwyMz…` |
| dark_secp256k1_auth `7dF2…` | precompile address, message and signature binding in every build | `34047e2` | `2DwGkrg4…` |
| dark_null_lottery `Ecs5…` | AnchorTickets and RevealDraw require the config admin | `3134df4` | `53Kb2UMF…` |
| dark_shielded_pool_program `FmLW…` | PDA-keyed relay-rail buckets, admin-only Pause/Resume | `30a0ce6` | `n1Krdkjp…` |
| receipt_commitment_tree `Fyp5…` | leaf counterparty = Poseidon2(hi128, lo128) of the recipient key | `c9f03f8` | `2qtQsp9D…` |

The v3 ceremony files were regenerated in `7af7b21` (`zkey verify` OK; VK SHA-256 `d1cb06d3…` equals the
compiled VK).

| Suite | Result | Pass/Total | File |
|---|---|---|---|
| passport 01 faceid (wrong message 0x400b, wrong key 0x4009, sign-in) | PASS | 4/4 | [dna-passport-01-faceid-rerun.json](./dna-passport-01-faceid-rerun.json) |
| passport 02 webcrypto | PASS | 3/3 | [dna-passport-02-webcrypto-rerun.json](./dna-passport-02-webcrypto-rerun.json) |
| passport 03 metamask (wrong address 0x5008, message mismatch 0x5009) | PASS | 3/3 | [dna-passport-03-metamask-rerun.json](./dna-passport-03-metamask-rerun.json) |
| bv7x eth passport | PASS | 1/1 | [dna-bv7x-eth-passport-rerun.json](./dna-bv7x-eth-passport-rerun.json) |
| lottery (non-admin AnchorTickets/RevealDraw now 0x6008) | PASS | 12/12 | [dna-probe-lottery-rerun.json](./dna-probe-lottery-rerun.json) |
| shielded pool init buckets (PDA bucket, authority rejections) | PASS | 6/6 | [dna-shielded-pool-init-buckets-rerun.json](./dna-shielded-pool-init-buckets-rerun.json) |
| shielded pool v3 relay rail (committed zkey, every outcome read from the ledger) | PASS | 8/8 | [dna-shielded-pool-v3-relay-rail-rerun.json](./dna-shielded-pool-v3-relay-rail-rerun.json) |
| x402 access gate v2 (recipient keys above the BN254 modulus) | PASS | 6/6 | [dna-x402-access-gate-v2-rerun.json](./dna-x402-access-gate-v2-rerun.json) |
| reputation gate, positive path | NOT RUN: no committed zkey matches the compiled `track_record` VK | — | [`summary-rerun.json`](./summary-rerun.json) |

Rerun totals: 43 pass, 0 fail across 8 suites ([`summary-rerun.json`](./summary-rerun.json)).

## Rerun 2: ETH binding message and lottery claim binding (dna-x402 `a32933d`)

Two programs were upgraded in place from the fix commits; build, hashes and the on-chain dump check are in
[`devnet-upgrades-rerun2.json`](./devnet-upgrades-rerun2.json).

| Program | Change | Commit | Upgrade tx | Slot |
|---|---|---|---|---|
| dark_secp256k1_auth `7dF2…` | the precompile-verified message must be the EIP-191 binding message naming the program, agent key, ETH address, domain and auth hashes; new error 0x500A BindingMessageMismatch | `aabb759` | `23ddExeQ…` | 508063592 |
| dark_null_lottery `Ecs5…` | ClaimJackpot on a Drawn round requires the claimant's anchored ticket: numbers, leaf index and SHA-256 Merkle proof under `tickets_root` | `a32933d` | `2VhbnYX8…` | 508063672 |

| Suite | Result | Pass/Total | File |
|---|---|---|---|
| passport 03 metamask (wrong address 0x5008, message mismatch 0x5009, squat replay by a second Solana key 0x500A, intended agent registers the same address afterwards, legacy unbound message 0x500A) | PASS | 10/10 | [dna-passport-03-metamask-rerun2.json](./dna-passport-03-metamask-rerun2.json) |
| bv7x eth passport (binding message built by `scripts/passport/lib/eth-agent.mjs`) | PASS | 1/1 | [dna-bv7x-eth-passport-rerun2.json](./dna-bv7x-eth-passport-rerun2.json) |
| lottery claim (nullifier-only claim 0x600B, anchored losing ticket 0x600A, relabelled ticket 0x600B, winner's ticket and proof under another signer 0x600B, owner claims, second claim 0x6005) | PASS | 14/14 | [dna-probe-lottery-claim-rerun2.json](./dna-probe-lottery-claim-rerun2.json) |

Rerun 2 totals: 25 pass, 0 fail across 3 suites ([`summary-rerun2.json`](./summary-rerun2.json)). All 21
signatures were re-read from the ledger: 12 succeeded and 9 failed as the expected negatives
([`raw/rerun2/sig-status.json`](./raw/rerun2/sig-status.json)).

## Rerun 3: lottery FallbackDraw selection (dna-x402 `7439dde`)

dark_null_lottery was upgraded in place from `7439dde` (`359dmp5Q…`, slot 508071735, deployed bytes SHA-256
`d7048db0…`; [`devnet-upgrades-rerun3.json`](./devnet-upgrades-rerun3.json)). FallbackDraw takes three
consecutive Drawn rounds, requires the third round's committed draw seed and its anchored tickets root and
count, and records no winner; only the owner of the selected anchored ticket can claim.

| Suite | Result | Pass/Total | File |
|---|---|---|---|
| lottery claim and fallback. Part A: the rerun 2 cases on a fresh round. Part B: FallbackDraw by a non-admin 0x6008, with an uncommitted or another round's seed 0x6004, a pool root or size that is not the anchored tree 0x600C, rounds out of order 0x600E; the valid FallbackDraw; claims with the old synthetic nullifier 0x600B, an unselected ticket carrying the drawn numbers 0x600D, the selected ticket under another signer 0x600B; the selected owner claims; second claim 0x6005; claim on a NoWinner round 0x6007; FallbackDraw again 0x6007 | PASS | 41/41 | [dna-probe-lottery-claim-rerun3.json](./dna-probe-lottery-claim-rerun3.json) |

Rerun 3 totals: 41 pass, 0 fail ([`summary-rerun3.json`](./summary-rerun3.json)).

The message format, ticket tree, claim rules and error codes are documented in
[`docs/DARK_SECP256K1_AUTH.md`](../../docs/DARK_SECP256K1_AUTH.md) and [`docs/NULL_LOTTERY.md`](../../docs/NULL_LOTTERY.md).

### Raw files for reruns 2 and 3

- [`raw/rerun2/logs/`](./raw/rerun2/logs/): console logs, the lottery probe (`lottery-claim-rerun2.mjs`), its
  helper `lib.mjs` and `build-rerun2-evidence.mjs`, which produced the rerun 2 files above.
- [`raw/rerun2/src/evidence/`](./raw/rerun2/src/evidence/): the files the passport and bv7x scripts wrote.
- [`raw/rerun3/logs/`](./raw/rerun3/logs/): console log, upgrade log, the probe (`lottery-claim-rerun3.mjs`),
  `lib.mjs` and `build-rerun3-evidence.mjs`.

The scripts ran in a container and read the payer key from `/w/keys/payer.json` there; no key material is in
these files. Signatures sampled from reruns 2 and 3 (the three upgrades, passport register, squat replay,
intended-agent register, bv7x register, and six lottery claim and FallbackDraw cases) were confirmed on devnet
with `solana confirm -v <sig> --url devnet`; slot and status match the recorded files. Both upgraded programs
were dumped again after rerun 3: `dark_secp256k1_auth` hashes to `3af9a00d…` and `dark_null_lottery` to
`d7048db0…` over the built length, with a zero tail.

## Night run: x402_settle, null_lottery_pools, null_fair_draw (scripts at dna-x402 `e308957`)

Three programs deployed to devnet on 2026-10-06 under fresh program keys, each with `--max-len` equal to its `.so`
size. `solana program show` returned the deployer as authority and `dataLen` equal to the `.so` size; `solana program
dump` returned bytes whose SHA-256 equals the `.so`, with no trailing bytes
([devnet-deploys-x402-settle-lottery-pools-fair-draw.json](./devnet-deploys-x402-settle-lottery-pools-fair-draw.json)).

| Program | Program id | Deploy tx | Slot | Dumped bytes SHA-256 |
|---|---|---|---:|---|
| x402_settle | `DFt7SG4WUiy6qpYJRLTKdcx4dvSHE1dVG5sbTfXWbfZE` | `3kseFohz…` | 508174975 | `c93a2cdc…` |
| null_fair_draw | `FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL` | `553ZzuPA…` | 508177679 | `09a71388…` |
| null_lottery_pools | `39QHCDuqugs2Fm16CtvD3SBmDJp9n2WbdNGQPtqFZSxw` | `1jS76dW9…` | 508177819 | `63a16e8a…` |

The e2e scripts in `scripts/devnet-e2e/` ran in a tmpfs container (`npm install --ignore-scripts`); every outcome was
read back with `getTransaction`. Runs on the public RPC hit HTTP 429; the passing runs used a private devnet RPC and
`RPC_MAX_ATTEMPTS=12`.

| Suite | Result | Pass/Total | File |
|---|---|---|---|
| x402_settle main (run 2): B2 settle 1 / 2 / 25 payers / 32 vouchers per V1 tx, 7 negatives, channels and disputes, two-phase commit and abort, fan-out, solvency, RequestExit | PASS | 86/86 | [dna-x402-settle-e2e.json](./dna-x402-settle-e2e.json) |
| x402_settle main (run 1, public RPC): the failed check is an HTTP 429 at send (ReclaimChannel) | FAIL | 90/91 | [dna-x402-settle-e2e-run1.json](./dna-x402-settle-e2e-run1.json) |
| x402_settle cleanup of the run 1 escrows after the 9,000-slot exit delay | PASS | 79/79 | [dna-x402-settle-cleanup-run1.json](./dna-x402-settle-cleanup-run1.json) |
| x402_settle cleanup of the run 2 escrows after the 9,000-slot exit delay | PASS | 78/78 | [dna-x402-settle-cleanup-run2.json](./dna-x402-settle-cleanup-run2.json) |
| null_lottery_pools (run 3): small preset, all-combinations pool, rollover, 5 negatives, creator fees | PASS | 147/147 | [dna-lottery-pools-e2e.json](./dna-lottery-pools-e2e.json) |
| null_lottery_pools (run 1, public RPC): five HTTP 429 at send | FAIL | 140/145 | [dna-lottery-pools-e2e-run1.json](./dna-lottery-pools-e2e-run1.json) |
| null_lottery_pools (run 2, public RPC): retries outlasted the 150-slot claim window | FAIL | 148/151 | [dna-lottery-pools-e2e-run2.json](./dna-lottery-pools-e2e-run2.json) |
| null_fair_draw: open raffle (SOL), weighted list (SPL), verify() every round, negatives with exact codes | PASS | 96/96 | [dna-fair-draw-e2e.json](./dna-fair-draw-e2e.json) |

Devnet (2026-10-06): x402_settle 86/86, null_lottery_pools 147/147, null_fair_draw 96/96 checks.

## Not covered by these runs

- Reputation gate positive path: only the rejection paths ran; no proving key in the repository matches the
  compiled 7-input `track_record` VK.
- Passkey browser flows (Face ID / WebAuthn in a real browser) need a person at the device; the runs above
  use scripted P-256 keys.
- `dark_semaphore` and `dark_bls12_381_credential` run with `IS_MAINNET_READY = false`: Signal records
  nullifiers without a membership proof, and the BLS pairing step is not executed. `dark_proof_gate_lite`
  logs `NOT_ZK_VERIFIER`.
- Three shielded-pool buckets created by the first run with derivable authority keys stay pausable by anyone;
  use the PDA buckets created after the upgrade.

Dark-Null-Protocol runs from the same day (canonical proof cycle on `35GMe13…`) are recorded in that
repository's `evidence/` directory.
