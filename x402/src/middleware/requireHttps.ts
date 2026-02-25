import type { NextFunction, Request, Response } from "express";
import { X402Error, X402ErrorCode } from "../x402/errors.js";
import { sendX402Error } from "../x402/errorResponse.js";

export function requireHttpsMiddleware(options: { allowInsecure: boolean }): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (options.allowInsecure) {
      next();
      return;
    }

    const proto = req.header("x-forwarded-proto") ?? req.protocol;
    const host = req.header("host") ?? "";
    const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1");
    if (proto === "https" || isLocalhost) {
      next();
      return;
    }

    sendX402Error(req, res, new X402Error(X402ErrorCode.X402_UNSUPPORTED_DIALECT, {
      message: "HTTPS is required for x402 requests in production mode.",
      cause: "Request used non-HTTPS transport while ALLOW_INSECURE is disabled.",
      hint: [
        "Send requests over HTTPS.",
        "Set ALLOW_INSECURE=1 only for controlled local development.",
      ],
      details: {
        protocol: proto,
      },
    }));
  };
}
