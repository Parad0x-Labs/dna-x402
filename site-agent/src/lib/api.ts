import {
  AnchoredReceiptResponse,
  AnchoringStatusResponse,
  CommitResponse,
  DemoPingResponse,
  FinalizeResponse,
  HealthResponse,
  MarketMetricsResponse,
  MarketSnapshotResponse,
  PaymentRequirements,
  ResourceResponse,
  SettlementMode,
  SignedReceipt,
} from "./types";

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await parseBody(response);
  if (!response.ok) {
    const error = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${response.status} ${response.statusText}: ${error}`);
  }
  return body as T;
}

export class AgentApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async health(): Promise<HealthResponse> {
    return fetchJson<HealthResponse>(`${this.baseUrl}/health`);
  }

  async marketSnapshot(): Promise<MarketSnapshotResponse> {
    return fetchJson<MarketSnapshotResponse>(`${this.baseUrl}/market/snapshot`);
  }

  async topSelling(verificationTier: "FAST" | "VERIFIED" = "FAST"): Promise<MarketMetricsResponse> {
    return fetchJson<MarketMetricsResponse>(
      `${this.baseUrl}/market/top-selling?window=24h&verificationTier=${verificationTier}`,
    );
  }

  async trending(verificationTier: "FAST" | "VERIFIED" = "FAST"): Promise<MarketMetricsResponse> {
    return fetchJson<MarketMetricsResponse>(
      `${this.baseUrl}/market/trending?window=1h&verificationTier=${verificationTier}`,
    );
  }

  async onSale(): Promise<MarketMetricsResponse> {
    return fetchJson<MarketMetricsResponse>(`${this.baseUrl}/market/on-sale?window=24h`);
  }

  async anchoringStatus(): Promise<AnchoringStatusResponse> {
    return fetchJson<AnchoringStatusResponse>(`${this.baseUrl}/market/anchoring/status`);
  }

  async ping(): Promise<DemoPingResponse> {
    return fetchJson<DemoPingResponse>(`${this.baseUrl}/demo/ping`);
  }

  async resource(commitId?: string): Promise<ResourceResponse> {
    const response = await fetch(`${this.baseUrl}/resource`, {
      headers: commitId ? { "x-dnp-commit-id": commitId } : undefined,
    });
    return {
      status: response.status,
      headers: headersToRecord(response.headers),
      body: await parseBody(response),
    };
  }

  async commit(quoteId: string, payerCommitment32B: string): Promise<CommitResponse> {
    return fetchJson<CommitResponse>(`${this.baseUrl}/commit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        quoteId,
        payerCommitment32B,
      }),
    });
  }

  async finalize(input: {
    commitId: string;
    settlement: SettlementMode;
    txSignature?: string;
    amountAtomic?: string;
    note?: string;
  }): Promise<FinalizeResponse> {
    const paymentProof = input.settlement === "transfer"
      ? {
        settlement: "transfer" as const,
        txSignature: input.txSignature,
        amountAtomic: input.amountAtomic,
      }
      : input.settlement === "stream"
        ? {
          settlement: "stream" as const,
          streamId: "site-agent-stream",
          amountAtomic: input.amountAtomic,
        }
        : {
          settlement: "netting" as const,
          amountAtomic: input.amountAtomic,
          note: input.note,
        };

    return fetchJson<FinalizeResponse>(`${this.baseUrl}/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commitId: input.commitId,
        paymentProof,
      }),
    });
  }

  async receipt(receiptId: string): Promise<SignedReceipt> {
    return fetchJson<SignedReceipt>(`${this.baseUrl}/receipt/${encodeURIComponent(receiptId)}`);
  }

  async anchoringReceipt(receiptId: string): Promise<AnchoredReceiptResponse> {
    return fetchJson<AnchoredReceiptResponse>(`${this.baseUrl}/anchoring/receipt/${encodeURIComponent(receiptId)}`);
  }
}

export function parsePaymentRequirements(resourceResponse: ResourceResponse): PaymentRequirements {
  if (resourceResponse.status !== 402) {
    throw new Error(`Expected 402 payment_required, got ${resourceResponse.status}`);
  }

  const body = resourceResponse.body as { paymentRequirements?: PaymentRequirements } | null;
  const requirements = body?.paymentRequirements;
  if (!requirements?.quote?.quoteId) {
    throw new Error("Missing paymentRequirements.quote.quoteId");
  }
  return requirements;
}
