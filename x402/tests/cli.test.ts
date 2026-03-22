import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { startDemoSeller } from "../src/demo/seller.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const current = cleanupPaths.pop();
    if (current && existsSync(current)) {
      rmSync(current, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

describe("dna-x402 cli", () => {
  it("scaffolds a seller starter without installing dependencies", async () => {
    const targetDir = makeTempDir("dna-x402-seller-");
    const exitCode = await runCli(["init", "seller", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(targetDir, "index.ts"))).toBe(true);
    expect(existsSync(path.join(targetDir, "vendor"))).toBe(true);
    expect(readFileSync(path.join(targetDir, "index.ts"), "utf8")).toContain("dnaSeller");
    expect(readFileSync(path.join(targetDir, "index.ts"), "utf8")).toContain("DNA_TRUSTED_LOCAL_NETTING");
    expect(readFileSync(path.join(targetDir, "package.json"), "utf8")).toContain("\"dna-x402\": \"file:./vendor/");
  });

  it("scaffolds a buyer starter without installing dependencies", async () => {
    const targetDir = makeTempDir("dna-x402-buyer-");
    const exitCode = await runCli(["init", "buyer", targetDir, "--no-install"]);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(targetDir, "index.ts"))).toBe(true);
    expect(existsSync(path.join(targetDir, "vendor"))).toBe(true);
    expect(readFileSync(path.join(targetDir, "index.ts"), "utf8")).toContain("fetchWith402");
    expect(readFileSync(path.join(targetDir, "package.json"), "utf8")).toContain("\"dna-x402\": \"file:./vendor/");
  });

  it("runs the demo buyer command against a live demo seller", async () => {
    const seller = await startDemoSeller({
      mode: "netting",
      port: 0,
      quiet: true,
    });
    try {
      const exitCode = await runCli([
        "demo",
        "buyer",
        "--mode",
        "netting",
        "--base-url",
        seller.baseUrl,
        "--quiet",
      ]);
      expect(exitCode).toBe(0);
    } finally {
      await seller.close();
    }
  });

  it("rejects an invalid demo mode", async () => {
    await expect(runCli(["demo", "seller", "--mode", "bogus"])).rejects.toThrow(
      "Invalid --mode: bogus. Expected transfer, netting, or stream.",
    );
  });

  it("rejects an invalid seller port", async () => {
    await expect(runCli(["demo", "seller", "--port", "abc"])).rejects.toThrow(
      "Invalid --port: abc. Expected an integer between 1 and 65535.",
    );
  });

  it("rejects an invalid buyer base url", async () => {
    await expect(runCli(["demo", "buyer", "--base-url", "not-a-url"])).rejects.toThrow(
      "Invalid --base-url: not-a-url. Expected an absolute http(s) URL.",
    );
  });
});
