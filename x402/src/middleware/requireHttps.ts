import type { NextFunction, Request, Response } from "express";
import { X402Error, X402ErrorCode } from "../x402/errors.js";
import { sendX402Error } from "../x402/errorResponse.js";

export function requireHttpsMiddleware(options: { allowInsecure: boolean }): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (options.allowInsecure) {
      next();
      return;
    }

    // SECURITY: Do not trust x-forwarded-proto blindly — an attacker can set
    // this header to "https" on any plain-HTTP request unless Express has
    // trust proxy configured (which causes req.protocol to reflect the header)
    // or the deployment exposes PUBLIC_BASE_URL whose scheme is authoritative.
    //
    // Resolution order:
    //  1. If PUBLIC_BASE_URL is set, derive the expected protocol from it.
    //     This is the safest option: the value comes from the server environment,
    //     not from an untrusted client header.
    //  2. If trust proxy is enabled (req.app.get("trust proxy") is truthy),
    //     Express has already vetted and normalised x-forwarded-proto into
    //     req.protocol, so we can use req.protocol directly.
    //  3. In development/test environments only, fall back to the raw
    //     x-forwarded-proto header for convenience (e.g. local tunnels).
    //  4. Otherwise use req.protocol, which reflects the direct TCP connection
    //     and cannot be spoofed.
    let proto: string;

    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    if (publicBaseUrl) {
      try {
        proto = new URL(publicBaseUrl).protocol.replace(":", ""); // "https" | "http"
      } catch {
        proto = "http"; // malformed URL — deny by default
      }
    } else {
      const trustProxy = req.app.get("trust proxy");
      const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
      if (trustProxy || isDev) {
        proto = req.protocol; // Express has already resolved x-forwarded-proto safely
      } else {
        proto = (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http"; // raw connection, cannot be faked
      }
    }

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
