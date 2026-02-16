import { PublicKey } from '@solana/web3.js';

function requireEnv(name: string): string {
  const value = import.meta.env[name];
  if (!value || String(value).trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

function envPublicKey(name: string): PublicKey {
  const value = requireEnv(name);
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid public key in ${name}: ${value}`);
  }
}

// PROGRAM IDENTIFIERS (ENV-DRIVEN, FAIL-FAST)
export const PDX_PROGRAM_ID = envPublicKey('VITE_PDX_PROGRAM_ID');

// TOKEN ADDRESSES (ENV-DRIVEN, FAIL-FAST)
export const NULL_TOKEN_MINT = envPublicKey('VITE_NULL_TOKEN_MINT');
export const USDC_MINT = envPublicKey('VITE_USDC_MINT');

// PDA ADDRESSES (DERIVED - DETERMINISTIC)
export const getProgramDerivedAddresses = (programId: PublicKey) => {
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programId
    );

    const [merkleTreePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("merkle_tree")],
        programId
    );

    return {
        configPda,
        merkleTreePda
    };
};

const devnetRpc = requireEnv('VITE_RPC_DEVNET');
const mainnetRpc = requireEnv('VITE_RPC_MAINNET');

// NETWORK CONFIGURATION
export const NETWORK_CONFIG = {
    mainnet: {
        rpcUrl: mainnetRpc,
        programId: PDX_PROGRAM_ID,
        tokenMint: NULL_TOKEN_MINT,
        micropaymentMint: USDC_MINT,
    },
    devnet: {
        rpcUrl: devnetRpc,
        programId: PDX_PROGRAM_ID,
        tokenMint: NULL_TOKEN_MINT,
        micropaymentMint: USDC_MINT,
    }
} as const;

// SECURITY CONSTANTS
export const SECURITY_CONFIG = {
    MAX_TRANSACTION_SIZE: 1024 * 10,
    TX_CONFIRMATION_TIMEOUT: 60000,
    REQUIRED_CONFIRMATIONS: 1,
    SESSION_TIMEOUT: 5 * 60 * 1000,
} as const;

export const VERIFIED_BUILD = {
    programHash: requireEnv('VITE_PROGRAM_HASH'),
    sourceHash: requireEnv('VITE_SOURCE_HASH'),
    timestamp: requireEnv('VITE_BUILD_TIMESTAMP'),
} as const;
