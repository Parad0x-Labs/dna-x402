# Discord Post — DNA x402 Mainnet Stress Test Results

---

**Copy below for Discord:**

---

## DNA x402 | 50-Agent Mainnet Stress Test — PASSED

We ran **50 AI agents** through DNA x402 on **Solana mainnet** and checked in the report artifact. Full combat conditions. Here's what happened.

### The Setup
- 50 independent agent wallets created, funded, and unleashed
- **30 agents** running netting (off-chain batched micropayments)
- **20 agents** running real on-chain USDC SPL transfers
- 10 burst agents hammering rapid-fire nano payments
- All 3 resource endpoints tested: `/resource`, `/inference`, `/stream-access`

### Amount Tiers Tested
```
$0.00001 (nano)    →  ✅
$0.00005 (nano+)   →  ✅
$0.0001  (micro)   →  ✅
$0.0005  (micro+)  →  ✅
$0.001   (milli)   →  ✅
$0.005   (milli+)  →  ✅
$0.01    (centi)   →  ✅
$0.10    (deci)    →  ✅
$1.00    (unit)    →  ✅
$2.00    (multi)   →  ✅
```

### Results
```
Tests Passed:     84/84
Tests Failed:     0
Pass Rate:        100%
Total Trades:     80
Netting Trades:   60
Transfer Trades:  20 (real on-chain USDC)
Receipts Anchored On-Chain: 80/80
Duration:         165 seconds
```

### Settlement Modes Verified
- **Netting** — off-chain batched micropayments, settled in bulk. No per-tx fee. Built for AI agent nano/micro payments
- **Transfer** — real on-chain USDC SPL transfers verified by the protocol. Full cryptographic proof

### Sample On-Chain Transfer TXs (Solscan)
1. `5YkC97LzZx3eCFFoGSh4jGE62SeccqG3UK5aAnt86sLDfeu9T3pG5wFH1CnKvhY2xnRYumiWS5KmAh4EZPzdum2e`
   → https://solscan.io/tx/5YkC97LzZx3eCFFoGSh4jGE62SeccqG3UK5aAnt86sLDfeu9T3pG5wFH1CnKvhY2xnRYumiWS5KmAh4EZPzdum2e
2. `2FKAFWsEFNJ7HvaEkh7BF45NXodK8FLeG4iMRqJuwyiePs8iin9ub8RVb7KXKerHyPGoiG64bGRwesUySjHNQpa9`
   → https://solscan.io/tx/2FKAFWsEFNJ7HvaEkh7BF45NXodK8FLeG4iMRqJuwyiePs8iin9ub8RVb7KXKerHyPGoiG64bGRwesUySjHNQpa9
3. `3SqZTFUuH8nUCVVGPCp1xbXMrqtMX2WuytbUYCYzJtB6dFKgh8rpAWZxDWvYY6vacEYHwN1gTSnWUPN8DAu1BYZW`
   → https://solscan.io/tx/3SqZTFUuH8nUCVVGPCp1xbXMrqtMX2WuytbUYCYzJtB6dFKgh8rpAWZxDWvYY6vacEYHwN1gTSnWUPN8DAu1BYZW
4. `5bqnVd9t3xkhAKY9D4UgPm4gneAx9vHPsUBDBdzdtr5o6MiFVHhgfTEdbrqxaDBzxsVtxSmQBG3dnxzmdSHQQP8K`
   → https://solscan.io/tx/5bqnVd9t3xkhAKY9D4UgPm4gneAx9vHPsUBDBdzdtr5o6MiFVHhgfTEdbrqxaDBzxsVtxSmQBG3dnxzmdSHQQP8K
5. `3Nez6P6ob1T4XELmvtJ15oXZDzttYfu6nUAk3CR5FJKRU1oz4b7wGsX68U9GDkFgfZGpDciPzYFPkUoLngZeSdVZ`
   → https://solscan.io/tx/3Nez6P6ob1T4XELmvtJ15oXZDzttYfu6nUAk3CR5FJKRU1oz4b7wGsX68U9GDkFgfZGpDciPzYFPkUoLngZeSdVZ

### On-Chain Receipt Anchoring TX
`3SqBvmJN6v54yP6rpADGJZHrjqJNdEyvbVur6Ut122m6jpneK4igMfx7QvkVxMEJSZtokE6DcV4DRnXz5CVmkkUb`
→ https://solscan.io/tx/3SqBvmJN6v54yP6rpADGJZHrjqJNdEyvbVur6Ut122m6jpneK4igMfx7QvkVxMEJSZtokE6DcV4DRnXz5CVmkkUb

### Program
`9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF`
→ https://solscan.io/account/9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF

### What This Proves
- AI agents can pay from **$0.00001 to $2.00+** in a single protocol
- Netting mode handles nano/micro payments without per-transaction Solana fees
- Transfer mode processes real on-chain USDC with cryptographic verification
- All 80 payment receipts anchored on-chain via our `receipt_anchor` Solana program
- 50 agents running concurrently with zero conflicts or failures
- All funds fully drained back after testing — zero loss

### Built With
- x402 protocol (HTTP 402 for AI agents)
- Solana mainnet
- USDC (SPL Token)
- Custom `receipt_anchor` Solana program
- Express middleware SDK (`dna-x402`)
- Netting ledger for batched micropayments
- Corporate audit logging (NDJSON)
- Webhook system with HMAC signing

**DNA x402. Payment rails for agents and APIs.**

---

# X Post (Single Post)

---

DNA x402 stress test complete.

50 AI agents. 80 trades. $0.00001 to $2.00. Netting + real on-chain USDC transfers. 84/84 tests passed. 80/80 receipts anchored on Solana mainnet. Zero failures.

Program: 9bPBmDNnKGxF8GTt4SqodNJZ1b9nSjoKia2ML4V5gGCF

Sample TXs:
solscan.io/tx/5YkC97LzZx3eCFFoGSh4jGE62SeccqG3UK5aAnt86sLDfeu9T3pG5wFH1CnKvhY2xnRYumiWS5KmAh4EZPzdum2e
solscan.io/tx/2FKAFWsEFNJ7HvaEkh7BF45NXodK8FLeG4iMRqJuwyiePs8iin9ub8RVb7KXKerHyPGoiG64bGRwesUySjHNQpa9

AI agent payment rails. Nano to normal. Built on Solana.

#DNA #DarkNullApex #Solana #AI #x402
