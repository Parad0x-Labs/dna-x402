import { Connection } from "@solana/web3.js";

type SignatureStatusResponse = Awaited<ReturnType<Connection["getSignatureStatus"]>>;
type ParsedTransactionResponse = Awaited<ReturnType<Connection["getParsedTransaction"]>>;
type BlockTimeResponse = Awaited<ReturnType<Connection["getBlockTime"]>>;
type SignatureStatusOptions = Parameters<Connection["getSignatureStatus"]>[1];
type ParsedTransactionOptions = Parameters<Connection["getParsedTransaction"]>[1];

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

export interface CachedRpcClientOptions {
  statusTtlMs?: number;
  parsedTxTtlMs?: number;
  blockTimeTtlMs?: number;
  maxCacheEntries?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  circuitBreakerFailures?: number;
  circuitBreakerCooldownMs?: number;
}

export function extractRpcErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isRetryableRpcError(error: unknown): boolean {
  const text = extractRpcErrorMessage(error).toLowerCase();
  return text.includes("429")
    || text.includes("too many requests")
    || text.includes("timed out")
    || text.includes("timeout")
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("socket hang up")
    || text.includes("fetch failed")
    || text.includes("503");
}

export class CachedRpcClient {
  private readonly statusTtlMs: number;
  private readonly parsedTxTtlMs: number;
  private readonly blockTimeTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly circuitBreakerFailures: number;
  private readonly circuitBreakerCooldownMs: number;

  private readonly statusCache = new Map<string, CacheEntry<SignatureStatusResponse>>();
  private readonly parsedTxCache = new Map<string, CacheEntry<ParsedTransactionResponse>>();
  private readonly blockTimeCache = new Map<string, CacheEntry<BlockTimeResponse>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private consecutiveRetryableFailures = 0;
  private circuitOpenUntilMs = 0;

  constructor(
    private readonly connection: Pick<Connection, "getSignatureStatus" | "getParsedTransaction" | "getBlockTime">,
    options: CachedRpcClientOptions = {},
  ) {
    this.statusTtlMs = options.statusTtlMs ?? 15_000;
    this.parsedTxTtlMs = options.parsedTxTtlMs ?? 15_000;
    this.blockTimeTtlMs = options.blockTimeTtlMs ?? 60_000;
    this.maxCacheEntries = options.maxCacheEntries ?? 1_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 150;
    this.circuitBreakerFailures = options.circuitBreakerFailures ?? 8;
    this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 2_500;
  }

  async getSignatureStatus(
    signature: string,
    options?: SignatureStatusOptions,
  ): Promise<SignatureStatusResponse> {
    const key = `status:${signature}`;
    return this.cached(key, this.statusCache, this.statusTtlMs, () =>
      this.withRetry(() => this.connection.getSignatureStatus(signature, options)),
    );
  }

  async getParsedTransaction(
    signature: string,
    options?: ParsedTransactionOptions,
  ): Promise<ParsedTransactionResponse> {
    const key = `parsed:${signature}`;
    return this.cached(key, this.parsedTxCache, this.parsedTxTtlMs, () =>
      this.withRetry(() => this.connection.getParsedTransaction(signature, options)),
    );
  }

  async getBlockTime(slot: number): Promise<BlockTimeResponse> {
    const key = `block:${slot}`;
    return this.cached(key, this.blockTimeCache, this.blockTimeTtlMs, () =>
      this.withRetry(() => this.connection.getBlockTime(slot)),
    );
  }

  private async cached<T>(
    key: string,
    cache: Map<string, CacheEntry<T>>,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const nowMs = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = loader().then((value) => {
      cache.set(key, {
        value,
        expiresAtMs: Date.now() + ttlMs,
      });
      this.trim(cache);
      return value;
    }).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.circuitOpenUntilMs > Date.now()) {
      throw new Error("RPC_UNAVAILABLE: circuit breaker open");
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const value = await fn();
        this.consecutiveRetryableFailures = 0;
        return value;
      } catch (error) {
        const retryable = isRetryableRpcError(error);
        if (retryable) {
          this.consecutiveRetryableFailures += 1;
          if (this.consecutiveRetryableFailures >= this.circuitBreakerFailures) {
            this.circuitOpenUntilMs = Date.now() + this.circuitBreakerCooldownMs;
          }
        }

        if (!retryable || attempt >= this.maxRetries) {
          throw error;
        }

        const jitter = Math.floor(Math.random() * this.retryBaseMs);
        const waitMs = this.retryBaseMs * (2 ** attempt) + jitter;
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
    }

    throw new Error("RPC_UNAVAILABLE: exhausted retries");
  }

  private trim<T>(cache: Map<string, CacheEntry<T>>): void {
    while (cache.size > this.maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      cache.delete(oldest);
    }
  }
}
