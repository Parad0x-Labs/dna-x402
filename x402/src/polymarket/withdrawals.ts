import crypto from "node:crypto";
import type { WithdrawalIntent, WithdrawalStatus } from "./types.js";

export interface CreateWithdrawalQuoteInput {
  id: string;
  userId: string;
  agentId: string;
  depositWallet: string;
  sourceAmountPusd: string;
  destinationChain: string;
  destinationToken: string;
  recipientAddress: string;
  quoteId: string;
  quotePayload: unknown;
  quoteExpiresAt: string;
  minReceived: string;
  estimatedReceived: string;
  fees: Record<string, unknown>;
  slippage: Record<string, unknown>;
  now?: Date;
}

export interface WithdrawalRouteInput {
  sourceAmountPusd: string;
  destinationChain: string;
  destinationToken: string;
  recipientAddress: string;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashQuotePayload(payload: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function createQuotedWithdrawalIntent(input: CreateWithdrawalQuoteInput): WithdrawalIntent {
  const now = input.now ?? new Date();
  return {
    id: input.id,
    userId: input.userId,
    agentId: input.agentId,
    depositWallet: input.depositWallet,
    sourceAmountPusd: input.sourceAmountPusd,
    destinationChain: input.destinationChain,
    destinationToken: input.destinationToken,
    recipientAddress: input.recipientAddress,
    quoteId: input.quoteId,
    quotePayloadHash: hashQuotePayload(input.quotePayload),
    quoteExpiresAt: input.quoteExpiresAt,
    minReceived: input.minReceived,
    estimatedReceived: input.estimatedReceived,
    fees: input.fees,
    slippage: input.slippage,
    status: "QUOTED",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function assertIntentExecutable(intent: WithdrawalIntent, now = new Date()): void {
  if (intent.status !== "QUOTED" && intent.status !== "USER_CONFIRMED") {
    throw new Error(`Withdrawal intent is not executable from status ${intent.status}.`);
  }
  if (new Date(intent.quoteExpiresAt).getTime() <= now.getTime()) {
    throw new Error("Withdrawal quote expired; create a new quote intent.");
  }
}

export function assertWithdrawalRouteUnchanged(intent: WithdrawalIntent, next: WithdrawalRouteInput): void {
  const changes: string[] = [];
  if (intent.sourceAmountPusd !== next.sourceAmountPusd) changes.push("sourceAmountPusd");
  if (intent.destinationChain !== next.destinationChain) changes.push("destinationChain");
  if (intent.destinationToken !== next.destinationToken) changes.push("destinationToken");
  if (intent.recipientAddress !== next.recipientAddress) changes.push("recipientAddress");
  if (changes.length > 0) {
    throw new Error(`Withdrawal intent invalidated by route change: ${changes.join(", ")}`);
  }
}

export function invalidateIntentForRouteChange(intent: WithdrawalIntent, next: WithdrawalRouteInput, now = new Date()): WithdrawalIntent {
  try {
    assertWithdrawalRouteUnchanged(intent, next);
    return intent;
  } catch {
    return { ...intent, status: "QUOTE_EXPIRED", updatedAt: now.toISOString() };
  }
}

export function confirmWithdrawalIntent(intent: WithdrawalIntent, now = new Date()): WithdrawalIntent {
  assertIntentExecutable(intent, now);
  if (intent.withdrawalAddress) {
    throw new Error("Withdrawal address already exists; withdrawal addresses must not be reused.");
  }
  return { ...intent, status: "USER_CONFIRMED", updatedAt: now.toISOString() };
}

export function expireQuoteIfNeeded(intent: WithdrawalIntent, now = new Date()): WithdrawalIntent {
  if (new Date(intent.quoteExpiresAt).getTime() <= now.getTime()) {
    return { ...intent, status: "QUOTE_EXPIRED", updatedAt: now.toISOString() };
  }
  return intent;
}

export function expireAwaitingUserTransfer(input: WithdrawalIntent, options: {
  now?: Date;
  ttlMs: number;
}): WithdrawalIntent {
  if (input.status !== "AWAITING_USER_TRANSFER") {
    return input;
  }
  const now = options.now ?? new Date();
  const updatedAt = new Date(input.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt <= options.ttlMs) {
    return input;
  }
  return { ...input, status: "SUPPORT_NEEDED", updatedAt: now.toISOString() };
}

export class WithdrawalIntentStore {
  private readonly intents = new Map<string, WithdrawalIntent>();
  private readonly usedWithdrawalAddresses = new Set<string>();

  save(intent: WithdrawalIntent): WithdrawalIntent {
    this.intents.set(intent.id, intent);
    return intent;
  }

  get(id: string): WithdrawalIntent | undefined {
    return this.intents.get(id);
  }

  createQuote(input: CreateWithdrawalQuoteInput): WithdrawalIntent {
    const intent = createQuotedWithdrawalIntent(input);
    this.save(intent);
    return intent;
  }

  confirm(id: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    const confirmed = confirmWithdrawalIntent(intent, now);
    return this.save(confirmed);
  }

  expireQuoteIfNeeded(id: string, now = new Date()): WithdrawalIntent {
    return this.save(expireQuoteIfNeeded(this.requireIntent(id), now));
  }

  createWithdrawalAddress(id: string, withdrawalAddress: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "USER_CONFIRMED") {
      throw new Error("Withdrawal address can only be created after final user confirmation.");
    }
    if (intent.withdrawalAddress) {
      throw new Error("Withdrawal address already exists for this intent.");
    }
    if (this.usedWithdrawalAddresses.has(withdrawalAddress)) {
      throw new Error("Withdrawal address reuse is forbidden.");
    }
    this.usedWithdrawalAddresses.add(withdrawalAddress);
    return this.save({
      ...intent,
      withdrawalAddress,
      status: "WITHDRAW_ADDRESS_CREATED",
      updatedAt: now.toISOString(),
    });
  }

  markAwaitingUserTransfer(id: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "WITHDRAW_ADDRESS_CREATED") {
      throw new Error(`Cannot await user transfer from status ${intent.status}.`);
    }
    return this.save({ ...intent, status: "AWAITING_USER_TRANSFER", updatedAt: now.toISOString() });
  }

  expireAwaitingUserTransfer(id: string, options: { now?: Date; ttlMs: number }): WithdrawalIntent {
    return this.save(expireAwaitingUserTransfer(this.requireIntent(id), options));
  }

  markTransferSigned(id: string, txHash: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "AWAITING_USER_TRANSFER") {
      throw new Error(`Cannot mark pUSD transfer signed from status ${intent.status}.`);
    }
    return this.save({
      ...intent,
      pUsdTransferTxHash: txHash,
      status: "PUSD_TRANSFER_SIGNED",
      updatedAt: now.toISOString(),
    });
  }

  markTransferConfirmed(id: string, txHash: string, bridgeDelivered: boolean, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    return this.save({
      ...intent,
      pUsdTransferTxHash: txHash,
      status: bridgeDelivered ? "DESTINATION_RECEIVED" : "PUSD_TRANSFER_CONFIRMED",
      updatedAt: now.toISOString(),
    });
  }

  markBridgePending(id: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "PUSD_TRANSFER_CONFIRMED") {
      throw new Error(`Cannot mark bridge pending from status ${intent.status}.`);
    }
    return this.save({ ...intent, status: "BRIDGE_PENDING", updatedAt: now.toISOString() });
  }

  markDestinationReceived(id: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "BRIDGE_PENDING" && intent.status !== "PUSD_TRANSFER_CONFIRMED") {
      throw new Error(`Cannot mark destination received from status ${intent.status}.`);
    }
    return this.save({ ...intent, status: "DESTINATION_RECEIVED", updatedAt: now.toISOString() });
  }

  markReconciled(id: string, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    if (intent.status !== "DESTINATION_RECEIVED") {
      throw new Error(`Cannot reconcile withdrawal from status ${intent.status}.`);
    }
    return this.save({ ...intent, status: "RECONCILED", updatedAt: now.toISOString() });
  }

  markRecoverableFailure(id: string, status: Extract<WithdrawalStatus, "QUOTE_EXPIRED" | "ROUTE_UNAVAILABLE" | "LIQUIDITY_EXHAUSTED" | "SUPPORT_NEEDED">, now = new Date()): WithdrawalIntent {
    const intent = this.requireIntent(id);
    return this.save({ ...intent, status, updatedAt: now.toISOString() });
  }

  private requireIntent(id: string): WithdrawalIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new Error(`Withdrawal intent not found: ${id}`);
    }
    return intent;
  }
}
