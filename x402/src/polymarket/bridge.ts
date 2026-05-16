import type { DepositStatus } from "./types.js";

export interface BridgeSupportedAsset {
  chainId?: string;
  chain?: string;
  addressType?: "evm" | "svm" | "btc" | "tvm" | string;
  tokenSymbol?: string;
  symbol?: string;
  tokenAddress?: string;
  minCheckoutUsd?: number;
  [key: string]: unknown;
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export interface DepositIntent {
  id: string;
  userId: string;
  agentId: string;
  depositWallet: string;
  selectedChain: string;
  selectedToken: string;
  amountUsd: number;
  idempotencyKey: string;
  status: DepositStatus;
  depositAddress?: string;
  bridgePayloadHash?: string;
  originTxHash?: string;
  createdAt: string;
  updatedAt: string;
}

export class PolymarketBridgeClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly bridgeBaseUrl = "https://bridge.polymarket.com",
  ) {}

  async supportedAssets(): Promise<BridgeSupportedAsset[]> {
    const response = await this.fetchImpl(`${this.bridgeBaseUrl}/supported-assets`);
    if (!response.ok) {
      throw new Error(`Polymarket bridge supported-assets failed: HTTP ${response.status}`);
    }
    return normalizeSupportedAssetsResponse(await response.json());
  }
}

export function normalizeSupportedAssetsResponse(payload: unknown): BridgeSupportedAsset[] {
  if (Array.isArray(payload)) {
    return payload as BridgeSupportedAsset[];
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["assets", "supportedAssets", "tokens", "data"]) {
      if (Array.isArray(record[key])) {
        return record[key] as BridgeSupportedAsset[];
      }
    }
  }
  return [];
}

function assetSymbol(asset: BridgeSupportedAsset): string {
  return String(asset.tokenSymbol ?? asset.symbol ?? "").toUpperCase();
}

function isSolanaAsset(asset: BridgeSupportedAsset): boolean {
  const chain = String(asset.chain ?? asset.chainId ?? "").toLowerCase();
  const addressType = String(asset.addressType ?? "").toLowerCase();
  return addressType === "svm" || chain === "solana" || chain === "svm";
}

export function sortDepositAssetsForUx(assets: BridgeSupportedAsset[]): BridgeSupportedAsset[] {
  return [...assets].sort((a, b) => {
    const aScore = isSolanaAsset(a) && assetSymbol(a) === "USDC" ? 0 : isSolanaAsset(a) ? 1 : 2;
    const bScore = isSolanaAsset(b) && assetSymbol(b) === "USDC" ? 0 : isSolanaAsset(b) ? 1 : 2;
    return aScore - bScore || assetSymbol(a).localeCompare(assetSymbol(b));
  });
}

export function validateDepositSelection(input: {
  assets: BridgeSupportedAsset[];
  selectedChain: string;
  selectedToken: string;
  amountUsd: number;
}): DepositStatus {
  const selected = input.assets.find((asset) => {
    const sameToken = assetSymbol(asset) === input.selectedToken.toUpperCase();
    const sameChain = String(asset.chain ?? asset.chainId ?? asset.addressType ?? "").toLowerCase() === input.selectedChain.toLowerCase();
    return sameToken && sameChain;
  });

  if (!selected) {
    return "WRONG_CHAIN_OR_UNSUPPORTED";
  }
  const min = typeof selected.minCheckoutUsd === "number" ? selected.minCheckoutUsd : 0;
  if (input.amountUsd < min) {
    return "BELOW_MINIMUM";
  }
  return "ASSET_SELECTED";
}

export function mapBridgeDepositStatus(status: string | undefined): DepositStatus {
  switch ((status ?? "").toUpperCase()) {
    case "DEPOSIT_DETECTED":
      return "TX_DETECTED";
    case "PROCESSING":
    case "ORIGIN_TX_CONFIRMED":
    case "SUBMITTED":
      return "BRIDGE_PENDING";
    case "COMPLETED":
      return "PUSD_CREDITED";
    case "FAILED":
      return "FAILED";
    default:
      return "ADDRESS_CREATED";
  }
}

export class DepositIntentStore {
  private readonly intents = new Map<string, DepositIntent>();
  private readonly idempotency = new Map<string, string>();

  selectAsset(input: {
    id: string;
    userId: string;
    agentId: string;
    depositWallet: string;
    selectedChain: string;
    selectedToken: string;
    amountUsd: number;
    idempotencyKey: string;
    assets: BridgeSupportedAsset[];
    now?: Date;
  }): DepositIntent {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      return this.requireIntent(existingId);
    }
    const now = input.now ?? new Date();
    const intent: DepositIntent = {
      id: input.id,
      userId: input.userId,
      agentId: input.agentId,
      depositWallet: input.depositWallet,
      selectedChain: input.selectedChain,
      selectedToken: input.selectedToken,
      amountUsd: input.amountUsd,
      idempotencyKey: input.idempotencyKey,
      status: validateDepositSelection({
        assets: input.assets,
        selectedChain: input.selectedChain,
        selectedToken: input.selectedToken,
        amountUsd: input.amountUsd,
      }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.intents.set(intent.id, intent);
    this.idempotency.set(input.idempotencyKey, intent.id);
    return intent;
  }

  createDepositAddress(input: {
    id: string;
    depositAddress: string;
    bridgePayloadHash: string;
    idempotencyKey: string;
    now?: Date;
  }): DepositIntent {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      return this.requireIntent(existingId);
    }
    const intent = this.requireIntent(input.id);
    if (intent.status !== "ASSET_SELECTED") {
      throw new Error(`Deposit address requires valid asset selection, got ${intent.status}.`);
    }
    if (intent.depositAddress) {
      throw new Error("Deposit address already exists for this intent.");
    }
    const now = input.now ?? new Date();
    const updated: DepositIntent = {
      ...intent,
      depositAddress: input.depositAddress,
      bridgePayloadHash: input.bridgePayloadHash,
      status: "ADDRESS_CREATED",
      updatedAt: now.toISOString(),
    };
    this.intents.set(input.id, updated);
    this.idempotency.set(input.idempotencyKey, input.id);
    return updated;
  }

  applyBridgeStatus(id: string, bridgeStatus: string, originTxHash?: string, now = new Date()): DepositIntent {
    const intent = this.requireIntent(id);
    const status = mapBridgeDepositStatus(bridgeStatus);
    const updated: DepositIntent = {
      ...intent,
      originTxHash: originTxHash ?? intent.originTxHash,
      status,
      updatedAt: now.toISOString(),
    };
    this.intents.set(id, updated);
    return updated;
  }

  markReconciled(id: string, now = new Date()): DepositIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "PUSD_CREDITED") {
      throw new Error(`Deposit can only be reconciled after pUSD credit, got ${intent.status}.`);
    }
    const updated = { ...intent, status: "RECONCILED" as const, updatedAt: now.toISOString() };
    this.intents.set(id, updated);
    return updated;
  }

  get(id: string): DepositIntent | undefined {
    return this.intents.get(id);
  }

  private requireIntent(id: string): DepositIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new Error(`Deposit intent not found: ${id}`);
    }
    return intent;
  }
}
