# 🚨 BREAK GLASS - Manual PDX Dark Protocol Interaction

**EMERGENCY GUIDE: If the PDX Privacy Relay UI goes down, use these manual methods to access your funds.**

## ⚠️ IMPORTANT WARNINGS

- **This is for emergency use only** - The UI is designed to be your primary interface
- **These methods require technical knowledge** - You must understand Solana transactions
- **Test on devnet first** - Never use mainnet funds without testing
- **Keep your proofs secure** - Anyone with your proof data can steal your funds
- **Contact support** - Report UI outages so we can fix them

## 📋 Prerequisites

1. **Solana CLI installed**: `solana --version`
2. **Your wallet keypair**: `~/.config/solana/id.json`
3. **Node.js installed**: For proof serialization
4. **Valid ZK proof data**: From your successful transaction

## 🛠️ Method 1: CLI Direct Submission (Recommended)

### Step 1: Prepare Your Proof Data

Create a JSON file `proof_data.json`:

```json
{
  "proof": {
    "pi_a": ["0x123...", "0x456..."],
    "pi_b": [["0x789...", "0xabc..."], ["0xdef...", "0x123..."]],
    "pi_c": ["0x456...", "0x789..."]
  },
  "publicSignals": [
    "root_hash_hex",
    "nullifier_asset_hex",
    "nullifier_fee_hex",
    "new_commitment_hex",
    "asset_id_hash_hex"
  ]
}
```

### Step 2: Install Dependencies

```bash
npm install @solana/web3.js @solana/spl-token
```

### Step 3: Create Manual Submission Script

Save as `manual_submit.js`:

```javascript
const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

// Configuration - UPDATE THESE
const RPC_URL = 'https://api.devnet.solana.com'; // or mainnet
const PROGRAM_ID = new PublicKey('YOUR_DEPLOYED_PROGRAM_ID');
const USER_KEYPAIR_PATH = '~/.config/solana/id.json';

async function submitManualProof() {
  // Load your proof data
  const proofData = JSON.parse(fs.readFileSync('proof_data.json', 'utf8'));

  // Connect to Solana
  const connection = new Connection(RPC_URL, 'confirmed');

  // Load your keypair
  const keypairData = JSON.parse(fs.readFileSync(USER_KEYPAIR_PATH, 'utf8'));
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

  // Serialize proof for your program format
  const proofBytes = serializeProofForProgram(proofData);

  // Build instruction data according to your program's format
  const instructionData = Buffer.concat([
    Buffer.from([1]), // Transfer variant
    proofBytes,
    // Add public inputs, compressed memo, etc.
  ]);

  // Create instruction
  const instruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      // Add nullifier PDA accounts
      // Add other required accounts
    ],
    data: instructionData
  };

  // Send transaction
  const transaction = new Transaction();
  transaction.add(instruction);

  const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);

  console.log('Transaction submitted:', signature);
  console.log('Confirming...');

  // Wait for confirmation
  await connection.confirmTransaction(signature, 'confirmed');
  console.log('✅ Transaction confirmed!');
}

function serializeProofForProgram(proofData) {
  // Convert snarkjs format to your program's expected format
  // This must match your lib.rs serialization

  const pi_a = proofData.proof.pi_a.map(x => BigInt(x));
  const pi_b = proofData.proof.pi_b.flat().map(x => BigInt(x));
  const pi_c = proofData.proof.pi_c.map(x => BigInt(x));

  // Convert to bytes (adjust based on your program)
  // Return Uint8Array of 256 bytes for Groth16 proof
}

submitManualProof().catch(console.error);
```

### Step 4: Run Manual Submission

```bash
node manual_submit.js
```

## 🛠️ Method 2: Web3.js Browser Console

### For Advanced Users Only

1. Open browser console on any Solana explorer (e.g., Solscan)
2. Load your proof data and keypair
3. Run this script:

```javascript
// Load Solana library (if not already loaded)
import('https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js');

// Your proof data
const proofData = {
  proof: {
    pi_a: ["0x...", "0x..."],
    pi_b: [["0x...", "0x..."], ["0x...", "0x..."]],
    pi_c: ["0x...", "0x..."]
  },
  publicSignals: ["root", "nullifier_asset", "nullifier_fee", "commitment", "asset_hash"]
};

// Connect and submit
const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
const programId = new solanaWeb3.PublicKey('YOUR_PROGRAM_ID');

// Build and send transaction (adapt to your program)
```

## 🛠️ Method 3: Python Script (Alternative)

```python
#!/usr/bin/env python3

import json
import base64
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYS_ID
from solana.rpc.api import Client

# Load proof data
with open('proof_data.json', 'r') as f:
    proof_data = json.load(f)

# Connect to Solana
client = Client("https://api.devnet.solana.com")

# Your program ID
program_id = Pubkey.from_string("YOUR_PROGRAM_ID")

# Build instruction (adapt to your format)
instruction_data = b'\x01'  # Transfer variant
# Add proof bytes, public inputs, etc.

# Create instruction
instruction = Instruction(
    program_id,
    instruction_data,
    [
        # Add required accounts
    ]
)

# Send transaction
# (Add your keypair loading and signing logic)

print("Manual submission completed")
```

## 🔍 Verification Steps

### Check Your Transaction
```bash
# Get transaction details
solana confirm <transaction_signature>

# Check program logs
solana logs <transaction_signature>
```

### Verify Nullifiers
```bash
# Check if nullifiers were consumed
solana account <nullifier_pda_address>
```

## 🆘 If All Methods Fail

1. **Contact Support**: Provide your transaction signatures and proof data
2. **Wait for UI Fix**: The development team will restore UI access
3. **Security First**: Never share your full proof data publicly

## 📞 Support Information

- **GitHub Issues**: Report UI outages at [repo/issues]
- **Discord**: Join our support channel
- **Email**: emergency@pdxdark.com (encrypted only)

## 🔐 Security Notes

- **Never share full proof data** - Anyone can steal your funds
- **Use encrypted communication** for support requests
- **Verify all code** before running manual scripts
- **Test on devnet first** with small amounts

---

**Remember**: This manual process is a safety net. The PDX Privacy Relay is designed to be your primary, user-friendly interface. Manual methods should only be used in emergencies.

*Last updated: December 2025*
