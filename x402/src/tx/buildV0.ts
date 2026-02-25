import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { deriveBucketIdFromUnixMs, packAnchorBatchV1, packAnchorV1 } from "../packing/anchorV1.js";

export const DEFAULT_ANCHOR_PROGRAM_ID = new PublicKey("3hYWUSYmNCzrHNgsE6xo3jKT9GjCFxCpPWXj4Q4imToz");
export const DEFAULT_SHOP_ID = "dnp-core";

const U64_MAX = (1n << 64n) - 1n;

function toU64LeBytes(value: bigint): Buffer {
  const normalized = value & U64_MAX;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(normalized);
  return out;
}

export interface BuildAnchorInstructionParams {
  payer: PublicKey;
  bucketPda: PublicKey;
  anchor32: string;
  programId?: PublicKey;
  includeClockSysvar?: boolean;
  includeSystemProgram?: boolean;
  includeBucketId?: boolean;
  bucketId?: bigint;
  flags?: number;
}

export interface BuildAnchorTxParams extends Omit<BuildAnchorInstructionParams, "payer"> {
  payer: Keypair;
  recentBlockhash: string;
  lookupTables?: AddressLookupTableAccount[];
}

export interface BuildAnchorBatchTxParams {
  payer: Keypair;
  bucketPda: PublicKey;
  anchors: string[];
  recentBlockhash: string;
  programId?: PublicKey;
  includeClockSysvar?: boolean;
  includeSystemProgram?: boolean;
  lookupTables?: AddressLookupTableAccount[];
}

export function deriveBucketPda(params: {
  shopId?: string;
  bucketId?: bigint;
  nowMs?: number;
  programId?: PublicKey;
}): { bucketPda: PublicKey; bucketId: bigint; bump: number } {
  const programId = params.programId ?? DEFAULT_ANCHOR_PROGRAM_ID;
  const bucketId = params.bucketId
    ?? deriveBucketIdFromUnixMs(params.nowMs ?? Date.now());
  const seeds: Buffer[] = [
    Buffer.from("bucket", "utf8"),
    toU64LeBytes(bucketId),
  ];

  const [bucketPda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { bucketPda, bucketId, bump };
}

export function buildAnchorInstruction(params: BuildAnchorInstructionParams): TransactionInstruction {
  const includeClockSysvar = params.includeClockSysvar ?? true;
  const includeSystemProgram = params.includeSystemProgram ?? false;
  const includeBucketId = params.includeBucketId ?? false;

  const data = packAnchorV1({
    anchor32: params.anchor32,
    flags: params.flags,
    bucketId: includeBucketId ? (params.bucketId ?? deriveBucketIdFromUnixMs(Date.now())) : undefined,
  });

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.bucketPda, isSigner: false, isWritable: true },
  ];

  if (includeSystemProgram) {
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  }

  if (includeClockSysvar) {
    keys.push({ pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: params.programId ?? DEFAULT_ANCHOR_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });
}

export function buildAnchorBatchInstruction(params: {
  payer: PublicKey;
  bucketPda: PublicKey;
  anchors: string[];
  programId?: PublicKey;
  includeClockSysvar?: boolean;
  includeSystemProgram?: boolean;
}): TransactionInstruction {
  const includeClockSysvar = params.includeClockSysvar ?? true;
  const includeSystemProgram = params.includeSystemProgram ?? false;
  const data = packAnchorBatchV1(params.anchors);

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: params.bucketPda, isSigner: false, isWritable: true },
  ];

  if (includeSystemProgram) {
    keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  }

  if (includeClockSysvar) {
    keys.push({ pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: params.programId ?? DEFAULT_ANCHOR_PROGRAM_ID,
    keys,
    data: Buffer.from(data),
  });
}

export function buildLegacyAnchorTransaction(params: BuildAnchorTxParams): Transaction {
  const ix = buildAnchorInstruction({
    payer: params.payer.publicKey,
    bucketPda: params.bucketPda,
    anchor32: params.anchor32,
    programId: params.programId,
    includeClockSysvar: params.includeClockSysvar,
    includeSystemProgram: params.includeSystemProgram,
    includeBucketId: params.includeBucketId,
    bucketId: params.bucketId,
    flags: params.flags,
  });

  const tx = new Transaction({
    feePayer: params.payer.publicKey,
    recentBlockhash: params.recentBlockhash,
  }).add(ix);

  tx.sign(params.payer);
  return tx;
}

export function buildLegacyAnchorBatchTransaction(params: BuildAnchorBatchTxParams): Transaction {
  const ix = buildAnchorBatchInstruction({
    payer: params.payer.publicKey,
    bucketPda: params.bucketPda,
    anchors: params.anchors,
    programId: params.programId,
    includeClockSysvar: params.includeClockSysvar,
    includeSystemProgram: params.includeSystemProgram,
  });

  const tx = new Transaction({
    feePayer: params.payer.publicKey,
    recentBlockhash: params.recentBlockhash,
  }).add(ix);

  tx.sign(params.payer);
  return tx;
}

export function buildV0AnchorBatchTransaction(params: BuildAnchorBatchTxParams): VersionedTransaction {
  const ix = buildAnchorBatchInstruction({
    payer: params.payer.publicKey,
    bucketPda: params.bucketPda,
    anchors: params.anchors,
    programId: params.programId,
    includeClockSysvar: params.includeClockSysvar,
    includeSystemProgram: params.includeSystemProgram,
  });

  const messageV0 = new TransactionMessage({
    payerKey: params.payer.publicKey,
    recentBlockhash: params.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message(params.lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([params.payer]);
  return tx;
}

export function buildV0AnchorTransaction(params: BuildAnchorTxParams): VersionedTransaction {
  const ix = buildAnchorInstruction({
    payer: params.payer.publicKey,
    bucketPda: params.bucketPda,
    anchor32: params.anchor32,
    programId: params.programId,
    includeClockSysvar: params.includeClockSysvar,
    includeSystemProgram: params.includeSystemProgram,
    includeBucketId: params.includeBucketId,
    bucketId: params.bucketId,
    flags: params.flags,
  });

  const messageV0 = new TransactionMessage({
    payerKey: params.payer.publicKey,
    recentBlockhash: params.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message(params.lookupTables);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([params.payer]);
  return tx;
}

export function createSyntheticLookupTable(params: {
  authority: PublicKey;
  addresses: PublicKey[];
}): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: U64_MAX,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: params.authority,
      addresses: params.addresses,
    },
  });
}
