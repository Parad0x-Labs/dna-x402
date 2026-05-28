/**
 * Task Marketplace API — Integration Tests
 *
 * Tests the full HTTP API surface using supertest against the Express app.
 * No server port binding needed — supertest calls in-process.
 */

import request from "supertest";
import app from "../src/app.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const HEADERS = {
  "X-Passport-Id": "a".repeat(64),
  "X-Platform-Id": "test-platform",
  "X-Tier":        "bronze",
};

// ── /health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("null-miner-marketplace");
    expect(typeof res.body.ts).toBe("number");
  });
});

// ── GET /tasks ────────────────────────────────────────────────────────────────

describe("GET /tasks", () => {
  it("returns 401 without X-Passport-Id header", async () => {
    const res = await request(app).get("/tasks");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/passport/i);
  });

  it("returns array of tasks for authenticated request", async () => {
    const res = await request(app).get("/tasks").set(HEADERS);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("tasks have required fields", async () => {
    const res = await request(app).get("/tasks").set(HEADERS);
    const task = res.body[0];
    expect(typeof task.taskId).toBe("string");
    expect(typeof task.kind).toBe("string");
    expect(typeof task.rewardUsdc).toBe("number");
    expect(task.rewardUsdc).toBeGreaterThan(0);
    expect(typeof task.expiresAtSlot).toBe("number");
    expect(task.claimedBy).toBeNull();
    expect(task.completed).toBe(false);
  });

  it("returns tasks sorted by reward descending", async () => {
    const res = await request(app).get("/tasks").set(HEADERS);
    const rewards = res.body.map((t: { rewardUsdc: number }) => t.rewardUsdc);
    for (let i = 1; i < rewards.length; i++) {
      expect(rewards[i]).toBeLessThanOrEqual(rewards[i - 1]);
    }
  });
});

// ── GET /tasks/:id ────────────────────────────────────────────────────────────

describe("GET /tasks/:id", () => {
  it("returns 404 for unknown taskId", async () => {
    const res = await request(app).get("/tasks/" + "0".repeat(64));
    expect(res.status).toBe(404);
  });

  it("returns task for valid taskId", async () => {
    const listRes = await request(app).get("/tasks").set(HEADERS);
    const task    = listRes.body[0];
    const res     = await request(app).get(`/tasks/${task.taskId}`);
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(task.taskId);
  });
});

// ── POST /tasks/:id/claim ─────────────────────────────────────────────────────

describe("POST /tasks/:id/claim", () => {
  it("returns 401 without passport header", async () => {
    const res = await request(app)
      .post("/tasks/" + "0".repeat(64) + "/claim");
    expect(res.status).toBe(401);
  });

  it("returns 409 for unknown task", async () => {
    const res = await request(app)
      .post("/tasks/" + "0".repeat(64) + "/claim")
      .set(HEADERS);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("task not found");
  });

  it("successfully claims an available task", async () => {
    const listRes = await request(app).get("/tasks").set(HEADERS);
    const task    = listRes.body[0];
    const res     = await request(app)
      .post(`/tasks/${task.taskId}/claim`)
      .set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.task.claimedBy).toBe(HEADERS["X-Passport-Id"]);
  });

  it("rejects double-claim of same task", async () => {
    const listRes = await request(app).get("/tasks").set(HEADERS);
    // Find a task not already claimed (use second task to avoid collision with previous test)
    const task = listRes.body.find((t: { claimedBy: null }) => t.claimedBy === null);
    if (!task) return; // all tasks claimed — skip (shouldn't happen in test run)

    // First claim succeeds
    const first = await request(app)
      .post(`/tasks/${task.taskId}/claim`)
      .set(HEADERS);
    expect(first.status).toBe(200);

    // Second claim rejected
    const second = await request(app)
      .post(`/tasks/${task.taskId}/claim`)
      .set({ ...HEADERS, "X-Passport-Id": "b".repeat(64) });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already claimed");
  });
});

// ── POST /tasks/:id/proof ─────────────────────────────────────────────────────

describe("POST /tasks/:id/proof", () => {
  let claimedTaskId     = "";
  let expectedProofHash = "";

  beforeAll(async () => {
    // Claim a fresh task and record its expected proof hash
    const listRes = await request(app).get("/tasks").set(HEADERS);
    const available = listRes.body.find((t: { claimedBy: null }) => t.claimedBy === null);
    if (!available) return;
    await request(app)
      .post(`/tasks/${available.taskId}/claim`)
      .set(HEADERS);
    claimedTaskId     = available.taskId;
    expectedProofHash = available.proofRequirements.expectedProofHash as string;
  });

  it("returns 400 without proofHash body", async () => {
    if (!claimedTaskId) return;
    const res = await request(app)
      .post(`/tasks/${claimedTaskId}/proof`)
      .set(HEADERS)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/proofHash/);
  });

  it("rejects wrong proof hash with 422", async () => {
    // Claim a dedicated task for this test so it is unclaimed
    const listRes = await request(app).get("/tasks").set(HEADERS);
    const task = listRes.body.find(
      (t: { claimedBy: null; taskId: string }) => t.claimedBy === null && t.taskId !== claimedTaskId
    );
    if (!task) return; // no spare tasks — skip

    const claimRes = await request(app)
      .post(`/tasks/${task.taskId}/claim`)
      .set(HEADERS);
    expect(claimRes.status).toBe(200);

    const res = await request(app)
      .post(`/tasks/${task.taskId}/proof`)
      .set(HEADERS)
      .send({ proofHash: "bad" + "0".repeat(60) }); // deliberate mismatch
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/proof hash mismatch/);
  });

  it("submits correct proof hash and returns USDC earned", async () => {
    if (!claimedTaskId || !expectedProofHash) return;
    const res = await request(app)
      .post(`/tasks/${claimedTaskId}/proof`)
      .set(HEADERS)
      .send({ proofHash: expectedProofHash });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.usdcEarned).toBe("number");
    expect(res.body.usdcEarned).toBeGreaterThan(0);
    expect(typeof res.body.nullYield).toBe("number");
    expect(typeof res.body.receipt.txHash).toBe("string");
    expect(res.body.receipt.anchored).toBe(false); // devnet — no Solana tx yet
  });

  it("rejects proof for unknown task", async () => {
    const res = await request(app)
      .post("/tasks/" + "0".repeat(64) + "/proof")
      .set(HEADERS)
      .send({ proofHash: "a".repeat(64) });
    expect(res.status).toBe(409);
  });
});

// ── GET /platform/:id/stats ───────────────────────────────────────────────────

describe("GET /platform/:id/stats", () => {
  it("returns stats for platform (zeros if no completions)", async () => {
    const res = await request(app).get("/platform/test-platform/stats");
    expect(res.status).toBe(200);
    expect(res.body.platformId).toBe("test-platform");
    expect(typeof res.body.tasksCompleted).toBe("number");
    expect(typeof res.body.agentUsdcPaid).toBe("number");
    expect(typeof res.body.platformFeeEarned).toBe("number");
    expect(typeof res.body.lastUpdated).toBe("number");
  });
});
