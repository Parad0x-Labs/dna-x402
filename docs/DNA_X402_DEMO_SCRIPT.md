# DNA x402 Sandbox Demo Script

Goal: show a large programmable commerce surface without live money, private keys, unsafe categories, public netting, physical goods, high-risk categories, or Polymarket live movement.

## Pre-Demo Truth

- Mode: `Mode 0: Lab` or private sandbox.
- Settlement: fake/sandbox verifier only.
- Production money movement: disabled.
- Backend private key custody: forbidden.
- Unattended signing: disabled.
- Risky verticals: gated.

## Demo Flow

1. Open `/agent/marketplace`.
2. Show the marketplace home, search, filters, signed listing cards, proof badges, and seller reputation fields.
3. Create a low-risk paid API listing in the seller wizard.
4. Show the signed manifest preview and manifest version hash.
5. Publish the listing in sandbox mode.
6. Open the buyer flow and request quotes.
7. Show quote comparison: amount, settlement option, fee waterfall, policy result, expiry.
8. Commit the selected quote.
9. Submit a sandbox payment proof through the fake verifier.
10. Finalize and issue the signed receipt.
11. Open the receipt viewer and verify:
    - quote ID
    - commit ID
    - request digest
    - response digest
    - payment proof digest
    - policy decision hash
    - fee waterfall hash
    - seller manifest hash
12. Retry the paid endpoint and show fulfilled result.
13. Show seller reputation update and recent activity.
14. Fire a sandbox webhook and show replay protection.
15. Trigger emergency pause.
16. Confirm new quote creation is blocked.
17. Confirm old receipt remains readable.
18. Submit a sandbox payload containing raw email or tax-like data to an immutable path.
19. Confirm the PII guard blocks before hash/sign/write.
20. Run server mayhem and show attacks failing safely.
21. Open `/metrics` and show counters for finalize, policy, webhooks, PII blocks, emergency pause.
22. Open `docs/DNA_X402_FUTURE_PROOF_COMMERCE_MATRIX.md` and show APIs, tools, data feeds, agents, compute, auctions, bundles, and verticals as modules.

## Talk Track

DNA x402 is a programmable commerce rail. Sellers publish signed capabilities. Humans and agents discover, quote, pay, verify, and unlock results through one HTTP-native loop. Every paid action can carry policy, fee, settlement, receipt, reputation, tax, privacy, and governance metadata.

This demo proves the loop and the safety controls in sandbox mode. It does not claim public production readiness.

## What Not To Say

- Do not claim live money is enabled.
- Do not claim public production launch is approved.
- Do not claim physical goods, Polymarket live movement, public netting, high-risk categories, broad multi-chain settlement, or unattended live agent spending are launchable.
- Do not say monitoring is production-wired until evidence exists.
- Do not say Postgres proof passed unless live Postgres migration, concurrency, and backup/restore evidence exists.

## Demo Close

The safe demo should feel large because the architecture is modular. The risk posture stays strict because every dangerous path is behind explicit gates.
