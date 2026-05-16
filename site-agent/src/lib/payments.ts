import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { QuoteResponse } from "./types";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TRANSFER_CHECKED_INSTRUCTION = 12;
const MINT_DECIMALS_OFFSET = 44;

function writeU64Le(data: Uint8Array, offset: number, value: bigint): void {
  let cursor = value;
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
}

export interface BrowserWallet {
  publicKey: PublicKey | null;
  sendTransaction: (...args: any[]) => Promise<string>;
}

export interface TransferResult {
  signature: string;
  sourceAta: string;
  destinationAta: string;
  amountAtomic: string;
}

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  if (!PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error(`Owner is off curve: ${owner.toBase58()}`);
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  });
}

function createTransferCheckedInstruction(
  sourceAta: PublicKey,
  mint: PublicKey,
  destinationAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = TRANSFER_CHECKED_INSTRUCTION;
  writeU64Le(data, 1, amount);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const mintAccount = await connection.getAccountInfo(mint, "confirmed");
  if (!mintAccount) {
    throw new Error(`Mint account missing: ${mint.toBase58()}`);
  }
  if (!mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`Mint is not owned by the SPL Token program: ${mint.toBase58()}`);
  }
  if (mintAccount.data.length <= MINT_DECIMALS_OFFSET) {
    throw new Error(`Mint account is too small: ${mint.toBase58()}`);
  }
  return mintAccount.data[MINT_DECIMALS_OFFSET];
}

export async function payQuoteViaSplTransfer(input: {
  wallet: BrowserWallet;
  connection: Connection;
  quote: QuoteResponse;
}): Promise<TransferResult> {
  const { wallet, connection, quote } = input;
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }

  const mint = new PublicKey(quote.mint);
  const recipientOwner = new PublicKey(quote.recipient);
  const senderOwner = wallet.publicKey;

  const sourceAta = getAssociatedTokenAddressSync(mint, senderOwner);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipientOwner);

  const sourceInfo = await connection.getAccountInfo(sourceAta, "confirmed");
  if (!sourceInfo) {
    throw new Error(`Source ATA missing: ${sourceAta.toBase58()}. Fund USDC first.`);
  }

  const destinationInfo = await connection.getAccountInfo(destinationAta, "confirmed");
  const mintDecimals = await getMintDecimals(connection, mint);
  const amount = BigInt(quote.totalAtomic);

  const transaction = new Transaction();

  if (!destinationInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        senderOwner,
        destinationAta,
        recipientOwner,
        mint,
      ),
    );
  }

  transaction.add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      senderOwner,
      amount,
      mintDecimals,
    ),
  );

  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = senderOwner;

  const signature = await wallet.sendTransaction(transaction, connection, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, "confirmed");

  if (confirmation.value.err) {
    throw new Error(`Payment transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return {
    signature,
    sourceAta: sourceAta.toBase58(),
    destinationAta: destinationAta.toBase58(),
    amountAtomic: quote.totalAtomic,
  };
}
