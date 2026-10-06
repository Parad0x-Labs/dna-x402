# @parad0x_labs/x402-settle

TypeScript client for the `x402_settle` Solana program
([`programs/x402_settle`](../../programs/x402_settle)). No runtime dependencies (`node:crypto` for
SHA-256, SHA-512 and ed25519); Node.js 22.6 or later runs the TypeScript source directly.

- Vouchers: `voucherMessage`, `signVoucher`, `ledgerSalt`, wire encoders for Settle and
  CloseChannels entries.
- SIMD-0385 V1 transactions: `compileMessage` (solana-sdk account order), `serializeV1Message`,
  `signV1`, `buildV1Transaction`, `v1Size`, `fitsV1` (4,096 bytes, 64 addresses, 12 signatures).
- Instruction builders for every instruction, PDA derivation (`ledgerPda`, `escrowPda`, ...),
  account decoders, error names.
- Packers: `packSettle` (lane B2, 25 payers or 32 vouchers of one escrow per transaction),
  `latestPerPair`, `packCloseChannels` (lane C, 25 per transaction), `packFanOut` (60
  `TransferChecked` per transaction).
- Two-phase batches: `buildTwoPhase` returns Begin, one StageChunk per chunk, Commit, Resolve,
  Close and Abort instructions; `chooseChunkSize` picks the largest chunk that fits.
- `createB2FlushSink`: settles the vouchers carried by `x402/src/nettingLedger.ts` entries
  (`NettingLedger.flushToSettlement`), one V1 transaction per pack, latest voucher per pair.

Program ids are not hardcoded: pass the id from your configuration.

```bash
npm install --ignore-scripts
npm run lint
npm test   # recomputes programs/x402_settle/tests/vectors/x402_settle_v1.json
```
