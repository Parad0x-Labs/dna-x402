# ALT Setup

Address Lookup Tables (ALTs) reduce transaction key bloat for v0 messages. Use these scripts from `/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402`.

## 1) Create ALT

```bash
npm run alt:create -- --cluster devnet --keypair /path/to/deployer.json
```

This writes a report under `x402/reports/alt-create-*.json` with `lookupTableAddress`.

## 2) Extend ALT

```bash
npm run alt:extend -- \
  --cluster devnet \
  --keypair /path/to/deployer.json \
  --alt <LOOKUP_TABLE_ADDRESS> \
  --address <PROGRAM_ID> \
  --address 11111111111111111111111111111111 \
  --address SysvarC1ock11111111111111111111111111111111
```

Recommended static entries:
- Anchor/settlement program id
- `SystemProgram`
- `SYSVAR_CLOCK`
- USDC mint
- Token/ATA programs
- frequently used PDAs

## 3) Show ALT

```bash
npm run alt:show -- --cluster devnet --alt <LOOKUP_TABLE_ADDRESS>
```

This writes `x402/reports/alt-show-*.txt`.

## 4) Use in tx builders

`/Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/x402/src/tx/buildV0.ts` includes:
- `buildV0AnchorTransaction(...)`
- `createSyntheticLookupTable(...)` for local size benchmarking

For production, fetch real ALT accounts from RPC and pass them to `compileToV0Message`.
