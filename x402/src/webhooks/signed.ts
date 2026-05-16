import crypto from "node:crypto";
import { assertImmutableRecordSafe } from "../privacy/immutableGuard.js";

export interface SignedWebhookEnvelope {
  idempotencyKey: string;
  event: string;
  timestamp: string;
  payload: Record<string, unknown>;
  signature: string;
}

export class WebhookReplayStore {
  private readonly seen = new Set<string>();

  claim(idempotencyKey: string): boolean {
    if (this.seen.has(idempotencyKey)) {
      return false;
    }
    this.seen.add(idempotencyKey);
    return true;
  }
}

export function signWebhookPayload(secret: string, payload: Omit<SignedWebhookEnvelope, "signature">): SignedWebhookEnvelope {
  assertImmutableRecordSafe("WEBHOOK_IMMUTABLE_LOG", payload);
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { ...payload, signature };
}

export function verifyWebhookSignatureAndTimestamp(secret: string, envelope: SignedWebhookEnvelope, now = new Date()): void {
  const { signature, ...payload } = envelope;
  const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const signatureBytes = Buffer.from(signature, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (signatureBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(signatureBytes, expectedBytes)) {
    throw new Error("invalid webhook signature");
  }
  if (Math.abs(now.getTime() - new Date(envelope.timestamp).getTime()) > 300_000) {
    throw new Error("webhook timestamp outside replay window");
  }
}

export function verifyWebhookPayload(secret: string, envelope: SignedWebhookEnvelope, replayStore: WebhookReplayStore, now = new Date()): void {
  verifyWebhookSignatureAndTimestamp(secret, envelope, now);
  if (!replayStore.claim(envelope.idempotencyKey)) {
    throw new Error("duplicate webhook rejected");
  }
}
