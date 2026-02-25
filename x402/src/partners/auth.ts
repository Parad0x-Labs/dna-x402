import type { Request } from "express";
import crypto from "node:crypto";

export interface PartnerAuthConfig {
  token?: string;
  hmacSecret?: string;
  maxSkewSeconds?: number;
}

export function verifyPartnerAuth(req: Request, config: PartnerAuthConfig): boolean {
  const token = req.header("x-partner-token");
  if (config.token && token) {
    return token === config.token;
  }

  const signature = req.header("x-partner-signature");
  const timestamp = req.header("x-partner-timestamp");
  if (!config.hmacSecret || !signature || !timestamp) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const maxSkew = config.maxSkewSeconds ?? 300;
  if (Math.abs(nowSeconds - ts) > maxSkew) {
    return false;
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const digest = crypto.createHmac("sha256", config.hmacSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}
