import React from 'react';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import pako from 'pako';
import { MobileHardening } from '../utils/mobileHardening';
import { NETWORK_CONFIG, NULL_TOKEN_MINT, USDC_MINT } from '../constants/protocol';

export interface TransferParams {
  asset: string;
  amount: number;
  recipient: PublicKey;
  memo: string;
  useCompression: boolean;
  wallet: WalletTxContext;
}

export interface WalletTxContext {
  publicKey: PublicKey | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  sendTransaction?: (tx: Transaction, connection: Connection, options?: { skipPreflight?: boolean; maxRetries?: number }) => Promise<string>;
}

export interface PDXTransferResult {
  signature: string;
  slot: number;
  compressionRatio: number;
  nullBurned: number;
  confirmed: boolean;
}

function toAtomicAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be > 0');
  }
  const scaled = Math.round(amount * 10 ** decimals);
  return BigInt(scaled);
}

function inferMint(asset: string): { mint: PublicKey; decimals: number } {
  const upper = asset.toUpperCase();
  if (upper === 'USDC') {
    return { mint: USDC_MINT, decimals: 6 };
  }
  if (upper === 'NULL' || upper === '$NULL') {
    return { mint: NULL_TOKEN_MINT, decimals: 9 };
  }
  throw new Error(`Unsupported asset for micropayments: ${asset}`);
}

export class PDXDarkClient {
  private readonly connection: Connection;
  private readonly nebula: NebulaCompressor;

  constructor(connection?: Connection) {
    this.connection = connection ?? new Connection(NETWORK_CONFIG.devnet.rpcUrl, 'confirmed');
    this.nebula = new NebulaCompressor();
  }

  async transfer(params: TransferParams): Promise<PDXTransferResult> {
    const { wallet } = params;
    if (!wallet.publicKey) {
      throw new Error('Wallet not connected');
    }

    const { canHandle, reason } = await MobileHardening.canHandleZKOperations();
    if (!canHandle) {
      throw new Error(`Device not capable of ZK operations: ${reason}`);
    }

    const compressedMemo = params.useCompression
      ? await this.nebula.compress(params.memo)
      : params.memo;

    const compressionRatio = Math.max(1, params.memo.length) / Math.max(1, compressedMemo.length);

    const { mint, decimals } = inferMint(params.asset);
    const atomicAmount = toAtomicAmount(params.amount, decimals);

    const senderAta = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    const recipientAta = getAssociatedTokenAddressSync(mint, params.recipient, false, TOKEN_PROGRAM_ID);

    const ixes: TransactionInstruction[] = [];

    const recipientAtaInfo = await this.connection.getAccountInfo(recipientAta, 'confirmed');
    if (!recipientAtaInfo) {
      ixes.push(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          recipientAta,
          params.recipient,
          mint,
          TOKEN_PROGRAM_ID,
        ),
      );
    }

    ixes.push(
      createTransferCheckedInstruction(
        senderAta,
        mint,
        recipientAta,
        wallet.publicKey,
        atomicAmount,
        decimals,
      ),
    );

    const tx = new Transaction();
    tx.add(...ixes);
    tx.feePayer = wallet.publicKey;

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;

    const signature = await this.sendTransaction(wallet, tx);
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      'confirmed',
    );

    const confirmed = !confirmation.value.err;

    return {
      signature,
      slot: confirmation.context.slot,
      compressionRatio,
      nullBurned: 0,
      confirmed,
    };
  }

  async getNullBalance(walletAddress: PublicKey): Promise<number> {
    const ata = getAssociatedTokenAddressSync(NULL_TOKEN_MINT, walletAddress, false, TOKEN_PROGRAM_ID);
    const bal = await this.connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
    if (!bal?.value) {
      return 0;
    }
    return Number(bal.value.uiAmount ?? 0);
  }

  async canMakePrivacyTransaction(walletAddress: PublicKey): Promise<boolean> {
    const balance = await this.getNullBalance(walletAddress);
    return balance >= 0;
  }

  private async sendTransaction(wallet: WalletTxContext, tx: Transaction): Promise<string> {
    if (wallet.sendTransaction) {
      return wallet.sendTransaction(tx, this.connection, { skipPreflight: false, maxRetries: 3 });
    }

    if (!wallet.signTransaction) {
      throw new Error('Wallet cannot sign/send transaction');
    }

    const signedTx = await wallet.signTransaction(tx);
    return this.connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  }
}

class NebulaCompressor {
  async compress(data: string): Promise<string> {
    try {
      const input = new TextEncoder().encode(data);
      const compressed = pako.deflate(input);
      return Buffer.from(compressed).toString('base64');
    } catch (error) {
      console.warn('Compression failed, using uncompressed data:', error);
      return data;
    }
  }

  async decompress(data: string): Promise<string> {
    try {
      const compressed = Buffer.from(data, 'base64');
      const decompressed = pako.inflate(compressed);
      return new TextDecoder().decode(decompressed);
    } catch (error) {
      console.warn('Decompression failed:', error);
      return data;
    }
  }
}

export const usePDXDark = () => {
  return React.useMemo(() => new PDXDarkClient(), []);
};
