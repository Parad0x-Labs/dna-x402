import fs from "node:fs";
import { Buffer } from "node:buffer";
import {
  AddressLookupTableAccount,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { deriveBucketIdFromUnixMs } from "../packing/anchorV1.js";
import {
  buildV0AnchorBatchTransaction,
  buildV0AnchorTransaction,
  deriveBucketPda,
} from "../tx/buildV0.js";

export interface AnchorSendResult {
  signature: string;
  slot: number;
  confirmed: boolean;
  bucketPda: string;
  bucketId: string;
  anchorsCount: number;
}

export interface AnchorSimulationResult {
  ok: boolean;
  unitsConsumed: number;
  error?: string;
  logs: string[];
  bucketPda: string;
  bucketId: string;
  anchorsCount: number;
}

export interface AnchorBucketState {
  version: number;
  bump: number;
  bucketId: bigint;
  count: number;
  root: string;
  updatedAt: bigint;
}

export interface ReceiptAnchorClientConfig {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  protocolProgramId?: PublicKey;
  altAddress?: PublicKey;
  commitment?: Commitment;
  useAltByDefault?: boolean;
}

interface AnchorProgramMisconfiguredDetails {
  anchorProgramId: string;
  protocolProgramId: string;
}

export class AnchorProgramMisconfiguredError extends Error {
  readonly code = "ANCHOR_PROGRAM_MISCONFIGURED";
  readonly details: AnchorProgramMisconfiguredDetails;

  constructor(details: AnchorProgramMisconfiguredDetails) {
    super(
      `ANCHOR_PROGRAM_MISCONFIGURED: anchor program ${details.anchorProgramId} must not equal protocol program ${details.protocolProgramId}`,
    );
    this.name = "AnchorProgramMisconfiguredError";
    this.details = details;
  }
}

function assertAnchorProgramSeparation(params: {
  anchorProgramId: PublicKey;
  protocolProgramId?: PublicKey;
}): void {
  if (!params.protocolProgramId) {
    return;
  }
  if (params.anchorProgramId.equals(params.protocolProgramId)) {
    throw new AnchorProgramMisconfiguredError({
      anchorProgramId: params.anchorProgramId.toBase58(),
      protocolProgramId: params.protocolProgramId.toBase58(),
    });
  }
}

function parseError(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function decodeAnchorBucketState(data: Buffer): AnchorBucketState {
  if (data.length < 54) {
    throw new Error(`Anchor bucket account too small: ${data.length}`);
  }

  return {
    version: data[0],
    bump: data[1],
    bucketId: data.readBigUInt64LE(2),
    count: data.readUInt32LE(10),
    root: `0x${data.subarray(14, 46).toString("hex")}`,
    updatedAt: data.readBigInt64LE(46),
  };
}

function loadKeypairFromFile(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length < 64) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export class ReceiptAnchorClient {
  private readonly commitment: Commitment;
  private readonly useAltByDefault: boolean;
  private cachedAlt?: AddressLookupTableAccount;

  constructor(private readonly config: ReceiptAnchorClientConfig) {
    this.commitment = config.commitment ?? "confirmed";
    this.useAltByDefault = config.useAltByDefault ?? true;
  }

  static fromEnv(params: {
    rpcUrl: string;
    payerKeypairPath: string;
    programId: string;
    protocolProgramId?: string;
    altAddress?: string;
    commitment?: Commitment;
    useAltByDefault?: boolean;
  }): ReceiptAnchorClient {
    const payer = loadKeypairFromFile(params.payerKeypairPath);
    const connection = new Connection(params.rpcUrl, params.commitment ?? "confirmed");
    return new ReceiptAnchorClient({
      connection,
      payer,
      programId: new PublicKey(params.programId),
      protocolProgramId: params.protocolProgramId ? new PublicKey(params.protocolProgramId) : undefined,
      altAddress: params.altAddress ? new PublicKey(params.altAddress) : undefined,
      commitment: params.commitment,
      useAltByDefault: params.useAltByDefault,
    });
  }

  get payerPubkey(): PublicKey {
    return this.config.payer.publicKey;
  }

  get programId(): PublicKey {
    return this.config.programId;
  }

  get protocolProgramId(): PublicKey | undefined {
    return this.config.protocolProgramId;
  }

  assertProgramConfiguration(): void {
    assertAnchorProgramSeparation({
      anchorProgramId: this.config.programId,
      protocolProgramId: this.config.protocolProgramId,
    });
  }

  private async resolveLookupTables(useAlt: boolean): Promise<AddressLookupTableAccount[] | undefined> {
    if (!useAlt || !this.config.altAddress) {
      return undefined;
    }
    if (this.cachedAlt) {
      return [this.cachedAlt];
    }
    const alt = await this.config.connection.getAddressLookupTable(this.config.altAddress, {
      commitment: this.commitment,
    });
    if (!alt.value) {
      return undefined;
    }
    this.cachedAlt = alt.value;
    return [alt.value];
  }

  deriveBucket(nowMs = Date.now(), bucketId?: bigint): { bucketPda: PublicKey; bucketId: bigint } {
    const resolvedBucketId = bucketId ?? deriveBucketIdFromUnixMs(nowMs);
    const derived = deriveBucketPda({
      bucketId: resolvedBucketId,
      programId: this.config.programId,
    });
    return {
      bucketPda: derived.bucketPda,
      bucketId: derived.bucketId,
    };
  }

  private async latestBlockhash(): Promise<string> {
    const latest = await this.config.connection.getLatestBlockhash(this.commitment);
    return latest.blockhash;
  }

  private async simulateAndNormalize(tx: VersionedTransaction, meta: {
    bucketPda: PublicKey;
    bucketId: bigint;
    anchorsCount: number;
  }): Promise<AnchorSimulationResult> {
    const simulation = await this.config.connection.simulateTransaction(tx);
    return {
      ok: simulation.value.err === null,
      unitsConsumed: simulation.value.unitsConsumed ?? 0,
      error: parseError(simulation.value.err),
      logs: simulation.value.logs ?? [],
      bucketPda: meta.bucketPda.toBase58(),
      bucketId: meta.bucketId.toString(10),
      anchorsCount: meta.anchorsCount,
    };
  }

  async simulateSingle(params: {
    anchor32: string;
    nowMs?: number;
    bucketId?: bigint;
    useAlt?: boolean;
    includeClockSysvar?: boolean;
    includeSystemProgram?: boolean;
    includeBucketId?: boolean;
  }): Promise<AnchorSimulationResult> {
    this.assertProgramConfiguration();
    const nowMs = params.nowMs ?? Date.now();
    const resolvedBucketId = params.bucketId ?? deriveBucketIdFromUnixMs(nowMs);
    const { bucketPda, bucketId } = this.deriveBucket(nowMs, resolvedBucketId);
    const lookupTables = await this.resolveLookupTables(params.useAlt ?? this.useAltByDefault);
    const tx = buildV0AnchorTransaction({
      payer: this.config.payer,
      recentBlockhash: await this.latestBlockhash(),
      programId: this.config.programId,
      bucketPda,
      anchor32: params.anchor32,
      includeClockSysvar: params.includeClockSysvar ?? false,
      includeSystemProgram: params.includeSystemProgram ?? true,
      includeBucketId: params.includeBucketId ?? false,
      bucketId,
      lookupTables,
    });

    return this.simulateAndNormalize(tx, {
      bucketPda,
      bucketId,
      anchorsCount: 1,
    });
  }

  async simulateBatch(params: {
    anchors: string[];
    nowMs?: number;
    bucketId?: bigint;
    useAlt?: boolean;
    includeClockSysvar?: boolean;
    includeSystemProgram?: boolean;
  }): Promise<AnchorSimulationResult> {
    this.assertProgramConfiguration();
    const nowMs = params.nowMs ?? Date.now();
    const resolvedBucketId = params.bucketId ?? deriveBucketIdFromUnixMs(nowMs);
    const { bucketPda, bucketId } = this.deriveBucket(nowMs, resolvedBucketId);
    const lookupTables = await this.resolveLookupTables(params.useAlt ?? this.useAltByDefault);

    const tx = buildV0AnchorBatchTransaction({
      payer: this.config.payer,
      recentBlockhash: await this.latestBlockhash(),
      programId: this.config.programId,
      bucketPda,
      anchors: params.anchors,
      includeClockSysvar: params.includeClockSysvar ?? false,
      includeSystemProgram: params.includeSystemProgram ?? true,
      lookupTables,
    });

    return this.simulateAndNormalize(tx, {
      bucketPda,
      bucketId,
      anchorsCount: params.anchors.length,
    });
  }

  async sendBatch(params: {
    anchors: string[];
    nowMs?: number;
    bucketId?: bigint;
    useAlt?: boolean;
    includeClockSysvar?: boolean;
    includeSystemProgram?: boolean;
  }): Promise<AnchorSendResult> {
    this.assertProgramConfiguration();
    const nowMs = params.nowMs ?? Date.now();
    const resolvedBucketId = params.bucketId ?? deriveBucketIdFromUnixMs(nowMs);
    const { bucketPda, bucketId } = this.deriveBucket(nowMs, resolvedBucketId);
    const lookupTables = await this.resolveLookupTables(params.useAlt ?? this.useAltByDefault);

    const latest = await this.config.connection.getLatestBlockhash(this.commitment);

    const tx = buildV0AnchorBatchTransaction({
      payer: this.config.payer,
      recentBlockhash: latest.blockhash,
      programId: this.config.programId,
      bucketPda,
      anchors: params.anchors,
      includeClockSysvar: params.includeClockSysvar ?? false,
      includeSystemProgram: params.includeSystemProgram ?? true,
      lookupTables,
    });

    const signature = await this.config.connection.sendTransaction(tx, {
      maxRetries: 3,
      skipPreflight: false,
      preflightCommitment: this.commitment,
    });

    const confirmation = await this.config.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      this.commitment,
    );

    return {
      signature,
      slot: confirmation.context.slot,
      confirmed: confirmation.value.err === null,
      bucketPda: bucketPda.toBase58(),
      bucketId: bucketId.toString(10),
      anchorsCount: params.anchors.length,
    };
  }

  async sendSingle(params: {
    anchor32: string;
    nowMs?: number;
    bucketId?: bigint;
    useAlt?: boolean;
    includeClockSysvar?: boolean;
    includeSystemProgram?: boolean;
    includeBucketId?: boolean;
  }): Promise<AnchorSendResult> {
    this.assertProgramConfiguration();
    const nowMs = params.nowMs ?? Date.now();
    const resolvedBucketId = params.bucketId ?? deriveBucketIdFromUnixMs(nowMs);
    const { bucketPda, bucketId } = this.deriveBucket(nowMs, resolvedBucketId);
    const lookupTables = await this.resolveLookupTables(params.useAlt ?? this.useAltByDefault);

    const latest = await this.config.connection.getLatestBlockhash(this.commitment);
    const tx = buildV0AnchorTransaction({
      payer: this.config.payer,
      recentBlockhash: latest.blockhash,
      programId: this.config.programId,
      bucketPda,
      anchor32: params.anchor32,
      includeClockSysvar: params.includeClockSysvar ?? false,
      includeSystemProgram: params.includeSystemProgram ?? true,
      includeBucketId: params.includeBucketId ?? false,
      bucketId,
      lookupTables,
    });

    const signature = await this.config.connection.sendTransaction(tx, {
      maxRetries: 3,
      skipPreflight: false,
      preflightCommitment: this.commitment,
    });

    const confirmation = await this.config.connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      this.commitment,
    );

    return {
      signature,
      slot: confirmation.context.slot,
      confirmed: confirmation.value.err === null,
      bucketPda: bucketPda.toBase58(),
      bucketId: bucketId.toString(10),
      anchorsCount: 1,
    };
  }

  async fetchBucketState(bucketPda: PublicKey): Promise<AnchorBucketState | null> {
    const account = await this.config.connection.getAccountInfo(bucketPda, this.commitment);
    if (!account) {
      return null;
    }
    return decodeAnchorBucketState(account.data);
  }
}
