import http from "node:http";
import express, { Express } from "express";
import { dnaPrice, dnaSeller } from "../sdk/seller.js";
import { PaymentVerifier } from "../paymentVerifier.js";
import { PaymentProof, Quote, VerificationResult } from "../types.js";
import { DEMO_RESOURCES, demoProofValue, DemoMode } from "./shared.js";

export interface DemoSellerOptions {
  mode?: DemoMode;
  port?: number;
  host?: string;
  recipient?: string;
  mint?: string;
  quiet?: boolean;
}

export interface StartedDemoSeller {
  app: Express;
  server: http.Server;
  port: number;
  host: string;
  baseUrl: string;
  close(): Promise<void>;
}

class DemoPaymentVerifier implements PaymentVerifier {
  constructor(private readonly mode: DemoMode) {}

  async verify(quote: Quote, paymentProof: PaymentProof): Promise<VerificationResult> {
    if (paymentProof.settlement !== this.mode) {
      return {
        ok: false,
        settledOnchain: false,
        error: `demo seller is running in ${this.mode} mode only`,
        errorCode: "PAYMENT_INVALID",
        retryable: false,
      };
    }

    if (this.mode === "transfer") {
      const expectedSignature = demoProofValue("transfer", quote.quoteId);
      if (paymentProof.settlement !== "transfer" || paymentProof.txSignature !== expectedSignature) {
        return {
          ok: false,
          settledOnchain: false,
          error: `expected demo transfer proof ${expectedSignature}`,
          errorCode: "INVALID_PROOF",
          retryable: false,
        };
      }
      return {
        ok: true,
        settledOnchain: true,
        txSignature: paymentProof.txSignature,
      };
    }

    if (this.mode === "stream") {
      const expectedStreamId = demoProofValue("stream", quote.quoteId);
      if (paymentProof.settlement !== "stream" || paymentProof.streamId !== expectedStreamId) {
        return {
          ok: false,
          settledOnchain: false,
          error: `expected demo stream proof ${expectedStreamId}`,
          errorCode: "INVALID_PROOF",
          retryable: false,
        };
      }
      return {
        ok: true,
        settledOnchain: true,
        streamId: paymentProof.streamId,
      };
    }

    return {
      ok: true,
      settledOnchain: false,
    };
  }
}

export function createDemoSellerApp(options: DemoSellerOptions = {}): Express {
  const mode = options.mode ?? "transfer";
  const recipient = options.recipient ?? "DEMO_RECIPIENT_WALLET";
  const mint = options.mint ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const app = express();
  app.use(express.json());

  const pay = dnaSeller(app, {
    recipient,
    mint,
    settlement: [mode],
    unsafeUnverifiedNettingEnabled: mode === "netting",
    paymentVerifier: new DemoPaymentVerifier(mode),
  });

  app.get("/", (_req, res) => {
    res.json({
      service: "DNA x402 demo seller",
      mode,
      recipient,
      endpoints: Object.fromEntries(
        DEMO_RESOURCES.map((resource) => [
          resource.path,
          {
            amountAtomic: resource.amountAtomic,
            description: resource.description,
            settlement: mode,
          },
        ]),
      ),
      aliases: {
        "/api/inference": "/inference",
        "/api/embedding": "/resource",
      },
    });
  });

  for (const resource of DEMO_RESOURCES) {
    app.get(resource.path, dnaPrice(resource.amountAtomic, pay), (_req, res) => {
      res.json(resource.response);
    });
  }

  app.get("/api/inference", dnaPrice("5000", pay), (_req, res) => {
    res.json({
      ok: true,
      kind: "inference",
      model: "dna-demo",
      result: "The answer is 42.",
      tokens: 847,
    });
  });

  app.get("/api/embedding", dnaPrice("1000", pay), (_req, res) => {
    res.json({
      ok: true,
      kind: "embedding",
      vector: [0.1, 0.2, 0.3, 0.4],
      dims: 4,
    });
  });

  return app;
}

export async function startDemoSeller(options: DemoSellerOptions = {}): Promise<StartedDemoSeller> {
  const app = createDemoSellerApp(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;

  const server = await new Promise<http.Server>((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.once("error", reject);
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${resolvedPort}`;

  if (!options.quiet) {
    console.log(`DNA x402 demo seller running on ${baseUrl}`);
    console.log(`Settlement mode: ${options.mode ?? "transfer"}`);
    console.log("Paid endpoints:");
    for (const resource of DEMO_RESOURCES) {
      console.log(`  GET ${resource.path} → ${resource.amountAtomic} atomic (${options.mode ?? "transfer"})`);
    }
  }

  return {
    app,
    server,
    port: resolvedPort,
    host,
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}
