# Mainnet Frontier Final Gate

## Why Mainnet Is Blocked

Mainnet deployment is blocked until ALL of the following conditions are met.
Missing any single condition blocks the deploy.

## Required Conditions

| # | Condition | Status | Evidence File |
|---|-----------|--------|---------------|
| 1 | `ALLOW_MAINNET_DEPLOY=YES` env var set | Manual | — |
| 2 | Third-party audit sign-off | Not started | dist/frontier-final/evidence/audit_signed.json |
| 3 | `cargo test --workspace` passes on current commit | Scripts check | — |
| 4 | `cargo audit` — no critical/high vulnerabilities | Not run | — |
| 5 | `cargo deny check` — licenses + duplicates clean | Not run | — |
| 6 | No forbidden claim failures (check-frontier-final-claims.mjs) | Script ready | — |
| 7 | Signed deploy plan with program IDs | Not created | dist/frontier-final/evidence/signed_deploy_plan.json |
| 8 | Max SOL budget specified and within limits | Not set | — |
| 9 | Program size estimate (≤ 2MB per program) | ~75-80KB each | — |
| 10 | Upgrade authority policy defined | Not defined | — |
| 11 | Rollback/pause procedure documented | Not documented | — |
| 12 | No HMAC-lite in production path | Fixed in Phase 9 | dist/frontier-final/evidence/hmac_rfc2104.json |
| 13 | x402 devnet tx verified (if x402 claimed) | Mock only | dist/frontier-final/evidence/x402_devnet_real.json |
| 14 | Poseidon real backend tested (if Poseidon claimed) | Blocked | dist/frontier-final/evidence/poseidon_real.json |
| 15 | ZK proof real backend wired (if ZK claimed) | Mock only | dist/frontier-final/evidence/zk_verifier_real.json |
| 16 | Compression real integration (if compression claimed) | Simulator only | dist/frontier-final/evidence/zk_compression_real.json |

## Command to Run Gate Check

```bash
node scripts/check-mainnet-frontier-final.mjs
```

## Emergency Stop

If mainnet deploy has started and must be stopped:
1. `solana program set-upgrade-authority <program_id> --new-upgrade-authority <emergency_authority>`
2. Contact Solana Labs Foundation incident response
3. Document all affected program IDs and deploy transactions

## Upgrade Authority Policy (REQUIRED before mainnet)

- Upgrade authority must NOT be the deploy keypair
- Upgrade authority should be a hardware wallet multisig (3-of-5 minimum)
- Must document: who holds each key, key rotation procedure, emergency procedures

## Cost Budget

Estimated mainnet deploy cost per program (including rent):
- Program account: ~1.5 SOL per MB of .so file
- 3 programs at ~80KB each: ~0.38 SOL total
- Buffer + overhead: ~2 SOL total

Max allowed deploy spend: **5 SOL** (without additional approval)

## Rollback Policy (REQUIRED before mainnet)

- All programs must remain upgradeable on mainnet v1
- Immutable-authority programs require separate audit
- Rollback procedure: redeploy previous .so to program buffer, then upgrade
