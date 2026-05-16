import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve("..");

const requiredDocs = [
  "README.md",
  "docs/API_REFERENCE.md",
  "docs/BUILDER_QUICKSTART.md",
  "docs/AGENT_QUICKSTART.md",
  "docs/SELLER_LISTING_GUIDE.md",
  "docs/RECEIPT_VERIFICATION.md",
  "docs/WEBHOOKS.md",
  "docs/BUILDER_FEES.md",
  "docs/ERROR_CODES.md",
  "docs/DNA_X402_PUBLIC_BETA_ACCEPTANCE.md",
];

const examples = [
  "buyer-agent-ts",
  "seller-paid-api-ts",
  "builder-monetized-agent-ts",
  "webhook-receiver-ts",
  "receipt-verifier-ts",
];

const publicBetaConfigPath = "config/x402.public-beta.example.json";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("builder developer launch pack", () => {
  it("ships the required Public Beta documentation without overclaiming unlimited production", () => {
    for (const doc of requiredDocs) {
      const text = read(doc);
      expect(text.length).toBeGreaterThan(200);
      expect(text).toContain("Public Beta");
    }

    const builderFees = read("docs/BUILDER_FEES.md");
    expect(builderFees).toContain("display_only");
    expect(builderFees).toContain("builder_accrual");
    expect(builderFees).toContain("public direct builder fee collection");
    expect(builderFees).toContain("not in beta scope");

    const apiReference = read("docs/API_REFERENCE.md");
    for (const phrase of [
      "seller profile",
      "signed manifest",
      "listing search",
      "Quote Request",
      "Commit",
      "Finalize",
      "Paid Retry",
      "Receipt Verify",
      "Webhooks",
      "Builder Fee Config",
      "Policy Errors",
      "Replay Errors",
    ]) {
      expect(apiReference).toContain(phrase);
    }
  });

  it("ships a Public Beta API config template with dangerous gates closed", () => {
    const config = JSON.parse(read(publicBetaConfigPath)) as {
      status?: string;
      api?: { baseUrl?: string; version?: string };
      settlement?: { publicBetaMoneyMovement?: string; backendSigning?: boolean; backendCustody?: boolean };
      fees?: {
        directSplitCollection?: string;
        autoSweep?: boolean;
        backendCustody?: boolean;
        hiddenFees?: boolean;
      };
      gates?: Record<string, boolean>;
      publicBeta?: { agentCreation?: boolean; paperAgents?: boolean; publicAgentProfiles?: boolean; copySettings?: boolean; alphaMonetization?: boolean; lowRiskLivePayments?: boolean };
      builderBeta?: { requiresVisibleFeeWaterfall?: boolean };
    };

    expect(config.status).toBe("PUBLIC_BETA_PILOT");
    expect(config.api?.baseUrl).toContain("beta");
    expect(config.api?.version).toBe("v1");
    expect(config.publicBeta).toMatchObject({
      agentCreation: true,
      paperAgents: true,
      publicAgentProfiles: true,
      copySettings: true,
      alphaMonetization: true,
      lowRiskLivePayments: true,
    });
    expect(config.settlement?.publicBetaMoneyMovement).toBe("open_with_caps");
    expect(config.settlement?.backendSigning).toBe(false);
    expect(config.settlement?.backendCustody).toBe(false);
    expect(config.fees?.directSplitCollection).toBe("separate_gate_required");
    expect(config.fees?.autoSweep).toBe(false);
    expect(config.fees?.backendCustody).toBe(false);
    expect(config.fees?.hiddenFees).toBe(false);
    expect(config.builderBeta?.requiresVisibleFeeWaterfall).toBe(true);

    for (const [gate, enabled] of Object.entries(config.gates ?? {})) {
      expect(enabled, `${gate} must stay disabled in Public Beta config`).toBe(false);
    }
  });

  it("ships runnable example project skeletons with acceptance tests", () => {
    for (const example of examples) {
      const base = path.join(repoRoot, "examples", example);
      expect(fs.existsSync(path.join(base, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(base, ".env.example"))).toBe(true);
      expect(fs.existsSync(path.join(base, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(base, "src", "index.ts"))).toBe(true);
      expect(fs.existsSync(path.join(base, "test", "acceptance.test.ts"))).toBe(true);

      const readme = fs.readFileSync(path.join(base, "README.md"), "utf8");
      expect(readme).toContain("npm install");
      expect(readme).toContain("npm run dev");
      expect(readme).toContain("npm test");
      expect(readme).toContain("Expected Output");

      const pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(pkg.scripts?.dev).toBeTruthy();
      expect(pkg.scripts?.test).toContain("vitest");
    }
  });

  it("keeps builder monetization examples in display/accrual mode only", () => {
    const builderExample = read("examples/builder-monetized-agent-ts/src/index.ts");
    expect(builderExample).toContain("builder_accrual");
    expect(builderExample).toContain("directSplitEnabled: false");
    expect(builderExample).not.toContain("direct_split");
    expect(builderExample).not.toContain("autoSweep");

    const acceptance = read("docs/DNA_X402_PUBLIC_BETA_ACCEPTANCE.md");
    expect(acceptance).toContain("public direct fee collection");
    expect(acceptance).toContain("direct split fee gate approval");
  });
});
