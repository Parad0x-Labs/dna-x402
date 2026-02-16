# PDX Dark Wallet Setup Guide

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd pdx_dark_protocol/wallet
npm install
```

### 2. Update Program Addresses
Edit `src/lib/pdx-dark.ts` with your deployed addresses:
```typescript
const PDX_PROGRAM_ID = new PublicKey('YOUR_DEPLOYED_PROGRAM_ID');
const NULL_MINT_ADDRESS = new PublicKey('YOUR_NULL_TOKEN_MINT');
```

### 3. Start Development Server
```bash
npm run dev
```

### 4. Build for Production
```bash
npm run build
```

## 🔧 Configuration

### Environment Setup
Create `.env` file for production:
```env
VITE_SOLANA_NETWORK=mainnet-beta
VITE_PDX_PROGRAM_ID=your_program_id
VITE_NULL_MINT=your_null_mint
```

### Network Configuration
- **Devnet**: For testing (current default)
- **Mainnet**: Update `WalletAdapterNetwork.Mainnet` in `App.tsx`

## 🏗️ Architecture

### Components
- **App.tsx**: Main application with wallet providers
- **PDXWallet.tsx**: Main wallet interface with mode switching
- **StandardWallet.tsx**: Regular SOL/USDC transactions
- **PrivacyWallet.tsx**: PDX Dark Protocol integration

### Libraries
- **@solana/wallet-adapter**: Official wallet connection
- **@solana/web3.js**: Blockchain interaction
- **zstandard**: Compression for previews
- **decimal.js**: Precise number handling

## 🔗 Integration Points

### PDX Dark Protocol
The wallet integrates with your deployed PDX program:

1. **ZK Proof Generation**: Uses snarkjs (needs backend integration)
2. **Nebula Compression**: Client-side compression preview
3. **$NULL Token**: Balance checking and fee burning
4. **Transaction Building**: Custom instruction serialization

### Backend Requirements
For full functionality, you'll need:

1. **ZK Proof Service**: Generate proofs server-side (snarkjs)
2. **Merkle Tree Service**: Maintain UTXO trees
3. **Relayer Service**: Submit privacy transactions

## 🛡️ Security Audit (MANDATORY)

### Pre-Deployment Checklist
```bash
# Run full security audit
chmod +x security-audit.sh
./security-audit.sh

# All checks must pass:
✅ ESLint + TypeScript strict mode
✅ Dependency security audit (npm audit)
✅ CSP headers implemented
✅ No dangerous code patterns
✅ Required security features present
✅ Build integrity verified
```

### Security Features Implemented
- **Terms Modal**: Forced acceptance with scroll verification
- **Safety Banners**: Persistent warnings throughout UI
- **Session Manager**: Auto-disconnection after transactions
- **CSP Headers**: Strict content security policy
- **TypeScript Strict**: No `any` types, full type safety

## 🎨 Customization

### Themes
- Dark privacy theme for PDX mode
- Light standard theme for regular transactions
- Responsive design for mobile/desktop

### Features
- Add transaction history
- Multi-signature support
- Hardware wallet integration
- Advanced privacy settings

## 📱 Deployment Options

### Web Application
```bash
npm run build
# Deploy dist/ to Vercel, Netlify, or any static host
```

### Desktop App (Electron)
```bash
npm install -D electron electron-builder
# Add electron scripts to package.json
npm run electron:build
```

### Mobile App (React Native)
```bash
npx react-native init PDXWallet
# Copy components and adapt for mobile
```

## 🔒 Security Considerations

### Client-Side Operations
- Private keys never leave user's device
- ZK proofs generated locally (future)
- Compression happens client-side
- All wallet operations use official libraries

### Privacy Features
- Transaction amounts hidden via ZK
- Recipients anonymized
- Memo data compressed and private
- $NULL burning verified on-chain

## 🧪 Testing

### Unit Tests
```bash
npm install -D @testing-library/react jest
npm run test
```

### Integration Tests
- Test wallet connections
- Test PDX protocol integration
- Test compression accuracy
- Test transaction submission

## 🚀 Production Checklist

- [ ] Update all program addresses
- [ ] Configure correct network (mainnet)
- [ ] Test with real $NULL tokens
- [ ] Implement ZK proof generation
- [ ] Add transaction history
- [ ] Security audit of wallet code
- [ ] Performance optimization
- [ ] Mobile responsiveness
- [ ] Error handling and user feedback

## 🎯 User Experience Flow

### First Time User
1. **Connect Wallet** → Phantom/Solflare popup
2. **View Balances** → SOL and $NULL displayed
3. **Choose Mode** → Standard or Privacy toggle
4. **Make Transaction** → Form validation and submission

### Privacy Transaction
1. **Enter Details** → Recipient, amount, memo
2. **See Compression** → Real-time compression preview
3. **Confirm Fee** → 1 $NULL burn requirement
4. **Submit** → ZK proof generation and submission

This wallet serves as the perfect bridge between your powerful PDX Dark Protocol and everyday users, making privacy transactions as simple as regular ones! 🛡️⚡
