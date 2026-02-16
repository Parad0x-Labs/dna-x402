# PDX Dark Protocol - Architecture

## System Overview

PDX Dark Protocol implements a zero-knowledge privacy layer for Solana using advanced cryptographic primitives. The system enables anonymous asset transfers while maintaining full transaction validity through mathematical proofs.

## Core Architecture

### 1. Zero-Knowledge Circuit Layer

**File**: `circuits/dark_transfer.circom`

The ZK circuit defines the privacy constraints and generates mathematical proofs. Key components:

```circom
// Private inputs (hidden from blockchain)
signal input secret;           // User's secret key
signal input amount;           // Transfer amount
signal input pathElements[20]; // Merkle proof path
signal input pathIndices[20];  // Merkle proof indices

// Public inputs (visible on blockchain)
signal input root;             // Merkle root
signal input nullifierAsset;   // Asset nullifier
signal input nullifierFee;     // Fee nullifier
signal input newCommitment;    // New commitment
signal input assetIdHash;      // Integrity hash

// Constraints
// 1. Verify secret generates valid commitment
// 2. Verify Merkle proof inclusion
// 3. Generate nullifiers correctly
// 4. Validate amount and recipient integrity
```

**Key Properties:**
- **Soundness**: Invalid statements cannot generate valid proofs
- **Completeness**: Valid statements always generate proofs
- **Zero-Knowledge**: Proofs reveal nothing about private inputs
- **Succinctness**: Proofs are small and fast to verify

### 2. On-Chain Program Layer

**File**: `src/lib.rs`

The Solana program verifies ZK proofs and executes asset transfers. Architecture:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client App    │───▶│  Solana Program  │───▶│   Blockchain    │
│                 │    │                  │    │                 │
│ • Generate Proof│    │ • Verify Proof   │    │ • Asset Transfer│
│ • Construct TX  │    │ • Validate Data  │    │ • State Update │
│ • Sign & Send   │    │ • Execute Transfer│    │ • Event Logs   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

**Program Instructions:**
- `Deposit`: Lock assets in privacy pool
- `Withdraw`: Unlock assets with valid proof

**Security Model:**
- Proof verification prevents invalid transfers
- Nullifier consumption prevents double-spending
- PDA-based access control
- Economic incentives via relayer fees

### 3. Client Application Layer

**Directory**: `client/`

Handles proof generation and transaction construction:

```
client/
├── pdx_client.py          # Main client library
├── proof_generator.py     # ZK proof generation
├── merkle_manager.py      # Merkle tree operations
├── transaction_builder.py # Solana TX construction
└── wallet_integration.py  # Wallet connectivity
```

**Key Components:**
- **Proof Generation**: Uses compiled circuit to create ZK proofs
- **Merkle Management**: Maintains deposit/withdrawal state
- **Transaction Building**: Constructs anonymous transfer transactions
- **Wallet Integration**: Connects with Solana wallets

### 4. User Interface Layer

**Directory**: `extension/`

Browser extension for user interaction:

```
extension/
├── popup.html/js          # Main interface
├── background.js          # Background processing
├── content.js             # Page injection
├── manifest.json          # Extension configuration
└── assets/                # UI resources
```

**Features:**
- Privacy-preserving transaction creation
- Wallet connectivity
- Transaction monitoring
- Privacy analytics

## Data Flow Architecture

### Deposit Flow

```
1. User → Client: Deposit Request
2. Client → Circuit: Generate Commitment
3. Client → Merkle: Update Tree
4. Client → Solana: Submit Deposit TX
5. Solana → Vault: Transfer SOL
6. Solana → Client: Confirmation
```

### Withdrawal Flow

```
1. User → Client: Withdrawal Request
2. Client → Circuit: Generate ZK Proof
3. Client → Merkle: Generate Inclusion Proof
4. Client → Solana: Submit Withdrawal TX
5. Solana → Circuit: Verify ZK Proof
6. Solana → Vault: Transfer SOL to Recipient
7. Solana → Client: Confirmation
```

## Security Architecture

### Cryptographic Primitives

1. **Pedersen Commitments**
   - Hide deposit amounts
   - Enable range proofs
   - Prevent inflation attacks

2. **Poseidon Hash**
   - Efficient ZK-friendly hashing
   - Used in Merkle trees and nullifiers
   - Collision-resistant

3. **Groth16 Proofs**
   - Succinct zero-knowledge proofs
   - Fast verification on-chain
   - Trusted setup required

### Attack Vectors & Mitigations

| Attack Vector | Mitigation |
|---------------|------------|
| Double-spending | Nullifier consumption |
| Invalid proofs | On-chain verification |
| Front-running | ZK proof opacity |
| Amount inflation | Commitment validation |
| Replay attacks | Nullifier uniqueness |

## Performance Architecture

### On-Chain Costs

- **Proof Verification**: ~200k compute units
- **Nullifier Creation**: ~50k compute units
- **Asset Transfer**: ~10k compute units
- **Total TX Cost**: ~5,000-10,000 lamports

### Off-Chain Performance

- **Proof Generation**: ~5-10 seconds
- **Merkle Update**: ~100ms
- **TX Construction**: ~50ms

### Scalability Considerations

- **Batch Processing**: Multiple transfers per proof
- **Recursive Proofs**: Layered privacy constructions
- **Optimistic Execution**: Assume validity, verify later

## Deployment Architecture

### Network Topology

```
┌─────────────────┐    ┌─────────────────┐
│   User Clients  │───▶│  Solana Devnet  │
│                 │    │                 │
│ • Browsers      │    │ • PDX Program   │
│ • Wallets       │    │ • Privacy Pool  │
│ • dApps         │    │ • Merkle Trees  │
└─────────────────┘    └─────────────────┘
```

### Infrastructure Requirements

- **Solana RPC**: For transaction submission
- **IPFS/Arweave**: For proof storage
- **Relayer Network**: For fee payment
- **Merkle Services**: For state management

## Monitoring & Observability

### Metrics

- Proof verification success rate
- Transaction throughput
- Privacy pool utilization
- Relayer performance

### Logging

- Proof validation events
- Transfer executions
- Error conditions
- Security alerts

## Future Architecture Extensions

### Multi-Asset Support

```rust
enum AssetType {
    SOL,
    SPL(TokenMint),
    NFT(TokenMint),
}
```

### Cross-Chain Privacy

- Wormhole integration
- Proof aggregation
- Unified privacy pools

### Advanced Privacy Features

- Amount hiding with range proofs
- Sender/receiver unlinkability
- Transaction graph analysis resistance

---

This architecture provides a solid foundation for privacy-preserving DeFi on Solana, with room for significant expansion and optimization.
