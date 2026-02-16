import crypto from "node:crypto";
import { QuoteEngine, RankedQuote } from "./quotes.js";

export type LimitOrderStatus = "pending" | "executed" | "expired" | "cancelled";

export interface LimitOrder {
  orderId: string;
  capability: string;
  maxPriceAtomic: string;
  expiresAt: string;
  callbackUrl?: string;
  status: LimitOrderStatus;
  createdAt: string;
  updatedAt: string;
  selectedQuote?: RankedQuote;
}

export interface PlaceOrderInput {
  capability: string;
  maxPriceAtomic: string;
  expiresAt: string;
  callbackUrl?: string;
}

export class LimitOrderBook {
  private readonly orders = new Map<string, LimitOrder>();

  constructor(
    private readonly quotes: QuoteEngine,
    private readonly now: () => Date = () => new Date(),
  ) {}

  placeOrder(input: PlaceOrderInput): LimitOrder {
    const order: LimitOrder = {
      orderId: crypto.randomUUID(),
      capability: input.capability,
      maxPriceAtomic: input.maxPriceAtomic,
      expiresAt: input.expiresAt,
      callbackUrl: input.callbackUrl,
      status: "pending",
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  list(): LimitOrder[] {
    return Array.from(this.orders.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(orderId: string): LimitOrder | undefined {
    return this.orders.get(orderId);
  }

  cancel(orderId: string): LimitOrder | undefined {
    const order = this.orders.get(orderId);
    if (!order) {
      return undefined;
    }
    if (order.status === "pending") {
      order.status = "cancelled";
      order.updatedAt = this.now().toISOString();
      this.orders.set(orderId, order);
    }
    return order;
  }

  poll(): LimitOrder[] {
    const executed: LimitOrder[] = [];
    const now = this.now();

    for (const order of this.orders.values()) {
      if (order.status !== "pending") {
        continue;
      }

      if (new Date(order.expiresAt).getTime() <= now.getTime()) {
        order.status = "expired";
        order.updatedAt = now.toISOString();
        this.orders.set(order.orderId, order);
        continue;
      }

      const quote = this.quotes.getQuotes({
        capability: order.capability,
        maxPriceAtomic: order.maxPriceAtomic,
        limit: 1,
      })[0];

      if (!quote) {
        continue;
      }

      order.status = "executed";
      order.selectedQuote = quote;
      order.updatedAt = now.toISOString();
      this.orders.set(order.orderId, order);
      executed.push(order);
    }

    return executed;
  }
}
