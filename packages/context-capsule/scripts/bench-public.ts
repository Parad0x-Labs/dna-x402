#!/usr/bin/env tsx
/**
 * Context Capsule Public Benchmark
 * Reproducible proof: token savings + memory recovery quality
 *
 * Run: npm run bench:public
 * Gate: savings >= 95%, recovery >= 90%, runtime < 1000ms
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compressContext, injectCapsule, searchCapsule, estimateSavings } from '../src/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.argv.find(a => a.startsWith('--fixture='))?.split('=')[1] ?? 'agent-session-100'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryQuestion {
  question: string
  required_keywords: string[]
}

interface QuestionResult {
  question: string
  passed: boolean
  matched_keywords: string[]
  missing_keywords: string[]
}

interface BenchResults {
  fixture: string
  original_tokens: number
  capsule_tokens: number
  saved_tokens: number
  savings_percent: number
  recovery_score_percent: number
  runtime_ms: number
  questions_total: number
  questions_passed: number
  passed_gates: boolean
  gate_savings_ok: boolean
  gate_recovery_ok: boolean
  gate_runtime_ok: boolean
  per_question: QuestionResult[]
  timestamp: string
}

// ── Load fixtures ─────────────────────────────────────────────────────────────

const fixturesDir = join(__dirname, '..', 'bench', 'fixtures')
const resultsDir  = join(__dirname, '..', 'bench', 'results')

const fixturePath   = join(fixturesDir, `${FIXTURE}.json`)
const questionsPath = join(fixturesDir, 'recovery-questions.json')

let messages: { role: string; content: string }[]
try {
  messages = JSON.parse(readFileSync(fixturePath, 'utf8'))
} catch (err) {
  console.error(`ERROR: Could not load fixture at ${fixturePath}`)
  console.error((err as Error).message)
  process.exit(1)
}

let recoveryQuestions: RecoveryQuestion[]
try {
  recoveryQuestions = JSON.parse(readFileSync(questionsPath, 'utf8'))
} catch (err) {
  console.error(`ERROR: Could not load recovery questions at ${questionsPath}`)
  console.error((err as Error).message)
  process.exit(1)
}

// ── Run benchmark ─────────────────────────────────────────────────────────────

const startMs = Date.now()

// 1. Build context capsule
const capsule = compressContext(messages, { sessionId: `bench-${FIXTURE}` })

// 2. Token counts
const injection      = injectCapsule(capsule)
const originalTokens = capsule.originalTokenEstimate
const capsuleTokens  = Math.ceil(injection.length / 4)

// 3. Savings %
const savings       = estimateSavings(messages, capsule)
const savingsNum    = parseFloat(savings.savedPercent)   // strip trailing '%'

// 4. Recovery questions
const questionResults: QuestionResult[] = []

for (const q of recoveryQuestions) {
  const result = searchCapsule(capsule, q.question)
  const lower  = result.toLowerCase()

  const matched: string[] = []
  const missing: string[] = []

  for (const kw of q.required_keywords) {
    if (lower.includes(kw.toLowerCase())) {
      matched.push(kw)
    } else {
      missing.push(kw)
    }
  }

  questionResults.push({
    question:          q.question,
    passed:            missing.length === 0,
    matched_keywords:  matched,
    missing_keywords:  missing,
  })
}

const runtimeMs       = Date.now() - startMs
const questionsPassed = questionResults.filter(r => r.passed).length
const questionsTotal  = questionResults.length
const recoveryScore   = Math.round((questionsPassed / questionsTotal) * 100 * 10) / 10

// 5. Gate checks
const gateSavings  = savingsNum  >= 95
const gateRecovery = recoveryScore >= 90
const gateRuntime  = runtimeMs   < 1000
const allGatesPassed = gateSavings && gateRecovery && gateRuntime

// ── Assemble results ──────────────────────────────────────────────────────────

const benchResults: BenchResults = {
  fixture:                FIXTURE,
  original_tokens:        originalTokens,
  capsule_tokens:         capsuleTokens,
  saved_tokens:           originalTokens - capsuleTokens,
  savings_percent:        savingsNum,
  recovery_score_percent: recoveryScore,
  runtime_ms:             runtimeMs,
  questions_total:        questionsTotal,
  questions_passed:       questionsPassed,
  passed_gates:           allGatesPassed,
  gate_savings_ok:        gateSavings,
  gate_recovery_ok:       gateRecovery,
  gate_runtime_ok:        gateRuntime,
  per_question:           questionResults,
  timestamp:              new Date().toISOString(),
}

// ── Write results/latest.json ─────────────────────────────────────────────────

mkdirSync(resultsDir, { recursive: true })
writeFileSync(
  join(resultsDir, 'latest.json'),
  JSON.stringify(benchResults, null, 2),
  'utf8'
)

// ── Write results/latest.md ───────────────────────────────────────────────────

function gateIcon(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL'
}

const mdLines: string[] = [
  '# Context Capsule Public Benchmark Report',
  '',
  `**Fixture:** \`${FIXTURE}\`  `,
  `**Timestamp:** ${benchResults.timestamp}`,
  '',
  '## Metrics',
  '',
  '| Metric | Value | Gate | Status |',
  '|--------|-------|------|--------|',
  `| Token savings | ${savingsNum.toFixed(1)}% | >= 95% | **${gateIcon(gateSavings)}** |`,
  `| Recovery score | ${recoveryScore.toFixed(1)}% | >= 90% | **${gateIcon(gateRecovery)}** |`,
  `| Runtime | ${runtimeMs}ms | < 1000ms | **${gateIcon(gateRuntime)}** |`,
  `| Original tokens | ${originalTokens} | — | — |`,
  `| Capsule tokens | ${capsuleTokens} | — | — |`,
  `| Saved tokens | ${benchResults.saved_tokens} | — | — |`,
  `| Questions passed | ${questionsPassed}/${questionsTotal} | — | — |`,
  '',
  `**Overall: ${allGatesPassed ? 'ALL GATES PASSED' : 'ONE OR MORE GATES FAILED'}**`,
  '',
  '## Per-Question Recovery Results',
  '',
  '| # | Question | Result | Matched Keywords | Missing Keywords |',
  '|---|----------|--------|-----------------|-----------------|',
]

questionResults.forEach((r, i) => {
  const icon     = r.passed ? 'PASS' : 'FAIL'
  const matched  = r.matched_keywords.length > 0 ? r.matched_keywords.join(', ') : '—'
  const missing  = r.missing_keywords.length > 0 ? r.missing_keywords.join(', ') : '—'
  mdLines.push(`| ${i + 1} | ${r.question} | **${icon}** | ${matched} | ${missing} |`)
})

mdLines.push(
  '',
  '## Reproduce',
  '',
  '```bash',
  'npm run bench:public',
  '# With a custom fixture:',
  `npm run bench:public -- --fixture=${FIXTURE}`,
  '```',
  '',
  '> **Warning:** This benchmark tests the included fixture only. Results vary by content type.',
  '',
)

writeFileSync(
  join(resultsDir, 'latest.md'),
  mdLines.join('\n'),
  'utf8'
)

// ── Print summary to stdout ───────────────────────────────────────────────────

const sep = '─'.repeat(60)

console.log('')
console.log('╔══════════════════════════════════════════════════════════╗')
console.log('║         CONTEXT CAPSULE PUBLIC PROOF                    ║')
console.log('╚══════════════════════════════════════════════════════════╝')
console.log('')
console.log(`  Fixture   : ${FIXTURE}`)
console.log(`  Messages  : ${messages.length}`)
console.log(sep)
console.log('')
console.log('  TOKEN SAVINGS')
console.log(`    Original tokens   : ${originalTokens}`)
console.log(`    Capsule tokens    : ${capsuleTokens}`)
console.log(`    Saved tokens      : ${benchResults.saved_tokens}`)
console.log(`    Savings %         : ${savingsNum.toFixed(1)}%   [gate: >= 95%]  ${gateSavings ? 'PASS' : 'FAIL'}`)
console.log('')
console.log('  MEMORY RECOVERY QUALITY')
console.log(`    Questions tested  : ${questionsTotal}`)
console.log(`    Questions passed  : ${questionsPassed}`)
console.log(`    Recovery score    : ${recoveryScore.toFixed(1)}%   [gate: >= 90%]  ${gateRecovery ? 'PASS' : 'FAIL'}`)
console.log('')
console.log('  PERFORMANCE')
console.log(`    Runtime           : ${runtimeMs}ms       [gate: < 1000ms] ${gateRuntime ? 'PASS' : 'FAIL'}`)
console.log('')
console.log(sep)
console.log('')

if (allGatesPassed) {
  console.log('  RESULT: ALL GATES PASSED')
} else {
  console.log('  RESULT: GATES FAILED')
  if (!gateSavings)  console.log(`    - Savings ${savingsNum.toFixed(1)}% is below the 95% threshold`)
  if (!gateRecovery) console.log(`    - Recovery ${recoveryScore.toFixed(1)}% is below the 90% threshold`)
  if (!gateRuntime)  console.log(`    - Runtime ${runtimeMs}ms exceeds the 1000ms limit`)
}

console.log('')
console.log('  Per-question summary:')
questionResults.forEach((r, i) => {
  const icon = r.passed ? '[PASS]' : '[FAIL]'
  console.log(`    ${icon} Q${String(i + 1).padStart(2, '0')}: ${r.question}`)
  if (!r.passed && r.missing_keywords.length > 0) {
    console.log(`          missing: ${r.missing_keywords.join(', ')}`)
  }
})

console.log('')
console.log(sep)
console.log(`  Results written to bench/results/latest.json and latest.md`)
console.log(`  Reproduce: npm run bench:public`)
console.log(sep)
console.log('')

// ── Exit code ─────────────────────────────────────────────────────────────────

if (!allGatesPassed) {
  process.exit(1)
}
