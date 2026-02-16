# PDX Dark Protocol - Setup Guide

## Prerequisites

### System Requirements
- **OS**: Linux/macOS/Windows (WSL2 recommended for Windows)
- **RAM**: 8GB minimum, 16GB recommended
- **Storage**: 10GB free space
- **Network**: Stable internet connection

### Software Dependencies

#### Node.js & NPM
```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # v18.x.x
npm --version   # 9.x.x
```

#### Rust & Cargo
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Verify installation
rustc --version  # 1.70+
cargo --version  # 1.70+
```

#### Solana CLI
```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.4/install)"

# Add to PATH
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify installation
solana --version  # 1.18.x
```

#### Circom & SnarkJS
```bash
# Install Circom
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
sudo cp target/release/circom /usr/local/bin/

# Install SnarkJS globally
npm install -g snarkjs

# Verify installations
circom --version  # 2.1.x
snarkjs --version # 0.7.x
```

## Project Setup

### 1. Clone Repository
```bash
git clone <repository-url>
cd pdx-dark-protocol
```

### 2. Install Dependencies
```bash
# Root dependencies
npm install

# Circuit dependencies
cd circuits
npm install
cd ..

# Client dependencies
cd client
npm install
cd ..
```

### 3. Configure Solana
```bash
# Set devnet as default
solana config set --url https://api.devnet.solana.com

# Generate/deployer keypair (if not exists)
solana-keygen new --outfile deployer_wallet.json

# Check balance
solana balance

# Airdrop SOL for testing (devnet only)
solana airdrop 2
```

## Circuit Compilation

### 1. Compile Circom Circuit
```bash
cd circuits

# Generate R1CS, WASM, and symbols
circom dark_transfer.circom --r1cs --wasm --sym --c

# Verify compilation
ls -la
# Should see: dark_transfer.r1cs, dark_transfer.wasm, dark_transfer.sym
```

### 2. Trusted Setup & ZKey Generation
```bash
# Phase 1: Powers of Tau ceremony
# (Using pre-computed powers - in production, participate in ceremony)
# Download pot12_final.ptau if not present

# Phase 2: Circuit-specific setup
snarkjs groth16 setup dark_transfer.r1cs pot12_final.ptau dark.zkey

# Contribute randomness (optional but recommended)
snarkjs zkey contribute dark.zkey dark_final.zkey --name="PDX Contributor" --entropy="random text"

# Export verification key
snarkjs zkey export verificationkey dark_final.zkey verification_key.json

# Verify setup
snarkjs zkey verify dark_transfer.r1cs pot12_final.ptau dark_final.zkey
```

### 3. Generate Verification Contract (Optional)
```bash
# Generate Solidity verifier
snarkjs zkey export solidityverifier dark_final.zkey verifier.sol

# For EVM compatibility testing
snarkjs zkey export soliditycalldata dark_final.zkey public.json proof.json
```

## Program Build & Deployment

### 1. Build Solana Program
```bash
# Build for Solana blockchain target
cargo build-sbf

# Verify build
ls -la target/deploy/
# Should see: pdx_dark_protocol.so, pdx_dark_protocol-keypair.json
```

### 2. Deploy to Devnet
```bash
# Deploy program
solana program deploy target/deploy/pdx_dark_protocol.so \
  --program-id target/deploy/pdx_dark_protocol-keypair.json

# Note the program ID from output
# Example: Program Id: 3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz
```

### 3. Verify Deployment
```bash
# Check program status
solana program show <PROGRAM_ID>

# Should show: Program is executable and deployed
```

## Testing Setup

### 1. Unit Tests
```bash
# Run Rust tests
cargo test

# Run with verbose output
cargo test -- --nocapture
```

### 2. Circuit Tests
```bash
cd circuits

# Test basic functionality
npm test

# Generate test proof
snarkjs groth16 prove dark_final.zkey witness.wtns proof.json public.json
```

### 3. Integration Tests
```bash
cd client

# Run client tests
npm test

# Test wallet integration
node test_wallet_integration.js
```

### 4. Manual Testing
```bash
# Test deposit functionality
python test_real_deposit.py

# Test withdrawal attempt
python execute_real_transfer.py
```

## Client Setup

### 1. Build Client Library
```bash
cd client

# Build TypeScript
npm run build

# Generate type definitions
npm run types
```

### 2. Wallet Integration
```bash
# Install wallet adapter
npm install @solana/wallet-adapter-react

# Configure for Phantom, Solflare, etc.
```

## Extension Setup

### 1. Browser Extension
```bash
cd extension

# Install dependencies
npm install

# Build extension
npm run build

# Load in browser:
# Chrome: chrome://extensions/ → Load unpacked → select extension/build
# Firefox: about:debugging → Load Temporary Add-on
```

### 2. Extension Configuration
```bash
# Update manifest.json with correct program IDs
{
  "program_id": "3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
  "vault_pda": "FFUFFGQBgcqbNHYGoEkNYqkQnfMxGf4zsePRzcd3HsEg"
}
```

## Configuration Files

### Environment Variables
Create `.env` file:
```bash
# Solana Configuration
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz

# Circuit Configuration
CIRCUIT_PATH=./circuits/dark_transfer.circom
ZKEY_PATH=./circuits/dark_final.zkey
VK_PATH=./circuits/verification_key.json

# Client Configuration
WALLET_CONNECT=true
RELAYERS_ENABLED=true
```

### Program Configuration
Update `src/lib.rs` constants:
```rust
// Program constants
const RELAYER_FEE: u64 = 5_000;  // 0.000005 SOL
const MAX_WITHDRAWAL: u64 = 10_000_000_000;  // 10 SOL
const MIN_DEPOSIT: u64 = 1_000_000;  // 0.001 SOL
```

## Troubleshooting

### Common Issues

#### 1. Circuit Compilation Fails
```bash
# Check Circom version
circom --version

# Reinstall dependencies
cd circuits && rm -rf node_modules && npm install
```

#### 2. Program Build Fails
```bash
# Update Rust toolchain
rustup update

# Clean and rebuild
cargo clean
cargo build-sbf
```

#### 3. Deployment Fails
```bash
# Check Solana balance
solana balance

# Airdrop more SOL if needed
solana airdrop 5

# Check program size limits
ls -lh target/deploy/pdx_dark_protocol.so
```

#### 4. Proof Generation Fails
```bash
# Verify circuit files exist
ls -la circuits/*.zkey circuits/*.json

# Check input format
cat circuits/input.json

# Regenerate keys if corrupted
snarkjs groth16 setup dark_transfer.r1cs pot12_final.ptau dark.zkey
```

### Debug Commands

```bash
# Check Solana logs
solana logs --program <PROGRAM_ID>

# Monitor transactions
solana transaction-history <ACCOUNT> --limit 10

# Check program accounts
solana program show <PROGRAM_ID>
```

## Performance Tuning

### Circuit Optimization
```bash
# Analyze circuit constraints
snarkjs r1cs info dark_transfer.r1cs

# Optimize for smaller proofs
# Use fewer constraints, smaller field sizes
```

### Program Optimization
```bash
# Profile compute units
cargo build-sbf --release

# Minimize stack usage
# Use efficient data structures
```

## Security Checklist

- [ ] All dependencies audited
- [ ] ZK proofs mathematically verified
- [ ] Program accounts properly secured
- [ ] Input validation comprehensive
- [ ] Economic incentives aligned
- [ ] Trusted setup properly executed

## Next Steps

1. **Test Real Transfers**: Generate valid ZK proofs and execute actual SOL movements
2. **Optimize Performance**: Reduce proof generation time and on-chain costs
3. **Add Features**: Multi-asset support, batch transactions, etc.
4. **Security Audit**: Third-party cryptographic and code review
5. **Mainnet Deployment**: Full production deployment with monitoring

---

**Setup complete!** PDX Dark Protocol is now ready for privacy-preserving SOL transfers on Solana. 🔒✨
