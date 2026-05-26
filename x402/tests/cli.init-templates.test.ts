import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const cleanupPaths: string[] = [];
afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});
function makeTempDir(prefix: string): string {
  const tmpRoot = path.resolve(process.cwd(), "..", "reports", "test-tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(path.join(tmpRoot, prefix));
  cleanupPaths.push(dir);
  return dir;
}

describe("cli init --template variants", () => {
  it("init agent --template service scaffolds a paid service agent with fetchWith402 pattern and package.json", async () => {
    const targetDir = makeTempDir("init-template-service-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "service", "--no-install"]);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(targetDir, "index.ts"))).toBe(true);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    // service template produces a seller agent using dnaSeller, not fetchWith402
    expect(index).toContain("dnaSeller");
    const pkg = readFileSync(path.join(targetDir, "package.json"), "utf8");
    expect(pkg).toContain("dna-x402");
  }, 30_000);

  it("init agent --template trading scaffolds a trading strategy agent with report/signal endpoints", async () => {
    const targetDir = makeTempDir("init-template-trading-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "trading", "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    // trading template has strategy endpoints
    expect(index).toContain("/strategy/report");
    expect(existsSync(path.join(targetDir, "manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(targetDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["shopId"]).toBe("trading-strategy-agent");
  }, 30_000);

  it("init agent --template auction scaffolds an auction tool agent with auction endpoints", async () => {
    const targetDir = makeTempDir("init-template-auction-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "auction", "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    expect(index).toContain("/auction/listings");
    const manifest = JSON.parse(readFileSync(path.join(targetDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["shopId"]).toBe("auction-tool-agent");
  }, 30_000);

  it("init agent --template restricted-market creates RESTRICTED_MARKET_DISABLED guard", async () => {
    const targetDir = makeTempDir("init-template-restricted-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "restricted-market", "--no-install"]);
    expect(exitCode).toBe(0);
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    expect(index).toContain("RESTRICTED_MARKET_DISABLED");
    const manifest = JSON.parse(readFileSync(path.join(targetDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["shopId"]).toBe("restricted-market-shell");
  }, 30_000);

  it("init agent --template marketplace creates marketplace manifest with manifest.json and sign-manifest.ts", async () => {
    const targetDir = makeTempDir("init-template-marketplace-");
    const exitCode = await runCli(["init", "agent", targetDir, "--template", "marketplace", "--no-install"]);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(targetDir, "manifest.json"))).toBe(true);
    expect(existsSync(path.join(targetDir, "sign-manifest.ts"))).toBe(true);
    const manifest = readFileSync(path.join(targetDir, "manifest.json"), "utf8");
    expect(manifest).toContain("marketplace-agent");
  }, 30_000);

  it("init agent --template service --force over an existing dir does not fail and overwrites", async () => {
    const targetDir = makeTempDir("init-template-force-");
    // First scaffold
    const firstExit = await runCli(["init", "agent", targetDir, "--template", "service", "--no-install"]);
    expect(firstExit).toBe(0);
    // Second scaffold with --force over same dir
    const secondExit = await runCli(["init", "agent", targetDir, "--template", "service", "--force", "--no-install"]);
    expect(secondExit).toBe(0);
    // The file should still exist and have the expected content
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    expect(index).toContain("dnaSeller");
  }, 30_000);

  it("init agent without --template defaults to service template without error", async () => {
    const targetDir = makeTempDir("init-template-default-");
    const exitCode = await runCli(["init", "agent", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    // Default is service template — should produce dnaSeller usage
    const index = readFileSync(path.join(targetDir, "index.ts"), "utf8");
    expect(index).toContain("dnaSeller");
  }, 30_000);

  it("init agent --template INVALID_TEMPLATE_XYZ throws with message about valid templates", async () => {
    const targetDir = makeTempDir("init-template-invalid-");
    await expect(
      runCli(["init", "agent", targetDir, "--template", "INVALID_TEMPLATE_XYZ", "--no-install"]),
    ).rejects.toThrow("Invalid --template");
  }, 30_000);
});
