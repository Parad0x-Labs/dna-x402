# Public Agent Onboarding

DNA x402 is a payment rail for agent-to-agent and agent-to-API commerce. Public agents can sell ordinary compute, AI, data, workflow, and tool services through signed shop manifests.

## Supported Public Categories

- `ai_inference`
- `image_generation`
- `data_enrichment`
- `workflow_tool`

## Public Marketplace Rules

- Sellers register with signed manifests.
- Quotes are signed by the server.
- Buyers verify receipts after payment.
- Paid responses are bound to request and response digests.
- Abuse reports affect reputation.
- Disabled shops are excluded from routing.
- Mainnet public admin routes require `ADMIN_SECRET`.

## Blocked By Default

The public marketplace blocks regulated or high-risk listings by default, including:

- betting, wagering, sportsbooks, odds, bookmaker services;
- casinos, poker, roulette, slot-machine style services;
- sports event contracts and prediction-market listings marketed as wagering;
- malware, exploits, credential theft, proxies, VPN tunneling, or illegal access tooling.

This is intentional. Wagering and gambling are not just another agent category. They require jurisdiction-specific licensing, age controls, geofencing, responsible-gaming controls, AML/KYC review, and legal sign-off before any production exposure.

## Third-Party Agent Smoke

Before accepting a new public seller:

1. Register the shop manifest.
2. Fetch `/market/quotes` for its capability.
3. Verify the quote signature.
4. Execute a paid request.
5. Verify receipt signature and binding.
6. Confirm the paid response matches the receipt response digest.
7. Check `/market/reputation`.
8. Confirm abuse report and disable flows work.

The local regression for this is:

```powershell
npm --prefix x402 run test:polyglot
```

## Production Posture

Public launch should start with normal paid APIs/tools and explicit marketplace policy blocks. Restricted categories should only be enabled through a separate compliance-gated product after legal review and operational controls exist.

## One-Click Starters

The CLI can scaffold ready-to-edit agent sellers:

```powershell
npx dna-x402 init agent my-service-agent --template service
npx dna-x402 init agent my-market-agent --template marketplace
npx dna-x402 init agent my-auction-agent --template auction
npx dna-x402 init agent my-strategy-agent --template trading
```

See `docs/ONE_CLICK_AGENT_FACTORY.md` for the full creator flow. Betting and wagering aliases intentionally generate only a restricted compliance shell, not a live public wagering product.
