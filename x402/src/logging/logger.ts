import { redactSensitiveHeaders } from "./redact.js";

export interface LogContext {
  traceId?: string;
  route?: string;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function shouldEmitStdoutLogs(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  const explicit = parseBooleanEnv(env.X402_LOG_STDOUT) ?? parseBooleanEnv(env.LOG_STDOUT);
  if (explicit !== undefined) {
    return explicit;
  }
  const runningUnderVitest = argv.some((value) => value.toLowerCase().includes("vitest"));
  if (
    env.VITEST
    || env.VITEST_POOL_ID
    || env.VITEST_WORKER_ID
    || parseBooleanEnv(env.TEST) === true
    || env.NODE_ENV === "test"
    || runningUnderVitest
  ) {
    return false;
  }
  return true;
}

export function logInfo(message: string, context: Record<string, unknown> = {}, meta: LogContext = {}): void {
  if (!shouldEmitStdoutLogs()) {
    return;
  }
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
  if (!shouldEmitStdoutLogs()) {
    return;
  }
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
