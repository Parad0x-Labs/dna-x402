# 🛡️ PDX DARK PROTOCOL - USER GUIDE

## 🎯 What is PDX Dark?

PDX Dark is a **privacy-preserving transfer protocol** on Solana that uses:
- **Zero-Knowledge Proofs** for privacy
- **Nebula Compression** for efficient data handling
- **$NULL Token Fees** for spam prevention
- **Netting Engine** for batched processing

## 💰 $NULL Token: The Privacy Fee

### **Why $NULL Tokens?**
- **Spam Prevention**: Each transfer burns $NULL tokens as a fee
- **Fair Access**: No unlimited free transfers
- **Token Economics**: $NULL tokens can be traded/held like any SPL token

### **How to Get $NULL Tokens**
```bash
# 1. Connect wallet to PDX program
# 2. Call ClaimNullTokens instruction
# Result: Get 10 $NULL tokens in your wallet
```

### **$NULL Token Details**
- **Symbol**: $NULL
- **Decimals**: 6 (like USDC)
- **Total Supply**: Unlimited (minted on-demand)
- **Burn Rate**: 0.01 $NULL per transfer
- **Mint Authority**: PDX Program (burns only)

## 🔄 Complete User Flow

### **Phase 1: Setup**
```bash
# Deployer runs once:
InitVault()      # Creates SOL vault
InitNullMint()   # Creates $NULL token mint

# Users run once:
ClaimNullTokens() # Get initial $NULL allocation
```

### **Phase 2: Deposit Assets**
```bash
# Deposit SOL into privacy pool
Deposit(amount, commitment)

# Creates anonymous note in pool
# Note: No $NULL burn for deposits
```

### **Phase 3: Private Transfers**
```bash
# Burn $NULL + transfer anonymously
Transfer(proof, root, nullifiers, commitment, payload)

# Requirements:
# - Valid ZK proof
# - 0.01 $NULL tokens burned
# - Unused nullifiers consumed
# - Nebula-compressed payload
```

### **Phase 4: Netting & Settlement**
```bash
# Off-chain netting engine:
# - Processes transfer intents
# - Batches operations
# - Optimizes for efficiency

# On-chain settlement:
# - Final balance updates
# - Nullifier consumption
# - Fee collection
```

## 🎛️ Wallet Integration

### **Required Accounts per Transfer**
```
7 accounts required:
1. payer (signer) - transaction payer
2. user_null_ata - your $NULL token account
3. null_mint - $NULL token mint PDA
4. nullifier_asset - asset nullifier PDA
5. nullifier_fee - fee nullifier PDA
6. vault - SOL vault PDA
7. system_program - system program
```

### **Auto-Initialization**
Your wallet should automatically:
```typescript
// Check and create PDAs as needed
if (!vault.exists) await initVault();
if (!nullMint.exists) await initNullMint();
if (!userNullATA.exists) await claimNullTokens();
if (!nullifier.exists) await initNullifier(nullifier, tag);
```

### **Error Handling**
```typescript
// Common errors and solutions:
"vault not rent-exempt" → Wait for vault funding
"nullifier already used" → Use different nullifier
"insufficient $NULL balance" → Claim more tokens
"proof verification failed" → Regenerate proof
```

## 💸 Fee Structure

### **Deposit Fees**
- **SOL**: None (just network fees)
- **$NULL**: None

### **Transfer Fees**
- **SOL**: 0.05 SOL to relayer (from vault)
- **$NULL**: 0.01 tokens burned per transfer
- **Network**: Standard Solana fees

### **Nullifier Setup**
- **SOL**: Rent for PDA creation
- **$NULL**: None

## 🔒 Security Model

### **Privacy Guarantees**
- **Zero-Knowledge**: Transaction amounts hidden
- **Anonymous**: Sender/receiver unlinkable
- **Untraceable**: No timing correlations

### **Spam Protection**
- **$NULL Burning**: Economic cost per transfer
- **Nullifier Uniqueness**: Prevents double-spends
- **Proof Verification**: Prevents invalid transfers

### **Trust Assumptions**
- **Program Immutability**: No admin control after deployment
- **ZK Circuit Correctness**: Mathematical privacy guarantees
- **Oracle Honesty**: Relayer executes correctly

## 🚀 Advanced Usage

### **Batch Transfers**
```typescript
// Submit multiple transfers in one go
const batch = [
  transfer1, transfer2, transfer3
];
// Netting engine processes optimally
```

### **Custom Payloads**
```typescript
// Nebula-compressed data
const payload = nebula.compress({
  memo: "Payment for services",
  metadata: {...}
});
```

### **Token Integration**
```typescript
// Future: Support for other tokens
// For now: SOL + $NULL only
// Token 2022 support: Planned extension
```

## 🔧 Troubleshooting

### **"Account not found"**
- Run initialization instructions first
- Check PDA derivations

### **"Insufficient funds"**
- Fund vault with SOL
- Claim more $NULL tokens

### **"Proof failed"**
- Regenerate proof with correct inputs
- Check circuit parameters

### **"Nullifier used"**
- Use different nullifier values
- Wait for nullifier reset (if applicable)

## 📊 Monitoring

### **Your Balances**
- **SOL**: Standard wallet balance
- **$NULL**: Check associated token account
- **Privacy Pool**: Track via program state

### **Network Status**
- Vault balance monitoring
- Transaction success rates
- Nullifier consumption stats

## 🎯 Summary

**PDX Dark gives you:**
- ✅ **Complete Privacy**: ZK-proven anonymity
- ✅ **Efficient Fees**: $NULL token burning
- ✅ **Simple UX**: Auto-initialization
- ✅ **Solana Native**: Fast, cheap transfers
- ✅ **Future-Proof**: Netting engine ready

**Start with ClaimNullTokens(), then enjoy private transfers!** 🛡️✨
