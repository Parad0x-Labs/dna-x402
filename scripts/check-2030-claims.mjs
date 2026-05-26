#!/usr/bin/env node
// check-2030-claims.mjs — block overblown marketing claims from docs

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const FORBIDDEN = [
  /\bproduction[- ]ready\b/i,
  /\baudited\b/i,
  /\bend-to-end private\b/i,
  /\bmainnet[- ]ready\b/i,
  /\bsolved custody\b/i,
  /\bzero[- ]knowledge proven\b/i,
  /\bfully private\b/i,
  /\bno[- ]leakage\b/i,
];

const DOCS_DIR = 'docs';
let violations = 0;

function scanFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(line)) {
        console.error(`❌ ${filePath}:${i + 1}: "${line.trim()}" matches forbidden pattern ${pattern}`);
        violations++;
      }
    }
  });
}

const files = [
  'README.md',
  ...readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).map(f => join(DOCS_DIR, f)),
].filter(f => existsSync(f));

console.log(`🔍 Scanning ${files.length} markdown files for overblown claims...\n`);
for (const f of files) scanFile(f);

if (violations > 0) {
  console.error(`\n❌ ${violations} forbidden claim(s) found. Fix before publishing.`);
  process.exit(1);
} else {
  console.log('✅ No forbidden claims found.');
}
