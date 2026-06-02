# NULLA Credit System — Proof-of-Work Credits

## How it works

### 1. Complete a task → earn a WorkProof

When a NULLA node finishes a task (inference, routing, data relay, etc.) the
`ProofOfWorkMinter` issues a `WorkProof` object:

```
task_id          — what was done
node_id          — who did it
task_hash        — sha256(task_id + node_id)
result_hash      — sha256(result_bytes)
credits_earned   — how many NULLA credits this work is worth
timestamp        — when the proof was minted
signature        — sha256(task_hash + result_hash + str(credits))
solana_anchor_tx — None until anchored on-chain
```

The signature binds the work output to the node identity and the credit
amount.  No central authority can issue fake proofs because they would need
the original result bytes to produce a matching result_hash.

---

### 2. WorkProof anchored on Solana = permanent proof you did the work

Call `ProofOfWorkMinter.anchor_proof(proof, rpc_url)` to push the proof
on-chain using the receipt_anchor memo pattern:

```
[0x01][0x00][32 bytes — sha256(proof canonical fields)]
```

This writes a 34-byte memo into a Solana transaction.  The transaction
signature is stored in `proof.solana_anchor_tx`.

Once anchored:
- The proof is **immutable** — the Solana ledger is the source of truth.
- Anyone can verify the work happened by checking the on-chain memo.
- The timestamp is cryptographically bound to the slot in which the tx landed.

Set the `SOLANA_DEPLOYER_KEYPAIR` environment variable (base58 private key)
to submit real transactions.  Without it the minter runs in dry-run mode and
returns a deterministic `DRY_RUN:<hash>` identifier — useful for testing.

---

### 3. Sell your WorkProof = sell your work history / credits

`CreditMarket` lets nodes list their WorkProof objects for sale at a USDC
price:

```python
listing_id = market.list_for_sale(proof, price_usdc=1.50)
```

Another node buys it:

```python
transferred_proof = market.buy(listing_id, buyer_node_id="node-xyz")
```

Ownership transfer works by re-binding the `node_id` field to the buyer and
issuing a new signature that includes the buyer's identity.  The original
`task_hash` and `result_hash` are preserved, so the provenance chain —
*who originally did the work* — is never erased.

**Credits are the proofs themselves.**  There is no separate token ledger:
if you hold a valid signed WorkProof, you hold the credits.

---

### 4. Buyers use credits for priority routing in the mesh

NULLA nodes accept WorkProofs as proof of contribution history.  A node that
presents N credits (WorkProofs) earns:

- Priority job dispatch — your tasks are routed first.
- Discounted compute — workers may offer lower rates to high-credit nodes.
- Reputation score — the on-chain anchor history is public and queryable.

The market price of a WorkProof is set by supply and demand: scarce compute
tasks (high-demand models, rare hardware) produce more valuable proofs.

---

## Quick start

```python
from core.credits.proof_of_work import ProofOfWorkMinter, CreditMarket

minter = ProofOfWorkMinter()

# 1. Node completes a task and earns a proof
proof = minter.mint_proof(
    task_id="task-001",
    result_bytes=b"<model output>",
    node_id="my-node",
    credits=10,
)

# 2. Verify locally
assert minter.verify_proof(proof)

# 3. Anchor on Solana (set SOLANA_DEPLOYER_KEYPAIR env var for real tx)
tx = minter.anchor_proof(proof, rpc_url="https://api.mainnet-beta.solana.com")
print(f"Anchored: {tx}")

# 4. List for sale
market = CreditMarket()
listing_id = market.list_for_sale(proof, price_usdc=2.00)

# 5. Buyer acquires the proof
transferred = market.buy(listing_id, buyer_node_id="buyer-node")
```

---

## File layout

```
core/credits/
  proof_of_work.py   — WorkProof dataclass, ProofOfWorkMinter, CreditMarket
  README.md          — this file
```
