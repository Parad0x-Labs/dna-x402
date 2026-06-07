# Private Track-Record Proof — spec (`dark_reputation_gate`)

*The privacy inversion of SAID's public `ReceiptAnchor`+reputation. SAID lets a lender read your
whole history in the clear; this lets an agent prove **"I have a real payment track record meeting
bar X"** while revealing nothing else. Unblocks receipt-backed reputation/lending without doxxing
the agent's business. Reuses primitives already live on mainnet.*

## STATUS — built + proven on devnet (2026-06-07)
`dark_reputation_gate` is **live on devnet** (`9nN7UTTT5hgKnc2LZTqr3qaLLSt5PxWUrDbpUTGYHRxp`) and
on-chain-proven end-to-end (K=4, depth-10 POC):
- real track-record proof **CONFIRMED**; **replay-same-nullifier REJECTED `Custom(10)`** (single-use
  via CPI to `dark_nullifier_record`); forged + tampered-min_volume + zero all **REJECTED**.
- circuit `track_record.circom` (12,100 constraints), VK in `dark-groth16-core::track_record_vk`,
  e2e `scripts/zk/track-record-e2e.mjs`, evidence `evidence/zk/track-record-devnet.json`.

**Full stack proven (2026-06-07):** `receipt_commitment_tree`
(`8jC8QGiDJRRxhbPXMX5wJnGUq89xJZ2LsHMdbn2urCas`, devnet) maintains the incremental Poseidon root
via the `sol_poseidon` syscall (constant cost — frontier + root history only, no leaves on-chain).
e2e `scripts/zk/full-stack-e2e.mjs`: insert receipts on-chain → the on-chain root **matches the
circuit's circomlib root byte-for-byte** → the gate verifies a track-record proof against that
on-chain root → single-use. tree → root → proof → gate all agree.

**Remaining before mainnet:** (1) point the tree `authority` at your real x402 settlement signer
(one config — the leaf-writer is built, generic); (2) multi-party ceremony + public ptau (same as
the access gate); (3) scale K/depth.

## Reuses (already deployed)
| Piece | ID | Role here |
|---|---|---|
| alt_bn128 Groth16 verifier (`dark_x402_access_gate`) | `EepqzV…` | same syscall + verify path; new VK + public-input layout → `dark_reputation_gate` |
| `receipt_anchor` | `9bPBmDNn` | anchors the **commitment** Merkle root (not public receipts) |
| `dark_nullifier_record` | `24tmjEd1` | records the per-epoch reputation nullifier → single-use proofs |
| identity commitment | — | `agent_commitment = Poseidon(secret, agent_id)` — **identical** to the access gate, so one identity spans "prove I'm funded" and "prove my track record" |

## Leaf + receipt tree
On x402 settlement, the **settlement layer** (facilitator/settlement program — *not* the agent) inserts:

```
leaf = Poseidon(agent_commitment, amount, timestamp, counterparty_hash, receipt_nonce)
```

into an incremental Poseidon Merkle tree (depth 20 = ~1M receipts). The on-chain `root` is updated
via `receipt_anchor`. **Trust crux:** the proof is only as honest as leaf insertion — leaves must be
written by the settlement layer that witnessed a real payment, never self-asserted. `counterparty_hash`
in the leaf makes self-dealing detectable (distinct counterparties can be required).

## Circuit `track_record.circom` (fixed K, e.g. K=16)
**Public inputs:** `root`, `min_count`, `min_volume`, `window_start`, `reputation_nullifier`,
`agent_commitment` *(optional — include → pseudonymous/.null-bound; omit → fully anonymous)`.

**Private witness:** `secret`, `agent_id`, and per receipt i∈[0,K): `amount_i, timestamp_i,
counterparty_hash_i, receipt_nonce_i, merkle_path_i, leaf_index_i`.

**Constraints:**
1. `agent_commitment == Poseidon(secret, agent_id)`.
2. ∀i: `leaf_i = Poseidon(agent_commitment, amount_i, ts_i, cp_i, nonce_i)` and `merkle_path_i`
   opens `leaf_i` under `root`. *(each receipt is really in the anchored tree AND is this agent's)*
3. ∀i: `timestamp_i ≥ window_start`. *(inside the window)*
4. `leaf_index_i` strictly increasing → the K receipts are **distinct** (can't count one twice).
5. `K ≥ min_count`  and  `Σ amount_i ≥ min_volume`.
6. `reputation_nullifier == Poseidon(secret, epoch)` → single-use per epoch (recorded in
   `dark_nullifier_record`, replay = `Custom(10)`).

## Public / private split
| Field | Public | Private | Why |
|---|:--:|:--:|---|
| `root` | ✓ | | verifier asserts it == the on-chain `receipt_anchor` root |
| `min_count` / `min_volume` / `window_start` | ✓ | | the bar the consumer requires |
| `reputation_nullifier` | ✓ | | single-use, anti-replay |
| `agent_commitment` | opt | opt | public → pseudonymous; omit → anonymous |
| every `amount` / `timestamp` / `receipt_id` / `counterparty` / `path` | | ✓ | **the entire point — never leaks** |
| `secret`, `agent_id` | | ✓ | identity stays hidden |

## Flow
1. agent pays via x402 → settlement layer commits `leaf` → `root` anchored on-chain.
2. consumer (lender / marketplace / gated API) demands: "≥10 receipts, ≥ $1000, last 90 days".
3. agent runs `snarkjs fullprove` over their receipts + paths.
4. proof → `dark_reputation_gate`: verifies against the on-chain `root` + thresholds, records the
   nullifier. `Ok` ⇒ the bar is met; nothing else is learned.

## Why it beats SAID
- **Authenticated, not self-asserted** — leaves come from settlement; SAID reputation is
  self-submitted feedback ("no validation of authenticity", their words).
- **Discloses only the verdict** — lender learns "meets bar", not the history. SAID is fully public.
- **Single-use** — nullifier stops replay/double-counting. SAID has none.
- Pairs with **bonded stake + ZK-fraud-slash** (steal #2): track record + skin-in-the-game, both private.

## Build sequence
1. Lock the leaf schema + decide the settlement-layer leaf-writer (the trust anchor). *(design)*
2. `track_record.circom` — Merkle-membership×K + range/sum/count + nullifier (reuse Poseidon + Merkle gadgets). Compile, `r1cs info`.
3. Trusted setup — single-party for devnet; **multi-party ceremony before any trust claim** (same gate as the access gate; do them together).
4. `dark_reputation_gate` — clone `dark_x402_access_gate`, swap VK + public-input parse (NR_PUBLIC_INPUTS = 5–6). Same alt_bn128 path. On-chain Poseidon via **light-poseidon** (Veridise-audited, circomlib-compatible).
5. e2e (mirror today's `x402-access-full-e2e`): anchor test receipts → real proof CONFIRMED on devnet → forged / insufficient-count / out-of-window / replayed-nullifier all REJECTED → mainnet when green.

## Open decisions
- **Fixed K**: Groth16 is fixed-size → prove exactly K (= a tier bar). Tiers: K∈{4,16,64} circuits, or fold/recurse later. Start K=16.
- **Counter-Sybil**: require distinct `counterparty_hash`, weight by volume not raw count, and/or require a bonded stake (steal #2) so gaming costs real SOL.
- **Window proof**: `window_start` is a public input the consumer sets to `now − 90d`; circuit enforces `ts ≥ window_start`. (Upper bound `ts ≤ root_time` falls out of Merkle membership.)
