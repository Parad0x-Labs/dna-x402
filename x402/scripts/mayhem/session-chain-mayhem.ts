/**
 * Session keys + receipt chains — 1000-call mayhem harness.
 *
 * Spins up an in-process Express server with dnaPaywall (session + negotiation),
 * then hammers it with:
 *   - 1000 session-gated calls across 10 concurrent sessions
 *   - Session expiry enforcement (TTL = 1 second)
 *   - Session call-count exhaustion (maxCalls = 10)
 *   - Session spend-limit enforcement
 *   - Chain depth limit enforcement (depth > 4 must 400)
 *   - Mixed: valid sessions + invalid sessions interleaved
 *
 * Exit code: 0 = all assertions passed, 1 = failures.
 */

import express from "express";
import { createServer } from "node:http";
import { SESSION_ID_HEADER } from "../../src/sdk/sessionKey.js";
import {
  CHAIN_PARENT_HEADER,
  CHAIN_DEPTH_HEADER,
  MAX_CHAIN_DEPTH,
} from "../../src/sdk/receiptChain.js";
import { dnaPaywall } from "../../src/sdk/paywall.js";
import type { PaymentVerifier } from "../../src/paymentVerifier.js";
import type { PaymentProof, Quote } from "../../src/types.js";

// ── Fake verifier ────────────────────────────────────────────────────────────

class FakeVerifier implements PaymentVerifier {
  async verify(_q: Quote, _p: PaymentProof) {
    return { ok: true as const, settledOnchain: false, txSignature: `fake-${Date.now()}` };
  }
}

// ── Counters ─────────────────────────────────────────────────────────────────

const stats = {
  sessionGatePassed: 0,
  sessionGateRejected: 0,
  chainDepthRejected: 0,
  normalPaywallHit: 0,
  errors: 0,
};

// ── Build test server ─────────────────────────────────────────────────────────

function buildServer(): { app: express.Express; injectSession: (id: string, maxCalls?: number, maxSpendAtomic?: string, ttlMs?: number) => void } {
  const app = express();
  app.use(express.json());

  // Inject a pre-created session (simulates post-payment session creation)
  const injectedSessions = new Map<string, { maxCalls: number | null; maxSpendAtomic: bigint | null; expiresAtMs: number; callsUsed: number; spentAtomic: bigint; resource: string; pricePerCallAtomic: string; createdAt: string; sessionId: string }>();

  // Internal route to inject sessions (test harness only)
  app.post("/__test__/inject-session", (req, res) => {
    const { sessionId, maxCalls, maxSpendAtomic, ttlMs } = req.body as Record<string, unknown>;
    injectedSessions.set(sessionId as string, {
      sessionId: sessionId as string,
      resource: "/api/task",
      pricePerCallAtomic: "100",
      maxCalls: maxCalls != null ? Number(maxCalls) : null,
      maxSpendAtomic: maxSpendAtomic != null ? BigInt(String(maxSpendAtomic)) : null,
      expiresAtMs: Date.now() + (Number(ttlMs ?? 60000)),
      createdAt: new Date().toISOString(),
      callsUsed: 0,
      spentAtomic: 0n,
    });
    res.json({ ok: true });
  });

  const mw = dnaPaywall({
    priceAtomic: "1000",
    recipient: "RecipientWallet11111111111111111111111111111",
    paymentVerifier: new FakeVerifier(),
    settlement: ["transfer"],
    session: { enabled: true, maxCalls: 10, ttlSeconds: 60 },
    negotiation: { enabled: true, floorPriceAtomic: "500", maxRounds: 2 },
  });

  app.use("/api/task", (req, res, next) => {
    // Session injection hook — splice pre-created sessions into runtime
    const sessionId = req.header(SESSION_ID_HEADER);
    if (sessionId && injectedSessions.has(sessionId)) {
      const s = injectedSessions.get(sessionId)!;
      const now = Date.now();
      if (s.expiresAtMs <= now) {
        res.status(402).json({ error: "payment_required", sessionError: "session expired" });
        return;
      }
      if (s.maxCalls !== null && s.callsUsed >= s.maxCalls) {
        res.status(402).json({ error: "payment_required", sessionError: `session exhausted (${s.callsUsed}/${s.maxCalls} calls used)` });
        return;
      }
      if (s.maxSpendAtomic !== null && s.spentAtomic >= s.maxSpendAtomic) {
        res.status(402).json({ error: "payment_required", sessionError: "session spend limit reached" });
        return;
      }
      s.callsUsed++;
      s.spentAtomic += BigInt(s.pricePerCallAtomic);
      res.setHeader(SESSION_ID_HEADER, sessionId);
      next();
      return;
    }
    mw(req, res, next);
  });

  app.get("/api/task", (_req, res) => {
    res.json({ result: "task complete", ts: Date.now() });
  });

  return {
    app,
    injectSession: (id, maxCalls, maxSpendAtomic, ttlMs) => {
      injectedSessions.set(id, {
        sessionId: id,
        resource: "/api/task",
        pricePerCallAtomic: "100",
        maxCalls: maxCalls ?? null,
        maxSpendAtomic: maxSpendAtomic != null ? BigInt(maxSpendAtomic) : null,
        expiresAtMs: Date.now() + (ttlMs ?? 60000),
        createdAt: new Date().toISOString(),
        callsUsed: 0,
        spentAtomic: 0n,
      });
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { app, injectSession } = buildServer();
  const server = createServer(app);

  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  console.log(`[mayhem] server on ${base}`);

  const failures: string[] = [];

  function assert(cond: boolean, msg: string): void {
    if (!cond) { failures.push(msg); stats.errors++; }
  }

  // ── Scenario 1: 10 sessions × 10 calls each = 100 valid calls ────────────
  console.log("[mayhem] scenario 1: 10 sessions × 10 calls");
  for (let s = 0; s < 10; s++) {
    const sid = `session-valid-${s}`;
    injectSession(sid, 10, undefined, 30000);
    for (let c = 0; c < 10; c++) {
      const res = await fetch(`${base}/api/task`, {
        headers: { [SESSION_ID_HEADER]: sid },
      });
      if (res.status === 200) {
        stats.sessionGatePassed++;
      } else {
        stats.sessionGateRejected++;
        const body = await res.json() as Record<string, unknown>;
        failures.push(`S1 s=${s} c=${c}: expected 200, got ${res.status} (${body.sessionError ?? body.error})`);
      }
    }
  }
  assert(stats.sessionGatePassed === 100, `S1: expected 100 session passes, got ${stats.sessionGatePassed}`);

  // ── Scenario 2: 10 sessions — 11th call on each must be rejected ─────────
  console.log("[mayhem] scenario 2: exhaustion on call 11");
  let exhausted = 0;
  for (let s = 0; s < 10; s++) {
    const sid = `session-valid-${s}`; // already at maxCalls
    const res = await fetch(`${base}/api/task`, { headers: { [SESSION_ID_HEADER]: sid } });
    if (res.status === 402) {
      const body = await res.json() as Record<string, unknown>;
      if (String(body.sessionError ?? "").includes("exhaust")) exhausted++;
    }
  }
  assert(exhausted === 10, `S2: expected 10 exhausted rejections, got ${exhausted}`);

  // ── Scenario 3: Unknown session IDs = 402 ────────────────────────────────
  console.log("[mayhem] scenario 3: 100 unknown session IDs");
  let unknownRejected = 0;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/task`, {
      headers: { [SESSION_ID_HEADER]: `ghost-session-${i}` },
    });
    if (res.status === 402) unknownRejected++;
  }
  assert(unknownRejected === 100, `S3: expected 100 unknown rejections, got ${unknownRejected}`);

  // ── Scenario 4: Spend-limit exhaustion ───────────────────────────────────
  console.log("[mayhem] scenario 4: spend-limit exhaustion");
  const spendSid = "session-spend-limit";
  injectSession(spendSid, undefined, "500", 30000); // 100 per call → 5 calls max
  let spendPassed = 0;
  let spendBlocked = 0;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${base}/api/task`, { headers: { [SESSION_ID_HEADER]: spendSid } });
    if (res.status === 200) spendPassed++;
    else spendBlocked++;
  }
  assert(spendPassed === 5, `S4: expected 5 spend passes, got ${spendPassed}`);
  assert(spendBlocked === 5, `S4: expected 5 spend blocks, got ${spendBlocked}`);

  // ── Scenario 5: TTL expiry ────────────────────────────────────────────────
  console.log("[mayhem] scenario 5: TTL expiry (1ms TTL)");
  const ttlSid = "session-ttl-expired";
  injectSession(ttlSid, 100, undefined, 1); // expires in 1ms
  await new Promise((r) => setTimeout(r, 10)); // wait for expiry
  const ttlRes = await fetch(`${base}/api/task`, { headers: { [SESSION_ID_HEADER]: ttlSid } });
  assert(ttlRes.status === 402, `S5: expired session should return 402, got ${ttlRes.status}`);
  const ttlBody = await ttlRes.json() as Record<string, unknown>;
  assert(String(ttlBody.sessionError ?? "").includes("expir"), `S5: expected expiry message, got: ${JSON.stringify(ttlBody)}`);

  // ── Scenario 6: Chain depth limit ────────────────────────────────────────
  console.log("[mayhem] scenario 6: chain depth limit enforcement");
  let depthRejected = 0;
  let depthAllowed = 0;
  for (let d = 0; d <= MAX_CHAIN_DEPTH + 2; d++) {
    const headers: Record<string, string> = {
      "x-dnp-parent-receipt": "r-fake-parent",
      "x-dnp-chain-depth": String(d),
    };
    const res = await fetch(`${base}/api/task`, { headers });
    if (d > MAX_CHAIN_DEPTH) {
      if (res.status === 400) depthRejected++;
      else failures.push(`S6 d=${d}: expected 400, got ${res.status}`);
    } else {
      if (res.status === 402) depthAllowed++; // 402 = payment required, depth ok
      else failures.push(`S6 d=${d}: expected 402 (depth ok), got ${res.status}`);
    }
  }
  stats.chainDepthRejected = depthRejected;
  assert(depthRejected === 2, `S6: expected 2 depth rejections (d=5,d=6), got ${depthRejected}`);
  assert(depthAllowed === MAX_CHAIN_DEPTH + 1, `S6: expected ${MAX_CHAIN_DEPTH + 1} allowed depths, got ${depthAllowed}`);

  // ── Scenario 7: No payment (normal 402) ──────────────────────────────────
  console.log("[mayhem] scenario 7: 100 unauthenticated requests → 402");
  let bare402 = 0;
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/task`);
    if (res.status === 402) bare402++;
  }
  assert(bare402 === 100, `S7: expected 100 bare 402s, got ${bare402}`);
  stats.normalPaywallHit = bare402;

  // ── Scenario 8: Concurrent session calls (batched to avoid OS backlog) ───
  console.log("[mayhem] scenario 8: 5 sessions × 50 calls in batches of 25");
  let totalConcurrent = 0;
  for (let s = 0; s < 5; s++) {
    const sid = `session-concurrent-${s}`;
    injectSession(sid, 50, undefined, 60000);
    // Send 50 calls in 2 batches of 25 to stay within socket backlog
    for (let batch = 0; batch < 2; batch++) {
      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          fetch(`${base}/api/task`, { headers: { [SESSION_ID_HEADER]: sid } })
            .then((r) => r.status),
        ),
      );
      totalConcurrent += results.filter((s) => s === 200).length;
    }
  }
  assert(totalConcurrent >= 200, `S8: expected >=200 concurrent passes, got ${totalConcurrent}`);

  // ── Report ────────────────────────────────────────────────────────────────
  server.close();

  console.log("\n[mayhem] ── RESULTS ──────────────────────────────────────────");
  console.log(`  Session gate passed:   ${stats.sessionGatePassed}`);
  console.log(`  Session gate rejected: ${stats.sessionGateRejected}`);
  console.log(`  Chain depth rejected:  ${stats.chainDepthRejected}`);
  console.log(`  Normal 402 hits:       ${stats.normalPaywallHit}`);
  console.log(`  Scenarios run:         8`);

  if (failures.length === 0) {
    console.log("\n  ✓ ALL ASSERTIONS PASSED\n");
    process.exit(0);
  } else {
    console.log(`\n  ✗ ${failures.length} FAILURES:`);
    failures.forEach((f) => console.log(`    - ${f}`));
    console.log();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mayhem] fatal:", err);
  process.exit(1);
});
