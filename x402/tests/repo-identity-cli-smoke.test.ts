import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("public repo identity and built CLI smoke", () => {
  it("keeps dna-x402 as the canonical repository", () => {
    const output = execFileSync(process.execPath, ["scripts/check-repo-identity.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("repo identity ok");
  });

  it("runs the built dna-x402 CLI entrypoint", () => {
    const help = execFileSync(process.execPath, ["dist/cli.js"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(help).toContain("dna-x402");
    expect(help).toContain("agent-builder templates");

    const templates = execFileSync(process.execPath, ["dist/cli.js", "agent-builder", "templates"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(JSON.parse(templates)).toMatchObject({ ok: true });
  });
});
