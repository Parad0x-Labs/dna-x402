# Null Resolver — Chrome Extension

A Manifest V3 Chrome/Chromium extension that intercepts navigation to `*.null` domains and resolves them via the Solana `null_registrar` program.

## What it does

1. You type `parad0x.null` in the address bar (or click a `.null` link).
2. The extension catches the navigation before the browser hits DNS.
3. It derives the on-chain PDA for that name (`["null-domain", name]` seeds against the `null_registrar` program).
4. It calls a Solana RPC node to fetch the account data.
5. It reads the `content_hash` field from the account and maps it to an Arweave URL (`https://arweave.net/<base58(content_hash)>`).
6. The tab is redirected to the resolved Arweave URL — your permanent, censorship-resistant site.
7. If the domain is not registered yet, a friendly "not found" page appears with a link to register at `parad0xlabs.com/null-register`.

## Files

```
null-resolver/
  manifest.json           — MV3 extension manifest
  background.js           — Service worker: navigation interception + Solana resolver
  popup.html / popup.js   — Toolbar popup: status, register CTA, RPC setting
  null-resolver-page.html — "Not registered" fallback page
  icon.png                — Extension icon (128x128)
  README.md               — This file
```

## Install (developer mode)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `null-resolver/` directory.
5. The extension is now active. Type any `.null` domain in the address bar.

## Configuration

Open the extension popup and expand **Advanced** to set a custom Solana RPC URL.

Default: `https://api.mainnet-beta.solana.com`

You can use any Solana mainnet RPC endpoint (e.g. Helius, QuickNode, Triton).

## Program details

| Field | Value |
|---|---|
| Program ID | `NuLLRegistrar1111111111111111111111111111111` (placeholder — update when deployed) |
| PDA seeds | `["null-domain", <name_bytes>]` |
| Account layout | 8-byte Anchor discriminator + u32 name length + name bytes + 32-byte `content_hash` + i64 `registered_at` + 32-byte owner pubkey |
| Content resolution | `content_hash` is base58-encoded and appended to `https://arweave.net/` |

## Roadmap

- Bundle `@solana/web3.js` (or a minimal Ed25519 library) to replace the heuristic off-curve PDA check with a cryptographically correct one.
- Support sub-domains: `agent.parad0x.null`.
- Support IPFS content hashes in addition to Arweave.
- Add a local cache (IndexedDB) to avoid RPC calls on repeat visits.
- Firefox/Brave compatible build (MV2 fallback).

## Built by

[Parad0x Labs](https://parad0xlabs.com) — NULL token · DNA x402 · Solana
