# null_fair_draw (Fair Draw)

A provably fair draw primitive any Solana project can plug into for raffles, giveaways and reward roll-outs
(native program, `solana-program` 1.18.26).

- Every prize is escrowed before entries open or a list is committed: a draw without funded prizes cannot run.
- Randomness is the SlotHashes entry of a slot fixed before its hash exists. No organizer seed, no cranker input;
  anyone can crank, and every crank reaches the same winners.
- Winners are drawn without replacement (an entry wins at most once), weighted or unweighted, with a bias bound
  below 2^-439 (see [MATH.md](./MATH.md)).
- Winners claim their prize themselves. Unclaimed prizes are re-drawn among the entries that have not won, for up
  to `redraw_rounds` rounds (SDK default 2), each with fresh randomness, then returned to the organizer.
- Anyone recomputes the full winner list and every proof from public data (`verify` in the SDK, and a
  self-contained [verify page](../../packages/fair-draw/verify.html)).
- 0% protocol fee: the program has no fee, treasury or admin key. A draw-as-a-service endpoint paid through x402
  charges in the x402 layer, outside this program.

Program id (keypair generated for devnet, declared in `src/lib.rs`): `FZxUXmGNzivQCw1nS6N6GakwyWN1PrX5ebGnS7hPjzGL`.
Client SDK: [`packages/fair-draw`](../../packages/fair-draw) (`@parad0x_labs/fair-draw`). Proofs:
[MATH.md](./MATH.md).

## Modes

| | Open raffle | Committed list |
|---|---|---|
| Who adds entries | entrants, on chain (`Enter`) | the organizer, as a Merkle root of an off-chain `(wallet, weight)` list (`CommitList`) |
| Entry price | free, or priced in SOL or one SPL mint, paid straight to the organizer's fee destination | none |
| Per-wallet cap | optional (`wallet_cap`), counted per owner in a small entrant record | n/a |
| Target slot fixed | at creation: `close_slot + 32` | at commit: `commit_slot + 32` |
| Entry data | leaves logged on chain (`entry` log line = participation receipt) | published list (for example IPFS); anyone rebuilds the root |
| Typical use | raffles, community giveaways | airdrops, reward roll-outs, allow-list draws |

**Weighted draws** work in both modes. Entries form a SHA-256 *sum tree*: each node commits
`(hash, subtree_weight)`, so a proof authenticates the leaf's prefix sum and its interval
`[start, start + weight)` of `[0, total)`. A winner proof shows the drawn point lies inside that interval. In an
open raffle a weighted `Enter(count)` adds one leaf of weight `count`; unweighted adds `count` leaves of weight 1
(up to 8 per instruction). Zero-weight entries are refused (`Enter` with count 0, any proof with weight 0).

## Draw math

```text
seed_r = SHA-256("null-fair-draw:seed:v1" || draw || round || target_slot || used_slot || slot_hash || root || total || count)
X_j    = SHA-256("null-fair-draw:stream:v1" || seed_r || j || 0) || SHA-256(... || j || 1)      (512 bits)
u_j    = X_j mod (total - won_weight)                         statistical distance < 2^-449 per slot
p_j    = u_j mapped past every won interval (ascending start)  uniform over the points not yet won
winner = the leaf whose interval contains p_j
```

Slot `j` wins leaf `i` with probability `w_i / (T - W)` given the weight `W` already won: exactly the
distribution of re-drawing on a collision with a previous winner, with one stream value per slot (bounded
CU). Unweighted, this is uniform over ordered k-tuples of distinct entries (a partial Fisher-Yates shuffle in
distribution); the point is the leaf index, so `Resolve` handles up to 24 unweighted slots per instruction with
no proof. Weighted slots are resolved one per instruction with the winner's leaf proof (anyone can supply it;
only the right leaf fits). Proofs, the bias bound, the without-replacement distribution, prize conservation,
re-draw termination and the solvency invariant are in [MATH.md](./MATH.md), with the chi-square results of
10^6-draw tests.

## Prizes

Up to 8 tiers, best to smallest (for example 1 x A, 5 x B, 50 x C), in SOL or one classic SPL Token mint. The winner of
slot 0 gets tier 0. `FundPrizes` escrows the whole amount in one step: SOL in the draw account itself,
SPL in a vault token account owned by the draw PDA. Entries, `CommitList` and `Draw` are refused until then.

Claim window: each round's window starts when its last slot is resolved. After it, `Advance` (permissionless)
marks unclaimed slots forfeited and, while rounds and unwon weight remain, opens a re-draw round for the same
tiers with the target slot `window_end + 32`, a slot whose hash nobody can know when deciding whether to claim.
After the last round the unclaimed prizes become refundable; `Reclaim` returns them to the organizer and `Close`
returns the account rent. Set `redraw_rounds = 0` to return unclaimed prizes right away.

## Life cycle

| Tag | Instruction | Who | Effect |
|---|---|---|---|
| 0 | CreateDraw | organizer | Creates the draw PDA (and SPL vault); tiers, mode, prices, cap, timing |
| 13 | Extend | anyone | Grows a draw account above 10 KiB by up to 10 KiB per call while unfunded (`create_draw_with_extends`) |
| 1 | FundPrizes | anyone | Escrows every prize; opens entries (open raffle) or allows the commit (list) |
| 2 | Enter | entrant | Pays the entry fee to the organizer, appends leaves, logs the receipt |
| 3 | CommitList | organizer | Commits root, total weight, count and depth; fixes the target slot |
| 4 | Draw | anyone | Fixes the round seed from SlotHashes (fixed fallback if the target aged out) |
| 5 | Resolve | anyone | Resolves the next winner slots (batch unweighted, one proof weighted) |
| 6 | Claim | winner | Pays the slot's prize to the winner (unweighted: with the winner's leaf proof) |
| 7 | Advance | anyone | After the window: opens a re-draw round or completes the draw |
| 8 | Reclaim | organizer | After completion: returns unclaimed and void prizes |
| 9 | Close | organizer | After reclaim: closes vault and draw, rent back |
| 10 | Cancel | organizer | Before any randomness is fixed (unfunded, or a funded list not yet committed): refund and close |
| 11 | ProveEntry | anyone | Logs a participation receipt for a valid leaf proof (no account) |
| 12 | CloseEntrant | owner | Closes the entrant record once entries are closed |

PDAs: draw `["draw", organizer, draw_id_le]`, vault `["vault", draw]`, entrant `["entrant", draw, owner]`.
Layouts in `src/state.rs`, instruction data in `src/instruction.rs`.

Rent (6,960 lamports per byte including the 128-byte overhead), all returned at Close / CloseEntrant:

| Account | Size | Rent |
|---|---:|---:|
| Draw, open raffle, 56 prizes, 2 re-draw rounds (168 slots) | 14,360 B | 0.10083648 SOL |
| Draw, committed list, 3 prizes, 1 re-draw round | 1,248 B | 0.00957696 SOL |
| Draw, largest (1,024 slots, open raffle) | 79,416 B | 0.55362624 SOL |
| SPL vault | 165 B | 0.00203928 SOL |
| Entrant record (only with a per-wallet cap) | 81 B | 0.00145464 SOL |

Size: `792 + 800 (open raffle frontier) + 76 * prizes * (1 + redraw_rounds)` bytes.

## CPI interface

Build with `features = ["no-entrypoint"]` and use the builders in `null_fair_draw::instruction`; a program PDA
can be organizer and funder with `invoke_signed`. Winners and status are read from the draw account
(`state::Draw::unpack`, `read_slot`). Minimal calling program (tested in `tests/cpi.rs`):

```rust
use null_fair_draw::{instruction as fd, state::{Tier, MODE_LIST}};

// accounts: giveaway PDA (w), draw (w), system program, null_fair_draw program
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let (pda, draw, system, fair_draw) =
        (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let (_, bump) = Pubkey::find_program_address(&[b"giveaway"], program_id);
    let seeds: &[&[u8]] = &[b"giveaway", &[bump]];
    let (draw_id, root, total, count, depth) = parse(data); // the published list's commitment
    let params = fd::CreateParams {
        mode: MODE_LIST, weighted: false, redraw_rounds: 2,
        tiers: vec![Tier { count: 1, amount: 100_000_000 }, Tier { count: 2, amount: 10_000_000 }],
        entry_price: 0, wallet_cap: 0, close_slot: 0, claim_window_slots: 216_000,
        prize_mint: [0; 32], entry_mint: [0; 32], fee_dest: [0; 32],
    };
    let infos = [pda.clone(), draw.clone(), system.clone(), fair_draw.clone()];
    for ix in fd::create_draw_with_extends(fair_draw.key, pda.key, draw_id, params) {
        invoke_signed(&ix, &infos, &[seeds])?;
    }
    invoke_signed(&fd::fund_prizes(fair_draw.key, pda.key, draw.key, None), &infos, &[seeds])?;
    invoke_signed(&fd::commit_list(fair_draw.key, pda.key, draw.key, root, total, count, depth), &infos, &[seeds])
}
```

`Draw`, `Resolve` and `Claim` are then permissionless calls (the SDK's `crank` and `claim`).

## Trust model and residual risks

- **No privileged input.** The draw takes no randomness from anyone. The target slot is fixed when entries close
  (open raffle, at creation) or when the list is committed; prizes are escrowed before that, so the organizer
  never holds a fund-or-walk-away option after seeing the outcome. Cancel exists only before the target is fixed.
- **Leader skip.** The leader of the target slot sees its bank hash before anyone else and can skip the slot; the draw then
  uses the next produced slot. That is one extra sample per skipped slot: for an outcome of probability `q`, at
  most `1 - (1 - q)^(s+1)` with `s` skips (about `2q` for one skip, up to 4 consecutive leader slots). Each skip
  costs that slot's block rewards and fees.
- **Late cranks** fall back to the next fixed slot `T + 512 * i` (the lowest still in the SlotHashes window);
  a cranker cannot pick among them.
- **Committed lists.** The organizer controls the list: sybil entries are possible before the commit and are
  visible in the published list, which anyone can check against the root. If the list is never published,
  weighted slots cannot resolve and the prizes stay escrowed (no path returns them to the organizer).
- **Open raffle entry data** comes from the program's `entry` logs; verifying an old raffle needs an RPC that
  keeps transaction history.
- **Per-wallet caps** count per owner key; one person with many keys is many owners.
- **Program upgrades.** The code has no upgrade path for organizers, but the deployment's upgrade authority can
  replace the program; deploy with `--final` or a multisig authority for draws that hold significant value.
- **VRF mode, coming next:** an optional Switchboard on-demand randomness source (its devnet program is
  reachable), as an alternative to SlotHashes that removes the leader-skip sample.

## Errors

Custom codes are `0x46440000 + n` ("FD"), listed in `src/error.rs`: InvalidInstruction 1, InvalidParams 2,
InvalidAccount 3, AccountInUse 4, WrongStatus 5, EntriesClosed 6, EntriesOpen 7, WalletCapExceeded 8, TreeFull 9,
InvalidSysvar 10, DrawTooEarly 11, InvalidProof 12, PointNotInLeaf 13, MissingProof 14, NotWinner 15,
ClaimWindowClosed 16, ClaimWindowOpen 17, NotOrganizer 18, Insolvent 19, MathOverflow 20, InvalidTokenAccount 21,
NothingToResolve 22, ZeroWeight 23, AlreadyClaimed 24, EntrantInUse 25, AccountNotExtended 26.

## Tests

```bash
cargo test -p null-fair-draw                                   # native processor
cargo build-sbf --manifest-path programs/null_fair_draw/Cargo.toml --sbf-out-dir <dir>
SBF_OUT_DIR=<dir> cargo test -p null-fair-draw --test integration --test cpi
cargo test -p null-fair-draw --test stats -- --nocapture       # 10^6-draw chi-square tests
npm --prefix packages/fair-draw test                           # TS SDK against the shared vectors
```

- Unit tests: sum tree (append = batch root, prefix sums, edges, zero weight), stream (wide reduction,
  remap, reference draw), layouts, encodings, parameter bounds.
- `tests/integration.rs` (native and SBF): open raffle with re-draw and reclaim; committed weighted SPL list
  with proofs at leaf 0, the last leaf and the weight boundary, tampered proofs, neighbour leaf;
  a heavy leaf wins once; zero weight refused; void slots; unweighted claim rejections (no proof, wrong owner,
  a loser's proof, tampered proof, after the window, double claim); four re-draw rounds; entry fees in SOL and
  SPL; per-wallet cap; unfunded prizes block entries and the draw; cancel rules; SlotHashes checks and the
  fallback slot; pre-funded draw, vault and entrant addresses; the largest draw grown with Extend; a solvency
  and conservation fuzz; compute units.
- `tests/cpi.rs`: a calling program creates, funds and commits through CPI; the winner claims.
- `tests/stats.rs`: chi-square tests over 10^6 draws each (results in MATH.md).
- `tests/vectors.rs` writes `tests/vectors/fair_draw_v1.json`; the TS SDK recomputes it, including PDAs and a
  resolved draw with a re-draw round that `verify` must accept.

Compute units against the SBF build (simulated, compute-budget instruction excluded; three runs with random keys:
ranges come from the canonical bump search of a PDA, 1,500 CU per extra attempt, and from how many won intervals
a drawn point skips):

| Instruction | CU |
|---|---:|
| CreateDraw (open raffle, 56 prizes, 2 re-draw rounds, SOL) | 7,570 to 10,570 |
| CreateDraw (committed list, SPL vault) | 18,282 to 22,782 |
| Extend (+4,120 bytes) | 5,467 |
| FundPrizes (SOL, writes 56 slot tiers) | 7,720 |
| FundPrizes (SPL) | 13,396 |
| Enter (1 leaf, free) | 9,673 |
| Enter (8 leaves, free) | 48,100 |
| CommitList | 4,170 |
| Draw (500-entry SlotHashes) | 5,017 |
| Resolve unweighted, 24 slots (batch 1) | 74,915 to 75,192 |
| Resolve unweighted, 8 slots (48 already won) | 29,789 to 32,179 |
| Resolve weighted, 1 proof, depth 20 | 11,426 |
| Claim unweighted (leaf proof, SOL) | 9,930 to 9,957 |
| Claim weighted (SPL) | 13,568 |
| Advance (56 slots, opens a re-draw round) | 6,598 |
| ProveEntry (depth 20) | 8,840 |

A depth-20 weighted Resolve transaction is 1,055 bytes (limit 1,232); lists go up to depth 22 (4,194,304 entries).
