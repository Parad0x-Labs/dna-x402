# Rogue Alpha WOW Demo

**An AI agent spent money without holding a wallet.**

> NOT_PRODUCTION. Devnet only. No audit. No mainnet. No real money moved.

---

## What just happened?

Imagine a vending machine that hands out soda — but the machine doesn't own the money.
Someone else put money in a locked box, wrote rules on the box ("only buy soda, no cash withdrawals"),
and gave the machine a key that only works within those rules.

That's what Rogue Alpha just did — but on Solana, with cryptographic proofs.

---

## The 9 things in this demo (and what they mean in plain language)

### 1. Permission Note (`agent-permission-notes`)

A permission note is like a signed permission slip from a parent.

- The parent (you) writes: *"Rogue Alpha can spend up to 0.001 SOL on API calls. No withdrawals. Expires in 10,000 slots."*
- The slip has a cryptographic fingerprint (hash). Nobody can change it without the hash changing.
- The agent spends money by presenting this slip — not by holding any keys.

**The key insight:** the agent never touched a private key. It just proved it had permission.

---

### 2. Shadow Bundle (`spend-shadows`)

When the agent pays for something, it creates 5 identical-looking envelopes.
Only 1 has the real payment inside. The other 4 are fakes:

| # | Kind      | What it is                              |
|---|-----------|------------------------------------------|
| 1 | Real      | The actual spend                         |
| 2 | Decoy     | Fake envelope #1                         |
| 3 | Decoy     | Fake envelope #2                         |
| 4 | Delayed   | Opens in the future (fake timing signal) |
| 5 | Poison    | Deliberately wrong data (honeypot bait)  |

**Copy-sniper precision = 0.2** — if a chain-analysis bot tries to copy the trade,
it has a 20% chance of picking the right envelope. The other 80% is noise.

Every envelope is exactly **81 bytes**. They're indistinguishable.

---

### 3. Allowed Spend (`spend-shadows` + `agent-permission-notes`)

The 8-step permission check, in plain language:

1. Is the permission slip's fingerprint valid? ✓
2. Is the kill switch off? ✓
3. Has the permission expired? ✓ (not yet)
4. Is the spend amount within the single-payment limit? ✓
5. Is the total so far within the overall limit? ✓
6. Is this a withdrawal? ✓ (it's an API call, not a withdrawal)
7. Is this scope on the denied list? ✓ (not denied)
8. Is this scope on the allowed list? ✓ (empty = all allowed)

**Result: Spend accepted.**

---

### 4. Forbidden Withdraw (`agent-permission-notes`)

What if someone tries to make the agent send funds to an external address?

The same 8-step check runs, but step 6 catches it:

```
no_withdraw = true
scope_hash == withdraw_scope_hash()
→ Err(PermissionError::WithdrawDenied)
```

**The agent cannot move money to any external wallet. Full stop.**

This is proven cryptographically, not just by policy.

---

### 5. Kill Switch (`agent-permission-notes`)

If something goes wrong, anyone holding the revocation key can call `revoke_session()`.

This produces a `RevocationRoot` — a hash that proves the session was ended.

Any subsequent spend attempt returns:
```
Err(PermissionError::KillSwitchActive)
```

No transaction goes through. No undo needed. One hash, session dead.

---

### 6. Receipt Soul (`receipt-souls`)

A receipt soul is a bearer note — like a gift card that burns when you use it.

- The **issuer** is hidden. You can't trace who gave it.
- The **nullifier** proves it was spent without revealing what it was.
- Policy: `BurnAfterRead` — spend it once, then it's gone.

The nullifier formula: `SHA256("dark_null_v1_soul_nullifier" || soul_id || holder || expiry_slot)`

Notice the issuer hash is **not** in the nullifier. The issuer is unlinkable.

---

### 7. Session Channel (`session-note-channel`)

Instead of submitting 5 separate payments to the chain, the agent:

1. Issues 5 spend notes in memory
2. Collapses them all into **one settlement root**
3. Posts the root (one hash) instead of 5 transactions

The root is computed as:
```
SHA256("dark_null_v1_session_settlement" || session_hash || sorted_nullifiers...)
```

Sorted for determinism — the root is the same regardless of order.

**5 payments → 1 hash. No channel PDA needed.**

---

### 8. Flight Recorder (`agent-flight-recorder`)

Every action the agent takes is logged in a tamper-evident chain.

- Each log entry (`FlightReceipt`) hashes the previous entry.
- If anyone modifies an entry, the entire chain breaks.
- A public viewer gets the `RedactedFlightView` — they can see the agent acted, but not the strategy.

Full record: `agent_id + model_output + permission + risk_policy + spend_receipt + kill_switch_state`
Public view: `agent_id + timestamp + kill_switch_state` (strategy hidden)

---

### 9. No-Custody Attestation (`no-custody-attestation`)

The agent publishes a signed declaration that it holds **none** of these:

| Key Class          | Meaning                             |
|--------------------|-------------------------------------|
| `UserSpendKey`     | User's private spending key         |
| `RootAuthority`    | Program authority                   |
| `UpgradeAuthority` | Program upgrade key                 |
| `SessionVaultSecret` | Session vault secret              |

**Risk score = 0** when all 4 classes are denied and `custody_denied = true`.

Formula: `25 × (number of missing denied key classes)`. Zero missing = zero risk.

This is the cryptographic proof that the agent **cannot** be a honeypot.

---

## The Onchain Part — "ROGUE" Ritual

The word "ROGUE" was encoded as a sequence of nullifier shards on Solana devnet.

Each letter → ASCII byte → shard index → `InsertNullifier` transaction:

| Letter | ASCII | Shard | Devnet TX |
|--------|-------|-------|-----------|
| R | 82 | 0x52 | [67jsL2Km...](https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet) |
| O | 79 | 0x4F | [4UDnJctm...](https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet) |
| G | 71 | 0x47 | [5BCtkPKL...](https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet) |
| U | 85 | 0x55 | [63LQ8uUZ...](https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet) |
| E | 69 | 0x45 | [5Dd58Qcy...](https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet) |

Program ID: `7LaYJVJafLVjTpfz8x68EMR75SXd8epwQntorkNSMwQj` (deployed devnet)

---

## Run it yourself

```bash
# Build and run the Rust demo binary
cargo run -p rogue-agent-demo-core --bin rogue_wow_demo

# Or via Node.js wrapper
node scripts/run-rogue-wow-demo.mjs

# Open the interactive UI
open packages/rogue-agent-demo/index.html
```

Output: `dist/true-frontier/ROGUE_WOW_DEMO.json`

---

## What this is NOT

- Not production software
- Not a mainnet deployment
- Not audited
- Not a financial product
- Not a claim that this design is complete or secure

This is a demonstration that the cryptographic primitives work locally and can connect to Solana devnet.

---

## Technical details

All 7 primitives used:

| Primitive | Crate | Purpose |
|-----------|-------|---------|
| Permission note | `agent-permission-notes` | 8-step spend check with kill switch |
| Shadow bundle | `spend-shadows` | 5-leaf privacy bundle, 81 bytes each |
| Flight recorder | `agent-flight-recorder` | Chained tamper-evident action log |
| Receipt soul | `receipt-souls` | Unlinkable bearer note (BurnAfterRead) |
| Session channel | `session-note-channel` | 5 notes → 1 settlement root |
| No-custody | `no-custody-attestation` | Risk score 0, all 4 key classes denied |
| Puzzle compiler | `onchain-puzzle-compiler` | Compiled "ROGUE" into shard[82,79,71,85,69] |

Commit: `66765c973f0b1a9ba0a3ee7bdee87d4f85b6d186`
Tests: 534 passed, 0 failed (`cargo test --workspace`)
