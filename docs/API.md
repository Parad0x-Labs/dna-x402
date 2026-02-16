# PDX Dark Protocol - API Reference

## Program Interface

### Program ID
```
3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz
```

### Instruction Format

All instructions follow the standard Solana instruction format:
- **Program ID**: PDX program address
- **Accounts**: Required accounts for operation
- **Data**: Borsh-serialized instruction data

## Instructions

### 1. Deposit

Lock SOL in the privacy pool to enable anonymous withdrawals.

#### Instruction Data
```rust
enum DarkInstruction {
    Deposit {
        amount: u64,        // Amount to deposit in lamports
        commitment: [u8; 32] // Pedersen commitment hash
    }
}
```

#### Required Accounts
| Account | Type | Description |
|---------|------|-------------|
| Depositor | Signer, Writable | Account paying the SOL |
| Vault PDA | Writable | Privacy pool account receiving deposit |
| System Program | Read-only | Solana system program |

#### Account Derivation
```rust
vault_pda = find_program_address([b"pdx_vault"], program_id)
```

#### Example Transaction
```javascript
const depositIx = {
  programId: PDX_PROGRAM_ID,
  accounts: [
    { pubkey: depositor, isSigner: true, isWritable: true },
    { pubkey: vaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
  ],
  data: Buffer.from([
    0, // Instruction discriminant
    ...amountBytes, // 8 bytes LE
    ...commitmentBytes // 32 bytes
  ])
}
```

### 2. Withdraw

Withdraw SOL from privacy pool with zero-knowledge proof.

#### Instruction Data
```rust
enum DarkInstruction {
    Withdraw {
        proof: Vec<u8>,             // Groth16 proof (256 bytes)
        root: [u8; 32],            // Merkle root
        nullifier_asset: [u8; 32], // Asset nullifier
        nullifier_fee: [u8; 32],   // Fee nullifier
        new_commitment: [u8; 32],  // New commitment
        asset_id_hash: [u8; 32],   // Integrity hash
        recipient: Pubkey,         // Recipient address
        amount: u64,               // Withdrawal amount
    }
}
```

#### Required Accounts
| Account | Type | Description |
|---------|------|-------------|
| Relayer | Signer, Writable | Pays transaction fees, receives relayer fee |
| Recipient | Writable | Receives withdrawn SOL |
| Asset Nullifier PDA | Writable | Tracks asset spending |
| Fee Nullifier PDA | Writable | Tracks fee spending |
| Vault PDA | Writable | Privacy pool source |
| System Program | Read-only | Solana system program |

#### Account Derivation
```rust
asset_nullifier_pda = find_program_address([b"pdx_nullifier", nullifier_asset], program_id)
fee_nullifier_pda = find_program_address([b"pdx_nullifier", nullifier_fee], program_id)
vault_pda = find_program_address([b"pdx_vault"], program_id)
```

## Client Library API

### TypeScript/JavaScript API

#### Installation
```bash
npm install @pdx-dark/protocol
```

#### Initialization
```typescript
import { PDXClient } from '@pdx-dark/protocol';

const client = new PDXClient({
  programId: '3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz',
  rpcUrl: 'https://api.devnet.solana.com',
  zkeyPath: './circuits/dark_final.zkey'
});
```

#### Deposit SOL
```typescript
const depositTx = await client.createDeposit({
  amount: 1_000_000, // 0.001 SOL
  commitment: commitmentHash
});

await wallet.sendTransaction(depositTx);
```

#### Withdraw SOL Anonymously
```typescript
const withdrawTx = await client.createWithdrawal({
  recipient: recipientAddress,
  amount: 500_000, // 0.0005 SOL
  // ZK proof data automatically generated
});

await wallet.sendTransaction(withdrawTx);
```

### Python API

#### Installation
```bash
pip install pdx-dark-protocol
```

#### Usage
```python
from pdx_dark import PDXClient

client = PDXClient(
    program_id="3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz",
    rpc_url="https://api.devnet.solana.com"
)

# Deposit
deposit_tx = client.create_deposit(amount=1000000, commitment=commitment)
client.send_transaction(deposit_tx, wallet)

# Withdraw
withdraw_tx = client.create_withdrawal(recipient=address, amount=500000)
client.send_transaction(withdraw_tx, wallet)
```

## Circuit API

### Input Parameters

#### Public Inputs (Blockchain Visible)
- `root`: Merkle tree root (32 bytes)
- `nullifierAsset`: Asset nullifier hash (32 bytes)
- `nullifierFee`: Fee nullifier hash (32 bytes)
- `newCommitment`: New output commitment (32 bytes)
- `assetIdHash`: Integrity hash of recipient + amount (32 bytes)

#### Private Inputs (Hidden)
- `secret`: User's secret key
- `amount`: Withdrawal amount
- `pathElements[20]`: Merkle proof path elements
- `pathIndices[20]`: Merkle proof path indices

### Proof Generation

```javascript
// Using snarkjs
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,           // Circuit inputs
  "dark_transfer.wasm",     // Compiled circuit
  "dark_final.zkey"         // Proving key
);

// Proof format
{
  pi_a: [string, string],     // G1 point (2 elements)
  pi_b: [[string, string], [string, string]], // G2 point (4 elements)
  pi_c: [string, string]      // G1 point (2 elements)
}
```

### Proof Verification

```javascript
// On-chain verification
const isValid = await snarkjs.groth16.verify(
  verificationKey,    // From verification_key.json
  publicSignals,      // Public inputs
  proof               // Groth16 proof
);
```

## Error Codes

### Program Errors
| Error Code | Description |
|------------|-------------|
| 0x00 | Invalid instruction data |
| 0x01 | Invalid account provided |
| 0x02 | Insufficient vault balance |
| 0x03 | Invalid ZK proof |
| 0x04 | Double-spend detected |
| 0x05 | Integrity check failed |

### Client Errors
| Error Code | Description |
|------------|-------------|
| 1001 | Circuit compilation failed |
| 1002 | Proof generation failed |
| 1003 | Invalid input parameters |
| 1004 | Network connection error |
| 1005 | Insufficient balance |

## Events & Logs

### Program Logs
```
PDX_INFO: Processing deposit of X lamports
PDX_INFO: Withdrawing X lamports to recipient
PDX_SUCCESS: Deposit completed
PDX_SUCCESS: Withdrawal completed
PDX_ERROR: Invalid proof
PDX_ERROR: Insufficient balance
```

### Transaction Events
```javascript
// Listen for PDX events
connection.onProgramAccountChange(pdxProgramId, (accountInfo) => {
  // Parse PDX-specific events
  const event = parsePDXEvent(accountInfo);
  console.log('PDX Event:', event);
});
```

## Network Endpoints

### Devnet
- **RPC**: `https://api.devnet.solana.com`
- **Program ID**: `3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz`
- **Vault PDA**: `FFUFFGQBgcqbNHYGoEkNYqkQnfMxGf4zsePRzcd3HsEg`

### Mainnet (Future)
- **RPC**: `https://api.mainnet.solana.com`
- **Program ID**: TBD
- **Vault PDA**: TBD

## Rate Limits

- **Proof Generation**: 10 requests/minute per IP
- **Transaction Submission**: 100 requests/minute per wallet
- **Merkle Updates**: 1000 requests/minute

## SDK Examples

### Basic Deposit Flow
```typescript
import { PDXClient, Wallet } from '@pdx-dark/protocol';

// Initialize
const pdx = new PDXClient({ /* config */ });

// Connect wallet
const wallet = new Wallet(window.solana);

// Deposit 0.1 SOL
const depositAmount = 100_000_000; // 0.1 SOL
const commitment = pdx.generateCommitment(depositAmount);

const tx = await pdx.deposit({
  amount: depositAmount,
  commitment: commitment
});

const signature = await wallet.sendTransaction(tx);
console.log('Deposit confirmed:', signature);
```

### Anonymous Withdrawal Flow
```typescript
// Withdraw 0.05 SOL to anonymous recipient
const withdrawalAmount = 50_000_000; // 0.05 SOL
const recipient = new PublicKey('CKuw7ToeLFYxMVrPTY9eoJYNSVp7dKHamJBTkyY842Le');

const tx = await pdx.withdraw({
  recipient: recipient,
  amount: withdrawalAmount,
  // ZK proof automatically generated
});

const signature = await wallet.sendTransaction(tx);
console.log('Anonymous withdrawal confirmed:', signature);
```

## Integration Guides

### Wallet Integration
See `docs/WALLET_INTEGRATION.md`

### Frontend Integration
See `docs/FRONTEND_INTEGRATION.md`

### Backend Integration
See `docs/BACKEND_INTEGRATION.md`

---

For more examples and detailed usage, visit the [GitHub Repository](https://github.com/pdx-dark/protocol) or check the `examples/` directory.
