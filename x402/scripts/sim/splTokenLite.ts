import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const MINT_ACCOUNT_SIZE = 82;
const ACCOUNT_AMOUNT_OFFSET = 64;
const INITIALIZE_MINT_INSTRUCTION = 0;
const TRANSFER_INSTRUCTION = 3;
const MINT_TO_INSTRUCTION = 7;
const TRANSFER_CHECKED_INSTRUCTION = 12;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeU64Le(data: Buffer, offset: number, value: bigint): void {
  let cursor = value;
  for (let i = 0; i < 8; i += 1) {
    data[offset + i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
}

function createInitializeMintInstruction(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
): TransactionInstruction {
  const data = Buffer.alloc(67);
  data[0] = INITIALIZE_MINT_INSTRUCTION;
  data[1] = decimals;
  mintAuthority.toBuffer().copy(data, 2);
  if (freezeAuthority) {
    data.writeUInt32LE(1, 34);
    freezeAuthority.toBuffer().copy(data, 38);
  }
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function waitForTokenProgramAccount(params: {
  connection: Connection;
  address: PublicKey;
  minDataLength: number;
  commitment: Commitment;
  label: string;
}): Promise<void> {
  let waitMs = 250;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const account = await params.connection.getAccountInfo(params.address, params.commitment);
    if (account?.owner.equals(TOKEN_PROGRAM_ID) && account.data.length >= params.minDataLength) {
      return;
    }
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 2_000);
  }
  throw new Error(`${params.label} not visible as initialized token account: ${params.address.toBase58()}`);
}

export function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

export function createAssociatedTokenAccountInstruction(
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
    data: Buffer.alloc(0),
  });
}

export function createTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint | number,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = TRANSFER_INSTRUCTION;
  writeU64Le(data, 1, BigInt(amount));
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

export function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint | number,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = TRANSFER_CHECKED_INSTRUCTION;
  writeU64Le(data, 1, BigInt(amount));
  data[9] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function createMintToInstruction(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint | number): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = MINT_TO_INSTRUCTION;
  writeU64Le(data, 1, BigInt(amount));
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export async function createMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  commitment: Commitment = "confirmed",
): Promise<PublicKey> {
  const mint = Keypair.generate();
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_ACCOUNT_SIZE, commitment);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MINT_ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, decimals, mintAuthority, freezeAuthority),
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mint], {
    commitment,
    preflightCommitment: commitment,
  });
  await waitForTokenProgramAccount({
    connection,
    address: mint.publicKey,
    minDataLength: MINT_ACCOUNT_SIZE,
    commitment,
    label: "mint",
  });
  return mint.publicKey;
}

export async function getOrCreateAssociatedTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<{ address: PublicKey }> {
  const address = getAssociatedTokenAddress(mint, owner);
  const existing = await connection.getAccountInfo(address, commitment);
  if (existing) {
    if (!existing.owner.equals(TOKEN_PROGRAM_ID) || existing.data.length < ACCOUNT_AMOUNT_OFFSET + 8) {
      throw new Error(`associated token address exists but is not an initialized token account: ${address.toBase58()}`);
    }
    return { address };
  }
  const tx = new Transaction().add(createAssociatedTokenAccountInstruction(payer.publicKey, address, owner, mint));
  await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment,
    preflightCommitment: commitment,
  });
  await waitForTokenProgramAccount({
    connection,
    address,
    minDataLength: ACCOUNT_AMOUNT_OFFSET + 8,
    commitment,
    label: "associated token account",
  });
  return { address };
}

export async function mintTo(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: bigint | number,
  commitment: Commitment = "confirmed",
): Promise<string> {
  const tx = new Transaction().add(createMintToInstruction(mint, destination, authority.publicKey, amount));
  return sendAndConfirmTransaction(connection, tx, [payer, authority], {
    commitment,
    preflightCommitment: commitment,
  });
}

export async function getAccount(connection: Connection, address: PublicKey, commitment: Commitment = "confirmed"): Promise<{ amount: bigint }> {
  const account = await connection.getAccountInfo(address, commitment);
  if (!account) {
    throw new Error(`token account not found: ${address.toBase58()}`);
  }
  if (!account.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new Error(`account is not owned by SPL Token program: ${address.toBase58()}`);
  }
  if (account.data.length < ACCOUNT_AMOUNT_OFFSET + 8) {
    throw new Error(`token account too small: ${address.toBase58()}`);
  }
  return {
    amount: account.data.readBigUInt64LE(ACCOUNT_AMOUNT_OFFSET),
  };
}
