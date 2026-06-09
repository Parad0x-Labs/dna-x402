# Dark Relay Rail — fully-unlinkable shielded payment rail (devnet)

Status: **Public Beta scope — devnet only, non-custodial, capped, UNAUDITED, no audit
scheduled.** `mainnet_ready = false` throughout. Single-party VK is the on-chain default;
the trustless multi-party VK is produced by a ceremony pipeline (dry-run today). Do not
claim "audited", "trustless on mainnet", or any date.

The Dark Relay Rail extends `dark_shielded_pool` (shielded_withdraw **v3**) into a
decentralized, unlinkable payment rail with **no central relayer and no admin**:

| Privacy / decentralization axis | Mechanism | State |
|---|---|---|
| **Sender hidden** | ZK membership proof over a Poseidon Merkle tree of note commitments — a withdrawal proves "I own *a* note in this pool" without revealing which. | ✅ live (v2→v3) |
| **Amount hidden** | Fixed **denomination buckets** (0.1 / 1 / 10 SOL). Every note in a bucket is identical, so a withdrawal reveals only the bucket, never the balance or exact transfer. | ✅ live |
| **Recipient hidden** | Stealth addresses (NullPay) — recipient derives a one-time address; nobody links it to their main wallet. | ⏳ documented stub (follow-up) |
| **Gas paid by permissionless relayers** | Any wallet can submit a withdraw; it is reimbursed an **in-proof fee** from the pool. No central relayer server, no allow-list. | ✅ live (v3) |
| **Trustless setup** | Open multi-party ceremony: public Powers-of-Tau phase-1 + multiple independent phase-2 contributions + a public drand beacon. | ⚙️ pipeline + dry-run (real beacon); needs independent humans |

## 1. In-proof relayer fee (the trustless relayer incentive)

In v2 the withdraw paid the full denomination to the recipient and a `fee_payer`
(relayer) merely signed + funded the nullifier-record rent for free. There was no
permissionless market: a relayer could not safely be paid out of the pool because
nothing bound the fee.

v3 binds the relayer **and** the fee into the Groth16 proof. The circuit
(`circuits/shielded_withdraw_v3.circom`) adds public inputs and constraints:

```
public  [nullifier, merkle_root, recipient, pool_id, relayer, fee, denomination]
constraints:
  payout_recipient === denomination - fee     // exact split
  fee <= MAX_FEE   (LessEqThan, MAX_FEE = 0.05 SOL)   // relayer cannot over-charge
  fee <= denomination                                  // payout cannot underflow
```

On-chain (`programs/dark_shielded_pool`), `process_withdraw`:
- requires `relayer == fee_payer` (the submitter that fronted gas reimburses itself);
- re-checks `fee <= denomination` (fail-closed before any subtraction);
- verifies the 7-public-input proof (`gamma_abc.len() == 8`) via the real `alt_bn128`
  pairing syscall, passing `relayer`, `fee`, `denomination` as public inputs;
- does a **2-way payout**: `recipient += denomination - fee`, `relayer += fee`.

Result: **anyone** can run a relayer, gets reimbursed the proof-capped fee, and is
provably unable to redirect the recipient's funds or inflate the fee. No central server,
no admin. A front-runner who swaps the recipient or relayer account invalidates the proof
(`ProofInvalid`), and a third party who replays someone else's proof under their own
relayer key is rejected because `relayer != fee_payer` / the bound relayer mismatches.

## 2. Denomination buckets (amount privacy)

`InitPool` takes a denomination; the rail stands up N fixed-denom pools. The devnet init
script (`build/zk/init-buckets-devnet.mjs`) creates **0.1 / 1 / 10 SOL** buckets, each a
distinct pool PDA keyed by a deterministic per-denomination authority (idempotent).

**Splitting arbitrary amounts.** To move an arbitrary amount privately, the wallet
decomposes it (largest-bucket-first) into a multiset of identical notes, then deposits +
withdraws each note independently. Example — 12.3 SOL:

```
12.3 SOL = 1×10 + 2×1 + 3×0.1  (+ 0.0 remainder)
```

The on-chain footprint is just a set of identical bucket operations; an observer sees
"some 10-SOL, some 1-SOL, some 0.1-SOL notes moved", not 12.3 SOL from wallet X to
wallet Y. A remainder smaller than the smallest bucket is paid transparently or rounded by
the wallet; arbitrary-precision privacy needs a smallest "dust" denomination.

## 3. Open multi-party ceremony (makes the VK trustless)

A Groth16 VK is derived from secret randomness ("toxic waste"). Whoever knows it can
**forge withdrawals**. The on-chain devnet pilot VK is **single-party** (one machine,
forgeable → devnet only, `mainnet_ready=false`). The ceremony fixes this; the setup is
sound as long as **≥1 contributor was honest**.

`ceremony/run-ceremony-v3.mjs`:
1. **Phase-1**: downloads + `snarkjs powersoftau verify`s a **public** Hermez Perpetual
   Powers of Tau (`powersOfTau28_hez_final_14.ptau`, 54+ contributions). We never run our
   own phase-1.
2. **Phase-2**: `groth16 setup` + **multiple independent** `zkey contribute` steps.
3. **Beacon**: finalises with a **real drand round** fetched live from the League of
   Entropy (`api.drand.sh`). A real run **pre-commits** the round number before starting
   so it cannot be ground.
4. Verifies (`zkey verify` → `ZKey Ok!`) and exports the candidate trustless VK + a
   verifiable `transcript_v3.json` (r1cs/ptau/zkey/vk SHA-256, every contribution hash,
   the drand round + randomness).

Anyone contributes via `ceremony/CONTRIBUTING_V3.md` — that is the decentralized part.

**Honest scope:** the dry run's contributions are simulated-independent (one operator),
so it is **not yet trustless** — it becomes trustless when those steps are run by
independent humans. The **drand beacon is real**. Swapping the ceremony VK into the
verifier and re-running the e2e under it is supported via `--vk-mode ceremony`.

## 4. Devnet e2e (full unlinkability)

`build/zk/e2e-v3-devnet.mjs` (evidence → `evidence/dark-relay-rail-devnet.json`):
deposit into a bucket → real V3 proof for a withdraw to a **fresh** recipient with a
relayer fee → submitted by a **relayer** (`fee_payer != recipient`, recipient never
signs) → asserts recipient gets `denom - fee`, relayer is reimbursed `fee`, and:
double-spend / wrong-root / wrong-recipient / over-fee / relayer-mismatch all **revert**.

## 5. NullPay stealth recipient — follow-up stub

Sender + amount are hidden today; the **recipient** is still a plain wallet in the e2e.
To make the recipient unlinkable, integrate stealth addresses (NullPay):

- Recipient publishes a stealth meta-address `(B = bG)`; the sender draws ephemeral `r`,
  derives the one-time address `P = H(rB)·G + B` and publishes `R = rG` in the note.
- The recipient scans with `b`, recomputes `P`, and withdraws to `P` — only they can link
  `P` to themselves; on-chain it is a fresh, unlinkable address.
- Circuit impact: bind the stealth one-time address as the `recipient` public input
  (already a field element), so no circuit change is required — only client-side key
  derivation + a scanning service. Tracked as the next deliverable.

## Files

- Circuit: `circuits/shielded_withdraw_v3.circom` (canonical) + `build/zk/shielded_withdraw_v3.circom` (ASCII build copy).
- Program: `programs/dark_shielded_pool/src/{instruction,processor,error}.rs`.
- VK: `crates/dark-groth16-core/src/shielded_withdraw_v3_vk.rs` (regen: `build/zk/vk-to-rust-v3.mjs`).
- Setup (pilot): `build/zk/run-setup-v3.mjs`. Prover: `build/zk/prove-v3.mjs`.
- Ceremony (trustless): `ceremony/run-ceremony-v3.mjs` + `ceremony/CONTRIBUTING_V3.md`.
- Buckets: `build/zk/init-buckets-devnet.mjs`. E2E: `build/zk/e2e-v3-devnet.mjs`.
- Evidence: `evidence/dark-relay-rail-devnet.json`, `evidence/dark-relay-rail-buckets-devnet.json`.
