# Dark Null Edge Capstone Flow

This is the repo-facing flow that turns the strongest primitives into one
developer-readable evidence path.

It is not a new chain, not a validator network, not BFT, and not a bridge. It is
a local/devnet evidence runner that proves the product shape developers can build
against now:

```text
hidden execution wallet
  -> session hash
  -> trade commitment
  -> x402 payment intent
  -> paid subscriber reveal
  -> receipt DAG
  -> Blink ritual layout
  -> compressed state root
  -> x402 adapter service capsule
  -> fee/rent savings model
  -> final evidence hash
```

## What It Proves

| Step | Evidence |
|---|---|
| Hidden execution wallet | Public output stores the session hash, not the wallet bytes |
| Paid alpha reveal | `x402` payer hash becomes the reveal subscriber hash |
| Receipt DAG | Trade commitment and paid reveal chain into an append-only head |
| Blink ritual layout | The x402 intent is bound into a five-instruction transaction shape |
| Hook verdict | The Token-2022 hook verdict capsule verifies by recomputing its hash |
| Compressed state | Commitment, nullifier, and receipt-head leaves form one state root |
| Service posture | The x402 adapter capsule declares clean key posture and liveness paths |
| Cost edge | The model reports compressed-state rent savings and p-token CU savings |

## Run It

```bash
cargo test -p dark-frontier-demo
cargo run -p dark-frontier-demo
```

The binary writes:

```text
dist/frontier-edge/FRONTIER_EDGE_DEMO.json
```

The new capstone object is under:

```text
primitives.edge-capstone
```

## Why It Matters

Competitor surface area can look large when it is split across node, consensus,
bridge, and withdrawal language. Dark Null's stronger angle is a smaller set of
executable primitives that join into a usable paid-private commerce flow:

- x402 payment intent gates the reveal
- the subscriber gets a verifiable reveal
- the trader does not publish the live wallet in evidence
- the raw mint is represented by a hash in the receipt path
- compressed leaves keep state growth under control
- service capsules make relayer posture checkable
- fee modeling explains why the Solana path is economically sharper

The important claim is not that every production dependency is complete. The
important claim is that the core developer path is concrete, deterministic, and
covered by tests.

## Public Claim Boundary

Allowed:

- local evidence runner
- devnet-oriented capstone flow
- x402-bound paid reveal
- hash-only evidence object
- compressed-state root model
- service posture capsule
- fee and rent savings model

Forbidden unless separate evidence is added:

- live validator network
- BFT layer
- bridge product
- live private compute network
- unrestricted autonomous trading
- profit promises
- absolute privacy
- complete anonymity
