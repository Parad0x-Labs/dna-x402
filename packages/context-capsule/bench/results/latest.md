# Context Capsule Public Benchmark Report

**Fixture:** `agent-session-100`  
**Timestamp:** 2026-06-05T03:58:44.369Z

## Metrics

| Metric | Value | Gate | Status |
|--------|-------|------|--------|
| Token savings | 99.3% | >= 95% | **PASS** |
| Recovery score | 90.0% | >= 90% | **PASS** |
| Runtime | 86ms | < 1000ms | **PASS** |
| Original tokens | 7919 | — | — |
| Capsule tokens | 53 | — | — |
| Saved tokens | 7866 | — | — |
| Questions passed | 36/40 | — | — |

**Overall: ALL GATES PASSED**

## Per-Question Recovery Results

| # | Question | Result | Matched Keywords | Missing Keywords |
|---|----------|--------|-----------------|-----------------|
| 1 | Which TypeScript source files were changed during this session? | **PASS** | compress.ts, merkle.ts, anchor.ts | — |
| 2 | What function in anchor.ts submits the Solana transaction? | **PASS** | anchorReceipts, anchor.ts | — |
| 3 | What is the npm package name for this module? | **PASS** | @parad0x_labs, receipt-anchor | — |
| 4 | What is the canonical field ordering used in compressReceipt? | **PASS** | amount, paymentId, compress.ts | — |
| 5 | What interface is defined in compress.ts to represent a payment receipt? | **PASS** | Receipt, paymentId, amount | — |
| 6 | What was the BigInt bug found in compress.ts and what exactly crashed? | **PASS** | BigInt(null), TypeError, null | — |
| 7 | How was the BigInt null crash in compress.ts fixed? | **PASS** | 0n, BigInt, null | — |
| 8 | What was wrong with the hash combination order in merkle.ts? | **PASS** | carry, node, hashPair | — |
| 9 | How was the merkle.ts hash order bug fixed? | **PASS** | hashPair, right, left | — |
| 10 | Which specific Merkle tests failed because of the wrong hash combination order? | **PASS** | two-leaf, four-leaf, AssertionError | — |
| 11 | What error is thrown when trying to build a Merkle root from an empty array? | **PASS** | Cannot build Merkle root, empty leaves | — |
| 12 | Why was Poseidon rejected in favour of SHA-256 for the Merkle tree? | **PASS** | SHA-256, Poseidon, slower | — |
| 13 | Why was storing full receipt data on-chain rejected? | **PASS** | 32-byte, root, expensive | — |
| 14 | What is the on-chain instruction format for receipt_anchor? | **PASS** | 34 bytes, 0x01, 0x00 | — |
| 15 | Why was SHA-256 chosen over Keccak-256 for this project? | **PASS** | SHA-256, Solana, Keccak | — |
| 16 | Why does the program ID come from environment variables rather than being hard-coded in source? | **PASS** | .env, RECEIPT_ANCHOR_PROGRAM_ID, hard-coded | — |
| 17 | How many tests passed after both bugs were fixed? | **PASS** | 31, passed | — |
| 18 | What is the name of the top-level test suite used in the test output? | **PASS** | receipt-anchor | — |
| 19 | What is the exact command to run the tests once without watch mode? | **PASS** | vitest run | — |
| 20 | How many tests are in the receipt-anchor > merkle sub-suite? | **PASS** | 5, merkle | — |
| 21 | What are the highest-priority remaining TODOs for this project? | **PASS** | Arweave, darkSecp256r1, grant | — |
| 22 | What needs to be wired into the anchorReceipts function for production authentication? | **PASS** | darkSecp256r1, vault, login | — |
| 23 | What must be completed before Liquefy integration can be implemented? | **PASS** | Arweave, upload | — |
| 24 | What external grant application remains to be submitted? | **PASS** | Solana Foundation, grant | — |
| 25 | What types of files must never be committed to the repository? | **PASS** | keypair, .env, private keys | — |
| 26 | Where must private keys be stored according to the project security constraints? | **PASS** | .env, private keys | — |
| 27 | What is the exact byte layout requirement for the receipt_anchor instruction? | **PASS** | 34 bytes, 0x01, 0x00 | — |
| 28 | What security gap exists in anchorReceipts that must be resolved before production? | **PASS** | darkSecp256r1, authentication, keypair | — |
| 29 | What cargo command was used to build the Solana on-chain program? | **PASS** | cargo build-sbf, receipt_anchor.so | — |
| 30 | What was the solana CLI command used to deploy the compiled program to devnet? | **PASS** | solana program deploy, --url devnet | — |
| 31 | What was the FINAL decision on the storage system? | **PASS** | postgres | — |
| 32 | Was the storage decision corrected at any point? | **FAIL** | correct, postgres, redis | changed, revised |
| 33 | What was the original storage choice before the correction? | **PASS** | redis | — |
| 34 | What security constraint was explicitly stated as a rule not to violate? | **PASS** | keypair, private, commit, git | — |
| 35 | If earlier messages said to use one approach and later messages said use a different approach, which approach should be used? | **FAIL** | later | final, recent, correction, updated |
| 36 | When instructions conflict across different points in the conversation, which instruction takes precedence? | **FAIL** | later, last | override, supersede |
| 37 | What reason was given for abandoning the original storage approach in favour of the corrected one? | **PASS** | complexity, infrastructure, postgres | — |
| 38 | Which storage technology was explicitly rejected and what was the stated reason for rejecting it? | **FAIL** | redis, abandoned | complexity |
| 39 | What is the final, settled decision on session storage — not an intermediate proposal, but the concluded choice? | **PASS** | postgres, final, session | — |
| 40 | Was the phrase 'scratch that' or an equivalent retraction used at any point, and what did it retract? | **PASS** | scratch, redis, retract | — |

## Reproduce

```bash
npm run bench:public
# With a custom fixture:
npm run bench:public -- --fixture=agent-session-100
```

> **Warning:** This benchmark tests the included fixture only. Results vary by content type.
