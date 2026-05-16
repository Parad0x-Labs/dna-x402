# One-Click Agent Factory

This factory turns a new seller idea into a runnable DNA x402 agent starter with a manifest, paid routes, local env template, and manifest signing script.

## Public Templates

Use these for normal public marketplace onboarding:

```powershell
npx dna-x402 init agent my-service-agent --template service
npx dna-x402 init agent my-market-agent --template marketplace
npx dna-x402 init agent my-auction-agent --template auction
npx dna-x402 init agent my-strategy-agent --template trading
```

Local source checkout equivalent:

```powershell
npm --prefix x402 run init:agent -- .\reports\agent-lab\service-agent --template service --no-install
npm --prefix x402 run init:agent -- .\reports\agent-lab\market-agent --template marketplace --no-install
npm --prefix x402 run init:agent -- .\reports\agent-lab\auction-agent --template auction --no-install
npm --prefix x402 run init:agent -- .\reports\agent-lab\strategy-agent --template trading --no-install
```

Quote absolute Windows paths that contain spaces:

```powershell
npm --prefix x402 run init:agent -- "G:\DNA x402\reports\agent-lab\service-agent" --template service --no-install
```

Each starter includes:

- `index.ts` with paid x402 endpoints.
- `manifest.json` for marketplace registration.
- `sign-manifest.ts` for owner signature generation.
- `.env.example` with recipient, owner, RPC, and settlement controls.
- A vendored local `dna-x402` tarball when generated from the checkout.

## Restricted Market Template

Betting, wagering, gambling, odds, and sportsbook flows are blocked by default:

```powershell
npx dna-x402 init agent my-restricted-agent --template restricted-market
```

Aliases such as `--template betting` map to the same restricted shell. The generated service returns HTTP 451 and does not expose paid wagering routes. This is intentional. A live restricted-market product requires jurisdiction-specific legal approval, licensing, age/location controls, AML/KYC controls, responsible-use controls, and a separate compliance-gated launch path.

## Publish Flow

1. Set `RECIPIENT` to the wallet that receives paid endpoint revenue.
2. Set `OWNER_PUBKEY` to the manifest owner wallet.
3. Set `SOLANA_RPC_URL` to a production-grade mainnet RPC before production traffic.
4. Run the service locally and inspect `/.well-known/dna-x402/manifest.json`.
5. Set `OWNER_SECRET_BASE58` only in a local shell.
6. Run `npm run sign-manifest`.
7. Register the signed manifest with the marketplace.
8. Run quote, paid request, receipt verification, response digest, reputation, and disable-flow checks before sending public traffic.

## Production Gate

A generated agent is not production-ready until these pass:

```powershell
npm --prefix x402 run build
npm --prefix x402 test -- tests/cli.test.ts tests/market.safety.test.ts
npm --prefix x402 run security:scan
```

Public categories can be launched through the normal marketplace policy. Restricted categories remain blocked until a separate compliance gate exists.
