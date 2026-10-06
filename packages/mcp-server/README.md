Published from Parad0x-Labs/openclaw-skills; this copy is not published.

# @parad0x_labs/mcp-server

Exposes the Parad0x Labs stack as MCP tools. Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible agent runtime.

## Tools

| Tool | Description |
|---|---|
| `x402_get_quote` | Get a payment quote for an x402-gated API endpoint |
| `anchor_receipt` | Anchor a 32-byte receipt hash via `receipt_anchor`. This server configures no `receipt_anchor` program (devnet: `HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs`); the tool returns an error and sends nothing |
| `lookup_passport` | Check if an ETH address or Solana wallet has a Dark Passport binding record from the retired mainnet pilot (records stay readable) |
| `build_outcome_receipt` | Build a signed outcome receipt with PnL, accuracy, or delivery result |
| `compress_receipts` | Compress a batch of receipts with zlib deflate (level 9) and return a SHA-256 Merkle root; a format demonstration, not the Liquefy columnar codec |
| `check_nullifier` | Validate a nullifier for `dark_nullifier_record`. This server configures no `dark_nullifier_record` program (devnet: `CPMfXL73v9PDmxyPLTM97bzrNa5eg2AEpsac9XKzX9et`); the tool returns an error and makes no RPC call |
| `get_stack_status` | Status of the mainnet pilot programs (all retired 2026-07-14) and of programs this server does not configure |
| `private_compute` | Encrypt an input locally (AES-256-GCM), send the ciphertext to an executor endpoint you name, and return the result hash. With `anchor: true` the commitment reports `anchor_failed`, since no `receipt_anchor` program is configured |

## Install

```bash
npm install -g @parad0x_labs/mcp-server
```

Or use directly via `npx` without installing.

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "parad0x": {
      "command": "npx",
      "args": ["-y", "@parad0x_labs/mcp-server"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        "SOLANA_KEYPAIR": "[1,2,3,...]"
      }
    }
  }
}
```

`SOLANA_KEYPAIR` is a JSON array of 64 bytes (the standard Solana keypair format output by `solana-keygen`). `anchor_receipt` does not use it: this server configures no `receipt_anchor` program.

## Cursor / Windsurf config

Add to `.cursor/mcp.json` or `.windsurf/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "parad0x": {
      "command": "npx",
      "args": ["-y", "@parad0x_labs/mcp-server"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com"
      }
    }
  }
}
```

## Build from source

```bash
cd packages/mcp-server
npm install
npm run build
npm start
```

## Env vars

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `SOLANA_KEYPAIR` | _(unset)_ | JSON array of 64 bytes — enables real transaction submission |

## Programs (mainnet pilot, retired)

The mainnet pilot programs ran from 2026-05-29 and were retired on 2026-07-14 (ProgramData closed); accounts they own stay readable. `receipt_anchor` (`HSdEQWunzPtNqdzv5HfXuA3zwPLpgTXRyfbndnGamhXs`) and `dark_nullifier_record` (`CPMfXL73v9PDmxyPLTM97bzrNa5eg2AEpsac9XKzX9et`) run on devnet only ([`configs/devnet.oss.json`](../../configs/devnet.oss.json)); this server configures neither, so `anchor_receipt` and `check_nullifier` return an error without sending or reading anything.

| Program | Address | Status |
|---|---|---|
| dark_secp256k1_auth | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | Retired 2026-07-14 (records readable) |
| dark_semaphore | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | Retired 2026-07-14 (records readable) |
| null_token | `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` | Live |
| dark_bn254_gate | `GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd` | Retired 2026-07-14. Was excluded from the pilot (`0xDE 0xAD` unconditional bypass, documented P0); do not use |
