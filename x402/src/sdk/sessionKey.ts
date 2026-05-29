/**
 * x402 Session Keys — pay once, agent runs N calls in a window.
 *
 * First Solana implementation of session keys for x402 micropayments.
 * Agents making 1000+ calls/min can't sign 1000 transactions — a session
 * covers the whole burst with one upfront payment.
 *
 * Protocol:
 *   1. Agent calls fetchWith402 normally — server issues a session ID in
 *      the x-dnp-session-id response header alongside the 200 body.
 *   2. Agent stores the SessionHandle returned by createSession().
 *   3. Subsequent calls send x-dnp-session-id: <id> — server validates
 *      and passes through without a new payment, until the session is
 *      exhausted or expired.
 *
 * Session limits (all optional, server configures):
 *   maxCalls       — hard cap on calls (e.g. 100)
 *   maxSpendAtomic — hard cap on total spend (e.g. "50000")
 *   ttlSeconds     — session lifetime (default 3600)
 *
 * Usage:
 *   const session = await createSession("https://api.example/infer", {
 *     wallet, maxSpendAtomic: "50000",
 *   });
 *   const r1 = await fetchWithSession("https://api.example/infer", session);
 *   const r2 = await fetchWithSession("https://api.example/infer", session);
 */

export const SESSION_ID_HEADER = "x-dnp-session-id";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Server-side session configuration (add to PaywallOptions.session).
 */
export interface SessionPolicy {
  enabled: boolean;
  /** Maximum number of calls allowed per session. Null = unlimited. */
  maxCalls?: number;
  /**
   * Maximum total atomic units spendable per session.
   * Defaults to priceAtomic (i.e. one full payment worth of calls).
   */
  maxSpendAtomic?: string;
  /** Session lifetime in seconds. Default: 3600. */
  ttlSeconds?: number;
}

/**
 * Client-side session handle returned by createSession().
 * Pass to fetchWithSession() for subsequent calls.
 */
export interface SessionHandle {
  sessionId: string;
  resource: string;
  pricePerCallAtomic: string;
  maxCalls: number | null;
  maxSpendAtomic: string | null;
  expiresAt: string;
  /** Mutable — updated after each fetchWithSession() call. */
  callsUsed: number;
  /** Mutable — updated after each fetchWithSession() call. */
  spentAtomic: string;
}

export interface SessionStatusResponse {
  sessionId: string;
  resource: string;
  callsUsed: number;
  callsRemaining: number | null;
  spentAtomic: string;
  remainingSpendAtomic: string | null;
  expiresAt: string;
  active: boolean;
}

// ── Client helpers ────────────────────────────────────────────────────────────

interface RawFetchWith402Options {
  wallet: unknown;
  maxSpendAtomic: string;
  [key: string]: unknown;
}

/**
 * Make one x402 payment and get back a reusable session handle.
 *
 * Internally calls fetchWith402 (dynamically imported to avoid circular deps).
 * The session ID is extracted from the x-dnp-session-id response header that
 * the server includes when PaywallOptions.session.enabled = true.
 *
 * Throws if the server does not return a session ID (server not configured
 * with session support).
 */
export async function createSession(
  url: string,
  options: RawFetchWith402Options,
): Promise<SessionHandle> {
  const { fetchWith402 } = await import("../client.js");
  const result = await fetchWith402(url, options as Parameters<typeof fetchWith402>[1]);

  const sessionId = result.response.headers.get(SESSION_ID_HEADER);
  if (!sessionId) {
    throw new Error(
      `createSession: server did not return ${SESSION_ID_HEADER}. ` +
      "Ensure the server has PaywallOptions.session.enabled = true.",
    );
  }

  // Fetch session metadata from the server's /session/:id route.
  const statusUrl = new URL(url);
  statusUrl.pathname = `/session/${sessionId}`;
  const statusRes = await fetch(statusUrl.toString());
  if (!statusRes.ok) {
    throw new Error(`createSession: failed to fetch session status (${statusRes.status})`);
  }
  const status = (await statusRes.json()) as SessionStatusResponse;

  return {
    sessionId: status.sessionId,
    resource: status.resource,
    pricePerCallAtomic: "0", // server tracks this internally
    maxCalls: status.callsRemaining !== null ? (status.callsUsed + (status.callsRemaining ?? 0)) : null,
    maxSpendAtomic: status.remainingSpendAtomic !== null
      ? String(BigInt(status.spentAtomic) + BigInt(status.remainingSpendAtomic ?? "0"))
      : null,
    expiresAt: status.expiresAt,
    callsUsed: status.callsUsed,
    spentAtomic: status.spentAtomic,
  };
}

/**
 * Make a request using an existing session — no payment needed.
 *
 * Updates session.callsUsed and session.spentAtomic in place.
 * Throws if the session is expired or exhausted (server returns 402).
 */
export async function fetchWithSession(
  url: string,
  session: SessionHandle,
  requestInit: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(requestInit.headers);
  headers.set(SESSION_ID_HEADER, session.sessionId);

  const res = await fetch(url, { ...requestInit, headers });

  if (res.status === 402) {
    let reason = "session exhausted or expired";
    try {
      const body = await res.clone().json() as Record<string, unknown>;
      if (body.sessionError) reason = String(body.sessionError);
    } catch { /* ignore */ }
    throw new Error(`fetchWithSession: server rejected session — ${reason}`);
  }

  // Update local state optimistically.
  session.callsUsed += 1;

  return res;
}

/**
 * Check session status directly against the server.
 * Use this to confirm remaining calls / spend before starting a burst.
 */
export async function getSessionStatus(
  baseUrl: string,
  sessionId: string,
): Promise<SessionStatusResponse> {
  const url = new URL(baseUrl);
  url.pathname = `/session/${sessionId}`;
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`getSessionStatus: HTTP ${res.status}`);
  }
  return res.json() as Promise<SessionStatusResponse>;
}
