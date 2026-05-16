import { createRequire } from "node:module";
import BN from "bn.js";

const require = createRequire(import.meta.url);

export type StreamCluster = unknown;

interface CreateStreamData {
  recipient: string;
  tokenId: string;
  amount: BN;
  start: number;
  period: number;
  cliff: number;
  cliffAmount: BN;
  amountPerPeriod: BN;
  name: string;
  canTopup: boolean;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  automaticWithdrawal: boolean;
  withdrawalFrequency: number;
}

interface CreateStreamExt {
  sender: unknown;
  isNative: boolean;
}

interface CreateStreamResult {
  metadataId: string;
  txId: string;
}

interface TopupStreamData {
  id: string;
  amount: BN;
}

interface TopupStreamExt {
  invoker: unknown;
  isNative: boolean;
}

interface TransactionResult {
  txId: string;
}

interface GetOneData {
  id: string;
}

interface StreamRecord {
  sender: string;
  recipient: string;
  mint: string;
  depositedAmount: { toString(radix?: number): string };
  withdrawnAmount: { toString(radix?: number): string };
  canTopup: boolean;
  closed: boolean;
}

interface StreamflowModule {
  ICluster?: {
    Devnet?: StreamCluster;
  };
  SolanaStreamClient: new (clusterUrl: string, cluster?: StreamCluster) => StreamClientLike;
}

export interface CreateStreamParams {
  sender: unknown;
  recipient: string;
  mint: string;
  amountAtomic: string;
  startUnix?: number;
  durationSeconds?: number;
  periodSeconds?: number;
  name?: string;
}

export interface TopupStreamParams {
  invoker: unknown;
  streamId: string;
  amountAtomic: string;
}

export interface StreamState {
  id: string;
  sender: string;
  recipient: string;
  mint: string;
  depositedAmountAtomic: string;
  withdrawnAmountAtomic: string;
  canTopup: boolean;
  closed: boolean;
}

export interface StreamClientLike {
  create(data: CreateStreamData, extParams: CreateStreamExt): Promise<CreateStreamResult>;
  topup(data: TopupStreamData, extParams: TopupStreamExt): Promise<TransactionResult>;
  getOne(data: GetOneData): Promise<StreamRecord>;
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid atomic amount: ${value}`);
  }
  return BigInt(value);
}

function loadStreamflowModule(): StreamflowModule {
  try {
    return require("@streamflow/stream") as StreamflowModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`@streamflow/stream is optional. Install it or pass a StreamClientLike client. Cause: ${message}`);
  }
}

export class StreamingService {
  private readonly client: StreamClientLike;

  constructor(params: { clusterUrl: string; cluster?: StreamCluster; client?: StreamClientLike }) {
    if (params.client) {
      this.client = params.client;
      return;
    }
    const streamflow = loadStreamflowModule();
    this.client = new streamflow.SolanaStreamClient(params.clusterUrl, params.cluster ?? streamflow.ICluster?.Devnet);
  }

  async createStream(params: CreateStreamParams): Promise<{ streamId: string; txId: string }> {
    const totalAmount = parseAtomic(params.amountAtomic);
    const start = params.startUnix ?? Math.floor(Date.now() / 1000) + 10;
    const duration = Math.max(1, params.durationSeconds ?? 60);
    const period = Math.max(1, params.periodSeconds ?? 1);
    const periods = Math.max(1, Math.floor(duration / period));

    const amountPerPeriod = totalAmount / BigInt(periods);
    const cliffAmount = totalAmount % BigInt(periods);

    const data: CreateStreamData = {
      recipient: params.recipient,
      tokenId: params.mint,
      amount: new BN(totalAmount.toString()),
      start,
      period,
      cliff: start,
      cliffAmount: new BN(cliffAmount.toString()),
      amountPerPeriod: new BN(amountPerPeriod.toString()),
      name: params.name ?? "x402-stream",
      canTopup: true,
      cancelableBySender: true,
      cancelableByRecipient: false,
      transferableBySender: true,
      transferableByRecipient: false,
      automaticWithdrawal: false,
      withdrawalFrequency: 0,
    };

    const result = await this.client.create(data, {
      sender: params.sender,
      isNative: false,
    });

    return {
      streamId: result.metadataId,
      txId: result.txId,
    };
  }

  async topupStream(params: TopupStreamParams): Promise<{ txId: string }> {
    const amount = parseAtomic(params.amountAtomic);
    const result = await this.client.topup(
      {
        id: params.streamId,
        amount: new BN(amount.toString()),
      },
      {
        invoker: params.invoker,
        isNative: false,
      },
    );

    return { txId: result.txId };
  }

  async getStream(streamId: string): Promise<StreamState> {
    const stream = await this.client.getOne({ id: streamId });
    return {
      id: streamId,
      sender: stream.sender,
      recipient: stream.recipient,
      mint: stream.mint,
      depositedAmountAtomic: stream.depositedAmount.toString(10),
      withdrawnAmountAtomic: stream.withdrawnAmount.toString(10),
      canTopup: stream.canTopup,
      closed: stream.closed,
    };
  }
}
