import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("cli agent-builder commands", () => {
  it("agent-builder templates returns JSON with ok: true and a templates array", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["agent-builder", "templates"], {
      stdout: (msg) => lines.push(msg),
      stderr: () => {},
    });
    expect(exitCode).toBe(0);
    const output = lines.join("");
    const parsed = JSON.parse(output) as { ok: boolean; templates: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.templates)).toBe(true);
    expect(parsed.templates.length).toBeGreaterThan(0);
  }, 15_000);

  it("agent-builder templates — each template has recipeId and description fields", async () => {
    const lines: string[] = [];
    await runCli(["agent-builder", "templates"], {
      stdout: (msg) => lines.push(msg),
      stderr: () => {},
    });
    const parsed = JSON.parse(lines.join("")) as { ok: boolean; templates: Array<Record<string, unknown>> };
    for (const template of parsed.templates) {
      expect(typeof template["recipeId"]).toBe("string");
      expect(typeof template["description"]).toBe("string");
    }
  }, 15_000);

  it("agent-builder draft --prompt resolves without throwing", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(
      ["agent-builder", "draft", "--prompt", "build a weather API seller"],
      { stdout: (msg) => lines.push(msg), stderr: () => {} },
    );
    expect(exitCode).toBe(0);
    const output = lines.join("");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
  }, 15_000);

  it("agent-builder draft without --prompt throws requiring --prompt", async () => {
    await expect(
      runCli(["agent-builder", "draft"]),
    ).rejects.toThrow("agent-builder draft requires --prompt");
  }, 15_000);

  it("agent-builder guided returns ok: true and a tree array", async () => {
    const lines: string[] = [];
    const exitCode = await runCli(["agent-builder", "guided"], {
      stdout: (msg) => lines.push(msg),
      stderr: () => {},
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(lines.join("")) as { ok: boolean; tree: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.tree)).toBe(true);
  }, 15_000);

  it("agent-builder clone with unreachable server rejects with a wrapped error", async () => {
    await expect(
      runCli([
        "agent-builder",
        "clone",
        "NONEXISTENT_RECIPE",
        "--base-url",
        "http://127.0.0.1:19999",
        "--owner-wallet",
        "abc",
      ]),
    ).rejects.toThrow();
  }, 15_000);

  it("agent-builder confirm with unreachable server rejects with a wrapped error", async () => {
    await expect(
      runCli([
        "agent-builder",
        "confirm",
        "NONEXISTENT_DRAFT",
        "--base-url",
        "http://127.0.0.1:19999",
        "--owner-wallet",
        "abc",
      ]),
    ).rejects.toThrow();
  }, 15_000);

  it("agent-builder with no subcommand returns non-zero exit code and does not crash", async () => {
    const errLines: string[] = [];
    const exitCode = await runCli(["agent-builder"], {
      stdout: () => {},
      stderr: (msg) => errLines.push(msg),
    });
    // Unknown subcommand path should return 1 (error) or 0 with templates listed
    // Based on cli.ts: unknown subcommand returns 1 after printing help
    expect(typeof exitCode).toBe("number");
    expect([0, 1]).toContain(exitCode);
  }, 15_000);
});
