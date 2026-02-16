# PDX Dark Protocol - Deploy & Test Guide

## Quick Start Checklist

### ✅ Prerequisites
- [ ] Node.js 18+ installed
- [ ] Rust 1.70+ installed
- [ ] Solana CLI installed
- [ ] Git repository cloned
- [ ] Devnet SOL available (25+ SOL recommended)

### ✅ Devnet Setup
```bash
# Switch to devnet
solana config set --url https://api.devnet.solana.com

# Get free SOL (5x for good measure)
solana airdrop 5
solana airdrop 5
solana airdrop 5
solana airdrop 5
solana airdrop 5

# Verify balance
solana balance

# Verify balance
solana balance
```

## 1. Deploy $NULL PARADOX Token

```bash
# Make deployment script executable
chmod +x deploy_null_paradox_devnet.sh

# Deploy token (creates 1B $NULL)
./deploy_null_paradox_devnet.sh
```

**Expected Output**:
```
🚀 Deploying $NULL PARADOX Token to Devnet...
🏭 Creating Token Mint Account...
✅ Mint Keypair: [MINT_ADDRESS]
💰 Minting 1B $NULL tokens...
...
✅ DEPLOYMENT COMPLETE!
📋 Deployment Summary:
   Token Name: $NULL PARADOX
   Mint Address: [MINT_ADDRESS]
   Total Supply: 1000000000 NULL
   Decimals: 6
```

**⚠️ IMPORTANT**: Copy the mint address and update contract:
```bash
# Update the contract constant
sed -i 's/const NULL_FEE_MINT_STR: &str = ".*";/const NULL_FEE_MINT_STR: &str = "[MINT_ADDRESS]";/' src/lib.rs
```

## 2. Deploy PDX Program

```bash
# Build and deploy program
cargo build-sbf
solana program deploy target/deploy/pdx_dark_protocol.so
```

**Expected Output**:
```
Program Id: [PROGRAM_ID]
```

## 3. Initialize Protocol

```bash
# Update IDs in client (replace with actual values)
PROGRAM_ID="your_program_id_here"
NULL_MINT="your_null_mint_here"

# Update client files
sed -i "s/PROGRAM_ID = Pubkey.from_string.*/PROGRAM_ID = Pubkey.from_string('$PROGRAM_ID')/" client/dark_client.py
sed -i "s/null_fee_mint = Pubkey.from_string.*/null_fee_mint = Pubkey.from_string('$NULL_MINT')/" client/dark_client.py

# Initialize SOL vault
python3 client/dark_client.py init_vault

# Initialize $NULL vault
python3 client/dark_client.py init_null_vault

# Preload vault with 100M $NULL for testing
chmod +x preload_vault.sh
./preload_vault.sh $PROGRAM_ID $NULL_MINT
```

## 4. Deploy Faucet (Optional but Recommended)

```bash
# Build faucet program
cd src && rustc --crate-type lib faucet.rs
solana program deploy faucet.so

# Initialize faucet
python3 faucet/setup_faucet.py [NULL_MINT_ADDRESS]
```

## 5. Test Everything

### Basic Functionality Test
```bash
# Run comprehensive tests
python3 client/test_dark_protocol.py
```

### Manual Testing
```bash
# 1. Claim $NULL from faucet
# 2. Deposit SOL to privacy pool
python3 client/dark_client.py deposit 1.0

# 3. Send privacy transfer (burns from vault automatically)
python3 client/dark_client.py transfer [RECIPIENT] 0.5 "Test transfer"

# 4. Check balances
solana balance
spl-token balance [NULL_MINT] --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

### Wallet Interface Test
```bash
cd wallet
npm run dev
```
**Access**: http://localhost:5173

## 6. Build Browser Extension

### For Chrome:
```bash
cd extension
npm install
npm run build

# Load in Chrome:
# 1. Open chrome://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the extension/ directory
```

### For Edge:
```bash
cd extension
npm run package

# Load in Edge:
# 1. Open edge://extensions/
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the extension/dist/ directory
```

### Extension Features:
- ✅ Connect Phantom wallet
- ✅ Display SOL balance
- ✅ Send private transfers
- ✅ Claim $NULL faucet
- ✅ Deposit $NULL to vault
```

## 6. Launch Wallet Interface

```bash
cd wallet
npm install
npm run dev
```

**Access**: http://localhost:5173

### Wallet Features to Test
- [ ] Connect wallet (Phantom/Backpack)
- [ ] $NULL faucet claims
- [ ] Standard SOL transfers
- [ ] Privacy mode deposits
- [ ] Anonymous transfers
- [ ] Security features active

## Troubleshooting

### "Insufficient SOL"
```bash
solana airdrop 5
solana balance  # Verify
```

### "Program deployment failed"
```bash
# Check program size
ls -lh target/deploy/pdx_dark_protocol.so

# If >50KB, optimize
cargo build-sbf --release
```

### "Transaction timeout"
```bash
# Increase timeout
solana config set --commitment confirmed
```

### "Faucet claims not working"
```bash
# Check faucet program deployment
solana program show [FAUCET_PROGRAM_ID]

# Verify NULL mint
spl-token supply [NULL_MINT_ADDRESS]
```

### "Privacy transfers failing"
```bash
# Check ZK setup
cd circuits
./setup_pdx.sh

# Verify proof generation
node test_endianness.js
```

## Security Verification

### Pre-Launch Checklist
- [ ] Program deployed with immutable authority
- [ ] $NULL mint authority burned
- [ ] Vault properly funded
- [ ] Test vectors locked
- [ ] Security audits passed
- [ ] Emergency procedures documented

### Runtime Monitoring
```bash
# Monitor program logs
solana logs [PROGRAM_ID]

# Check vault balance
solana balance [VAULT_PDA]

# Verify nullifier consumption
solana account [NULLIFIER_PDA]
```

## Performance Benchmarks

### Expected Performance
- **Deposit**: < 5 seconds
- **Transfer**: < 10 seconds (ZK proof generation)
- **Withdrawal**: < 5 seconds
- **Faucet Claim**: < 3 seconds

### Optimization Tips
- Use recent blockhash
- Set appropriate compute budget
- Batch operations when possible
- Monitor CU consumption

## Next Steps

### Immediate (This Week)
1. ✅ Deploy on devnet
2. ✅ Test all functionality
3. ✅ Fix any critical bugs
4. ✅ Security audit round 1

### Short Term (Next Month)
1. Mainnet deployment preparation
2. Production wallet polish
3. Documentation completion
4. Community beta testing

### Long Term (3-6 Months)
1. Multi-asset support
2. Cross-chain features
3. Mobile app
4. Enterprise integrations

---

## Emergency Contacts

**Critical Issues**: security@pdxprivacy.com
**Technical Support**: dev@pdxprivacy.com
**Community**: Discord #support

**Break Glass**: See BREAK_GLASS_MANUAL.md

---

**Status**: Ready for devnet deployment and testing 🚀
