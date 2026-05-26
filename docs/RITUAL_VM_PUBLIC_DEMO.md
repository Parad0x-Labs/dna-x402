# Rogue Alpha's Ritual — ELI5 Guide

> "An AI agent spent money without holding a wallet — and left a cryptographic proof that the whole thing happened correctly."

---

## The Story

Rogue Alpha is an AI agent. It needs to pay for an API call. Normally, paying for something means you hold a private key — which means you *are* a wallet.

DARK NULL says: **you can spend without holding a key**. But how do we prove the spending happened correctly? How do we know the agent didn't cheat?

That's what the **Transaction Ritual VM** does. It's like a tiny judge that sits inside the Solana blockchain and watches the entire spending ceremony play out — in the right order, with the right ingredients, and with no sneaky withdrawals hidden inside.

---

## Step 1 — The Grammar

A ritual is a transaction where every instruction must appear **in the correct order**:

```
1. ComputeBudget      — "I'm declaring how much compute I need"
2. IntentCapsule      — "I declare my intent to spend"
3. PermissionProof    — "I prove I have permission" ← must come BEFORE step 4
4. SpendShadow        — "I submit the spend, hidden in a bundle of fakes"
5. ReceiptSoul        — "I claim a one-time receipt"
6. NullifierInsert    — "I record that this spend happened, so it can't happen twice"
7. ChaffMaintenance   — "I close a fake account to pay back some rent" (optional, makes it profitable)
```

If you try to put SpendShadow before PermissionProof — **rejected**.  
If you try to sneak in a WithdrawInstruction — **rejected**.  
If any forbidden program appears — **rejected**.

The Solana program `dark_ritual_gate` watches all 7 steps, then emits a **33-byte return data capsule**: `[verdict_byte][ritual_hash]`.

---

## Step 2 — The CPI Firewall

When programs call other programs on Solana, that's called a CPI (Cross-Program Invocation). An agent that secretly calls a token transfer program to drain funds would be caught here.

The CPI manifest declares: **these are the only programs I'm allowed to call, with these maximum counts**:
- System Program: max 1 CPI
- DarkNullifierBanks: max 1 CPI

The manifest hash is then **bound to the ritual hash** — so you can't reuse a CPI manifest from a different ritual.

In this demo: **0 violations**.

---

## Step 3 — Account Lock Alchemy

Every Solana transaction declares which accounts it will read or write. That list is a fingerprint — a chain analyst can see it and say "ah, that's the same agent again."

Account Lock Alchemy scores the privacy of the lock plan:

| Factor | Weight | What it measures |
|---|---|---|
| Fee-heat score | 30% | Are the writable accounts hot (written often)? Hot accounts = more competition + easier to fingerprint |
| Fingerprint uniqueness | 30% | Is this account lock set unique across all transactions? |
| Shape pool score | 20% | How many other transactions share this exact shape? (k-anonymity) |
| Parallelism score | 20% | Fewer writable accounts = more tx can run in parallel = less risk |

In this demo: **overall score 0.78, recommendation: safe**.

---

## Step 4 — Rent Delta Proof

Creating accounts on Solana costs rent (lamports). Closing accounts returns rent. Chaff accounts are fake PDAs that are created and then closed in the same ritual — the chaff maintenance step.

If the rent reclaimed from closing chaff ≥ rent paid to open new accounts, the ritual is **profitable**:

```
rent_locked:    2,000 lamports  (receipt PDA opened)
rent_reclaimed: 5,000 lamports  (chaff PDA closed)
net_rent_cost:  -3,000 lamports ← negative = surplus
chaff_reward:   2,000 lamports  (min of locked/reclaimed)
net_label:      "profitable"
```

The chaff wasn't waste — it paid for itself and then some.

---

## Step 5 — Shape Market (k-Anonymity)

The shape market tracks how many transactions share the same instruction layout. If your transaction has a unique shape, it's like wearing a bright orange coat in a crowd — you stand out.

k-anonymity works like this:
- k = 1 → **Doxxed** (you're the only one with this shape)
- k = 2–4 → **LowAnonymity** (a small crowd)
- k ≥ 5 → **Safe** (you blend in)

The shape hash for `AgentSpendNoCustodyV1` has been observed **5 times** in this demo — so it's **Safe**.

---

## Step 6 — The Devnet Ritual

The word **ROGUE** was written onto Solana devnet by inserting 5 nullifiers — one per letter:

| Letter | ASCII byte | Solscan |
|---|---|---|
| R | 82 | [tx 1](https://solscan.io/tx/67jsL2KmhYfg2z1TvkGfzhDoA7YEi8Gojn3gcQkUL3zgMbXSnwjocvj1ZX3AX7ne11J1VUXnG6hnyV2f8DzczeCZ?cluster=devnet) |
| O | 79 | [tx 2](https://solscan.io/tx/4UDnJctmmvhmctQhJfLZuKNXgxnVqXrarDHFisozu5UMzxJ32cCXcFzEQo8UdiVmfdp1SG49P7UUoa8Ggb2br4hb?cluster=devnet) |
| G | 71 | [tx 3](https://solscan.io/tx/5BCtkPKLxjELu1Sg4UGHm5ja5G1RNyFkufpy62ho4RmXHjEtEMyxcNwTQwDGnCCE491j89WMVzJ8BzQhxJGJCF1a?cluster=devnet) |
| U | 85 | [tx 4](https://solscan.io/tx/63LQ8uUZN5f9uxo9PgYF2tgXu4oA6nH8UZH1L93seEazmhaR9zcnkbdSMFWhXaXx4GepHEb3XMQW6Y11Tge9xqZE?cluster=devnet) |
| E | 69 | [tx 5](https://solscan.io/tx/5Dd58QcyJSvGtx61EUjGiFexbx9fzYtEsuYNKXMFzoksBbA8dfYPqL3B8ihpgwo79PGccQGN41m6ex7rdiNpuzaQ?cluster=devnet) |

The ritual grammar for the `AgentSpendNoCustodyV1` type has been **verified on-chain** by the deployed `dark_ritual_gate` program.

**Program ID:** `31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy`

| Instruction | Solscan |
|---|---|
| EchoProof | [tx](https://solscan.io/tx/24oVf27F3GWFpTDmiVDRAho1QNDGGP8Xf6TmnKH9No97PcrgZwTs62EKzDofeBgmdZFh67JHnN93FgLC4Abxq5aA?cluster=devnet) |
| VerifyRitualShape | [tx](https://solscan.io/tx/48DRhiatEhuX3Vhx3ACyNXHsJS7CrnEcJbM6Uewvg5J8GKfKwtsUuLP21e8PuzsW37751Cp6QfbgvUAoxePQ497Z?cluster=devnet) |

The EchoProof transaction echoed the ritual_hash back as a 33-byte return-data capsule. The VerifyRitualShape transaction submitted the canonical `AgentSpendNoCustodyV1` shape_hash (`58bc9168...`) to the live BPF program and received verdict `0x01` (Accepted).

---

## What the Proof Capsule Proves

```
[0x01][ritual_hash:32]  — 33 bytes emitted as Solana return data
```

- **0x01** = Accepted verdict
- **ritual_hash** = binding commitment over all 7 primitive inputs (permission, spend, shadow, receipt, settlement, no-custody, max-spend-cap)

Anyone who holds the original inputs can verify the capsule by recomputing the hash. No trusted third party needed.

---

## What's Still Mock

| Thing | Why |
|---|---|
| Poseidon syscall | Using SHA-256 domain-separated as proxy; swap is one line |
| ZK proof of ritual | Capsule is a commitment; full Groth16 binding is `dark-proof-gate-lite` |
| Mainnet | Gate: requires audit + deploy plan + signed authority policy |

> NOT_PRODUCTION — Devnet only. `mainnet_ready = false`. No audit. No mainnet keys.

---

## Evidence

Run `cargo run -p ritual-vm-demo --bin ritual_vm_demo` to generate:
- `dist/ritual-vm/RITUAL_VM_DEMO.json` — machine-readable proof

All hashes in the evidence are deterministic — you can verify them by running the binary yourself.
