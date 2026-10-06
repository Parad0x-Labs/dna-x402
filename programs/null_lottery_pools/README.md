# null_lottery_pools

Permissionless, creator-seeded rolling-jackpot lottery pools on Solana (native program,
`solana-program` 1.18.26).

Anyone can create a pool. The creator seeds the jackpot, sets the ticket price and the odds, and
earns a fee on ticket sales. The fee stays at its maximum until the seed is recouped and then
decays towards a floor, while the jackpot keeps growing on rollovers. Parad0x takes no protocol fee:
the program has no treasury and no platform share. Each sale is split only between the creator, the
jackpot and a reserve. When a ticket is bought through x402, the x402 rail charges its own fee in the
x402 layer, outside this program.

Program id (keypair generated for devnet, declared in `src/lib.rs`):
`39QHCDuqugs2Fm16CtvD3SBmDJp9n2WbdNGQPtqFZSxw`.

Client math, encoders and decoders live in [`packages/lottery-pools`](../../packages/lottery-pools).

## Economics

All parameters are set once at CreatePool and bounded by program constants (`src/econ.rs`).

| Parameter | Meaning | Bounds |
|---|---|---|
| `seed` (S) | Lamports moved into the jackpot at creation. No instruction returns them to the creator. | `ticket_price <= S <= cap` |
| `ticket_price` (p) | Lamports per ticket | 10,000 to 1,000 SOL |
| `fee_max_bps` | Creator fee until the seed is recouped | `<= 3000` |
| `fee_min_bps` | Creator fee floor after recoup | `<= fee_max_bps` |
| `reserve_bps` | Share of each sale to the reserve | `<= 2000` |
| `cap_bps` | Jackpot cap, in bps of the cost of all combinations | `1000 <= cap_bps <= 10000 - fee_max_bps` (default 7000) |
| `pick_k`, `range_n` | A ticket picks `k` distinct numbers from `1..=n` | `1 <= k <= 8`, `k < n <= 80` |
| `round_slots` | Sales length of a round | 150 to 1,512,000 slots |
| `claim_window_slots` | Claim window after a draw | 150 to 1,512,000 slots |

### Creator fee curve

`V` is the pool's cumulative ticket sales before a ticket.

```text
Vr   = ceil(S * 10_000 / fee_max_bps)                         recoup volume
f(V) = fee_max_bps                                            V <  Vr
     = max(fee_min_bps, floor(fee_max_bps * Vr / V))          V >= Vr
```

`Vr` is the smallest volume at which the fee at `fee_max` reaches the seed. After recoup the rate is
about `S / V`, so it halves every time sales double, down to the floor. A ticket covers the volume
interval `[V, V + p)`; the part below `Vr` is charged at `fee_max`, the part at or above `Vr` at
`f(max(V, Vr))`. A single ticket can cross the boundary and is charged piecewise.

### Split of each ticket

```text
creator = floor((seg_below_Vr * fee_max_bps + seg_above_Vr * f(max(V, Vr))) / 10_000)
reserve = floor(p * reserve_bps / 10_000)
jackpot = p - creator - reserve
```

All math is u64 with u128 intermediates and checked arithmetic. Rounding always goes against the
creator and the reserve and in favour of the jackpot: the post-recoup rate is floored to whole bps,
both the fee and the reserve share are floored to whole lamports, and the jackpot receives the exact
remainder. Creator + reserve + jackpot equals the ticket price to the lamport.

### Reserve

The reserve receives `reserve_bps` of every sale plus any jackpot overflow above the cap. When a round
settles with a winner, the reserve moves into the next jackpot (up to the cap), so the creator never
re-seeds.

### Jackpot cap

```text
C   = binom(n, k)                       number of distinct tickets
cap = floor(cap_bps * p * C / 10_000)
```

A ticket's jackpot share above the cap goes to the reserve. Buying every combination costs `p * C`
and returns at most the capped jackpot plus, for the creator, its own fee (at most
`fee_max * p * C`). The net of that purchase is therefore at most
`(cap_bps + fee_max_bps - 10_000) * p * C / 10_000`, which CreatePool keeps `<= 0` by requiring
`cap_bps + fee_max_bps <= 10_000`. The default 7000 bps satisfies this at the maximum `fee_max` of
3000 bps, before transaction fees and before any split with other winners.

### Worked example

S = 1 SOL, p = 0.01 SOL, `fee_max` = 25%, `fee_min` = 2%, reserve = 5%, odds 3 of 24
(C = 2,024, one ticket wins with probability 1/2,024), cap 7000 bps = 0.7 x 0.01 x 2,024 =
14.168 SOL. `Vr` = 1 / 0.25 = 4 SOL (400 tickets).

Pool state after a number of tickets with no win yet (computed with the program's integer formulas):

| Tickets | Sales V | Fee on the next ticket | Creator fees accrued | Jackpot | Reserve |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.01 SOL | 25.00% | 0.0025 SOL | 1.007 SOL | 0.0005 SOL |
| 100 | 1 SOL | 25.00% | 0.25 SOL | 1.70 SOL | 0.05 SOL |
| 400 | 4 SOL | 25.00% | 1.00 SOL (seed recouped) | 3.80 SOL | 0.20 SOL |
| 800 | 8 SOL | 12.50% | 1.69 SOL | 6.91 SOL | 0.40 SOL |
| 1,600 | 16 SOL | 6.25% | 2.39 SOL | 13.81 SOL | 0.80 SOL |
| 4,000 | 40 SOL | 2.50% | 3.30 SOL | 14.168 SOL (cap) | 23.53 SOL |
| 5,000 | 50 SOL | 2.00% (floor) | 3.52 SOL | 14.168 SOL (cap) | 33.31 SOL |

Before recoup each 0.01 SOL ticket splits 0.0025 creator / 0.0005 reserve / 0.007 jackpot. At the
floor the split is 0.0002 / 0.0005 / 0.0093. A win pays the jackpot and the reserve becomes the next
jackpot.

Creator outcome under stated sales assumptions, from the reference simulation
(`sim.py`: 60 rounds, normally distributed ticket counts per round with the listed mean, win
probability 1/2,000 per ticket, fee rate fixed per round, no cap; 4,000 runs):

| Tickets per round | Mean creator net (fees minus 1 SOL seed) | Median round of the first win |
|---:|---:|---:|
| 20 | +1.09 SOL | 26 |
| 50 | +2.06 SOL | 20 |
| 150 | +3.49 SOL | 10 |
| 400 | +6.84 SOL | 4 |
| 150, `fee_max` 15% | +2.91 SOL | 10 |

These are expectations of a model, not a promise: they hold only if sales follow the assumptions.
Ticket buyers have negative expected value by construction (fees, reserve and cap), as in any
lottery.

Rent (paid once, at 6,960 lamports per byte including the 128-byte account overhead):

| Account | Size | Rent | Paid by | Returned |
|---|---:|---:|---|---|
| Pool (vault, holds all pool lamports) | 920 B | 0.00729408 SOL | creator | never (the account holds player funds) |
| Round (one per drawn round with tickets) | 248 B | 0.00261696 SOL | Draw cranker | CloseRound, to the cranker |
| Claim record (one per registered winning ticket) | 89 B | 0.00151032 SOL | claimant | Payout, to the ticket owner |

No account is created per ticket.

## Round life cycle

| Tag | Instruction | Who | Effect |
|---|---|---|---|
| 0 | CreatePool | creator | Creates the pool PDA, moves the seed into the jackpot, opens round 0 |
| 1 | BuyTicket | anyone | Pays `p` into the pool, applies the split, appends the ticket leaf to the round tree |
| 2 | Draw | anyone | After `close_slot`: draws the numbers from SlotHashes, locks the jackpot as the round prize, opens the next round |
| 3 | Claim | ticket owner | During the window: registers a winning ticket (leaf + Merkle proof), creates its claim record |
| 4 | Settle | anyone | After the window: splits the prize among registered tickets, or rolls it over; after a win the reserve seeds the jackpot |
| 5 | Payout | anyone | Pays one registered ticket's share to its owner and closes the claim record |
| 6 | WithdrawCreatorFees | creator | Withdraws up to the accrued creator fees |
| 7 | Retire | creator | Turns the creator fee off for good (see below) |
| 8 | CloseRound | anyone | After every registered winner is paid: closes the round account, rent to its payer |

PDAs: pool `["pool", creator, nonce_le]`, round `["round", pool, round_id_le]`, claim record
`["claim", pool, round_id_le, ticket_index_le]`. Account layouts are in `src/state.rs`; instruction
data in `src/instruction.rs`.

A round with no tickets is rolled by Draw without a round account. Draw of the next round is refused
until the previous drawn round is settled, so a prize that rolls over always reaches the next draw.
Tickets of the next round can be bought during the claim window of the previous one.

Winners are known after the claim window: the prize is split equally among the winning tickets
registered during the window (`share = floor(prize / winners)`, the remainder rolls over). A winning
ticket that is not registered within the window gets nothing. If no ticket is registered, the whole
prize rolls into the next jackpot (cap overflow to the reserve).

## Trust model

The creator is an interested party. The program gives it no say over tickets, the draw or the
prize.

- **Tickets.** BuyTicket runs in the buyer's own transaction. The leaf
  `SHA-256("null-lottery-pools:ticket:v1" || pool || round_id_le || owner || numbers[8] || ticket_index_le)`
  is appended to the round's on-chain incremental Merkle tree (depth 20, 2^20 tickets per round) in
  execution order, and logged with `sol_log_data` (`"ticket", round_id, ticket_index, owner, numbers,
  leaf`) so indexers can rebuild proofs. The payer may set another key as the ticket owner (an x402
  facilitator paying for an agent); only the owner can claim.
- **Hash choice.** `sol_sha256` costs 85 CU plus 1 CU per 2 input bytes (about 127 CU per node);
  `sol_poseidon` with 2 BN254 inputs costs 786 CU and requires inputs below the field modulus. A
  20-level append is about 2.5k CU with SHA-256 against about 16k CU with Poseidon.
- **Draw.** Sales close at `close_slot`, fixed when the round opens. The draw uses the SlotHashes
  entry for the fixed target `T_0 = close_slot + 32`, or, once `T_0` has aged out of the 512-entry
  SlotHashes window, the next fixed fallback `T_i = T_0 + 512 * i`. The program computes `i` itself
  (the lowest target still covered by the window) and takes the first produced slot at or after it,
  so every crank in the same period gets the same hash. Anyone can crank. There is no admin key, no
  creator seed and no randomness input in the instruction. Entropy is
  `SHA-256("null-lottery-pools:draw:v1" || pool || round_id || T_i || used_slot || slot_hash || tickets_root || ticket_count)`;
  the numbers come from a partial Fisher-Yates shuffle (`src/draw.rs`).
- **Claims.** A claim rebuilds the leaf from the signer's key, so a valid proof for someone else's
  ticket fails. Claim records are keyed by `(pool, round_id, ticket_index)`; a second claim of the
  same ticket fails. If anyone pre-funds a claim, round or pool address, the program tops it up and
  uses allocate + assign instead of create_account, so the transfer cannot stop the creation.
- **Window.** While a round is in its claim window its prize is held as `locked_prize`; only Claim
  touches that round, Draw of the next round is refused, Settle waits for the window end, and
  Retire is refused.
- **Solvency.** The pool account is the vault. Every instruction ends with
  `lamports >= jackpot + reserve + creator_owed + locked_prize + owed_prizes + rent_exempt_minimum`.
  Lamports leave the pool only through Payout (a settled share, to the ticket owner) and
  WithdrawCreatorFees (at most `creator_owed`, to the creator).
- **No exit for the jackpot.** There is no close or emergency instruction for the pool. Retire is
  allowed only when no round is in its window, every settled winner is paid, and either the last
  settlement paid a winner or the reserve is empty (all player-side funds are already jackpot). It
  folds the reserve into the jackpot (up to the cap) and sets the creator fee to zero for every later
  sale. The pool keeps selling and drawing; its jackpot pays out on the next win. Accrued fees stay
  withdrawable.
- **Accounts.** Every account is checked for owner and address. The program derives each PDA's
  canonical bump on chain with `find_program_address` when it creates the account, stores it in the
  account, and re-checks the address with `create_program_address` and that stored bump afterwards
  (one 1,500 CU derivation instead of a variable bump search). SlotHashes is checked by address and
  owner.
- **No upgrade logic.** The program contains no reference to its upgrade authority and no
  privileged key of any kind.

## Residual risks

- **Leader-skip bias.** The draw hash is the bank hash of the first produced slot at or after the
  target, and the leader schedule is public about an epoch ahead. The leader of the target slot sees
  its bank hash before it publishes and can withhold the block; the draw then uses the next produced
  slot, so a leader gets one extra outcome per slot it is willing to skip (up to four for its four
  consecutive slots), and it can also vary the transactions it includes to vary its bank hash within
  the slot time. Using this costs the leader its block rewards and fees for each skipped slot and only
  pays if it holds tickets (or another stake in the outcome) in that pool; the program does not
  remove this bias, so it grows in relevance as the jackpot grows relative to a leader's per-slot
  revenue.
- **Crank timing.** If nobody cranks Draw while `T_0` is in the window (about 512 slots, roughly
  3.4 minutes), the draw moves to `T_1`. A party that dislikes the `T_0` outcome can only change it by
  keeping every other party from cranking for that period. The next round's `close_slot` is set by the
  slot at which Draw executes, so a cranker that is also a validator can steer the next target into its
  own leader slots and then use the skip option above.
- **Liveness of claims.** A winner must register within the claim window. Clients should claim as soon
  as the draw lands; an unregistered winning ticket is not paid.
- **Ticket privacy.** Ticket numbers and owners are public in the transaction and the log.
- **Program upgrades.** The code has no upgrade path for the creator, but the deployment's upgrade
  authority can replace the program. Deploy with `--final` or a multisig authority for pools that
  hold significant value.
- **Unsolicited lamports.** Lamports sent directly to a pool account are surplus: they are not
  accounted to any liability and stay in the account.
- **Modulo bias.** Each drawn number uses `u64 mod (n - j)`, a bias of at most `80 / 2^64`.

## Errors

Custom codes are `0x4C500000 + n` (a range no other program in this repo uses).

| Code | Name | Meaning |
|---|---|---|
| 0x4C500001 | InvalidInstruction | Unknown tag or wrong data length |
| 0x4C500002 | InvalidParams | CreatePool parameters outside the bounds |
| 0x4C500003 | InvalidAccount | Wrong owner, discriminator, size or PDA, or wrong system program |
| 0x4C500004 | AccountInUse | A PDA to create already holds data or belongs to another program |
| 0x4C500005 | WrongRound | BuyTicket names a round other than the open one |
| 0x4C500006 | SalesClosed | BuyTicket at or after `close_slot` |
| 0x4C500007 | SalesOpen | Draw before `close_slot` |
| 0x4C500008 | InvalidNumbers | Numbers are not `k` ascending values in `1..=n`, zero padded |
| 0x4C500009 | RoundFull | The round already has 2^20 tickets |
| 0x4C50000A | PreviousRoundUnsettled | Draw while the previous drawn round is unsettled |
| 0x4C50000B | InvalidSysvar | The SlotHashes account is wrong or malformed |
| 0x4C50000C | DrawTooEarly | The active target slot has no hash yet |
| 0x4C50000D | WrongStatus | The round is not in the status the instruction needs |
| 0x4C50000E | ClaimWindowClosed | Claim after the window |
| 0x4C50000F | ClaimWindowOpen | Settle before the window ends |
| 0x4C500010 | TicketNotWinning | Ticket numbers are not the drawn numbers |
| 0x4C500011 | InvalidProof | Leaf (with the signer as owner) not under the round root, or index out of range |
| 0x4C500012 | AlreadyClaimed | A claim record for this ticket exists |
| 0x4C500013 | NotCreator | Signer is not the pool creator |
| 0x4C500014 | InsufficientFees | Withdraw of zero or more than the accrued fees |
| 0x4C500015 | Insolvent | Pool lamports would fall below liabilities plus rent |
| 0x4C500016 | RetireNotAllowed | Retire conditions not met |
| 0x4C500017 | MathOverflow | Checked arithmetic overflow |
| 0x4C500018 | ClaimMismatch | Payout: claim record or owner account does not match |
| 0x4C500019 | RoundNotFinished | CloseRound before every registered winner is paid |
| 0x4C50001A | WrongRentPayer | CloseRound to an account other than the rent payer |
| 0x4C50001B | AlreadyRetired | Retire on a retired pool |

The program logs no secrets; it holds none.

## Tests

```bash
# native processor
cargo test -p null-lottery-pools
# against the SBF binary
cargo build-sbf --manifest-path programs/null_lottery_pools/Cargo.toml --sbf-out-dir <dir>
SBF_OUT_DIR=<dir> cargo test -p null-lottery-pools --test integration
# TS client against the same vectors
npm --prefix packages/lottery-pools install --ignore-scripts && npm --prefix packages/lottery-pools test
```

- `src/*` unit tests: fee curve before and after recoup, floor and rounding, recoup crossing in one
  ticket, split conservation, cap overflow, parameter bounds, tree append against batch root and
  proofs, zero table, SlotHashes selection (too early, skipped target, aged-out fallback), drawn
  numbers.
- `tests/integration.rs`: on-chain split and recoup crossing, cap overflow, bounds, buy rejections,
  draw rejections (before close, before the target hash, forged SlotHashes account, another sysvar),
  fallback slot, skipped target, empty round, no-winner rollover, single and multi-winner payouts with
  dust, claim rejections (wrong owner, bad proof, wrong index, losing ticket, double claim, after the
  window, after settle), unclaimed winner rollover, reserve seeding the next jackpot, creator withdraw
  rules, retire rules, pre-funded pool, round and claim addresses, a solvency fuzz (random buy, draw,
  claim, settle, payout, withdraw and attack sequences, invariant checked after every step), and
  compute units.
- `tests/vectors.rs` writes and checks `tests/vectors/lottery_pools_v1.json`, which the TS package
  recomputes.

Compute units measured against the SBF build (simulated transactions holding only the instruction,
three runs): BuyTicket 10,773 to 10,776 (constant: one stored-bump address check and 21 SHA-256
calls), Claim 14,615, Draw 11,883 to 16,390 with a 500-entry SlotHashes (the round PDA's bump search
at creation costs 1,500 CU per extra attempt), Settle 5,842, Payout 7,801.
