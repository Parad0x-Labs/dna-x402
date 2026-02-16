# PDX Dark Protocol - User Interaction Guide

## Overview

The PDX Dark Protocol is a privacy-focused transfer system on Solana that uses zero-knowledge proofs, compression, and batching to provide anonymous transfers. This guide explains how users interact with the protocol.

## Prerequisites

### 1. Solana Wallet
- **Phantom, Backpack, or Solflare** recommended
- Must support Solana mainnet/devnet switching
- Need SOL for transaction fees

### 2. $NULL Tokens
- Fee token for privacy transfers
- **20 $NULL per day** via faucet (devnet)
- Burned per anonymous transaction

## User Flow

### Phase 1: Setup & Token Acquisition

#### Step 1: Get Devnet SOL
```bash
# Connect to devnet
solana config set --url https://api.devnet.solana.com

# Get free SOL for testing
solana airdrop 5
```

#### Step 2: Claim $NULL Tokens
1. Visit PDX faucet website
2. Connect wallet (Phantom/Backpack)
3. Click "Claim 20 $NULL"
4. Approve transaction
5. Receive 20 $NULL tokens in your wallet

**Daily Limit**: 20 $NULL per wallet per day
**Purpose**: $NULL tokens pay for privacy transfer fees

### Phase 2: Asset Deposit (Create Privacy Notes)

#### Step 3: Deposit Assets
1. Open PDX Privacy Wallet
2. Switch to "Privacy Mode"
3. Select asset to deposit (SOL, USDC, etc.)
4. Enter deposit amount
5. Click "Deposit to Privacy Pool"

**What happens**:
- Asset moves to protocol vault
- You receive encrypted "notes" (commitments)
- Notes prove ownership without revealing amounts

#### Step 4: Wait for Netting
- Deposits are batched off-chain
- Netting Engine combines multiple deposits
- Merkle tree roots updated
- Ready for anonymous transfers

### Phase 3: Privacy Transfers

#### Step 5: Send Anonymous Transfer
1. Select "Send Privacy Transfer"
2. Enter recipient address
3. Enter amount + memo
4. Click "Send Private Transfer"

**Technical Process**:
1. **Nebula Compression**: Memo compressed by ~50x
2. **ZK Proof Generation**: Creates proof of valid transfer
3. **$NULL Fee Burn**: Burns tokens as privacy fee
4. **On-chain Settlement**: Proof verified, transfer executed

#### Privacy Features
- **No Amount Leakage**: ZK proofs hide transfer amounts
- **No Recipient Correlation**: Timing attacks prevented
- **No IP Tracking**: RPC calls routed through proxy
- **Metadata Protection**: Memos compressed and encrypted

#### Transparency & Fees
- **$NULL Fee Burns**: Public on-chain records (sustainability fee)
- **No Mixing**: Each burn is individually observable
- **Honest Privacy**: Claims match cryptographic guarantees

### Phase 4: Withdrawal

#### Step 6: Withdraw from Privacy Pool
1. Go to "Withdraw" tab
2. Select withdrawal amount
3. Choose destination wallet
4. Click "Withdraw"

**Process**:
- Submit withdrawal request
- Wait for batch processing
- Receive assets in new wallet
- Break link to original deposits

## Security Features

### Frontend Protection
- **Transaction Guard**: Scans for hidden instructions
- **Address Validation**: Local math-only validation
- **Clipboard Nuke**: Sensitive data auto-cleared
- **Session Management**: Auto-disconnect after inactivity

### Protocol Security
- **Zero-Knowledge Proofs**: Cryptographic privacy guarantees
- **Merkle Trees**: Efficient inclusion proofs
- **Nullifiers**: Prevent double-spending
- **Autonomous Defense**: Burned authority keys

### Emergency Features
- **Circuit Breaker**: UI disables if protocol paused
- **Canary System**: Decentralized alerts via IPFS
- **Break Glass Manual**: Offline recovery guide

## Common Issues & Solutions

### "Insufficient $NULL Balance"
**Solution**: Claim from faucet or wait for daily refresh

### "Transaction Failed"
**Check**:
- Sufficient SOL for fees
- Network congestion
- Contract status (check autonomy dashboard)

### "Proof Generation Failed"
**Check**:
- Browser compatibility (Chrome recommended)
- Sufficient RAM (4GB+)
- No browser extensions interfering

### "Cannot Claim Faucet"
**Check**:
- Devnet network selected
- Wallet balance for fees
- Daily limit not exceeded

## Advanced Usage

### Batch Transfers
- Multiple transfers in one transaction
- Reduced fees per transfer
- Better privacy through mixing

### Cross-Chain Bridges
- Future: Privacy-preserving bridges
- Maintain anonymity across chains
- Unified privacy pool

### Custom Memo Encryption
- End-to-end encrypted memos
- Only recipient can decrypt
- Protocol never sees plaintext

## Development & Testing

### Local Development
```bash
# Clone repository
git clone <repository>

# Install dependencies
npm install
cd faucet && npm install

# Start local wallet
npm run dev

# Start faucet service
cd faucet && npm run dev
```

### Testing Checklist
- [ ] Wallet connection works
- [ ] $NULL faucet claims work
- [ ] Asset deposits succeed
- [ ] Privacy transfers complete
- [ ] Withdrawals work
- [ ] All security features active

## Support & Community

### Documentation
- **Technical Docs**: `/docs`
- **API Reference**: `/api`
- **Security Audit**: `/audit`

### Community
- **Discord**: PDX Privacy Community
- **Twitter**: @PDX_Privacy
- **GitHub**: Issues and feature requests

### Emergency Contacts
- **Critical Bugs**: security@pdxprivacy.com
- **Support**: help@pdxprivacy.com

## Future Roadmap

### Phase 2: Enhanced Privacy
- Multi-asset support (SOL, USDC, Token-2022)
- Cross-chain anonymity
- Mobile wallet support

### Phase 3: DeFi Integration
- Privacy-preserving DEX
- Anonymous lending
- Private NFT trading

### Phase 4: Enterprise Features
- Institutional-grade compliance
- Regulatory reporting tools
- Enterprise API access

---

**Remember**: Privacy is a right, not a privilege. Use PDX Dark Protocol responsibly and help build a more private financial future.
