# dark_registrar — anonymous `.null` name ownership

Own, manage, and transfer a `.null` name with **no on-chain link between the name and your wallet**.

A name's owner is a **commitment, not a public key**: `owner_commitment = Poseidon(secret, name)`.
The per-name PDA stores only the commitment, a content pointer, and a sequence number — never a
pubkey. Managing the site (`set_record`) and selling it (`transfer`) are authorized by a **Groth16
zero-knowledge proof** of knowledge of `secret`, so the wallet that signs and pays the fee (a
permissionless relayer) is never linked to the owner.

## Why a commitment instead of a pubkey

On a permanent ledger a single leak is forever. The usual registrar design stores `name → pubkey`,
which publishes the owner the moment they register. Here the chain only ever sees
`name → commitment`; the owner proves control in zero knowledge.

## Anti-replay

Each authorized action binds an `action_hash = Poseidon(domain, payload, seq)` as a proof public
input. The program recomputes it from the requested action and the name's current `seq` and rejects
a mismatch. A captured proof can't be replayed for a different action or after `seq` advances;
forging one requires the secret.

## Instructions

| Tag | Instruction | Effect |
|-----|-------------|--------|
| `0x00` | `register(name, commitment, proof)` | Create the name PDA owned by `commitment`. Requires an ownership proof — a name can only be claimed by someone who knows its secret, which stops a griefer from bricking a name with a junk commitment. |
| `0x01` | `set_record(name, proof, commitment, content_ptr)` | Update the site pointer. ZK-authorized; no signer/owner check. |
| `0x02` | `transfer(name, proof, commitment, new_commitment)` | Re-commit the name to a new owner. The old proof can't be replayed; after transfer, proofs against the old commitment no longer verify. |

## Full anonymity needs more than this program

The on-chain record is unlinkable, but two pieces live **off** this program and are required for
real anonymity:

- **Relayer fee-payer** — Solana needs a signer to pay fees. If that's your wallet, you're linked.
  A permissionless relayer (the same pattern as the shielded-pool withdraw) submits the transaction
  so your wallet never signs.
- **Private funding** — registration/renewal fees paid from the shielded pool, and any permanent
  storage (e.g. Arweave) funded through a gateway that accepts a shielded payment.

## Status

- **Devnet:** deployed and verified end-to-end — `build/zk/registrar-e2e.mjs` (register / set_record
  / transfer / replay-rejected / forge-rejected / brick-rejected) and `build/zk/anon-fullflow-e2e.mjs`
  (shared pool, anonymity set ≥ 2, no user→relayer transfer, owner = commitment, name txs signed by
  the relayer).
- **Verifying key:** single-party setup, `mainnet_ready = false`. The program **fails closed** by
  default; only the `devnet` build feature disables the guard. **Mainnet requires a trustless
  multi-party trusted-setup ceremony** and `mainnet_ready = true`.

Circuit: [`circuits/registrar.circom`](../../circuits/registrar.circom). Verifier:
`crates/dark-groth16-core` (`registrar_vk`).
