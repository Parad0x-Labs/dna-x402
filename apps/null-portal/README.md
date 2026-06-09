# .null Portal — Register MVP

A standalone Next.js app where any visitor connects **their own Phantom wallet**
and registers a `.null` name on **Solana mainnet**. The name is owned by the
visitor's wallet. Non-custodial — the app never holds a key.

This is the public registration front-end for the live `.null` registrar
program (`H4wbFJ…`). The on-chain SDK here is a TypeScript port of the
mainnet-verified go-live scripts (`scripts/mainnet-rollout/_lib.mjs` +
`06_verify.mjs` in `web0-internal`), byte-for-byte.

## Features

- **Search** (`/`) — debounced live availability lookup. Derives `domainPda(name)`,
  `getAccountInfo` → AVAILABLE vs TAKEN (shows owner if taken). Validates charset
  + length, shows the tier (4–32 registerable; 1–3 premium auction-only; invalid
  is explained) and the live price read from the on-chain config:
  `0.007 SOL  or  ~N NULL (−20%)`.
- **Register** — when AVAILABLE + registerable + wallet connected: a currency
  toggle (SOL default, NULL optional). The NULL option is disabled with a note
  if the wallet has no NULL ATA / insufficient NULL. A fresh `confirmed`
  blockhash is fetched at sign time, signed + sent via Phantom, confirmed, and
  the success card links the tx on Solscan.
- **My Names** (`/my-names`) — `getProgramAccounts` with a memcmp filter on the
  NullDomain owner field (offset 65) == the connected wallet. Lists owned
  domain accounts. `manage`/auction is phase 2.

## Run

```bash
cd apps/null-portal
npm install
npm run dev          # http://localhost:3000
```

Production:

```bash
npm run build && npm run start
```

### Environment

| Var | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | `https://api.mainnet-beta.solana.com` | Public; ships in the bundle. Use a paid RPC for production (the My-Names `getProgramAccounts` scan is heavy on the public RPC). |

Copy `.env.example` → `.env.local` to override.

## Verify the on-chain wiring (read-only, sends nothing)

```bash
npm run verify:wiring
```

Proves `configPda() === BQTxsYx…`, decodes the live 122-byte config, and checks
`domainPda("chat")` resolves to the existing on-chain `chat.null` account —
confirming the ported PDA / name-hash math is byte-correct. No transaction is
ever sent.

## Node 22 note

The machine runs Node 22, and Next.js 15.5 has a known prerender crash on Node
22. This app avoids it by making every wallet/RPC surface a **client component**
and forcing dynamic rendering (`export const dynamic = "force-dynamic"` on both
pages) — so no wallet page is statically prerendered. `next.config.mjs` also
pins `outputFileTracingRoot` to this app so the monorepo root isn't traced.

## Mainnet ground truth (hardcoded constants)

| Thing | Address |
|---|---|
| Registrar program | `H4wbFJucY9shJt95N8Bra532Z4nnkKhGEfqWvLcYfuDm` |
| Auction program | `7uxLhqLzkEzPpkvdmTwqgL3g66yq2aMBS5QgcjaZZEaw` |
| Registry config PDA (v2, 122B) | `BQTxsYxocM2ZC3Wb2pVdnyzTPduBcNhKojhBenR6AXYG` |
| $NULL mint (Token-2022) | `8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump` |
| Treasury | `F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY` |

Fees are read **live** from the config account at runtime (not hardcoded).

## Phase-2 TODOs

- **Auctions** for 1–3 char premium names (currently shown as "auction-only —
  coming soon"; the auction program is `7uxLhq…`).
- **Manage** a name: set/update the Arweave content pointer, transfer ownership.
- **Plaintext name in My Names**: the on-chain record stores `sha256(name)`, not
  the plaintext, so My Names lists domain *account* addresses. Showing the
  human name needs an off-chain index (or a user-supplied name to re-derive).
