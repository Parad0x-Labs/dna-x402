# Dark Null True Alien Demo Flow

> A 10-step pipeline connecting all True Alien Primitives into one end-to-end Parad0x session.
> No network required to run locally. All steps are pure Rust, deterministic, offline-verifiable.

---

## The Scenario

An AI trading agent ("Rogue Alpha") is given a caveated spending permission, observes a market signal, seals a prediction, executes a shadow bundle of transactions, logs everything in a tamper-evident black box, and settles a payment channel — all without custody, all with unlinkable nullifiers, and all with a chaff layer that makes chain analysis impossible.

---

## Step 1 — Issue Agent Permission (agent-permission-notes)

The operator issues `AgentPermissionNote` to Rogue Alpha:
- Max 0.05 SOL per spend, 0.5 SOL total
- Expires in 5000 slots
- Withdrawal scope denied
- Kill switch: operator can rotate the hash to invalidate all proofs immediately

```
note_hash = SHA256(agent_id || issuer || scopes || caps || expiry || kill_switch)
```

Rogue Alpha stores `note_hash`. Every spend proof it generates must reference this hash. If the operator rotates the note (changes expiry, caps, adds a scope), `note_hash` changes and all existing spend proofs become invalid.

---

## Step 2 — Seal the Alpha (alpha-capsules)

Rogue Alpha observes the market. Before acting, it seals a prediction capsule:
- Side: `[LONG]` (as bytes)
- Salt: random 32 bytes
- Confidence: 4/5
- Reveal slot: current + 100

```
side_commitment = SHA256("dark_null_v1_alpha_side" || [LONG] || salt)
```

The capsule is published (commitment only). Rogue Alpha keeps the salt private. After slot+100, anyone can verify the original side by presenting (side, salt) and confirming the commitment matches.

---

## Step 3 — Compile the Ritual (onchain-puzzle-compiler)

Before executing, Rogue Alpha generates a ritual tx plan spelling "DNA" in DARKNULL shard bytes:
- Step 0: shard 'D' (68) — epoch 0, solve for matching nullifier
- Step 1: shard 'N' (78)
- Step 2: shard 'A' (65)

```
shard_byte = SHA256(nullifier || epoch_le64 || domain)[0]
```

The ritual plan is hashed and stored as `ritual_hash`. The execution trace later proves these three transactions were deliberate, not random.

---

## Step 4 — Build Shadow Bundle (spend-shadows)

Rogue Alpha wraps the real spend in a shadow bundle:
- 1 real leaf: actual market entry (1_000_000 lamports)
- 2 decoy leaves: plausible-looking amounts, different scopes
- 1 delayed leaf: reveal_slot = current + 500 (simulates a "pending settlement")
- 1 poison leaf: if anyone tries to redeem this leaf, they're flagged

All 5 leaves encode to exactly 81 bytes. A chain analyst sees 5 identical-looking spend leaves and cannot determine which one was real.

```
copy_sniper_precision = 1.0 / 5 = 0.20
```

---

## Step 5 — Spend Against Permission (agent-permission-notes)

Rogue Alpha creates a `PermissionSpend` for the real leaf:

```
nullifier = SHA256("dark_null_v1_permission_nullifier" || note_hash || scope || slot)
```

Spend check pipeline (8 steps) passes:
- permission_hash matches note_hash ✓
- kill switch not triggered ✓
- not expired ✓
- 1_000_000 lamports ≤ max_per_spend ✓
- total_spent + 1_000_000 ≤ max_total ✓
- scope not in withdrawal scopes ✓
- scope not denied ✓
- scope in allowed set ✓

---

## Step 6 — Log to Black Box (agent-flight-recorder)

Rogue Alpha records the action as a `FlightRecord`:

```
record_hash = SHA256(agent_id || model_output_hash || spend_receipt_hash || scope || lamports || outcome || slot || previous_flight_hash)
```

The record chains to the previous flight hash. If this is the first record in the session, `previous_flight_hash = [0u8; 32]`.

A `RedactedFlightView` is produced (strips `model_output_hash` and `spend_receipt_hash`) — this can be shared publicly to prove accountability without leaking the model's internal reasoning or the exact spend receipt.

---

## Step 7 — Issue a Receipt Soul (receipt-souls)

After settlement, the counterparty receives a `ReceiptSoul` of type `Tip`:
- Transfer policy: `OneHopOnly` (recipient can pass it once, then it's bound)
- Redemption policy: `BurnAfterRead`

```
soul_nullifier = SHA256("dark_null_v1_soul_nullifier" || soul_id_hash || holder_hash || expiry_slot_le)
```

`issuer_hash` is NOT in the nullifier preimage. A spent soul nullifier cannot be linked back to Rogue Alpha as the issuer.

---

## Step 8 — Settle the Session Channel (session-note-channel)

The session accumulated 5 payment notes across different scopes. Settlement:

```
nullifier_i = SHA256("dark_null_v1_session_note" || session_hash || index_le4 || scope_hash_i)
settlement_root = SHA256(sort(nullifiers))
```

No channel PDA was ever created. No on-chain state existed during the session. The settlement root is a single hash that proves all 5 payments occurred without revealing their individual amounts or scopes.

---

## Step 9 — Run Productive Chaff (chaff-economy)

While the real transactions settle, the chaff layer activates. The `ChaffMarket` selects the best available job:

```
best_job = max(valid_jobs by reward_lamports)
→ CompactReceiptRoot: 12_000 lamports
```

Three chaff PDAs execute:
- One compacts an old receipt root (earns 12_000 lamports)
- One closes an expired account (earns 10_000 lamports)
- One is a pure decoy (no maintenance target, no reward — pure noise)

A chain analyst sees three PDAs doing similar-looking work. They cannot determine which one is the real maintenance action and which is noise.

---

## Step 10 — Attest No Custody + Commit to Roadmap (no-custody-attestation + roadmap-commitments)

**No-custody attestation:** The relayer that routed Rogue Alpha's transactions produces a `NoCustodyAttestation`:
- All 4 `DeniedKeyClass` variants present: Withdraw, Transfer, Mint, Approve
- `custody_denied: true`
- Risk score: 0

Any future routing decision that checks this relayer's attestation gets `risk_score = 0`, confirming it never held user funds.

**Roadmap commitment:** The protocol commits to a future feature ("session note compression"):
```
feature_hash = SHA256("dark_null_v1_feature" || docs_hash || tests_hash)
commitment_hash = SHA256(feature_hash || committed_at_slot_le || deadline_slot_le)
```

When the feature ships, a `FeatureReveal` proves the implementation matches the original commitment — and the deadline was not missed.

---

## End State

| Primitive | What was produced |
|---|---|
| agent-permission-notes | note_hash, 1 valid PermissionSpend, kill switch active |
| alpha-capsules | sealed side_commitment, ready to reveal at slot+100 |
| onchain-puzzle-compiler | RitualPlan spelling "DNA" in DARKNULL shard bytes |
| spend-shadows | 5-leaf bundle (1 real, 2 decoy, 1 delayed, 1 poison) |
| agent-flight-recorder | FlightRecord chain + RedactedFlightView |
| receipt-souls | 1 Tip soul with OneHopOnly + BurnAfterRead |
| session-note-channel | SessionSettlement root over 5 notes |
| chaff-economy | 3 chaff jobs (2 real maintenance, 1 decoy) |
| no-custody-attestation | attestation_hash, risk_score = 0 |
| roadmap-commitments | commitment_hash, deadline_slot, ready for reveal |

**Zero network calls. Zero on-chain state. Zero custody. Zero linkable nullifiers.**

All 10 primitives run in a single `cargo test --workspace` in under 1 second.

---

## Running Locally

```sh
# All 10 primitives — no network required
cargo test -p agent-permission-notes
cargo test -p spend-shadows
cargo test -p agent-flight-recorder
cargo test -p receipt-souls
cargo test -p alpha-capsules
cargo test -p chaff-economy
cargo test -p session-note-channel
cargo test -p onchain-puzzle-compiler
cargo test -p no-custody-attestation
cargo test -p roadmap-commitments

# Or all at once
cargo test --workspace
```

## What Requires Network

Nothing in the True Alien Primitives layer requires network access. The devnet evidence layer (`dark-x402-devnet-verify`) requires devnet RPC — run separately:

```sh
cargo run -p dark-x402-devnet-verify --bin x402_devnet_real
```
