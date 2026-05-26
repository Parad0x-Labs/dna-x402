#!/usr/bin/env node
/**
 * check-cost-constitution.mjs
 *
 * Scans crates/<name>/src/lib.rs for forbidden anti-patterns that
 * violate the Dark Null cost constitution. Docs are listed but not pattern-scanned
 * (doc files describe the patterns and would self-trigger). Also verifies each
 * crate directory contains a lib.rs.
 *
 * Exits 0 if clean, 1 if violations found.
 * Outputs a JSON summary.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Forbidden patterns — any of these in source means a rent-bomb risk
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  { pattern: /per-user\s+PDA/i,     label: 'per-user PDA' },
  { pattern: /per-receipt\s+PDA/i,  label: 'per-receipt PDA' },
  { pattern: /per-action\s+PDA/i,   label: 'per-action PDA' },
  { pattern: /no\s+per-user/i,      label: 'no per-user (ambiguous negation)' },
  { pattern: /rent\s+bomb/i,        label: 'rent bomb' },
];

const violations = [];
const scannedFiles = [];

// ---------------------------------------------------------------------------
// Helper: scan a single file for forbidden patterns
// ---------------------------------------------------------------------------
function scanFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    return; // unreadable — skip silently
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(lines[i])) {
        violations.push({
          file: filePath.replace(ROOT, '.'),
          line: i + 1,
          pattern: label,
          text: lines[i].trim().slice(0, 120),
        });
      }
    }
  }
  scannedFiles.push(filePath.replace(ROOT, '.'));
}

// ---------------------------------------------------------------------------
// 1. List docs/*.md (existence check only — docs describe patterns so are excluded
//    from the forbidden-pattern lint to avoid self-triggering false positives)
// ---------------------------------------------------------------------------
const docsDir = join(ROOT, 'docs');
const docFiles = existsSync(docsDir)
  ? readdirSync(docsDir).filter(f => f.endsWith('.md'))
  : [];
// (doc files noted in summary but not scanned for forbidden patterns)

// ---------------------------------------------------------------------------
// 2. Scan crates/<name>/src/lib.rs and check existence
// ---------------------------------------------------------------------------
const cratesDir = join(ROOT, 'crates');
const missingLibRs = [];

if (existsSync(cratesDir)) {
  const crateDirs = readdirSync(cratesDir).filter(name => {
    try {
      return statSync(join(cratesDir, name)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const crate of crateDirs) {
    const libPath = join(cratesDir, crate, 'src', 'lib.rs');
    if (!existsSync(libPath)) {
      missingLibRs.push(`crates/${crate}/src/lib.rs`);
    } else {
      scanFile(libPath);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Build summary
// ---------------------------------------------------------------------------
const summary = {
  timestamp: new Date().toISOString(),
  rust_files_scanned: scannedFiles.length,
  doc_files_found: docFiles.length,
  doc_files_note: 'docs are not pattern-scanned (they describe forbidden patterns, not implement them)',
  violations,
  missing_lib_rs: missingLibRs,
  status: (violations.length === 0 && missingLibRs.length === 0) ? 'CLEAN' : 'VIOLATIONS_FOUND',
};

console.log(JSON.stringify(summary, null, 2));

if (violations.length > 0) {
  console.error(`\n[FAIL] ${violations.length} forbidden pattern(s) found.`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — [${v.pattern}] "${v.text}"`);
  }
}

if (missingLibRs.length > 0) {
  console.error(`\n[FAIL] ${missingLibRs.length} crate(s) missing lib.rs:`);
  for (const p of missingLibRs) {
    console.error(`  ${p}`);
  }
}

if (summary.status === 'CLEAN') {
  console.error('\n[PASS] Cost constitution check clean.');
}

process.exit(summary.status === 'CLEAN' ? 0 : 1);
