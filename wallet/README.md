# PDX Privacy Relay - Experimental Transfer Tool

⚠️ **NOT A FULL WALLET** - This is an experimental privacy transfer tool for single-use transactions only.

**Critical Warning:** This tool is unaudited and experimental. Use only for transferring SOL/USDC/tokens, then disconnect immediately. Never store funds here.

## 🎯 What This Tool Does

### ✅ **Privacy Transfer Mode** (Primary Feature)
- **One-time private transfers** via PDX Dark Protocol
- **Nebula compression** (49x metadata reduction)
- **ZK privacy proofs** (zero-knowledge validation)
- **$NULL fee burning** (1 token per transfer)
- **99.999% cost savings** vs standard transactions

### ⚠️ **Standard Mode** (Limited - For Connection Only)
- Connect existing Phantom/Solflare wallet
- Basic SOL/USDC transfers (same as your main wallet)
- **Not for storage** - transfer and disconnect

### 🚫 **What This Is NOT**
- ❌ Full wallet for storing funds
- ❌ Production-ready financial tool
- ❌ Independently audited
- ❌ Recovery system for lost funds
- ❌ Multi-transaction session support

## 🏗️ Architecture

```
PDX Dark Wallet
├── Standard Wallet Features
│   ├── Connect Wallet (Phantom, Solflare, etc.)
│   ├── Balance Display (SOL, USDC, $NULL)
│   ├── Send/Receive Transactions
│   └── Token Management
│
├── PDX Dark Protocol Integration
│   ├── $NULL Fee Burning
│   ├── ZK Proof Generation
│   ├── Nebula Compression
│   ├── Merkle Tree Management
│   └── Privacy Transaction History
│
└── Security Features
    ├── Forced Terms Acceptance
    ├── Session Auto-Disconnection
    ├── CSP Security Headers
    ├── ESLint + TypeScript Strict Mode
    └── Audit Scripts
```

## 🛡️ Security Features

### 🔒 **Pre-Transaction Requirements**
- **Forced Terms Acceptance**: Must read and accept full terms before use
- **Scroll-to-Bottom Verification**: Cannot accept without reading all warnings
- **24-Hour Terms Expiry**: Must re-accept terms daily

### 🚨 **Runtime Security**
- **Session Management**: Automatic disconnection after transactions
- **Single-Use Design**: Forces disconnection after any transfer
- **Activity Monitoring**: Disconnects after 5 minutes or 2 minutes inactivity
- **Data Clearing**: Removes all session data on disconnect

### 🛡️ **Content Security**
- **Strict CSP Headers**: No inline scripts, restricted external resources
- **No Eval/InnerHTML**: TypeScript strict mode prevents dangerous code
- **Official Libraries Only**: Uses audited Solana Wallet Adapter
- **No Seed Storage**: Never stores private keys or seeds

### 🔍 **Audit & Testing**
```bash
# Run full security audit
chmod +x security-audit.sh
./security-audit.sh

# Or individual checks
npm run security:full    # Lint + TypeScript + Audit
npm run security:deps    # Dependency vulnerabilities
```

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## 🔧 Integration Points

### 1. Wallet Connection
```typescript
import { useWallet } from '@solana/wallet-adapter-react'

// Standard wallet connection
const { publicKey, signTransaction } = useWallet()
```

### 2. PDX Dark Protocol Integration
```typescript
import { PDXDarkClient } from './lib/pdx-dark'

// Privacy transfer
const result = await PDXDarkClient.transfer({
  asset: selectedAsset,
  amount: transferAmount,
  recipient: recipientAddress,
  memo: "Private transaction",
  useCompression: true  // Automatic Nebula compression
})
```

### 3. $NULL Token Support
```typescript
// Check $NULL balance
const nullBalance = await getTokenBalance(NULL_MINT_ADDRESS)

// Burn $NULL for privacy fees
await burnNullTokens(feeAmount)
```

## 📱 User Experience

### Standard Mode
- Connect wallet → Send SOL/USDC → Normal transaction
- Familiar interface like Phantom/Solflare

### Privacy Mode (PDX Dark)
- Toggle "Privacy Mode" → Select asset → Enter recipient
- Automatic $NULL fee calculation
- Nebula compression applied automatically
- ZK proof generation in background
- Private transaction confirmation

### Key UI Elements
```
┌─────────────────────────────────────┐
│ 💰 Balance: 10.5 SOL                │
│ 🔒 $NULL: 1,000 (for privacy fees) │
│                                     │
│ [📤 Send] [📥 Receive] [🔐 Privacy] │
│                                     │
│ 🔐 Privacy Mode: ON                 │
│   • Automatic compression: 49x     │
│   • $NULL fee: 1.0 per tx          │
│   • ZK privacy: Enabled             │
└─────────────────────────────────────┘
```

## 🛠️ Technical Implementation

### Core Dependencies
```json
{
  "@solana/wallet-adapter-react": "^0.15.0",
  "@solana/web3.js": "^1.87.0",
  "react": "^18.0.0",
  "zstandard": "^1.0.0",
  "snarkjs": "^0.7.0"
}
```

### PDX Integration Library
```typescript
// lib/pdx-dark.ts
export class PDXDarkClient {
  private nebula: NebulaCompressor
  private zkClient: ZKProofGenerator
  private programId: PublicKey

  async transfer(params: TransferParams): Promise<TransactionSignature> {
    // 1. Compress memo with Nebula
    const compressedMemo = await this.nebula.compress(params.memo)

    // 2. Generate ZK proof
    const proof = await this.zkClient.generateProof({
      asset: params.asset,
      amount: params.amount,
      recipient: params.recipient
    })

    // 3. Create PDX instruction
    const instruction = await this.buildTransferInstruction({
      proof,
      compressedMemo,
      ...params
    })

    // 4. Send transaction
    return await this.sendTransaction(instruction)
  }
}
```

## 🎨 Customization Options

### Branding
- Replace colors with PDX Dark theme
- Add privacy-focused icons
- Custom loading animations

### Features
- Privacy transaction history
- Compression ratio display
- $NULL earning opportunities
- Advanced privacy settings

## 📦 Distribution

### Web Version
- Host on Vercel/Netlify
- Domain: `wallet.pdxdark.com`

### Desktop Version
- Use Electron/Tauri
- Auto-updater functionality

### Mobile Version
- React Native + Expo
- App Store + Google Play

## 🔒 Security Considerations

- All ZK proofs generated client-side
- Private keys never leave user's device
- Nebula compression happens locally
- $NULL burning verified on-chain
- Audit all PDX protocol integration

## 🚀 Launch Plan

1. **Phase 1**: Basic wallet with PDX integration
2. **Phase 2**: Add compression visualization
3. **Phase 3**: Netting engine integration
4. **Phase 4**: Mobile app release

---

*Built for the privacy revolution* 🛡️
