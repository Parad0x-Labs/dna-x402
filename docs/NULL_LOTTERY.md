# dark_null_lottery: commit-reveal rounds, anchored tickets, bound claims

Source: [`programs/null_lottery/`](../programs/null_lottery/). Devnet:
`Ecs5Ch2AWThxpkgqxMHcgNeAz4nTqpmoFWRDD6bufLXd` (`lottery` in [`configs/devnet.oss.json`](../configs/devnet.oss.json)),
built from `7439dde`, upgraded in place on 2026-10-06 (tx
`359dmp5QAd9vYteatBnXTpHteHwjCszwZurSzSc3c7MsWznB8GSSjZzHH8Grx1zwk9uoLLJuC7dSyoH8haysSwhU`, slot 508071735),
deployed bytes SHA-256 `d7048db0d48a427237deb5f5702c8dad326fe6d240f1b4cb79043701e51e1fda`
([`evidence/devnet-programs-2026-10-06.json`](../evidence/devnet-programs-2026-10-06.json)). There is no mainnet
deployment; the mainnet pilot ID `3t5c2Trk…` was retired on 2026-07-14.

The config admin runs each round: `CommitRound` stores SHA-256(seed), `AnchorTickets` stores the tickets tree root
and count, `RevealDraw` checks the seed against the commitment and draws five numbers from 1..=30
(keccak256(seed \|\| round_id_le \|\| i), Fisher-Yates). `ClaimJackpot` records the winner. The program makes no SPL
token transfer; the claim is recorded on-chain.

## Ticket leaf and tree

`tickets_root` is the root of a binary SHA-256 Merkle tree over the round's tickets, in ticket order
([`ticket.rs`](../programs/null_lottery/src/ticket.rs)):

```text
leaf = SHA-256("dark-null-lottery:ticket:v1" || round_id_le[8] || owner[32] || numbers[5] || nullifier[32])
node = SHA-256(0x01 || left[32] || right[32])
```

- `numbers` are the ticket's five numbers in ascending order; `owner` is the Solana key allowed to claim.
- Depth is ceil(log2(ticket_count)); a level with an odd number of nodes repeats its last node.
- A proof is the list of sibling hashes from the leaf up; bit `k` of the leaf index says whether the node at
  level `k` is a right child. At most 32 siblings.
- `ClaimJackpot` rebuilds the leaf from the claimant's signing key, so a ticket can only be claimed by its owner.

The SDK mirror is `packages/null-miner-sdk/src/lottery/ticketTree.ts`; cross-language vectors are in
`packages/null-miner-sdk/tests/fixtures/lottery-ticket-vectors.json`, written by
[`tests/ticket_vectors.rs`](../programs/null_lottery/tests/ticket_vectors.rs).

## Claim rules

`ClaimJackpot` data: `[0x06, nullifier[32], numbers[5], leaf_index[8] LE, proof_len[1], proof[32 * proof_len]]`.
The claim record PDA is `["claim", nullifier]`.

| Round status | What a claim needs | On success |
|---|---|---|
| Drawn (3) | the claimant's ticket with `numbers` equal to the drawn numbers (sorted), at `leaf_index < ticket_count` under `tickets_root`, with a proof of the tree's depth | status Won, `winner_nullifier` = the ticket's nullifier |
| FallbackDrawn (6) | the ticket at the selected index (below), same leaf and proof check; the numbers can be any | status Won, `winner_nullifier` = the ticket's nullifier |
| Won (4) | closed: AlreadyClaimed for the stored nullifier, InvalidWinner for any other | none |
| any other | WrongStatus | none |

A nullifier-only claim (the 33-byte form) parses and never claims.

## FallbackDraw

`FallbackDraw` (`0x05`, data `[seed[32], fallback_tickets_root[32], fallback_pool_size[8] LE]`, admin signer)
takes three round accounts:

1. The rounds must be the canonical round PDAs with consecutive ids, all in status Drawn (three consecutive Drawn
   rounds with no claimed winner).
2. `seed` must be the third round's committed draw seed: SHA-256(seed) equals that round's `CommitRound`
   commitment, which was fixed before its tickets were anchored.
3. `fallback_tickets_root` and `fallback_pool_size` must equal the third round's anchored `tickets_root` and
   `ticket_count` (non-zero). That tree is the fallback pool.
4. The first two rounds become NoWinner (5) and the third FallbackDrawn (6). No winner is recorded until the
   selected ticket's owner claims.

Selected index:

```text
index = u64_le(SHA-256("dark-null-lottery:fallback:v1" || seed[32] || round_id_le[8])[0..8]) mod ticket_count
```

where `seed` and `round_id` are the third round's. `fallback_after` in the config must be 3 or less
(FallbackNotReady otherwise). The earlier synthetic winner nullifier SHA-256(seed \|\| "fallback" \|\| index) is
removed, and a round marked Won by it cannot pay out.

## Error codes

| Code | Name | Meaning |
|---|---|---|
| 0x6001 | InvalidInstruction | malformed data or unknown discriminant |
| 0x6002 | AlreadyInitialized | the config exists |
| 0x6003 | RoundNotFound | no such round |
| 0x6004 | InvalidSeed | SHA-256(seed) is not the stored commitment |
| 0x6005 | AlreadyClaimed | the winning ticket was claimed |
| 0x6006 | InvalidWinner | claim on a Won round with another nullifier |
| 0x6007 | WrongStatus | the round is not in the status the instruction needs |
| 0x6008 | NotAdmin | the signer is not the config admin |
| 0x6009 | FallbackNotReady | `fallback_after` > 3 |
| 0x600A | TicketNotWinning | the claimed numbers are not the drawn numbers |
| 0x600B | InvalidTicketProof | the leaf (claimant key, numbers, nullifier) is not at `leaf_index < ticket_count` under `tickets_root`, or no ticket was supplied |
| 0x600C | FallbackPoolMismatch | the fallback root or size is not the third round's anchored tree, or that tree is empty |
| 0x600D | NotFallbackWinner | the claimed `leaf_index` is not the ticket FallbackDraw selected |
| 0x600E | FallbackRoundsNotConsecutive | the three rounds are not consecutive round ids |

## SDK (`packages/null-miner-sdk`)

- `buildFallbackWinnerIndex(seed, roundId, poolSize)`: the program's selected-index formula; `roundId` is the
  third round's id and `poolSize` its anchored ticket count. It takes `roundId` as a new second argument.
- `executeFallbackDraw(rounds, fallbackSeed, thirdRoundCommitment?)`: the pool is the third round's batch; when
  the optional commitment is passed, the seed is checked against it before the index is computed. The result
  carries the winner ticket, index, pool root and the ticket's proof.
- `buildClaimJackpotData(tickets, leafIndex)`: `ClaimJackpot` data for the ticket at `leafIndex` of its round's
  anchored batch; the transaction is signed by that ticket's owner.

## Devnet runs

Recorded in [`evidence/devnet-2026-10-06/`](../evidence/devnet-2026-10-06/README.md):

- rerun 2 (`a32933d`), 14/14: nullifier-only claim 0x600B, anchored losing ticket 0x600A, relabelled ticket 0x600B,
  the winner's ticket and proof under another signer 0x600B, the owner claims, a second claim 0x6005;
- rerun 3 (`7439dde`), 41/41: the rerun 2 cases on a fresh round, then FallbackDraw by a non-admin 0x6008, with an
  uncommitted or another round's seed 0x6004, a wrong pool root or size 0x600C, rounds out of order 0x600E; the
  valid FallbackDraw; the old synthetic nullifier 0x600B, an unselected ticket with the drawn numbers 0x600D, the
  selected ticket under another signer 0x600B; the selected owner claims; a second claim 0x6005; a NoWinner round
  0x6007; FallbackDraw again 0x6007.

Program tests: [`claim_binding.rs`](../programs/null_lottery/tests/claim_binding.rs),
[`fallback_binding.rs`](../programs/null_lottery/tests/fallback_binding.rs),
[`admin_checks.rs`](../programs/null_lottery/tests/admin_checks.rs).

## Residual items

- In the admin-run lottery the admin commits the seed and also sets ticket order in the anchored tree, so players
  trust the admin over ticket order.
- null_lottery v1 has no claim window: a Drawn or FallbackDrawn round stays claimable with no deadline.
- The claim record PDA is keyed by nullifier only (`["claim", nullifier]`), not by round.

The creator-pool lottery program will address these (coming next).
