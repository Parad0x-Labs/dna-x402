import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
    }
  }
}

export function traceIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = crypto.randomUUID();
  req.traceId = traceId;
  res.setHeader("X-TRACE-ID", traceId);
  next();
}

export function readTraceId(req: Request): string {
  return req.traceId ?? crypto.randomUUID();
}
