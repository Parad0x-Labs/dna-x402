# Dark Null x402 Devnet Flow

## Minimal x402 Flow

```
Client                              Server
  |                                   |
  |--- GET /resource ----------------> |
  |                                   |
  |<-- 402 Payment Required ----------|
  |    (X402PaymentRequirement)       |
  |    {scheme, network, asset,       |
  |     amount_lamports, pay_to,      |
  |     resource, expires_at_slot,    |
  |     nonce}                        |
  |                                   |
  |--- [build proof locally] -------> |
  |                                   |
  |--- GET /resource ----------------> |
  |    X-Payment-Proof: <proof>       |
  |                                   |
  |    [Server: verify proof]         |
  |    [Server: mint DarkX402Receipt] |
  |                                   |
  |<-- 200 OK + payload --------------|
  |    (DarkX402Receipt in body)      |
```

**Key invariant:** The resource URL never appears in the proof. It is hashed via `scope_hash` before inclusion in the `X402PaymentRequirement` hash. This prevents the proof from leaking which resource was accessed.

---

## Mock / Local Demo

Use `dark-x402-server-mock` and `dark-x402-client-mock` for local integration testing.

- `MockX402Server` — simulates the 402-gated service with in-memory replay tracking
- `MockX402Client` — simulates a wallet that builds mock payment proofs

All proofs have `is_mock = true`. No real SOL is transferred. No real Solana RPC is contacted.

### Running tests

```sh
cargo test -p dark-x402-core
cargo test -p dark-x402-server-mock
cargo test -p dark-x402-client-mock
```

### JS demo (no Rust required)

```sh
node scripts/x402-devnet-demo.mjs
```

This runs the mock flow end-to-end in Node.js and prints each step to stdout.

---

## Devnet Tx Verification Mode (Strict Mode)

`dark-x402-devnet-verify` implements real Solana devnet payment verification using
`solana-client` RPC. It replaces the `MOCK_SIG_*` placeholder with a real chain check.

### How strict mode works

```
StrictX402Server                      DevnetPaymentVerifier
  |                                         |
  |-- proof.is_mock? YES -----------------> REJECT (MockSigRejected)
  |
  |-- sig.starts_with("MOCK_SIG_")? ------> REJECT (MockSigRejected)
  |
  |-- RpcClient::get_transaction(sig) ----> RPC call
  |                                         |
  |                                         |-- tx.meta.err? -> REJECT (TxFailed)
  |                                         |-- recipient not in account_keys?
  |                                         |      -> REJECT (RecipientNotFound)
  |                                         |-- balance delta < expected?
  |                                         |      -> REJECT (Underpayment)
  |                                         |
  |<-- VerifiedDevnetPayment ---------------+
  |
  |-- mint_receipt_note_after_payment()
  |
  |-- DarkX402Receipt(is_mock=false) -----> caller
```

The `StrictX402Server` checks `proof.is_mock` and requirement hash **before**
making the RPC call, to fail fast without unnecessary network traffic.

### Running the real devnet flow

```sh
# Requires devnet RPC access
cargo run -p dark-x402-devnet-verify --bin x402_devnet_real

# With custom RPC
SOLANA_RPC_URL=https://my-rpc.example.com \
  cargo run -p dark-x402-devnet-verify --bin x402_devnet_real
```

This binary:
1. Generates an ephemeral payer keypair
2. Airdrops 1 SOL from devnet faucet
3. Sends 1_000_000 lamports to a generated test recipient
4. Verifies via `DevnetPaymentVerifier` (RPC balance delta check)
5. Mints `DarkX402Receipt` with `is_mock=false`
6. Writes evidence to `dist/alien-final/evidence/x402_devnet_real.json`

### Evidence file path

```
dist/alien-final/evidence/x402_devnet_real.json
```

Schema:
```json
{
  "commit": "<git sha>",
  "network": "solana-devnet",
  "rpc_url": "https://api.devnet.solana.com",
  "tx_signature": "<real base58 sig>",
  "verified_at_slot": 12345678,
  "amount_lamports": 1000000,
  "pay_to": "<base58 pubkey>",
  "requirement_hash": "<hex>",
  "payment_proof_hash": "<hex>",
  "receipt_id": "<hex>",
  "receipt_nullifier": "<hex>",
  "mock": false,
  "mainnet_ready": false
}
```

### Running the library tests (no network required)

```sh
cargo test -p dark-x402-devnet-verify
```

All 10 tests use `FixtureVerifier` — no RPC connection needed. Only the
`x402_devnet_real` binary requires devnet access.

---

## What Is Not Production

| Gap | Status |
|-----|--------|
| No HTTP server | `StrictX402Server` has no HTTP listener — proof passed directly |
| No real SOL transfer in tests | `FixtureVerifier` used — only binary sends real SOL |
| No production facilitator | No fee routing, no service discovery |
| No mainnet | Devnet only — `mainnet_ready=false` always set |
| No custody or escrow | Funds transferred directly, no smart contract custody |
| No persistent nullifier store | In-memory `HashSet` only — lost on restart |
| payer_pubkey stored raw in proof | Future: replace with commitment scheme (hash+open) |
| No audit | `audit_signed.json` not present |

These gaps are intentional — this is a devnet payment evidence system, not a production server.

---

## Connection to Dark Null Receipt Rollup

The `DarkX402Receipt` struct is the bridge between the x402 payment layer and the Dark Null privacy receipt system:

| Field | Feeds into |
|-------|-----------|
| `receipt_nullifier` | `dark_compressed_receipts` Solana program (nullifier bank) |
| `service_scope_hash` | `receipt-rollup-lite` — scoped receipt tree leaves |
| `replay_key` | Replay protection in `dark_nullifier_banks` |
| `receipt_id()` | Session netting input in `dark-session-netting` |

Multiple `DarkX402Receipt` values from the same session can be batch-netted via `dark-session-netting`, collapsing N individual payment proofs into a single zero-knowledge session proof for the rollup.

The `receipt_nullifier` is derived deterministically from the receipt note hash and the requirement nonce, making it safe to include in a public nullifier set without revealing the payer or the resource accessed.
