# 🚀 PDX DARK PROTOCOL - PRODUCTION DEPLOYMENT GUIDE

## 📋 DEPLOYMENT PHASES

### **Phase 1: Devnet Testing**
```bash
# 1. Build with exact toolchain
solana --version  # Record this
cargo build-sbf --version  # Record this

# 2. Deploy to devnet
solana config set --url devnet
solana program deploy target/deploy/pdx_dark_protocol.so

# 3. Initialize protocol components
# InitVault (SOL vault)
# InitNullMint ($NULL token mint)

# 4. Generate golden vectors on devnet
cd circuits/
snarkjs groth16 prove build/circuit_final.zkey witness.wtns proof.json public.json
cd ../
./generate_golden_vectors.sh
cargo test test_golden_proof_format_lock  # Must pass

# 5. Test full user flow
# - ClaimNullTokens (get initial $NULL)
# - InitVault (if not done by deployer)
# - Deposit SOL to vault
# - InitNullifier for asset + fee nullifiers
# - Transfer with valid proof (burns $NULL)
```

### **Phase 2: Testnet Validation**
```bash
# 1. Deploy to testnet
solana config set --url testnet
solana program deploy target/deploy/pdx_dark_protocol.so

# 2. Re-run golden vector test (should pass - same format)
cargo test test_golden_proof_format_lock

# 3. Test with real SOL amounts
# - Multiple transfers
# - Error conditions (insufficient funds, invalid proofs)
# - Concurrent operations
```

### **Phase 3: Mainnet Deployment**
```bash
# 1. Final build verification
git tag v1.0.0  # Tag the exact commit
cargo build-sbf  # Verify build succeeds
shasum target/deploy/pdx_dark_protocol.so > program_checksum.txt

# 2. Deploy to mainnet
solana config set --url mainnet-beta
solana program deploy target/deploy/pdx_dark_protocol.so

# 3. Initialize vault
# Run InitVault instruction immediately after deployment

# 4. Burn upgrade authority (irreversible)
solana program set-upgrade-authority <PROGRAM_ID> --final
```

---

## 🔑 KEY MANAGEMENT & IMMUTABILITY

### **Build Reproducibility**
```bash
# Store these for immutability verification
git rev-parse HEAD > deployment_commit.txt
solana --version > solana_version.txt
cargo build-sbf --version > cargo_version.txt
rustc --version > rustc_version.txt

# Verify build reproducibility
git checkout <stored_commit>
cargo build-sbf  # Should produce identical .so file
```

### **Upgrade Authority Handling**
- **Devnet/Testnet**: Keep upgrade authority for fixes
- **Mainnet**: Burn immediately after vault initialization
- **Verification**: `solana program show <PROGRAM_ID>` should show no upgrade authority

---

## 💰 VAULT FUNDING & MONITORING

### **Funding Policy**
- **Initial**: Deployer funds vault with 10-50 SOL for relayer fees
- **Ongoing**: Relayers monitor and top up as needed
- **Alerts**: Vault balance < 1 SOL → automatic alerts

### **Off-Chain Watcher (Recommended)**
```javascript
// Monitor vault balance every 60 seconds
const VAULT_ADDRESS = "...";
const MIN_BALANCE = 1_000_000_000; // 1 SOL in lamports

setInterval(async () => {
  const balance = await connection.getBalance(new PublicKey(VAULT_ADDRESS));
  if (balance < MIN_BALANCE) {
    console.error(`🚨 VAULT LOW: ${balance / 1e9} SOL remaining`);
    // Send alert to relayers
  }
}, 60000);
```

---

## ⚡ COMPUTE BUDGET MANAGEMENT

### **Recommended Client Defaults**
```typescript
// In wallet SDK - bake these recommendations
const RECOMMENDED_COMPUTE_BUDGET = {
  units: 1_400_000,    // Max allowed by policy
  price: 50_000,       // Max µ-lamports per CU
};

// Auto-add to transfer transactions
const addComputeBudget = (tx: Transaction) => {
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: RECOMMENDED_COMPUTE_BUDGET.units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: RECOMMENDED_COMPUTE_BUDGET.price })
  );
};
```

### **CU Exceeded Handling**
```typescript
try {
  await sendTransaction(tx);
} catch (error) {
  if (error.message.includes("Compute budget exceeded")) {
    alert("Transaction too complex. Try again or contact support.");
  } else {
    alert(`Transaction failed: ${error.message}`);
  }
}
```

---

## 🎨 USER EXPERIENCE FLOWS

### **Automatic Initialization**
```typescript
// Client SDK should handle this transparently
async function prepareTransfer(params) {
  // 1. Check vault exists, init if not
  const vaultInfo = await connection.getAccountInfo(VAULT_ADDRESS);
  if (!vaultInfo) {
    await initVault();
  }

  // 2. Check nullifiers exist, init if not
  for (const nullifier of [params.assetNullifier, params.feeNullifier]) {
    const nullifierPda = deriveNullifierPda(nullifier, params.tag);
    const info = await connection.getAccountInfo(nullifierPda);
    if (!info) {
      await initNullifier(nullifier, params.tag);
    }
  }

  // 3. Proceed with transfer
  return await createTransferTx(params);
}
```

### **Error Messages (User-Friendly)**
- ❌ "Account not found" → "Preparing privacy setup..."
- ❌ "Insufficient funds" → "Need more SOL for privacy fees"
- ❌ "Invalid proof" → "Privacy proof verification failed"

---

## 📊 MONITORING & LOGGING

### **On-Chain Logs (Success Cases)**
```rust
// In transfer success
msg!("PDX_TRANSFER_SUCCESS");
msg!("root: {:?}", root);
msg!("new_commitment: {:?}", new_commitment);
msg!("asset_nullifier_prefix: {:?}", &nullifier_asset[..4]);
msg!("fee_nullifier_prefix: {:?}", &nullifier_fee[..4]);
msg!("relayer_fee: {} lamports", RELAYER_FEE_LAMPORTS);
```

### **Off-Chain Monitoring**
- Transaction success rates
- Average proof verification time
- Vault balance trends
- Nullifier initialization frequency

---

## 🚨 COMMON FAILURE MODES

### **"Transaction simulation failed"**
- **Cause**: Missing nullifier initialization
- **Fix**: Ensure client auto-initializes PDAs

### **"Program failed: Insufficient funds"**
- **Cause**: Vault depleted
- **Fix**: Monitor and fund vault proactively

### **"Proof verification failed"**
- **Cause**: Format mismatch or invalid proof
- **Fix**: Check golden vector test passes

### **"Compute budget exceeded"**
- **Cause**: Complex proof or high network congestion
- **Fix**: Increase CU limit within policy bounds

### **"Account not rent-exempt"**
- **Cause**: Vault or nullifier PDA became invalid
- **Fix**: Re-initialize with proper funding

---

## 🪙 TOKEN SUPPORT EXTENSIONS

### **Current Scope: SOL-Only**
The protocol currently supports SOL transfers with privacy. To add token support:

### **USDC SPL Support (Extension)**
```rust
// Would require:
// 1. Token account validation in instructions
// 2. Token transfer CPI calls
// 3. Associated token account creation
// 4. Updated circuit for token amounts
// 5. New instruction variants (TransferToken)
```

### **Token 2022 Support (Extension)**
```rust
// Additional complexity:
// 1. Token 2022 program CPI calls
// 2. Extension validation (transfer fees, etc.)
// 3. Updated PDA derivation for token accounts
// 4. Circuit modifications for token semantics
```

**Current Status**: SOL-only. Token support would be a major protocol extension requiring new circuit design and additional instructions.

---

## 🌐 NETWORK SWITCHING

### **Program Deployment**
- **Devnet**: Separate deployment, test program ID
- **Testnet**: Separate deployment, test program ID
- **Mainnet**: Production deployment, production program ID

### **Client Configuration**
```typescript
const NETWORK_CONFIGS = {
  devnet: {
    programId: "DevnetProgramId...",
    cluster: "devnet",
    vaultAddress: deriveVaultAddress("devnet"),
  },
  testnet: {
    programId: "TestnetProgramId...",
    cluster: "testnet",
    vaultAddress: deriveVaultAddress("testnet"),
  },
  mainnet: {
    programId: "MainnetProgramId...",
    cluster: "mainnet-beta",
    vaultAddress: deriveVaultAddress("mainnet"),
  },
};
```

### **Switching Networks**
1. Deploy program to each network separately
2. Generate network-specific golden vectors (if circuit changes)
3. Update client SDK with network-specific addresses
4. Test full flow on each network

---

## 🎯 FINAL CHECKLIST

- [ ] Devnet deployment successful
- [ ] Golden vectors generated and committed
- [ ] Testnet validation passed
- [ ] Build reproducibility verified
- [ ] Vault funding plan in place
- [ ] Client SDK handles auto-initialization
- [ ] Monitoring/logging implemented
- [ ] Mainnet deployment ready
- [ ] Upgrade authority burned
- [ ] All common failure modes handled

**Ready for production deployment.** 🚀
