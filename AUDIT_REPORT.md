# Full Audit Report

Generated: 2026-02-17T00:22:13.253Z
Cluster: devnet
Overall: PASS

## Steps
- Deploy estimate: PASS - Deploy estimate report generated
- Deploy ledger: PASS - validated 1 ledger entries
- Buffer reclaim: PASS - No buffers existed before reclaim
- Pause flags: PASS - Pause flags enforced for market, finalize, and orders.
- Verification negatives: PASS - Negative verification checks reject invalid proofs and forged receipts.
- 10-agent simulation: PASS - 10-agent simulation passed
- Local smoke: PASS - Local smoke passed (/health, /market/snapshot, 402->finalize->200, anchoring confirmed)
- Remote smoke: PASS - Remote smoke skipped: no X402_BASE_URL/--base-url provided.
- Anchoring evidence: PASS - Anchoring evidence confirmed for 2n7cubhzCXjnyyHncJ3dQyDvpsHRsNJMfC7wmURqVuKo3R2TsgWrH9Z2sgspZBydbi7tCSUsPoFaHiq1jRCQHhMK

## Artifacts
- audit json: <repo-root>/reports/audit-2026-02-17T00-22-05.420Z.json
- deploy estimate: <repo-root>/reports/estimate-deploy-cost-2026-02-17T00-22-05.420Z.json
- deploy ledger: <repo-root>/reports/deploy-ledger-receipt-anchor-20260217T001315Z.json
- close buffers: <repo-root>/reports/close-buffers-2026-02-17T00-22-05.420Z.json
- sim 10 agents: <repo-root>/reports/sim-10agents-2026-02-17T00-22-05.420Z.json
- anchor tx sigs: <repo-root>/reports/anchor_tx_sigs-2026-02-17T00-22-05.420Z.txt
- anchor confirm: <repo-root>/reports/anchor_confirm-2026-02-17T00-22-05.420Z.txt
- bucket dump: <repo-root>/reports/bucket_account_dump-2026-02-17T00-22-05.420Z.txt

## Notes
- Reused latest deploy-ledger report: <repo-root>/reports/deploy-ledger-receipt-anchor-20260217T001315Z.json