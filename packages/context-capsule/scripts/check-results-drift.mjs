#!/usr/bin/env node
/**
 * Fails when a fresh benchmark run disagrees with the committed result files,
 * ignoring fields that legitimately change between runs (timestamp, runtime,
 * Node version). Keeps the published numbers tied to the current source.
 *
 * Usage: node scripts/check-results-drift.mjs <committed-results-dir> <fresh-results-dir>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const [committedDir, freshDir] = process.argv.slice(2)
if (!committedDir || !freshDir) {
  console.error('usage: check-results-drift.mjs <committed-dir> <fresh-dir>')
  process.exit(2)
}
const VOLATILE = new Set(['timestamp', 'runtime_ms', 'node'])
const strip = (v) => Array.isArray(v)
  ? v.map(strip)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, strip(x)]))
    : v

let failed = 0
for (const f of ['latest.json', 'scope.json', 'e2e-dryrun.json']) {
  const a = strip(JSON.parse(readFileSync(join(committedDir, f), 'utf8')))
  const b = strip(JSON.parse(readFileSync(join(freshDir, f), 'utf8')))
  if (isDeepStrictEqual(a, b)) {
    console.log(`ok    ${f}`)
  } else {
    failed++
    console.log(`DRIFT ${f}: committed result differs from a fresh run; regenerate and commit bench/results/`)
  }
}
process.exit(failed ? 1 : 0)
