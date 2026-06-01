import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface AdminAuthOptions {
  secret?: string;
  allowInsecure?: boolean;
}

function readAdminToken(req: Request, res: Response): string | undefined {
  if (req.query.adminToken !== undefined) {
    res.status(400).json({
      error: "insecure_token_transport",
      message: "Admin token must be sent in x-admin-token header, not query string.",
    });
    return undefined;
  }
  return req.header("x-admin-token");
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function adminAuth(options: AdminAuthOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { secret, allowInsecure } = options;
    if (!secret) {
      if (allowInsecure === true) {
        next();
        return;
      }
      res.status(503).json({
        error: "admin_secret_required",
        message: "ADMIN_SECRET is required for admin operations. Set ALLOW_INSECURE=1 only for controlled local development.",
      });
      return;
    }

    const token = readAdminToken(req, res);
    if (res.headersSent) return;
    if (!token || !constantTimeEquals(token, secret)) {
      res.status(403).json({ error: "forbidden", message: "Invalid admin token" });
      return;
    }
    next();
  };
}
