import crypto from "node:crypto";
import { parseAtomic } from "../feePolicy.js";
import { QuoteBook } from "./quotes.js";
import { MarketOrder, MarketOrderInput } from "./types.js";

export class MarketOrders {
  private readonly byId = new Map<string, MarketOrder>();

  constructor(
    private readonly quoteBook: QuoteBook,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: MarketOrderInput): MarketOrder {
    const order: MarketOrder = {
      ...input,
      orderId: crypto.randomUUID(),
      status: "pending",
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    this.byId.set(order.orderId, order);
    return order;
  }

  get(orderId: string): MarketOrder | undefined {
    return this.byId.get(orderId);
  }

  list(): MarketOrder[] {
    return Array.from(this.byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  cancel(orderId: string): MarketOrder | undefined {
    const order = this.byId.get(orderId);
    if (!order) {
      return undefined;
    }

    if (order.status === "pending") {
      order.status = "cancelled";
      order.updatedAt = this.now().toISOString();
      this.byId.set(orderId, order);
    }
    return order;
  }

  poll(): MarketOrder[] {
    const now = this.now();
    const executed: MarketOrder[] = [];

    for (const order of this.byId.values()) {
      if (order.status !== "pending") {
        continue;
      }

      if (new Date(order.expiresAt).getTime() <= now.getTime()) {
        order.status = "expired";
        order.updatedAt = now.toISOString();
        this.byId.set(order.orderId, order);
        continue;
      }

      const quote = this.quoteBook.list({
        capability: order.capability,
        maxPriceAtomic: order.maxPrice,
        maxLatencyMs: order.maxLatencyMs,
        limit: 5,
      }).find((candidate) => {
        if (!order.preferSettlement) {
          return true;
        }
        return candidate.settlementModes.includes(order.preferSettlement);
      });

      if (!quote) {
        continue;
      }

      if (parseAtomic(quote.price) > parseAtomic(order.maxPrice)) {
        continue;
      }

      order.status = "executed";
      order.chosenQuote = quote;
      order.updatedAt = now.toISOString();
      this.byId.set(order.orderId, order);
      executed.push(order);
    }

    return executed;
  }
}
