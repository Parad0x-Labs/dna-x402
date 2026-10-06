# null_fair_draw: draw math

Notation: entries (leaves) `i = 0..L-1` with weights `w_i >= 0` (unweighted draws: every `w_i = 1`),
`T = sum w_i`, leaf `i` owns the interval `I_i = [s_i, s_i + w_i)` with `s_i = sum_{l<i} w_l`. Slots
`j = 0, 1, 2, ...` are drawn in order; `S_j` is the set of leaves won by slots before `j`, `W_j = sum_{i in S_j} w_i`.
Code references are to `src/stream.rs` and `src/processor.rs`.

## 1. Randomness and the stream

The seed of round `r` is `seed_r = SHA-256("null-fair-draw:seed:v1" || draw || r || T_r || used_r || slot_hash || root || T || L)`,
where `slot_hash` is the SlotHashes entry of the earliest produced slot at or after the target `T_r`. `T_r` is
fixed before its hash exists: `close_slot + 32` for an open raffle (set at creation), `commit_slot + 32` for a
committed list, `window_end_{r-1} + 32` for a re-draw round; if `T_r` has aged out of the 512-entry window the
fixed fallback `T_r + 512 * a` is used (shared with `null_lottery_pools`). The draw instruction takes no
randomness and no choice from its caller.

Slot `j` uses `X_j = B(j,0) || B(j,1)`, `B(j,b) = SHA-256("null-fair-draw:stream:v1" || seed_r || j || b)`, read as a
512-bit integer. Model: SHA-256 is a random oracle and `slot_hash` is unknown when the inputs are fixed, so the
`X_j` are independent and uniform on `[0, 2^512)`.

## 2. Reduction to `[0, m)` and its bias bound

`u_j = X_j mod m`, with `m = T - W_j`, `1 <= m < 2^64`. Write `2^512 = q m + t`, `0 <= t < m`. Residues `x < t`
have `q + 1` preimages, the others `q`. So `P(u = x) - 1/m` is `(m - t) / (m 2^512)` or `-t / (m 2^512)`; both
have absolute value `< 2^-512`. The statistical distance from uniform is

```text
d = 1/2 * sum_x |P(u = x) - 1/m| <= 1/2 * m * 2^-512 < 2^63 * 2^-512 = 2^-449.
```

Over `k` slots the joint distance is at most `k * 2^-449 <= 2^10 * 2^-449 = 2^-439` (at most 1024 slots per
draw), below the `2^-128` target by a factor above `2^311`. In what follows `u_j` is treated as exactly uniform;
every probability below holds up to this additive `2^-439`.

## 3. Mapping past won intervals

`p = remap(u, won)` walks the won intervals in ascending order of start and adds the length of every interval
that starts at or before the running point. Let `R_j = [0, T) \ union_{i in S_j} I_i` (`|R_j| = m`).

Claim: `remap` is the increasing bijection `f: [0, m) -> R_j`. Proof by induction over the sorted intervals
`(a_1, l_1), ..., (a_n, l_n)`. Below the lowest interval, points `< a_1` are unchanged and are exactly the
points of `R_j` below `a_1`. If `u >= a_1` the walk adds `l_1`, moving `u` to `u + l_1 >= a_1 + l_1`, i.e. past
`I_{(1)}`; the remaining intervals all start at or after `a_1 + l_1` (disjoint and sorted), so the same argument
applies to the shifted point against the remaining intervals. The result is never inside a won interval and the
map is strictly increasing, hence injective; both sides have `m` points, so it is a bijection. Intervals of
distinct leaves are disjoint because they partition `[0, T)` (sum tree, section 6).

## 4. Correctness of weighted sampling

Given `S_j`, `u_j` is uniform on `[0, m)`, so `p_j = f(u_j)` is uniform on `R_j`. Leaf `i` not in `S_j` owns
`w_i` points of `R_j`, leaves in `S_j` own none. Therefore

```text
P(slot j wins leaf i | S_j) = w_i / (T - W_j)   for i not in S_j,   0 for i in S_j.
```

A zero-weight leaf owns no point and is never drawn (the program also refuses its proof, `ZeroWeight`).

**Equivalence with re-drawing on a collision.** Drawing `p` uniformly on `[0, T)` and re-drawing while `p` falls
in a won interval returns leaf `i` with probability `sum_{r>=0} (W_j/T)^r * w_i/T = w_i / (T - W_j)`, the same
distribution. The program uses the mapped form because it needs exactly one stream value per slot (bounded CU);
the re-draw form needs an unbounded number of retries when the won weight is close to `T`.

## 5. The without-replacement distribution

Multiplying section 4 over slots, the ordered winners `(i_1, ..., i_k)` of `k` slots have probability

```text
P(i_1, ..., i_k) = prod_{j=1..k} w_{i_j} / (T - sum_{l<j} w_{i_l})      (distinct i's; 0 otherwise)
```

This is successive sampling without replacement (the Plackett-Luce order). Facts stated precisely:

- The slot-0 winner is proportional to weight. Later inclusion probabilities are *not* proportional to weight
  for `k > 1` (heavy entries saturate: an entry cannot win twice).
- **Unweighted** (`w_i = 1`): `P(i_1..i_k) = (L-k)! / L!`, uniform over ordered `k`-tuples of distinct indices,
  the distribution of a partial Fisher-Yates shuffle. The leaf index is the point itself, so the program resolves
  up to 24 unweighted slots per instruction with no proof.
- **No duplicate winners**: `p_j` is outside every won interval, so a leaf wins at most one slot; the fuzz and
  `heavy_leaf_wins_once_and_zero_weight_is_rejected` check it on chain.
- **Re-draw rounds** continue the same process with the won set carried over (forfeited winners stay excluded)
  and a fresh seed per round; within a round the formula above holds with `T - W` taken at the round's start.

**Determinism.** Slot `j`'s point depends only on `seed_r`, `j` and the won intervals of slots `< j`. A weighted
Resolve must present the proof of the unique leaf containing the point (section 6); an unweighted Resolve needs
none. Batch sizes and crankers therefore cannot change any winner.

## 6. Sum tree soundness

Each node commits `(hash, weight)`; the parent hash covers both children's weights. A proof that reaches the
committed `(root, T)` from `(leaf, w_i)` at index `i` authenticates every sibling weight on the path, so the
prefix it accumulates is `s_i` and the leaf owns `I_i`; under collision resistance no other `(index, weight)`
reaches the same root. Leaf and node preimages are domain separated (tag prefix, 94 vs 81 bytes).

## 7. Prize conservation

Every round-0 slot carries one prize of amount `a(t)` (its tier). A slot ends in exactly one of: `CLAIMED`
(`paid += a`, the amount leaves once: the status moves `WON -> CLAIMED` before any second claim could pass),
`VOID` (no weight left: `refundable += a` at once), or `FORFEITED`. A forfeited slot either creates exactly one
new slot of the same tier in the next round (if rounds and weight remain) or adds `a` to `refundable` when the
draw completes. So each prize is a chain of slots that ends claimed or refundable, and

```text
at Complete:  paid + refundable + returned = funded = sum_t count_t * a(t),
after Reclaim: paid + returned = funded, outstanding = 0.
```

The fuzz (`solvency_and_conservation_fuzz`, 80 random draws per run: modes, weights, tiers, re-draw rounds,
random claims and wrong-claimer attempts) asserts `paid + returned = funded`, that the claimed slots sum to
`paid`, and that no leaf won twice.

## 8. Re-draw termination

Rounds are numbered `0..=R` with `R <= 3`. A round has at most `P` slots (`P` = prizes); Resolve finishes a
round in at most `ceil(P / 24)` unweighted or `P` weighted instructions; the claim window ends at a fixed
slot; Advance either opens round `r + 1` (only if `r < R`, some prize was unclaimed and weight remains) or
completes the draw. So a draw completes after at most `R + 1` rounds, and the slot table never exceeds
`P * (R + 1) <= 1024` slots, the capacity allocated at creation.

## 9. Solvency invariant

`outstanding = funded - paid - returned`. SOL prizes: `lamports(draw) >= rent(len) + outstanding`; SPL prizes:
`vault.amount >= outstanding`. Both hold after FundPrizes (exactly `total_prize` enters). The only debits are
Claim (`a(t)` of a `WON` slot, while `paid + a <= funded - returned` because that prize is part of
`outstanding`), Reclaim (`refundable`, which only counts prizes no slot can claim any more) and Cancel/Close
(the whole account, allowed only before any randomness is fixed or when `outstanding = 0`). Each instruction
re-checks the invariant at its end (`Insolvent` otherwise). Entry fees never touch the vault: they go straight
to the organizer's fee destination, after the prizes were escrowed.

## 10. Residual risks (quantified)

- **Leader skip.** The leader of the target slot sees its bank hash before publishing and can skip the slot;
  the draw then uses the next produced slot. That is one extra sample per skipped slot: if an outcome `E` has
  probability `q` per sample, a leader willing to skip `s` consecutive slots (up to 4 for its own run) gets `E`
  with probability at most `1 - (1 - q)^(s+1)`, about `(s+1) q`; with one skip a leader holding share `q` of the
  weight raises its top-prize chance from `q` to at most `2q - q^2`. Each skip costs the leader that slot's block
  rewards and fees, and it only pays if the leader (or a party paying it) holds entries.
- **Late cranks.** If nobody cranks Draw while `T_r` is in the window (about 3.4 minutes), the fixed fallback
  `T_r + 512` is used, then `+1024`, and so on; a cranker cannot choose among them.
- **Organizer and the list.** In committed-list mode the organizer chooses the list before the target slot
  exists; sybil entries are possible and visible in the published list. Prizes are escrowed before the commit,
  so the organizer has no fund-or-walk-away option after seeing the hash. If the organizer withholds the list,
  weighted slots cannot be resolved and unweighted winners cannot prove their leaf; the prizes then stay in the
  vault (there is no path that returns them to the organizer without completing the rounds).
- **Re-draw randomness.** Each re-draw round uses the hash of a slot after the claim window ends, so a winner
  deciding whether to claim cannot know who a re-draw would pick.

## 11. null_lottery_pools: second tier

Split of one sale of price `p`: `creator + reserve + tier2 + jackpot = p` exactly, with
`tier2 = floor(p * tier2_bps / 10_000)` taken from what was the jackpot share (the creator fee and the reserve
are unchanged). The tier-2 pool `Q` receives `tier2` (overflow above `Q_cap = floor(tier2_bps * p * C / 10_000)`
to the reserve), is locked into the round at Draw (`Q -> round.tier2_prize`, counted in `locked_prize`), and at
Settle pays `share2 = floor(prize2 / n2)` to each of the `n2` registered tier-2 tickets (moved to
`owed_prizes`); the dust `prize2 - n2 * share2`, or the whole `prize2` if `n2 = 0`, rolls back into `Q`. Payout
debits `share2` once per registered tier-2 claim record (record closed after payment).

- **Conservation.** Every lamport of a sale is in exactly one of creator_owed, reserve, `Q`, jackpot; the pool
  account's lamports always equal `rent + jackpot + reserve + Q + creator_owed + locked_prize + owed_prizes`
  plus any unsolicited surplus. The pools fuzz (64 random pools, about a third with tier 2, 7,680 actions) checks
  `seed + sales = jackpot + reserve + Q + creator_withdrawn + paid` at the end of every pool.
- **Never pays from the jackpot or reserve.** Tier-2 payouts come only from `round.tier2_prize`, which came only
  from `Q`; the jackpot and reserve code paths are untouched, and the reserve only gains (cap overflow).
- **Never insolvent.** `Q` is part of the liabilities checked after every instruction.
- **Full coverage stays non-positive.** Buying all `C` tickets returns at most `cap + Q_cap + fee_max * p * C`;
  CreatePool requires `cap_bps + fee_max_bps + tier2_bps <= 10_000`, so this is `<= p * C`.
- **Hit rate and EV.** A quick-pick ticket matches exactly `k - 1` numbers with probability
  `h = k * (n - k) / C(n, k)`; for 3 of 18, `h = 45/816 = 5.51%` (1 in 18.1), and any prize `46/816 = 5.64%`
  (1 in 17.7). Since the whole tier-2 pool is eventually paid to tier-2 winners (rollover only delays it; it
  reaches the cap only after `Q_cap / (tier2 * p)` = all-combination sales with no tier-2 winner), the
  long-run tier-2 EV per ticket is `tier2 = 0.10 p` and the mean tier-2 prize per winning ticket is
  `0.10 p / h = 1.81 p` (0.0181 SOL for a 0.01 SOL ticket). In a round of `N` quick-pick tickets the chance of no
  tier-2 winner (rollover) is `(1 - h)^N`: 56.7% at N = 10, 5.9% at N = 50.

## 12. Statistical tests (`tests/stats.rs`, 10^6 draws each)

Seeds `SHA-256(tag || i)`, the program's own `stream::point` and `stream::remap`; chi-square against the exact
distribution of sections 4 and 5; a test fails if `p < 0.001`.

| Test | Cells | chi2 | df | p |
|---|---:|---:|---:|---:|
| Unweighted index, n = 97 | 97 | 79.46 | 96 | 0.8890 |
| Weighted winner, weights 1..20 | 20 | 13.53 | 19 | 0.8104 |
| Weighted ordered pairs without replacement, weights 1..6 | 30 | 41.66 | 29 | 0.0602 |
| Unweighted ordered triples, 3 of 6 | 120 | 97.65 | 119 | 0.9240 |
| Re-draw after winners {0, 3}, weights 4,1,2,7,3,5 | 4 | 0.38 | 3 | 0.9452 |
