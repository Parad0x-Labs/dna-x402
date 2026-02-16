import BN from "bn.js";
import {
  ICluster,
  type ICreateResult,
  type ICreateStreamData,
  type ICreateStreamExt,
  type IGetOneData,
  type ITopUpData,
  type ITopUpStreamExt,
  type ITransactionResult,
  SolanaStreamClient,
  type Stream,
} from "@streamflow/stream";

export interface CreateStreamParams {
  sender: ICreateStreamExt["sender"];
  recipient: string;
  mint: string;
  amountAtomic: string;
  startUnix?: number;
  durationSeconds?: number;
  periodSeconds?: number;
  name?: string;
}

export interface TopupStreamParams {
  invoker: ITopUpStreamExt["invoker"];
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
  create(data: ICreateStreamData, extParams: ICreateStreamExt): Promise<ICreateResult>;
  topup(data: ITopUpData, extParams: ITopUpStreamExt): Promise<ITransactionResult>;
  getOne(data: IGetOneData): Promise<Stream>;
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid atomic amount: ${value}`);
  }
  return BigInt(value);
}

export class StreamingService {
  private readonly client: StreamClientLike;

  constructor(params: { clusterUrl: string; cluster?: ICluster; client?: StreamClientLike }) {
    if (params.client) {
      this.client = params.client;
      return;
    }
    this.client = new SolanaStreamClient(params.clusterUrl, params.cluster ?? ICluster.Devnet);
  }

  async createStream(params: CreateStreamParams): Promise<{ streamId: string; txId: string }> {
    const totalAmount = parseAtomic(params.amountAtomic);
    const start = params.startUnix ?? Math.floor(Date.now() / 1000) + 10;
    const duration = Math.max(1, params.durationSeconds ?? 60);
    const period = Math.max(1, params.periodSeconds ?? 1);
    const periods = Math.max(1, Math.floor(duration / period));

    const amountPerPeriod = totalAmount / BigInt(periods);
    const cliffAmount = totalAmount % BigInt(periods);

    const data: ICreateStreamData = {
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
