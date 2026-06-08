# Devnet Smoke-Test Report

> This is an automated devnet smoke/integration test of deploy, pause-flag, and
> anchoring behavior — **not a security audit**. It has not been performed by any
> third-party auditor and must not be cited as a security review. The programs are
> UNAUDITED. "PASS" below means the smoke-test steps ran successfully on devnet.

Generated: 2026-05-27T04:00:40.822Z
Cluster: devnet
Overall: PASS (smoke test)

## Steps
- Deploy estimate: PASS - Deploy estimate report generated
- Deploy ledger: PASS - validated 1 ledger entries
- Buffer reclaim: PASS - No buffers existed before reclaim
- Pause flags: PASS - Pause flags enforced for market, finalize, and orders.
- Verification negatives: PASS - Negative verification checks reject invalid proofs and forged receipts.
- 10-agent simulation: PASS - 10-agent simulation passed
- Local smoke: PASS - Local smoke passed (/health, /market/snapshot, 402->finalize->200, anchoring confirmed)
- Remote smoke: PASS - Remote smoke skipped: no X402_BASE_URL/--base-url provided.
- Anchoring evidence: PASS - Anchoring evidence confirmed for 3hjamjwumezcJs6d7aiHiPNbUBTD9VvAVnZHxkuUm68h9exw1ANXhFUHMnwNKhHW1aTTYMiBTecWvBJZn6UqwQSN

## Artifacts
- smoke-test json: <repo-root>\reports\audit-2026-05-27T04-00-23.174Z.json
- deploy estimate: <repo-root>\reports\estimate-deploy-cost-2026-05-27T04-00-23.174Z.json
- deploy ledger: <repo-root>\reports\deploy-ledger-2026-05-14T11-26-56.475Z.json
- close buffers: <repo-root>\reports\close-buffers-2026-05-27T04-00-23.174Z.json
- sim 10 agents: <repo-root>\reports\sim-10agents-2026-05-27T04-00-23.174Z.json
- anchor tx sigs: <repo-root>\reports\anchor_tx_sigs-2026-05-27T04-00-23.174Z.txt
- anchor confirm: <repo-root>\reports\anchor_confirm-2026-05-27T04-00-23.174Z.txt
- bucket dump: <repo-root>\reports\bucket_account_dump-2026-05-27T04-00-23.174Z.txt

## Notes
- Reused latest deploy-ledger report: <repo-root>\reports\deploy-ledger-2026-05-14T11-26-56.475Z.json
