import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { QuoteResponse } from "./types";

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

  const sourceAta = getAssociatedTokenAddressSync(
    mint,
    senderOwner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const destinationAta = getAssociatedTokenAddressSync(
    mint,
    recipientOwner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const sourceInfo = await connection.getAccountInfo(sourceAta, "confirmed");
  if (!sourceInfo) {
    throw new Error(`Source ATA missing: ${sourceAta.toBase58()}. Fund USDC first.`);
  }

  const destinationInfo = await connection.getAccountInfo(destinationAta, "confirmed");
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  const amount = BigInt(quote.totalAtomic);

  const transaction = new Transaction();

  if (!destinationInfo) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        senderOwner,
        destinationAta,
        recipientOwner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
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
      mintInfo.decimals,
      [],
      TOKEN_PROGRAM_ID,
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
