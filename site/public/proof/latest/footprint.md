# FOOTPRINT

Generated: 2026-02-17T00:23:41.093Z

## Settlement Tx Size

| Flow | tx bytes | signatures | accounts | ix data bytes | ALT |
| --- | ---: | ---: | ---: | ---: | --- |
| anchor_legacy | 270 | 1 | 4 | 34 | no |
| anchor_v0_no_alt | 272 | 1 | 4 | 34 | no |
| anchor_v0_with_alt | 244 | 1 | 4 | 34 | yes |

- Smallest settlement tx: **244 bytes**
- Batch max anchors within 1232 bytes: **32**

## Compute

- anchor_single_v0: 13,600 CU
- anchor_batch32_v0: 19,434 CU
- Max observed: **19,434 CU** (threshold 30,000 CU)

## Soak (10-agent)

- runs: 16, successRate: 100.00%, p50: 1953.0 ms, p95: 1996.0 ms

## Benchmark Inputs

- txsize report: `x402/reports/bench_txsize.json`
- compute report: `x402/reports/bench_compute.json`
- soak report: `x402/reports/soak-2026-02-17T00-23-05.216Z.json`

## Verified Tier Definition

- VERIFIED = fulfilled receipt whose anchor32 is confirmed on-chain (anchored=true, verificationTier=VERIFIED).
- FAST = fulfilled + payment verified + valid signed receipt, regardless of anchor status.