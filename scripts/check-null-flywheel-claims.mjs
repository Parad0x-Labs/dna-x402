#!/usr/bin/env node
// check-null-flywheel-claims.mjs
// NULL_FLYWHEEL_VAULT_V1 — forbidden claim scanner
// Run: node scripts/check-null-flywheel-claims.mjs
//
// Scans flywheel crates and docs for language that implies price manipulation,
// guaranteed returns, or burn-pump mechanics.
// Does NOT scan pre-existing docs that legitimately reference these terms
// in detection/negation context (MemeTrans formula, INTERNAL_REVIEW, etc.).

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

// ─── Forbidden patterns ──────────────────────────────────────────────────────
const FORBIDDEN = [
  /buyback\s+pump/i,
  /price\s+support/i,
  /guaranteed\s+demand/i,
  /auto[\s-]?pump/i,
  /deflation\s+machine/i,
  /passive\s+income/i,
  /holders?\s+will\s+benefit/i,
  /burn\s+to\s+pump/i,
  /floor\s+support/i,
  /guaranteed\s+holder\s+value/i,
  /buyback\s+guarantee/i,
  /price\s+floor/i,
  /pump\s+the\s+price/i,
  /token\s+appreciation\s+guaranteed/i,
  /guaranteed\s+profit/i,
  /wash\s+trad/i,
  /fake\s+volume/i,
  /sybil\s+farm/i,
  /rug\s+tool/i,
];

// ─── Safe context — a line matching one of these is exempt ───────────────────
const SAFE_CONTEXTS = [
  /NOT.*claim/i,
  /does\s+not\s+claim/i,
  /not\s+a\s+guarantee/i,
  /scanner\s+blocks/i,
  /we\s+don.t\s+claim/i,
  /no\s+guarantee/i,
  /not\s+guaranteed/i,
  /<!-- dnc-allow -->/,
  /\/\/\//,            // Rust doc comments (///)
  /detect/i,           // lines discussing detection of the thing (not doing it)
  /\bNOT\b/,           // explicit NOT negation
];

// ─── Scan targets — flywheel-specific only ───────────────────────────────────
// Pre-existing docs that legitimately reference "wash trade" / "rug tool" etc.
// in detection context (MemeTrans formula, test cases) are excluded by design.
const SCAN_DIRS = [
  join('crates', 'null-flywheel-core'),
  join('crates', 'null-flywheel-randomizer'),
  join('crates', 'null-flywheel-receipts'),
  join('crates', 'null-flywheel-sim'),
];

// Individual files to scan (flywheel docs)
const SCAN_FILES = [
  join('docs', 'NULL_FLYWHEEL_VAULT.md'),
  join('docs', 'NULL_FLYWHEEL_PUBLIC_COPY.md'),
];

const SCAN_EXTENSIONS = new Set(['.md', '.rs', '.ts', '.mjs', '.js']);

// ─── Collect files from directory ─────────────────────────────────────────────
function collectFiles(dir) {
  let files = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      files = files.concat(collectFiles(full));
    } else if (SCAN_EXTENSIONS.has(extname(name))) {
      files.push(full);
    }
  }
  return files;
}

// ─── Build file list ──────────────────────────────────────────────────────────
let allFiles = [...SCAN_FILES];
for (const dir of SCAN_DIRS) {
  allFiles = allFiles.concat(collectFiles(dir));
}

// ─── Scan ─────────────────────────────────────────────────────────────────────
let violations = [];
let filesScanned = 0;

for (const filePath of allFiles) {
  filesScanned++;
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n');
  } catch {
    continue;
  }
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const isSafe = SAFE_CONTEXTS.some(rx => rx.test(line));
    if (isSafe) return;
    for (const pattern of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push({ file: filePath, line: lineNo, text: line.trim(), pattern: pattern.toString() });
      }
    }
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`NULL Flywheel claim scanner`);
console.log(`Scanned ${filesScanned} files (flywheel crates + NULL_FLYWHEEL docs only)`);
console.log('');

if (violations.length === 0) {
  console.log('✅  No forbidden claims found. NULL_FLYWHEEL_VAULT_V1 language is clean.');
  process.exit(0);
} else {
  console.error(`❌  ${violations.length} forbidden claim(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    text:    ${v.text}`);
    console.error(`    pattern: ${v.pattern}`);
    console.error('');
  }
  console.error('Fix: rewrite using safe language — "premium-fee conversion", "utility inventory",');
  console.error('"rewards vault", "capped randomized execution", "public receipts".');
  console.error('Or add <!-- dnc-allow --> on the line if context makes the claim safe.');
  process.exit(1);
}
