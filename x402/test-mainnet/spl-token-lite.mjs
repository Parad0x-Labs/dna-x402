import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const TRANSFER_INSTRUCTION = 3;
const CLOSE_ACCOUNT_INSTRUCTION = 9;
const ACCOUNT_AMOUNT_OFFSET = 64;

function writeU64Le(data, offset, value) {
  let cursor = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
}

export function getAssociatedTokenAddress(mint, owner) {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function createAssociatedTokenAccountInstruction(payer, ata, owner, mint) {
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
    data: Buffer.alloc(0),
  });
}

export function createTransferInstruction(source, destination, owner, amount) {
  const data = Buffer.alloc(9);
  data[0] = TRANSFER_INSTRUCTION;
  writeU64Le(data, 1, amount);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function createCloseAccountInstruction(account, destination, owner) {
  const data = Buffer.from([CLOSE_ACCOUNT_INSTRUCTION]);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function getAccount(connection, address) {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (!account) {
    throw new Error(`token account not found: ${address.toBase58()}`);
  }
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`account is not owned by SPL Token program: ${address.toBase58()}`);
  }
  return {
    amount: account.data.readBigUInt64LE(ACCOUNT_AMOUNT_OFFSET),
  };
}
