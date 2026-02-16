import fs from "node:fs";
import path from "node:path";

interface EvidencePaths {
  env: string;
  tests: string;
  devnet: string;
  sim10: string;
  receipts: string;
  marketSnapshot: string;
  marketValidations: string;
  smoke: string;
  outMarkdown: string;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function readJson(pathToFile: string): any {
  return JSON.parse(fs.readFileSync(pathToFile, "utf8"));
}

function boolToYesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function makeReportBlock(data: {
  env: any;
  tests: any;
  devnet: any;
  smoke: any;
  marketValidations: any;
  paths: EvidencePaths;
}): string {
  const topFive = (data.tests.results ?? []).slice(0, 5)
    .map((row: any) => `  - ${row.name}: ${row.sha256}`)
    .join("\n");

  const fastCount = data.marketValidations.metrics?.fastCount ?? "n/a";
  const verifiedCount = data.marketValidations.metrics?.verifiedCount ?? "n/a";
  const invariant = data.marketValidations.invariants?.verifiedLteFast ? "PASS" : "FAIL";

  return [
    "1. **Git + tools**",
    `- commit: \`${data.env.git?.commit ?? "unavailable"}\``,
    `- dirty: \`${data.env.git?.dirty ?? "unavailable"}\``,
    `- node/npm/solana versions: \`${data.env.tools?.node ?? "n/a"}\` / \`${data.env.tools?.npm ?? "n/a"}\` / \`${data.env.tools?.solana ?? "n/a"}\``,
    "",
    "2. **Tests**",
    `- \`typecheck:x402\`: ${boolToYesNo((data.tests.results ?? []).find((r: any) => r.name === "typecheck")?.exitCode === 0).toUpperCase() === "YES" ? "PASS" : "FAIL"}`,
    `- \`npm test\`: ${boolToYesNo((data.tests.results ?? []).find((r: any) => r.name === "test")?.exitCode === 0).toUpperCase() === "YES" ? "PASS" : "FAIL"}`,
    `- \`test:wow\`: ${boolToYesNo((data.tests.results ?? []).find((r: any) => r.name === "wow")?.exitCode === 0).toUpperCase() === "YES" ? "PASS" : "FAIL"}`,
    `- \`sim:10agents\`: ${boolToYesNo((data.tests.results ?? []).find((r: any) => r.name === "sim10")?.exitCode === 0).toUpperCase() === "YES" ? "PASS" : "FAIL"}`,
    `- \`audit:full\`: ${boolToYesNo((data.tests.results ?? []).find((r: any) => r.name === "auditfull")?.exitCode === 0).toUpperCase() === "YES" ? "PASS" : "FAIL"}`,
    "- Attach `tests.json` SHA256 list (top 5 is fine)",
    topFive || "  - n/a",
    "",
    "3. **Devnet program**",
    `- program id: \`${data.devnet.program_id ?? "n/a"}\``,
    "- `solana program show` saved at: `audit_out/program_show.txt`",
    `- deploy ledger file: \`${data.devnet.deploy_ledger_file ?? "n/a"}\``,
    `- deploy delta SOL: \`${data.devnet.delta_sol ?? "n/a"}\``,
    `- buffers before/after: \`${data.devnet.buffers_before_count ?? "n/a"}\` -> \`${data.devnet.buffers_after_count ?? "n/a"}\``,
    `- reclaimed SOL from buffers: \`${data.devnet.reclaimed_sol ?? "n/a"}\``,
    "",
    "4. **Devnet smoke**",
    `- base url: \`${data.smoke.baseUrl ?? "not provided"}\``,
    `- 402 observed: ${data.smoke.first402Observed ? "yes" : "no"}`,
    `- 200 after pay: ${data.smoke.paid200Observed ? "yes" : "no"}`,
    `- receipt verified: ${data.smoke.receiptVerified ? "yes" : "no"}`,
    `- settlement mode: \`${data.smoke.settlementMode ?? "n/a"}\``,
    `- payment tx signature: \`${data.smoke.paymentTxSignature ?? "n/a"}\``,
    "",
    "5. **FAST vs VERIFIED**",
    `- FAST: \`${fastCount}\``,
    `- VERIFIED: \`${verifiedCount}\``,
    `- invariant VERIFIED <= FAST: ${invariant}`,
    "",
    "6. **Evidence pack paths**",
    `- \`${data.paths.outMarkdown.replace(/\/EVIDENCE.md$/, "/EVIDENCE.md")}\``,
    `- \`${data.paths.devnet}\``,
    `- \`${data.paths.marketSnapshot}\``,
    `- \`${data.paths.receipts}\``,
    `- \`${data.paths.sim10}\``,
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const x402Root = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const outDir = parseFlagValue(argv, "--out-dir") ?? path.join(x402Root, "audit_out");

  const paths: EvidencePaths = {
    env: path.join(outDir, "env.json"),
    tests: path.join(outDir, "tests.json"),
    devnet: path.join(outDir, "devnet.json"),
    sim10: path.join(outDir, "sim10.json"),
    receipts: path.join(outDir, "receipts_sample.json"),
    marketSnapshot: path.join(outDir, "market_snapshot.json"),
    marketValidations: path.join(outDir, "market_validations.json"),
    smoke: path.join(outDir, "devnet_smoke.json"),
    outMarkdown: path.join(outDir, "EVIDENCE.md"),
  };

  const env = readJson(paths.env);
  const tests = readJson(paths.tests);
  const devnet = readJson(paths.devnet);
  const sim10 = readJson(paths.sim10);
  const receipts = readJson(paths.receipts);
  const marketSnapshot = readJson(paths.marketSnapshot);
  const marketValidations = readJson(paths.marketValidations);
  const smoke = fs.existsSync(paths.smoke) ? readJson(paths.smoke) : {
    baseUrl: null,
    first402Observed: false,
    paid200Observed: false,
    receiptVerified: false,
  };

  const markdown = [
    "# EVIDENCE PACK",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Git + Tools",
    `- commit: \`${env.git?.commit ?? "unavailable"}\``,
    `- dirty: \`${env.git?.dirty ?? "unavailable"}\``,
    `- node: \`${env.tools?.node ?? "n/a"}\``,
    `- npm: \`${env.tools?.npm ?? "n/a"}\``,
    `- solana: \`${env.tools?.solana ?? "n/a"}\``,
    "",
    "## Tests",
    ...(tests.results ?? []).map((row: any) => `- ${row.name}: exit=${row.exitCode}, sha256=${row.sha256}`),
    "",
    "## Devnet",
    `- program id: \`${devnet.program_id ?? "n/a"}\``,
    `- deploy ledger: \`${devnet.deploy_ledger_file ?? "n/a"}\``,
    `- deploy delta SOL: \`${devnet.delta_sol ?? "n/a"}\``,
    `- buffers before/after: \`${devnet.buffers_before_count ?? "n/a"}\` -> \`${devnet.buffers_after_count ?? "n/a"}\``,
    `- reclaimed SOL: \`${devnet.reclaimed_sol ?? "n/a"}\``,
    "",
    "## Devnet Smoke",
    `- base url: \`${smoke.baseUrl ?? "not provided"}\``,
    `- first 402 observed: ${smoke.first402Observed ? "yes" : "no"}`,
    `- paid 200 observed: ${smoke.paid200Observed ? "yes" : "no"}`,
    `- receipt verified: ${smoke.receiptVerified ? "yes" : "no"}`,
    `- settlement mode: \`${smoke.settlementMode ?? "n/a"}\``,
    `- payment tx signature: \`${smoke.paymentTxSignature ?? "n/a"}\``,
    "",
    "## Simulation",
    `- passed scenarios: \`${sim10.passedScenarios ?? "n/a"}\``,
    `- failed scenarios: \`${sim10.failedScenarios ?? "n/a"}\``,
    `- FAST/VERIFIED: \`${sim10.analyticsConsistency?.fastCount24h ?? "n/a"}\` / \`${sim10.analyticsConsistency?.verifiedCount24h ?? "n/a"}\``,
    "",
    "## Receipts",
    `- sample size: \`${receipts.sampleSize ?? "n/a"}\``,
    `- valid count: \`${receipts.validCount ?? "n/a"}\``,
    `- tampered rejected: \`${receipts.negativeTests?.tamperedPayloadRejected ?? false}\``,
    `- wrong signature rejected: \`${receipts.negativeTests?.wrongSignatureRejected ?? false}\``,
    "",
    "## Market Integrity",
    `- VERIFIED <= FAST: \`${marketValidations.invariants?.verifiedLteFast ?? false}\``,
    `- dev ingest disabled: \`${marketValidations.invariants?.devIngestDisabled ?? false}\``,
    `- fulfilled+verified+receipt_valid gate: \`${marketValidations.invariants?.countedOnlyFulfilledPaymentVerifiedReceiptValid ?? false}\``,
    "",
    "## Artifacts",
    `- env: \`${paths.env}\``,
    `- tests: \`${paths.tests}\``,
    `- devnet: \`${paths.devnet}\``,
    `- sim10: \`${paths.sim10}\``,
    `- receipts: \`${paths.receipts}\``,
    `- market snapshot: \`${paths.marketSnapshot}\``,
    `- market validations: \`${paths.marketValidations}\``,
  ].join("\n");

  fs.writeFileSync(paths.outMarkdown, markdown);

  const reportBlock = makeReportBlock({ env, tests, devnet, smoke, marketValidations, paths });
  fs.writeFileSync(path.join(outDir, "REPORT_TO_CHATGPT.md"), reportBlock);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    evidence: paths.outMarkdown,
    reportBlock: path.join(outDir, "REPORT_TO_CHATGPT.md"),
    marketFast: marketValidations.metrics?.fastCount,
    marketVerified: marketValidations.metrics?.verifiedCount,
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
