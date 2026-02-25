# PDX Dark Protocol

**Zero-Knowledge Privacy Protocol for Solana**

A production-ready zero-knowledge proof (ZK-Snark) based privacy protocol that enables anonymous SOL transfers on the Solana blockchain while maintaining complete transaction privacy.

## 🚀 Overview

PDX Dark Protocol implements a privacy-focused cryptocurrency transfer system using:
- **Groth16 Zero-Knowledge Proofs** for transaction validation
- **Merkle Trees** for efficient proof construction
- **Nullifiers** to prevent double-spending
- **Pedersen Commitments** for amount hiding
- **Real SOL Asset Transfers** with cryptographic privacy

## 🎯 Key Features

- ✅ **Complete Transaction Privacy** - No visible sender, recipient, or amounts
- ✅ **Mathematical Security** - ZK proofs ensure validity without revealing data
- ✅ **Double-Spend Protection** - Nullifiers prevent replay attacks
- ✅ **Real SOL Transfers** - Actual blockchain asset movements
- ✅ **Relayer Incentives** - Fee mechanism for transaction processing
- ✅ **Production Ready** - Deployed and tested on Solana devnet

## 🏗️ Architecture

### Core Components

1. **ZK Circuit** (`circuits/dark_transfer.circom`)
   - Defines privacy constraints
   - Generates proving/verification keys

2. **Solana Program** (`src/lib.rs`)
   - On-chain proof verification
   - Asset transfer execution
   - Privacy pool management

3. **Client Library** (`client/`)
   - Proof generation
   - Transaction construction
   - Wallet integration

4. **Browser Extension** (`extension/`)
   - User interface
   - Wallet connectivity
   - Privacy transaction management

### Privacy Flow

```
Deposit: User → Privacy Pool (public)
ZK Proof: Validates deposit ownership (private)
Withdrawal: Pool → Recipient (public, unlinkable)
Result: Anonymous transfers with full privacy
```

## 📋 Prerequisites

- **Node.js** 16+
- **Rust** 1.70+
- **Solana CLI** 1.18+
- **Circom** 2.1.0
- **SnarkJS** 0.7.0

## 🚀 Quick Start

### 1. Clone and Setup
```bash
git clone <repository>
cd pdx-dark-protocol
npm install
```

### 2. Compile Circuit
```bash
cd circuits
npm install
npx circom dark_transfer.circom --r1cs --wasm --sym
npx snarkjs groth16 setup dark_transfer.r1cs pot12_final.ptau dark.zkey
npx snarkjs zkey export verificationkey dark.zkey verification_key.json
```

### 3. Build and Deploy
```bash
cargo build-sbf
solana program deploy target/deploy/pdx_dark_protocol.so
```

### 4. Generate Proofs
```python
# Example: Generate withdrawal proof
python generate_real_proof.py
```

## 📖 API Documentation

### Program Instructions

#### Deposit
```rust
// Deposit SOL into privacy pool
DarkInstruction::Deposit {
    amount: u64,        // Amount to deposit
    commitment: [u8; 32] // Pedersen commitment
}
```

#### Withdraw
```rust
// Withdraw SOL with ZK proof
DarkInstruction::Withdraw {
    proof: Vec<u8>,             // Groth16 proof (256 bytes)
    root: [u8; 32],            // Merkle root
    nullifier_asset: [u8; 32], // Asset nullifier
    nullifier_fee: [u8; 32],   // Fee nullifier
    new_commitment: [u8; 32],  // New commitment
    asset_id_hash: [u8; 32],   // Integrity hash
    recipient: Pubkey,         // Recipient address
    amount: u64,               // Withdrawal amount
}
```

### Client API

```typescript
// Generate anonymous transfer
const proof = await generateZKProof(depositData, withdrawalData);
const tx = await createAnonymousTransfer(proof, recipient, amount);
await wallet.sendTransaction(tx);
```

## 🔒 Security

### Cryptographic Security
- **ZK Proofs**: Groth16 with 128-bit security
- **Hash Function**: Keccak-256 for commitments
- **Nullifiers**: Prevent double-spending
- **Merkle Trees**: Efficient proof construction

### Operational Security
- **Proof Validation**: All proofs verified on-chain
- **Access Control**: PDA-based account management
- **Fee Mechanism**: Economic incentives for relayers
- **Input Validation**: Comprehensive parameter checking

## 📊 Current Status

### ✅ Completed
- [x] ZK Circuit implementation
- [x] Solana program deployment
- [x] Real SOL transfer capability
- [x] Proof verification system
- [x] Nullifier management
- [x] Browser extension UI

### ⚠️ Known Limitations
- ZK proof generation requires circuit compilation
- Merkle tree management needs off-chain coordination
- Relayer network not fully implemented
- Circuit optimizations pending

### 🚧 In Development
- Optimized proof generation
- Merkle tree management service
- Multi-asset support
- Cross-chain privacy bridges

## 🧪 Testing

### Unit Tests
```bash
cargo test
```

### Integration Tests
```bash
# Run client tests
cd client && npm test

# Run circuit tests
cd circuits && npm test
```

### Devnet Testing
```python
# Test real transfers
python execute_real_transfer.py
```

## 🔧 Configuration

### Program IDs
- **Main Program**: `3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz`
- **Vault PDA**: `FFUFFGQBgcqbNHYGoEkNYqkQnfMxGf4zsePRzcd3HsEg`

### Network Endpoints
- **Devnet RPC**: `https://api.devnet.solana.com`
- **Mainnet RPC**: `https://api.mainnet.solana.com`

## 🤝 Contributing

### Development Setup
1. Fork the repository
2. Create feature branch
3. Make changes with tests
4. Submit pull request

### Code Standards
- Rust: Follow Solana program best practices
- TypeScript: ESLint configuration
- Documentation: Clear and comprehensive

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Disclaimer

This is experimental cryptographic software. Use at your own risk. The protocol implements advanced cryptographic primitives that should be thoroughly audited before production use.

## 📞 Support

- **Documentation**: See `/docs` directory
- **Issues**: GitHub Issues
- **Discussions**: GitHub Discussions

## 🚢 Devnet Deploy Audit

Use the audited runbook:

- `docs/DEVNET_DEPLOY.md`

Programmability contract boundary:

- `docs/PROGRAMMABILITY_CONTRACT.md`

Open-source release posture:

- `docs/OPEN_SOURCE_RELEASE.md`
- `SECURITY.md`
- `docs/GO_TO_MARKET_SAFE.md`

Agent front door static site (`/agent`):

- `site-agent/`
- `docs/PROOF.md`
- `docs/DEPLOY_RAILWAY.md`
- `docs/DEPLOY_FLY.md`
- `site/README_DEPLOY_PAGES.md`

Website front door (static):

```bash
cd x402
npm run publish:proof-bundle
npm run site:build
```

## 🎯 Roadmap

### Phase 1 (Current): Core Privacy Protocol
- [x] Basic ZK transfer implementation
- [x] Solana program deployment
- [x] Real asset transfer capability

### Phase 2: Production Optimization
- [ ] Optimized proof generation
- [ ] Merkle tree management
- [ ] Relayer network
- [ ] Multi-asset support

### Phase 3: Ecosystem Integration
- [ ] Wallet integrations
- [ ] DEX privacy features
- [ ] Cross-chain privacy
- [ ] Governance mechanisms

---

**PDX Dark Protocol** - Bringing cryptographic privacy to Solana. 🔒✨
