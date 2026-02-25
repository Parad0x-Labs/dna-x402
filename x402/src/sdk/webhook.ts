import crypto from "node:crypto";

export interface WebhookPayload {
  event: string;
  receiptId?: string;
  quoteId?: string;
  commitId?: string;
  shopId?: string;
  endpointId?: string;
  amountAtomic?: string;
  mint?: string;
  settlement?: string;
  txSignature?: string;
  streamId?: string;
  ts: string;
  data?: Record<string, unknown>;
}

export interface WebhookDeliveryResult {
  url: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  retryCount: number;
}

export interface WebhookServiceOptions {
  signingSecret?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  onDelivery?: (result: WebhookDeliveryResult) => void;
}

export class WebhookService {
  private readonly signingSecret: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  private readonly onDelivery?: (result: WebhookDeliveryResult) => void;

  constructor(options: WebhookServiceOptions = {}) {
    this.signingSecret = options.signingSecret ?? crypto.randomBytes(32).toString("hex");
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.onDelivery = options.onDelivery;
  }

  sign(payload: string): string {
    return crypto
      .createHmac("sha256", this.signingSecret)
      .update(payload)
      .digest("hex");
  }

  async deliver(url: string, payload: WebhookPayload): Promise<WebhookDeliveryResult> {
    const body = JSON.stringify(payload);
    const signature = this.sign(body);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dna-signature": signature,
            "x-dna-event": payload.event,
            "x-dna-timestamp": payload.ts,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const durationMs = Date.now() - start;
        const result: WebhookDeliveryResult = {
          url,
          status: response.status,
          ok: response.ok,
          durationMs,
          retryCount: attempt,
        };
        this.onDelivery?.(result);

        if (response.ok) {
          return result;
        }

        if (response.status >= 400 && response.status < 500) {
          result.error = `client error ${response.status}`;
          return result;
        }
      } catch (error) {
        const durationMs = Date.now() - start;
        if (attempt === this.maxRetries) {
          const result: WebhookDeliveryResult = {
            url,
            status: null,
            ok: false,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
            retryCount: attempt,
          };
          this.onDelivery?.(result);
          return result;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, this.retryBaseMs * 2 ** attempt));
    }

    return { url, status: null, ok: false, durationMs: 0, error: "exhausted retries", retryCount: this.maxRetries };
  }
}
