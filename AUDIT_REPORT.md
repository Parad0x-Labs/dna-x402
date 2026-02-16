# Full Audit Report

Generated: 2026-02-16T23:09:26.532Z
Cluster: devnet
Overall: PASS

## Steps
- Deploy estimate: PASS - Deploy estimate report generated
- Deploy ledger: PASS - validated 1 ledger entries
- Buffer reclaim: PASS - No buffers existed before reclaim
- Pause flags: PASS - Pause flags enforced for market, finalize, and orders.
- Verification negatives: PASS - Negative verification checks reject invalid proofs and forged receipts.
- 10-agent simulation: PASS - 10-agent simulation passed
- Local smoke: PASS - Local smoke endpoints passed (/health, /market/snapshot)
- Remote smoke: PASS - Remote smoke skipped: no X402_BASE_URL/--base-url provided.

## Artifacts
- audit json: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/audit-2026-02-16T23-09-21.293Z.json
- deploy estimate: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/estimate-deploy-cost-2026-02-16T23-09-21.293Z.json
- deploy ledger: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/deploy-ledger-2026-02-16T21-34-25.470Z.json
- close buffers: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/close-buffers-2026-02-16T23-09-21.293Z.json
- sim 10 agents: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/sim-10agents-2026-02-16T23-09-21.293Z.json

## Notes
- Reused latest deploy-ledger report: /Users/sauliuskruopis/Desktop/dark $NULL/dark_null_protocol/reports/deploy-ledger-2026-02-16T21-34-25.470Z.json