// PDX $NULL Faucet Client
// Handles claiming 20 $NULL tokens per day per wallet

import {
    Connection,
    PublicKey,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
    Keypair
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction
} from '@solana/spl-token';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token-2022';

export interface FaucetState {
    nullMint: PublicKey;
    authority: PublicKey;
    dailyLimit: number;
    bump: number;
}

export interface ClaimRecord {
    lastClaimDay: number;
    totalClaimed: number;
}

export class NullFaucetClient {
    private connection: Connection;
    private programId: PublicKey;
    private nullMint: PublicKey;

    constructor(
        connection: Connection,
        programId: PublicKey,
        nullMint: PublicKey
    ) {
        this.connection = connection;
        this.programId = programId;
        this.nullMint = nullMint;
    }

    // Get faucet PDA
    getFaucetPDA(): PublicKey {
        const [faucetPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('pdx_faucet')],
            this.programId
        );
        return faucetPDA;
    }

    // Get claim record PDA for a wallet
    getClaimRecordPDA(wallet: PublicKey): PublicKey {
        const [claimPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('pdx_claim'), wallet.toBuffer()],
            this.programId
        );
        return claimPDA;
    }

    // Get user's $NULL ATA
    async getUserNullATA(wallet: PublicKey): Promise<PublicKey> {
        return getAssociatedTokenAddress(
            this.nullMint,
            wallet,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
    }

    // Check if user can claim today
    async canClaim(wallet: PublicKey): Promise<boolean> {
        try {
            const claimRecordPDA = this.getClaimRecordPDA(wallet);
            const accountInfo = await this.connection.getAccountInfo(claimRecordPDA);

            if (!accountInfo) {
                return true; // Never claimed before
            }

            // Deserialize claim record
            const data = accountInfo.data;
            const lastClaimDay = data.readBigUInt64LE(0);

            // Get current day
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const currentDay = Math.floor(currentTimestamp / 86400);

            return lastClaimDay < currentDay;
        } catch (error) {
            console.error('Error checking claim status:', error);
            return false;
        }
    }

    // Claim $NULL tokens
    async claimTokens(wallet: Keypair): Promise<string> {
        const faucetPDA = this.getFaucetPDA();
        const claimRecordPDA = this.getClaimRecordPDA(wallet.publicKey);
        const userATA = await this.getUserNullATA(wallet.publicKey);

        // Create claim instruction
        const claimIxData = Buffer.alloc(1);
        claimIxData.writeUInt8(1, 0); // Claim instruction variant

        const claimIx = {
            programId: this.programId,
            keys: [
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // claimant
                { pubkey: userATA, isSigner: false, isWritable: true }, // claimant_ata
                { pubkey: faucetPDA, isSigner: false, isWritable: true }, // faucet_pda
                { pubkey: claimRecordPDA, isSigner: false, isWritable: true }, // claim_record_pda
                { pubkey: this.nullMint, isSigner: false, isWritable: false }, // null_mint
                { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: claimIxData
        };

        const transaction = new Transaction().add(claimIx);

        // Get recent blockhash
        const { blockhash } = await this.connection.getRecentBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = wallet.publicKey;

        // Sign and send
        transaction.sign(wallet);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());

        // Confirm transaction
        await this.connection.confirmTransaction(signature);

        return signature;
    }

    // Get faucet state
    async getFaucetState(): Promise<FaucetState | null> {
        try {
            const faucetPDA = this.getFaucetPDA();
            const accountInfo = await this.connection.getAccountInfo(faucetPDA);

            if (!accountInfo) return null;

            const data = accountInfo.data;
            return {
                nullMint: new PublicKey(data.slice(0, 32)),
                authority: new PublicKey(data.slice(32, 64)),
                dailyLimit: data.readBigUInt64LE(64),
                bump: data[72]
            };
        } catch (error) {
            console.error('Error getting faucet state:', error);
            return null;
        }
    }
}
