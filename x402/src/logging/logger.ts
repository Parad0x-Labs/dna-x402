import { redactSensitiveHeaders } from "./redact.js";

export interface LogContext {
  traceId?: string;
  route?: string;
}

export function logInfo(message: string, context: Record<string, unknown> = {}, meta: LogContext = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: "info",
    message,
    traceId: meta.traceId,
    route: meta.route,
    ...context,
  }));
}

export function logError(message: string, context: Record<string, unknown> = {}, meta: LogContext = {}): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    level: "error",
    message,
    traceId: meta.traceId,
    route: meta.route,
    ...context,
  }));
}

export function logRequestHeaders(message: string, headers: Record<string, string | undefined>, meta: LogContext = {}): void {
  logInfo(message, {
    headers: redactSensitiveHeaders(headers),
  }, meta);
}
