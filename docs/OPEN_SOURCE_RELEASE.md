# Open Source Release

## What This Is

Dark Null Protocol (DNP) is a payment and verification rail for AI tool commerce:
- HTTP `402 -> pay -> retry -> 200` flow (x402 style)
- signed receipts with hash chaining
- optional on-chain receipt anchoring for verifiable leaderboards

## What This Is Not

- Not a custody wallet service
- Not an arbitration oracle for seller business outcomes
- Not a betting or gambling platform
- Not a guarantee of seller fairness; seller logic is seller-defined

## Verification Tier Definitions

- `FAST`: fulfilled request + payment verified + receipt signature valid
- `VERIFIED`: `FAST` + receipt anchor confirmed on-chain

## Quickstart

```bash
cd x402
npm install
npm test
npm run bench:txsize
npm run bench:compute
npm run audit:programmable -- --cluster devnet
```

Optional proof bundle publish (for website):

```bash
cd x402
npm run publish:proof-bundle
```

## Reproducibility

Core proof/evidence artifacts:
- `docs/FOOTPRINT.md`
- `x402/audit_out/PROGRAMMABILITY_READINESS_REPORT.md`
- `x402/audit_out/programmable_readiness.json`
- `x402/audit_out/programmable_devnet.json`

## Safety Boundary

Protocol-vs-seller responsibility boundary is defined in:
- `docs/PROGRAMMABILITY_CONTRACT.md`
