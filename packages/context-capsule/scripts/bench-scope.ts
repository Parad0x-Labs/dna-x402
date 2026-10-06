#!/usr/bin/env node
/**
 * Context Capsule scope benchmark (deterministic, no LLM).
 *
 * bench-public.ts reports one savings number and one recovery number. They come
 * from different stages of the pipeline: savings is measured on the initial
 * injectCapsule() pointer string, recovery is measured on searchCapsule() output.
 * This script measures each stage separately on the same fixture and the same
 * 40 questions, and adds the baselines a reader needs to interpret them:
 *
 *   archive        JSONL bytes vs zlib bytes vs base64 bytes held in the capsule
 *   initial prompt full history vs injectCapsule() vs injectEnrichedCapsule()
 *   per-question   text that would reach the model for each arm, its chars/4
 *                  token estimate, and whether every required keyword is in it
 *
 * Arms (per question):
 *   full_history         every message, "[ROLE]: content", no compression
 *   window_last_10/20    the most recent N messages only
 *   capsule_only         injectCapsule() alone (no-retrieval negative control)
 *   capsule_search_q     injectCapsule() + searchCapsule(capsule, <question text>)
 *                        (this is exactly what bench-public.ts scores)
 *   capsule_search_kw    injectCapsule() + searchCapsule(capsule, <question
 *                        content words>) — stop words and words < 4 chars removed
 *   capsule_search_kw_limit8  same query with searchCapsule(..., { limit: 8 })
 *   retrieval_top8       ordinary retrieval baseline, no capsule: the 8 messages
 *                        sharing the most distinct question content words
 *
 * "keyword pass" = all required_keywords appear (case-insensitive) in the text.
 * It is a deterministic availability check, NOT model task success: it says
 * whether the answer text is present in what the model would receive, not
 * whether a model answers correctly. No model is called.
 *
 * Run:  node --experimental-strip-types scripts/bench-scope.ts
 * Out:  bench/results/scope.json, bench/results/scope.md
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import {
  compressContext, injectCapsule, searchCapsule,
  taggedCompressContext, injectEnrichedCapsule,
} from '../src/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = process.argv.find(a => a.startsWith('--fixture='))?.split('=')[1] ?? 'agent-session-100'
const fixturesDir = join(__dirname, '..', 'bench', 'fixtures')
const resultsDir = join(__dirname, '..', 'bench', 'results')

type Msg = { role: string; content: string }
type Q = { id: number; question: string; required_keywords: string[]; category?: string; unanswerable?: boolean }

const messages: Msg[] = JSON.parse(readFileSync(join(fixturesDir, `${FIXTURE}.json`), 'utf8'))
const questions: Q[] = JSON.parse(readFileSync(join(fixturesDir, 'recovery-questions.json'), 'utf8'))

const tok = (s: string) => Math.ceil(s.length / 4)
const fmt = (ms: Msg[]) => ms.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n')
const pass = (text: string, kws: string[]) => {
  const lower = text.toLowerCase()
  return kws.every(k => lower.includes(k.toLowerCase()))
}

// Deterministic, non-oracle query builder: question content words only.
const STOP = new Set([
  'what', 'which', 'when', 'where', 'were', 'with', 'that', 'this', 'from', 'have',
  'does', 'used', 'into', 'about', 'there', 'their', 'they', 'them', 'than', 'then',
  'been', 'being', 'will', 'would', 'should', 'could', 'after', 'before', 'during',
  'exactly', 'specific', 'session', 'point', 'equivalent',
])
const contentQuery = (q: string) =>
  (q.toLowerCase().match(/[a-z0-9_.@/-]+/g) ?? [])
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(w => w.length >= 4 && !STOP.has(w))
    .join(' ')

// Score only the returned message bodies, never the header line. (Before 1.2.0
// the header repeated the query, so a keyword taken from the question could pass.)
const body = (r: string) => r.replace(/^\[CAPSULE SEARCH[^\n]*\n*/, '')

// Count messages a searchCapsule() call returned, from its header line.
const returnedCount = (r: string) => {
  const m = r.match(/— (\d+)\/(\d+) messages\]/)
  return m ? Number(m[1]) : 0
}

const t0 = Date.now()
const capsule = compressContext(messages, { sessionId: `bench-${FIXTURE}` })
const injection = injectCapsule(capsule)
const enriched = injectEnrichedCapsule(taggedCompressContext(messages, { sessionId: `bench-${FIXTURE}` }))

// ── Archive stage ─────────────────────────────────────────────────────────────
const jsonl = messages.map(m => JSON.stringify(m)).join('\n')
const jsonlBytes = Buffer.byteLength(jsonl, 'utf8')
const zlibBytes = deflateSync(Buffer.from(jsonl, 'utf8'), { level: 9 }).length
const base64Bytes = Buffer.byteLength(capsule.compressedBase64, 'utf8')
const capsuleObjectBytes = Buffer.byteLength(JSON.stringify(capsule), 'utf8')

// ── Initial prompt stage ──────────────────────────────────────────────────────
const fullText = fmt(messages)
const contentOnlyChars = messages.reduce((n, m) => n + m.content.length, 0)

// ── Per-question arms ─────────────────────────────────────────────────────────
type ArmRow = { tokens: number; pass: boolean; returned?: number }
const armNames = [
  'full_history', 'window_last_10', 'window_last_20',
  'capsule_only', 'capsule_search_q', 'capsule_search_kw', 'capsule_search_kw_limit8', 'retrieval_top8',
] as const
type Arm = typeof armNames[number]

// A question is answerable only if all its keywords occur in the session itself.
const contentText = messages.map(m => m.content).join('\n')

const perQuestion: Array<{
  id: number; category?: string; query_kw: string; answerable: boolean
} & Record<Arm, ArmRow>> = []
for (const q of questions) {
  const w10 = fmt(messages.slice(-10))
  const w20 = fmt(messages.slice(-20))
  const rq = searchCapsule(capsule, q.question)
  const kwq = contentQuery(q.question)
  const rk = searchCapsule(capsule, kwq)
  const rk8 = searchCapsule(capsule, kwq, { limit: 8 })
  const withInj = (r: string) => `${injection}\n\n${r}`
  const terms = new Set(kwq.split(' ').filter(Boolean))
  const top8 = fmt(messages
    .map((m, i) => ({ m, i, s: [...terms].filter(t => m.content.toLowerCase().includes(t)).length }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 8)
    .sort((a, b) => a.i - b.i)
    .map(x => x.m))
  perQuestion.push({
    id: q.id,
    category: q.category,
    query_kw: kwq,
    answerable: pass(contentText, q.required_keywords),
    full_history: { tokens: tok(fullText), pass: pass(fullText, q.required_keywords) },
    window_last_10: { tokens: tok(w10), pass: pass(w10, q.required_keywords) },
    window_last_20: { tokens: tok(w20), pass: pass(w20, q.required_keywords) },
    capsule_only: { tokens: tok(injection), pass: pass(injection, q.required_keywords) },
    capsule_search_q: { tokens: tok(withInj(rq)), pass: pass(body(rq), q.required_keywords), returned: returnedCount(rq) },
    capsule_search_kw: { tokens: tok(withInj(rk)), pass: pass(body(rk), q.required_keywords), returned: returnedCount(rk) },
    capsule_search_kw_limit8: { tokens: tok(withInj(rk8)), pass: pass(body(rk8), q.required_keywords), returned: returnedCount(rk8) },
    retrieval_top8: { tokens: tok(top8), pass: pass(top8, q.required_keywords) },
  })
}
const runtimeMs = Date.now() - t0

const answerableIds = perQuestion.filter(r => r.answerable).map(r => r.id)
// The question file flags unanswerable questions; the flag must agree with the
// session text, or the fixture and the question set have drifted apart.
const flagMismatch = questions.filter(q => (q.unanswerable === true) === pass(contentText, q.required_keywords)).map(q => q.id)
if (flagMismatch.length) {
  console.error(`unanswerable flag disagrees with the session text for questions: ${flagMismatch.join(', ')}`)
  process.exit(1)
}

const summarize = (arm: Arm) => {
  const rows = perQuestion.map(r => r[arm])
  const passedAnswerable = perQuestion.filter(r => r.answerable && r[arm].pass).length
  const total = rows.reduce((n, r) => n + r.tokens, 0)
  const passed = rows.filter(r => r.pass).length
  const ret = rows.map(r => r.returned).filter((x): x is number => typeof x === 'number')
  return {
    keyword_pass: passed,
    keyword_pass_percent: Math.round((passed / rows.length) * 1000) / 10,
    keyword_pass_answerable: passedAnswerable,
    tokens_mean_per_question: Math.round(total / rows.length),
    tokens_total_40q: total,
    ...(ret.length ? {
      messages_returned_mean: Math.round((ret.reduce((a, b) => a + b, 0) / ret.length) * 10) / 10,
      messages_returned_min: Math.min(...ret),
      messages_returned_max: Math.max(...ret),
    } : {}),
  }
}

const result = {
  schema: 'context-capsule.scope-bench.v1',
  fixture: FIXTURE,
  messages: messages.length,
  questions: questions.length,
  tokenizer: 'chars/4 estimate (Math.ceil(length / 4)); no model tokenizer',
  model_calls: 0,
  metric_note: 'keyword_pass = every required keyword present in the text the model would receive. Availability check only, not model task success.',
  archive: {
    jsonl_bytes: jsonlBytes,
    zlib_level9_bytes: zlibBytes,
    zlib_ratio: Math.round((jsonlBytes / zlibBytes) * 10) / 10,
    capsule_compressedBase64_bytes: base64Bytes,
    capsule_object_json_bytes: capsuleObjectBytes,
    lossless: true,
  },
  initial_prompt: {
    full_history_jsonl_tokens: tok(jsonl),
    full_history_formatted_tokens: tok(fullText),
    full_history_content_only_tokens: Math.ceil(contentOnlyChars / 4),
    injectCapsule_tokens: tok(injection),
    injectEnrichedCapsule_tokens: tok(enriched),
    injectCapsule_text: injection,
  },
  answerable_questions: answerableIds.length,
  unanswerable_question_ids: perQuestion.filter(r => !r.answerable).map(r => r.id),
  arms: Object.fromEntries(armNames.map(a => [a, summarize(a)])),
  per_question: perQuestion,
  runtime_ms: runtimeMs,
  node: process.version,
  timestamp: new Date().toISOString(),
}

mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'scope.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')

const armLabel: Record<Arm, string> = {
  full_history: 'Full history (no compression)',
  window_last_10: 'Sliding window, last 10 messages',
  window_last_20: 'Sliding window, last 20 messages',
  capsule_only: 'injectCapsule() only (no retrieval)',
  capsule_search_q: 'injectCapsule() + searchCapsule(question text)',
  capsule_search_kw: 'injectCapsule() + searchCapsule(question content words)',
  capsule_search_kw_limit8: 'injectCapsule() + searchCapsule(question content words, { limit: 8 })',
  retrieval_top8: 'Ordinary retrieval: top 8 messages by term overlap (no capsule)',
}
const md: string[] = [
  '# Context Capsule scope benchmark',
  '',
  `Fixture \`${FIXTURE}\` (${messages.length} messages), ${questions.length} questions, tokenizer: chars/4 estimate, model calls: 0.`,
  '',
  '## Archive (lossless)',
  '',
  '| JSONL bytes | zlib-9 bytes | zlib ratio | base64 bytes in capsule |',
  '|---:|---:|---:|---:|',
  `| ${jsonlBytes} | ${zlibBytes} | ${result.archive.zlib_ratio}x | ${base64Bytes} |`,
  '',
  '## Initial prompt payload',
  '',
  '| Full history (JSONL) | Full history (content only) | injectCapsule() | injectEnrichedCapsule() |',
  '|---:|---:|---:|---:|',
  `| ${result.initial_prompt.full_history_jsonl_tokens} | ${result.initial_prompt.full_history_content_only_tokens} | ${result.initial_prompt.injectCapsule_tokens} | ${result.initial_prompt.injectEnrichedCapsule_tokens} |`,
  '',
  'injectCapsule() output on this fixture:',
  '',
  '```text',
  injection,
  '```',
  '',
  '## Per-question arms (keyword availability, not model task success)',
  '',
  `${answerableIds.length} of ${questions.length} questions are answerable from the session text (all required keywords occur in it); unanswerable: ${result.unanswerable_question_ids.join(', ')}.`,
  'Search arms score the returned message bodies only (the header line is excluded).',
  '',
  '| Arm | Keyword pass (of 40) | Of answerable | Mean tokens / question | Messages returned (mean, min-max) |',
  '|---|---:|---:|---:|---:|',
  ...armNames.map(a => {
    const s = result.arms[a] as ReturnType<typeof summarize>
    const ret = 'messages_returned_mean' in s
      ? `${s.messages_returned_mean} (${s.messages_returned_min}-${s.messages_returned_max}) of ${messages.length}`
      : '-'
    return `| ${armLabel[a]} | ${s.keyword_pass}/${questions.length} (${s.keyword_pass_percent}%) | ${s.keyword_pass_answerable}/${answerableIds.length} | ${s.tokens_mean_per_question} | ${ret} |`
  }),
  '',
  `Generated ${result.timestamp} with Node ${process.version}. Regenerate: \`node --experimental-strip-types scripts/bench-scope.ts\`.`,
  '',
]
writeFileSync(join(resultsDir, 'scope.md'), md.join('\n'), 'utf8')

console.log(md.join('\n'))
