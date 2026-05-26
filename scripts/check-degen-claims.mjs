// NOT_PRODUCTION scan — run before any public post or commit to check for forbidden marketing claims

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Forbidden pattern definitions
// Each entry: { pattern: RegExp, reason: string }
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  {
    pattern: /untraceable|invisible wallet|anonymize your wallet/i,
    reason: "wallet anonymity claim",
  },
  {
    pattern: /guaranteed (profit|return|yield|income)/i,
    reason: "guaranteed profit claim",
  },
  {
    pattern: /100% private|completely private|fully anonymous/i,
    reason: "absolute privacy claim",
  },
  {
    pattern: /mainnet.ready\s*[:=]\s*true/i,
    reason: "mainnet_ready flag set to true",
  },
  {
    pattern: /production.claim\s*[:=]\s*true/i,
    reason: "production_claim flag set to true",
  },
  {
    pattern: /mixer|tumbler|tornado/i,
    reason: "mixer/tumbler reference",
  },
  {
    pattern: /rug\s*(tool|kit|protocol)|wash.trad(e|ing) feature|sybil.farm/i,
    reason: "rug/wash/sybil tooling",
  },
  {
    pattern: /casino|gambling(?! forbidden)|guaranteed win/i,
    reason: "casino mechanic without gate",
  },
  {
    pattern: /agent_had_private_key\s*[:=]\s*true/i,
    reason: "agent private key claim",
  },
  {
    pattern: /make money (while|sleeping|automatically)|earn.*without.*risk/i,
    reason: "passive income without risk claim",
  },
];

// ---------------------------------------------------------------------------
// Recursive directory scanner
// Returns an array of absolute file paths with the given extension.
// ---------------------------------------------------------------------------
function scanDir(dir, ext) {
  const results = [];

  // Return empty if directory doesn't exist
  if (!fs.existsSync(dir)) {
    return results;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const nested = scanDir(fullPath, ext);
      for (const f of nested) {
        results.push(f);
      }
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Negation prefixes: lines that DENY or BLOCK the forbidden thing are safe.
// Examples: "NOT a mixer", "does NOT use gambling", "no casino mechanics"
// Also skips: Rust test strings (the string being tested against), doc comments
// listing examples of banned terms, and any line ending with // dnc-allow
// ---------------------------------------------------------------------------
const NEGATION_PATTERN = /\b(NOT|not a|does not|is not|is NOT|does NOT|no |cannot|block|forbid|prevent|reject|deny|avoid|disallow|explicitly banned|detect|scan for|test.*forbidden|check.*forbidden|wagering.*block|gambling.*block|block.*wager|block.*gambl|remain.*blocked|lists?\s+(restricted|blocked|banned))\b/i;

// Known technical term exceptions — these use words that pattern-match but mean something different
const TECHNICAL_EXCEPTIONS = [
  /ALT [Ss]hape [Mm]ixer/,          // "ALT Shape Mixer" is a tx-shape anonymity tool, not a coin mixer
  /shape.pool.*mixer/i,              // shape-pool mixer = tx fingerprint tool
  /shape mixer/i,                    // same
  /Casino energy/i,                  // figurative marketing energy, not a casino service
  /Tornado Cash.*gap/i,              // academic reference to an existing system's gap
  /Zcash.*Tornado/i,                 // academic comparison context
  /mainnet.ready.*must fail/i,       // test code asserting mainnet_ready=true is rejected
  /mainnet_ready = true/,            // test code setting the flag to verify rejection
  /check_forbidden_claims\(/,        // calling the function that tests for forbidden claims
  /ForbiddenClaim/,                  // the error type, not an actual forbidden claim
];

function isExempt(line) {
  const trimmed = line.trim();
  // Explicit exemption marker
  if (trimmed.endsWith("// dnc-allow") || trimmed.includes("<!-- dnc-allow -->")) return true;
  // Technical term exceptions
  for (const exc of TECHNICAL_EXCEPTIONS) {
    if (exc.test(line)) return true;
  }
  // Negation context
  if (NEGATION_PATTERN.test(trimmed)) return true;
  // Rust doc comments listing forbidden terms (e.g. /// "guaranteed profit")
  if (trimmed.startsWith("///")) return true;
  // Rust module doc comments
  if (trimmed.startsWith("//!")) return true;
  // Lines that are pure string literals being tested (starts with quote)
  if (/^\s*["']/.test(line)) return true;
  // Test assertion lines (assert! assert_eq! assert_ne! etc.)
  if (/assert.*forbidden|forbidden.*assert/i.test(trimmed)) return true;
  if (/assert_eq!\(phrase,\s*"/.test(trimmed)) return true;
  // Test comment lines explaining the test
  if (/^\/\/\s*(15\.|16\.|test.*forbidden|forbidden.*test)/i.test(trimmed)) return true;
  // Markdown list items that enumerate BLOCKED/RESTRICTED categories
  // e.g. "- casinos, poker, roulette..." in a policy doc blocking those things
  if (/^\s*-\s+(casino|poker|roulette|slots?|loteri|wager|gambl)/i.test(line)) return true;
  // Lines explicitly saying these listings are blocked/restricted by policy
  if (/block.*wager|wager.*block|block.*gambl|gambl.*block|regulated.*wager|restricted.*gambl/i.test(trimmed)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Check a single file for forbidden patterns.
// Returns an array of violation objects:
//   { file, line, lineNumber, patternReason }
// ---------------------------------------------------------------------------
function checkFile(filePath) {
  const violations = [];
  let content;

  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`ERROR: Could not read file: ${filePath} — ${err.message}`);
    return violations;
  }

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Skip lines in exemption context
    if (isExempt(line)) continue;

    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: filePath,
          lineNumber,
          line: line.trim(),
          reason,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------
function main() {
  // Resolve paths relative to this script's location
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..");

  const docsDir = path.join(projectRoot, "docs");
  const cratesDir = path.join(projectRoot, "crates");

  console.log("Dark Null forbidden-claims scanner");
  console.log("===================================");
  console.log(`Scanning docs (*.md):   ${docsDir}`);
  console.log(`Scanning crates (*.rs): ${cratesDir}`);
  console.log("");

  // Collect files
  const mdFiles = scanDir(docsDir, ".md");
  const rsFiles = scanDir(cratesDir, ".rs");
  const allFiles = [...mdFiles, ...rsFiles];

  if (allFiles.length === 0) {
    console.log("WARNING: No files found to scan. Check that docs/ and crates/ exist.");
    process.exit(0);
  }

  console.log(`Found ${mdFiles.length} .md file(s) and ${rsFiles.length} .rs file(s).`);
  console.log("");

  // Scan all files
  const allViolations = [];

  for (const filePath of allFiles) {
    const fileViolations = checkFile(filePath);
    for (const v of fileViolations) {
      allViolations.push(v);
    }
  }

  // Report
  if (allViolations.length === 0) {
    console.log("✅ No forbidden claims found.");
    process.exit(0);
  } else {
    console.log(`❌ ${allViolations.length} forbidden claim(s) found:\n`);

    for (const v of allViolations) {
      // Print relative path for readability
      const relPath = path.relative(projectRoot, v.file);
      console.log(`  FILE:    ${relPath}`);
      console.log(`  LINE:    ${v.lineNumber}`);
      console.log(`  PATTERN: ${v.reason}`);
      console.log(`  TEXT:    ${v.line}`);
      console.log("");
    }

    console.log(`Total violations: ${allViolations.length}`);
    console.log("Fix all violations before publishing or committing.");
    process.exit(1);
  }
}

main();
