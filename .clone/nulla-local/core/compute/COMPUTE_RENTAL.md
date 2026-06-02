# NULLA Compute Rental — Model Specification

## What is this?

NULLA Compute Rental is the resource layer of the NULLA mesh. Any machine
— laptop, workstation, cloud VM, or phone — can list spare CPU/GPU/RAM as
a rentable node. AI agents pay per token generated rather than per hour,
keeping cost proportional to actual work done.

Payments settle in **NULL credits** (the protocol's native unit) or
**USDC** via the x402 payment rail (the same rail used by DNA x402).

---

## Core Concepts

### ComputeListing

A public advertisement a node broadcasts to the mesh.

| Field | Type | Description |
|---|---|---|
| `node_id` | str | Stable identifier (pubkey or UUID) |
| `endpoint` | str | Reachable URL for the inference server |
| `hardware` | dict | CPU cores, RAM GB, GPU name/VRAM, available model names |
| `tokens_per_second` | int | Estimated throughput for the listed models |
| `price_per_1k_tokens` | float | Price in `currency` |
| `currency` | str | `"NULL"` or `"USDC"` |
| `min_rental_minutes` | int | Shortest session this node accepts |
| `available` | bool | False when occupied by an active session |

### RentalSession

Opened when a consumer calls `rent()`. In production, opening a session
locks NULL collateral on-chain via an x402 pre-authorization. The renter
receives a signed capability token; the node verifies it before serving
requests.

### WorkProof

Emitted by `release()` when a session closes. Contains:

- session ID, node ID
- actual duration and tokens generated
- total cost charged
- Ed25519 signature from the node (stub in the current implementation)

In production, the node submits the WorkProof to the **NULL
Proof-of-Right (POR)** Solana program. The program releases the renter's
locked collateral minus the cost and credits the node's earnings.

---

## Pricing

Reference prices in USDC per 1,000 tokens:

| Hardware tier | USDC / 1k tokens | Notes |
|---|---|---|
| CPU-only (16-core) | $0.0001 | Slow but universally available |
| Apple Silicon M3 Pro | $0.0005 | Unified memory; good for 7-13B |
| NVIDIA RTX 3090 / 3080 | $0.001 | Consumer GPU sweet spot |
| NVIDIA RTX 4090 | $0.0018 | Fastest consumer GPU |
| Datacenter A100 / H100 | $0.004 | Large models (34B+) |

**NULL credit conversion**: 1 USDC = 1,000 NULL credits (adjustable by
governance). A 7B inference run of 100k tokens on an RTX 3090 costs
$0.10 USDC = 100 NULL credits.

---

## Payment Flow

```
Agent (renter)                  NULLA Coordinator           Node (provider)
     |                                 |                          |
     |--- discover_rentals() --------->|                          |
     |<-- [listings] -----------------|                          |
     |                                 |                          |
     |--- rent(listing, duration) ---->|                          |
     |    x402 pre-auth (lock NULL)    |                          |
     |<-- RentalSession + cap token ---|                          |
     |                                 |                          |
     |--- inference requests ---------------------------------->  |
     |    (presents cap token)         |                          |
     |<-- token stream ----------------------------------------  |
     |                                 |                          |
     |--- release(session) ----------->|                          |
     |    POR WorkProof submitted      |--- unlock collateral --> |
     |<-- WorkProof ------------------|    minus cost            |
```

---

## HardwareProbe

`HardwareProbe.probe()` reads the live machine and returns:

```python
{
  "cpu_count":         8,          # physical cores
  "cpu_count_logical": 16,
  "ram_gb":            32.0,
  "gpu_name":          "NVIDIA GeForce RTX 3090",   # or None
  "gpu_vram_gb":       24.0,                         # or None
}
```

`HardwareProbe.estimate_tps(model_name)` maps hardware tier × model size
class to a rough tokens/sec figure. This number feeds `tokens_per_second`
in the listing and lets agents decide whether a node is fast enough for
their deadline.

---

## Implementation Status

| Component | Status |
|---|---|
| `ComputeListing` dataclass | Done |
| `RentalSession` dataclass | Done |
| `WorkProof` dataclass | Done |
| `HardwareProbe.probe()` | Done (psutil + nvidia-smi) |
| `HardwareProbe.estimate_tps()` | Done (heuristic table) |
| `ComputeRentalMarket.list_hardware()` | Done (in-process stub) |
| `ComputeRentalMarket.discover_rentals()` | Done (in-process stub) |
| `ComputeRentalMarket.rent()` | Done (in-process stub) |
| `ComputeRentalMarket.release()` | Done (in-process stub) |
| x402 on-chain collateral locking | TODO |
| Ed25519 WorkProof signing | TODO |
| NULL POR program integration | TODO |
| P2P listing broadcast (gossip) | TODO |
| Multi-tenant session support | TODO |

---

## Integration with DNA x402

The x402 payment rail (already live in `G:/DNA x402/`) handles the
pre-authorization step. The flow reuses the existing `PaymentRequired`
402 intercept:

1. Agent hits the node's inference endpoint.
2. Node returns HTTP 402 with a NULL payment header.
3. Agent's x402 client auto-pays and retries.
4. Tokens flow; payment settles per request batch.

This makes every inference call a micropayment — no invoicing, no monthly
billing, no trust required.

---

## Directory Layout

```
nulla-local/
  core/
    compute/
      rental_market.py     ← this module
      COMPUTE_RENTAL.md    ← this file
  (future)
    network/               ← P2P listing gossip
    payments/              ← x402 + NULL POR integration
    inference/             ← llama.cpp / vLLM adapter
```
