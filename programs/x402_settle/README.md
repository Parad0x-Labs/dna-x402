# x402_settle

Atomic settlement of x402 payments on Solana (native program, `solana-program` 1.18.26). One
program, one voucher format, three lanes, plus two-phase batches that stay atomic across many
transactions. The program charges no fee; an x402 facilitator fee, if any, is accounted for in the
x402 TypeScript layer.

Program id (keypair generated for devnet, declared in `src/lib.rs`):
`DFt7SG4WUiy6qpYJRLTKdcx4dvSHE1dVG5sbTfXWbfZE`.

Client: [`packages/x402-settle`](../../packages/x402-settle) (voucher signing and encoding, SIMD-0385
V1 transaction builders, packers per lane, two-phase batch builder, account decoders, and the flush
sink used by `x402/src/nettingLedger.ts`).

## Why three lanes

Measured on devnet by the batch-settlement spike (Dark NULL design note `X402_BATCH_SETTLEMENT.md`,
2026-10-06, Agave 4.4 cluster; fees read back from `getTransaction`):

| Approach | Payments per tx | Fee per payment (lamports) |
|---|---:|---:|
| x402 `exact` (facilitator fee payer + client signature) | 1 | 10,001 |
| ed25519 precompile vouchers, K=22 | 22 | 5,227 (each precompile signature is charged `lamports_per_signature`) |
| B2, vouchers verified in the program, paged ledger, spike format | 50 | 100 |
| C, channel, one voucher closing 1,000 payments | 1,000 | 10 |
| C, batch close | 35 channels | 142.9 per channel |
| V1 multi-transfer fan-out | 60 | 83.3 |

The spike measured 8,832 CU per voucher for in-program ed25519 (`sol_sha512` + one two-point
curve25519 multiscalar multiplication) with a 56-byte message. This program reuses that verifier and
binds a larger message (below). The precompile is never used, so a voucher costs no signature fee.

V1 limits that bind: 4,096 bytes, 64 addresses, 12 signatures, 64 instructions, no address lookup
tables, a 64-entry instruction trace that counts CPIs.

## Accounts

| Account | Seeds | Size | Holds |
|---|---|---:|---|
| Ledger (one per mint; the SOL ledger is also its own vault) | `["ledger", mint]`, mint = 32 zero bytes for SOL | 192 | mint, vault, cluster salt, delays, `liabilities`, next scope |
| Vault (SPL token account, authority = ledger) | `["vault", ledger]` | 165 | all tokens of the ledger |
| Escrow (one per payer) | `["escrow", ledger, payer]` | 120 + 56 per pair | free balance, exit request, pair table, open channel count |
| Book (shared payee balances) | `["book", ledger, page_le32]` | 2,608 | 64 payee slots (owner, balance) |
| Channel | `["channel", ledger, payer, payee, channel_id_le]` | 168 | deposit, balance, best voucher, expiry, dispute end |
| Batch (two-phase) | `["batch", ledger, batch_id_le]` | 968 | root, counts, totals, chunk bitmap, held funds, up to 16 payee credits |

Every account is checked for owner, discriminator, size and address. Each PDA stores the canonical
bump found with `find_program_address` at creation and is re-derived with `create_program_address`
on every use. Creation tops up and takes over a pre-funded address with allocate + assign, so a
transfer to the address cannot block it.

Mints: SPL Token, or Token-2022 with an extension allowlist: MintCloseAuthority, MetadataPointer,
TokenMetadata, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember. TransferFee,
PermanentDelegate, TransferHook, NonTransferable, DefaultAccountState, ConfidentialTransfer,
InterestBearing, ScaledUiAmount, Pausable and any other extension are refused at InitLedger.

## Voucher

One format for both lanes. The payer signs (ed25519) a 224-byte message:

```text
offset size field
     0    8 tag "X402STL1"
     8   32 program id
    40   32 mint (32 zero bytes for SOL)
    72   32 cluster salt of the ledger
   104   32 payer
   136   32 payee
   168    8 scope u64        escrow scope (lane B2) or channel scope (lane C)
   176    8 cumulative u64   total paid payer -> payee in this scope
   184    8 expiry slot u64  last slot at which it may be submitted
   192   32 x402 quote hash  SHA-256 of the quote this payment answers
```

- **Cluster binding.** InitLedger sets `salt = SHA-256("x402-settle:domain:v1" || program id || mint
  || slot || hash)` from the newest SlotHashes entry. Ledgers of the same program id and mint on two
  clusters get different salts, so a voucher does not replay across clusters. The genesis hash is not
  readable on chain; the salt costs one SlotHashes read per ledger.
- **Scope.** Every escrow and every channel takes a fresh scope from the ledger counter when it is
  created. Scopes are never reused, so vouchers of a closed escrow or channel do not verify against a
  new one, and a B2 voucher never verifies as a channel voucher.
- **Quote hash.** The full 32 bytes are bound. A 16-byte truncation would add one voucher per
  transaction at most and was not adopted.
- Only `cumulative`, `expiry`, `quote hash` and the signature travel on the wire; the other fields
  come from accounts. B2 wire entry: `escrow_ix u8 | pair_ix u8 | book_ix u8 | slot u8 | cumulative u64
  | expiry u64 | quote 32 | signature 64` (116 bytes). Channel close entry: 115 bytes (no pair index).
- Verification is cofactorless with a canonical `s` (no malleability). Payer keys must be canonical
  and not of small order; that is checked once when the escrow opens.

### Replay record: cumulative counter per payer-payee pair

Each escrow keeps a pair table (payee, settled cumulative, pending cumulative, pending batch). A
voucher settles `cumulative - settled` and stores `cumulative`; a voucher at or below the stored
value fails (`StaleVoucher`). Compared with a nonce bitmap it is cheaper on every axis:

- 8 bytes of state per pair against a bitmap window plus its base;
- 8 fewer wire bytes per voucher (no separate nonce next to the amount);
- repeated payments between the same pair collapse: only the latest voucher goes on chain, so a
  netting flush settles one voucher per pair, not one per charge;
- no window to slide and no ordering failure: a newer voucher supersedes any older one.

The cost is that a payer client keeps a running total per payee. A pair entry is unique per payee:
appending a second entry for a payee that already has one is refused (`DuplicatePair`), otherwise a
fresh counter would let the same voucher settle twice. The check scans at most 255 entries and runs
only on an append.

## Lanes

### Escrow and exit

`OpenEscrow` (payer signs, picks the pair capacity, 1 to 255; `GrowEscrow` raises it), `Deposit`
(anyone, SOL by system transfer or SPL by TransferChecked into the vault), `RequestExit(amount)`,
then after `EXIT_DELAY_SLOTS` = 9,000 slots `WithdrawEscrow` pays `min(amount, free balance)`.
Vouchers handed out before the request keep settling during the delay, so a payer cannot front-run
them. `CloseEscrow` requires a zero balance, no pending pairs and no open channels.

### B2: Settle

Verifies K vouchers in one instruction, debits each payer escrow by its delta and credits the payee
slot in a book. Payee balances live in shared book accounts (64 slots per page; slots are permanent
once registered, so a credit always reaches the payee it was signed for). Payees withdraw with
`WithdrawPayee`. One invalid voucher fails the whole transaction; a facilitator simulates before sending.

### C: Channels

- `OpenChannel` moves `deposit` from the payer's escrow into a channel for one payee with an expiry.
- Off-chain, the payer signs cumulative vouchers with the channel scope.
- `CloseChannels` takes many channels in one instruction. If the payee signs the transaction, each
  channel closes at once with the payee's latest voucher. Otherwise a voucher opens a dispute
  window (`DISPUTE_SLOTS` = 1,500) in which a higher voucher supersedes; `FinalizeChannel` pays the
  best voucher after the window (or at once when the payee signs).
- `RequestChannelClose` (payer) opens the dispute window without a voucher, so the payee must answer.
- After expiry, an open channel with no close is refunded in full; `ReclaimChannel` returns the
  remaining balance to the escrow and the rent to the payer.

### Fan-out

Paying many existing token accounts from one source is a client-built V1 multi-transfer
(`packFanOut`: 60 `TransferChecked` per transaction, the address cap). A program instruction would
add a CPI per payment (instruction-trace entries and CU) and no authorization the source signer does
not already give, so none is provided.

### Two-phase batches (atomic beyond one transaction)

1. `BeginBatch(batch_id, root, count, total, chunk_log, chunk_size)` creates the batch PDA with a
   deadline (`BATCH_TIMEOUT_SLOTS` = 1,500).
2. `StageChunk(i, proof, vouchers)`: every voucher is verified as in Settle, its delta leaves the
   escrow balance and is held by the batch, and its pair is locked (`pending`). The leaf is
   `SHA-256(0x00 || delta || message)`; the chunk is a subtree of height `chunk_log` whose leading
   `chunk_size` leaves are the chunk's vouchers (zero leaves after them), and the proof folds the
   chunk root up to `root` (`node = SHA-256(0x01 || left || right)`). A bitmap allows each chunk once.
3. `CommitBatch` checks that every chunk is staged, `staged_count == count`, `staged_total == total
   == held`, and credits every payee slot in that one instruction.
4. `AbortBatch`: the submitter any time before commit, anyone after the deadline.
5. `ResolveStaged` (anyone): after commit it advances each pair's settled cumulative; after abort it
   returns each reservation to its escrow. `CloseBatch` returns the rent to the submitter once every
   pair is resolved.

Atomicity: funds of a staged voucher leave the free balance at staging, so a concurrent withdraw or a
second batch cannot take them (`InsufficientFunds`); the pair is locked, so it cannot be staged again
or settled directly (`PairPending`). Commit and abort are exclusive states of the batch. After commit
nothing can fail: every credit was applied in the commit instruction and resolves only clear markers.
Either every voucher of the batch settles or none does. Constraints: one voucher per pair per batch
(the latest), at most 16 payee slots, at most 256 chunks.

## Solvency

`Ledger::liabilities` is the sum of every escrow balance, channel balance, batch hold and payee
balance of the ledger. Instructions that move tokens in or out of the vault update it and check
`vault holdings >= liabilities` (holdings exclude rent for the SOL ledger; a donation to the vault
is surplus, not a failure). Every other instruction moves value between entries and debits exactly
what it credits. The tests check the full equality `sum of entries == liabilities == holdings` after
every instruction, including a random-sequence fuzz. All arithmetic is checked; loops are bounded by
program constants (255 pairs, 16 batch payees, 32 mint extensions) or by the instruction's own
entries.

## Trust model

- The payer authorizes each payment with its own signature; nobody else can move escrow funds.
- Payees and facilitators hold vouchers. A voucher pays at most `cumulative - settled` to the payee
  named in it, from the scope named in it, before its expiry.
- Anyone may submit vouchers, stage chunks, commit complete batches, finalize channels after the
  window and crank resolves; none of these can redirect funds.
- The payee of a channel must watch for closes it did not sign and answer within the dispute window.
- A payee should settle before the payer's exit completes (exit requests are visible on chain).

## Residual risks

- A token mint with a freeze authority can freeze the vault; withdrawals then fail until thawed.
- A voucher seen on chain (for example in a failed transaction) can be staged by anyone into a batch
  that never completes, locking that pair for up to `BATCH_TIMEOUT_SLOTS` before an abort releases
  it. Keep vouchers private until submitted and stage promptly.
- Book pages and the ledger (for scope counters) are write-locked by the instructions that use them;
  heavy traffic on one page serializes.
- The SHA-512 used on chain comes from `sol_sha512` (SIMD-0512) in the cluster build; the test build
  runs a portable SHA-512 because the solana-program-test 1.18 runtime has no such syscall.

## Errors

Custom codes `0x5853_0000 + n` ("XS"):

| n | Error | n | Error |
|---:|---|---:|---|
| 1 | InvalidInstruction | 19 | ChannelExpired |
| 2 | InvalidAccount | 20 | ChannelNotExpired |
| 3 | AccountInUse | 21 | DisputeOpen |
| 4 | MintNotAllowed | 22 | OverDeposit |
| 5 | Unauthorized | 23 | BatchState |
| 6 | InsufficientFunds | 24 | BatchDeadline |
| 7 | MathOverflow | 25 | BatchNotTimedOut |
| 8 | BadSignature | 26 | ChunkAlreadyStaged |
| 9 | VoucherExpired | 27 | BadChunk |
| 10 | StaleVoucher | 28 | BadMerkleProof |
| 11 | PairPending | 29 | BatchIncomplete |
| 12 | PairMismatch | 30 | BatchTotalMismatch |
| 13 | PairTableFull | 31 | BatchPayeesFull |
| 14 | SlotMismatch | 32 | BatchOutstanding |
| 15 | ExitNotReady | 33 | Insolvent |
| 16 | EscrowBusy | 34 | InvalidParams |
| 17 | InvalidPayerKey | 35 | WrongPendingBatch |
| 18 | ChannelState | 36 | DuplicatePair |

## Compute units and capacity

Measured against the SBF build in solana-program-test 1.18.26 (`tests/cu.rs`). That build uses the
portable SHA-512, measured at 32,410 CU per voucher input (288 bytes, 3 blocks) by the `cu-probe`
instruction that only the test build contains. The cluster column replaces it with `sol_sha512`,
estimated at 229 CU with the `sol_sha256` cost model (85 + one CU per two bytes): an estimate, not a
measurement.

| Instruction | CU, test build [M] | CU, cluster build [E] |
|---|---:|---:|
| InitLedger (SOL) | 6,196 | 6,196 |
| CreateBook | 8,422 | 8,422 |
| OpenEscrow (4 pairs) | 7,099 | 7,099 |
| Deposit (SOL) | 6,782 | 6,782 |
| RequestExit | 4,383 | 4,383 |
| WithdrawEscrow (SOL) | 5,159 | 5,159 |
| RegisterPayee | 2,254 | 2,254 |
| WithdrawPayee (SOL) | 4,961 | 4,961 |
| Settle, 1 voucher | 47,585 | 15,404 |
| Settle, per extra voucher (new payer) | 43,379 | 11,198 |
| Settle, 25 vouchers, 25 payers | 1,088,665 | 284,140 |
| Settle, 32 vouchers, one escrow | 1,332,779 | 302,987 |
| OpenChannel | 16,801 | 16,801 |
| CloseChannels, 1 channel | 47,730 | 15,549 |
| CloseChannels, per extra channel | 43,266 | 11,085 |
| CloseChannels, 25 channels | 1,085,486 | 280,961 |
| ReclaimChannel | 4,564 | 4,564 |
| BeginBatch | 11,767 | 11,767 |
| StageChunk, 24 vouchers | 1,065,914 | 293,570 |
| CommitBatch, 1 payee slot | 4,515 | 4,515 |
| ResolveStaged, 24 pairs | 51,062 | 51,062 |
| CloseBatch | 2,474 | 2,474 |

The per-voucher cost includes the escrow PDA check (1,500 CU) and the pair-table update; the spike's
8,832 CU had neither. Test keys are random, so instructions that create a PDA vary by 1,500 CU per
extra bump tried (OpenChannel measured 9,301 and 16,801 in two runs) and per-voucher figures move by
a few tens of CU between runs.

Largest batch per V1 transaction (4,096 bytes and 64 addresses; each was executed in the tests):

| Lane | Per tx | Binding limit | Fee per payment, one 5,000-lamport signature |
|---|---:|---|---:|
| B2 Settle, distinct payers | 25 | bytes (3,975 B, 29 addresses) | 200 |
| B2 Settle, one escrow | 32 | bytes (3,995 B) | 156 |
| C CloseChannels (payee signs) | 25 | bytes (3,951 B) | 200 per close; (5,000 + 200) / N for N payments per channel |
| Two-phase StageChunk | 25 / 24 / 23 | bytes, at proof depth <= 2 / 3-7 / 8 | about 210 plus Begin, Commit, Resolve, Close |
| Fan-out (client multi-transfer) | 60 | 64 addresses | 83 (spike) |

Against the spike: the quote hash and expiry add 40 bytes per voucher and a per-payer escrow account
adds 33 bytes per distinct payer, which takes B2 from 50 to 25 per transaction (32 for one escrow).
The payer escrow PDA buys a per-payer time-locked exit and isolation of each payer's funds.

## Build and test

Sandbox only (no installs on a key-holding machine):

```bash
cargo-build-sbf --offline --manifest-path programs/x402_settle/Cargo.toml --features sha512-syscall   # cluster build
cargo-build-sbf --offline --manifest-path programs/x402_settle/Cargo.toml --features cu-probe          # test build
cargo test -p x402-settle --features cu-probe                                    # native
SBF_OUT_DIR=<dir of the test build> cargo test -p x402-settle --features cu-probe # against the .so
X402_SETTLE_WRITE_VECTORS=1 cargo test -p x402-settle --test vectors            # regenerate vectors
```

Tests: 5 unit (scalar reduction vectors, SHA-512 known answers and cross-check, small-order keys,
subtree roots), 16 integration (each lane's happy path; tampered, replayed, expired, wrong program id,
wrong mint, wrong salt, wrong scope and malleated vouchers; duplicate pair entries; exit timelock;
channel supersede, dispute, payer close, expiry refund and batch close; two-phase commit, missing
chunk, double staging, bad proof, total mismatch, timeout abort, reservations against withdraw and a
second batch; pre-funded PDAs; Token-2022 allowlist; solvency fuzz), 1 CU and capacity test, and 1
cross-language vector test shared with `packages/x402-settle`.
