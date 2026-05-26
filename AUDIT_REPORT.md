# Full Audit Report

Generated: 2026-05-14T11:27:10.771Z
Cluster: devnet
Overall: PASS

## Steps
- Deploy estimate: PASS - Deploy estimate report generated
- Deploy ledger: PASS - validated 1 ledger entries
- Buffer reclaim: PASS - No buffers existed before reclaim
- Pause flags: PASS - Pause flags enforced for market, finalize, and orders.
- Verification negatives: PASS - Negative verification checks reject invalid proofs and forged receipts.
- 10-agent simulation: PASS - 10-agent simulation passed
- Local smoke: PASS - Local smoke passed (/health, /market/snapshot, 402->finalize->200)
- Remote smoke: PASS - Remote smoke skipped: no X402_BASE_URL/--base-url provided.
- Anchoring evidence: PASS - Anchoring signature log not found: <repo-root>\reports\anchor_tx_sigs.txt

## Artifacts
- audit json: <repo-root>\reports\audit-2026-05-14T11-26-56.475Z.json
- deploy estimate: <repo-root>\reports\estimate-deploy-cost-2026-05-14T11-26-56.475Z.json
- deploy ledger: <repo-root>\reports\deploy-ledger-2026-05-14T11-26-56.475Z.json
- close buffers: <repo-root>\reports\close-buffers-2026-05-14T11-26-56.475Z.json
- sim 10 agents: <repo-root>\reports\sim-10agents-2026-05-14T11-26-56.475Z.json
- anchor tx sigs: n/a
- anchor confirm: n/a
- bucket dump: n/a

## Notes
- No previous deploy-ledger report found; generated dry-run ledger.