function isRateLimitError(error: unknown): boolean {
  const text = String((error as { message?: string })?.message ?? error ?? "");
  return text.includes("429") || text.toLowerCase().includes("too many requests");
}

export async function withRpcRetry<T>(label: string, fn: () => Promise<T>, maxRetries = 8): Promise<T> {
  let attempt = 0;
  let waitMs = 500;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (!isRateLimitError(error) || attempt > maxRetries) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.warn(`[rpc-retry] ${label} attempt=${attempt} waiting=${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      waitMs = Math.min(waitMs * 2, 8_000);
    }
  }
}

