# @parad0x_labs/mcp-server

Exposes the Parad0x Labs stack as MCP tools. Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible agent runtime.

## Tools

| Tool | Description |
|---|---|
| `x402_get_quote` | Get a payment quote for an x402-gated API endpoint |
| `anchor_receipt` | Anchor a 32-byte receipt hash via `receipt_anchor`. Receipt anchoring is unavailable until the redeploy under a fresh key; the tool returns an error and sends nothing |
| `lookup_passport` | Check if an ETH address or Solana wallet has a verified Dark Passport binding |
| `build_outcome_receipt` | Build a signed outcome receipt with PnL, accuracy, or delivery result |
| `compress_receipts` | Compress a batch of receipts (Liquefy format, 83x typical ratio) |
| `get_stack_status` | Discover all live Parad0x Labs mainnet program addresses |

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

`SOLANA_KEYPAIR` is a JSON array of 64 bytes (the standard Solana keypair format output by `solana-keygen`). `anchor_receipt` does not use it while receipt anchoring is unavailable.

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

## Programs (mainnet)

`receipt_anchor` and `dark_nullifier_record` have no usable deployment on any cluster until the redeploy under a fresh key, so `anchor_receipt` and `check_nullifier` return an error without sending or reading anything.

| Program | Address | Status |
|---|---|---|
| dark_secp256r1_vault | `3hbbtjeSrTVYXq6eRwjeofDe2DCPh3n8cfN6kZcQfewi` | Live |
| dark_secp256k1_auth | `AqwBbV13AoczhoELwP8oxT3nDqB6MsLWXauNzHkssZ9B` | Live |
| dark_semaphore | `Ev7HEFhhKTXk6kS2Y6ssbUcK9C7E6yZ589jJNjUrQV5p` | Live |
| null_token | `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` | Live |
| dark_bn254_gate | `GCptvBYF8S6eVYoh15B7WAESc54FUHCpN1Ui6aHeQYZd` | ⛔ Excluded stub — `0xDE 0xAD` unconditional bypass (any proof passes), documented P0. NOT a real verifier, do not use. A trustless on-chain verifier is pending (clean redeploy + ceremony). |
