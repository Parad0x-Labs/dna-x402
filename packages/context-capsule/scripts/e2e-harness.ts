#!/usr/bin/env node
/**
 * End-to-end model-task harness for Context Capsule (skeleton).
 *
 * Compares the same tasks, model, system text and grader across five context
 * strategies, counting every token a strategy spends:
 *
 *   full       full history in the prompt
 *   window     last N messages only (--window, default 10)
 *   summary    a model-written summary of the history (one summarization call
 *              per session, its tokens counted) + the question
 *   retrieval  top-k messages by term overlap with the question (k = --k, default 8)
 *              placed in the prompt; no tool call
 *   capsule    injectCapsule() pointer in the prompt + a search_capsule tool the
 *              model may call; every tool round-trip is counted
 *
 * Accounting per task and arm: input tokens, output tokens, cached input tokens
 * (reported separately), tool-schema tokens, retrieval-response tokens,
 * summarization tokens, retries, latency, and graded success. Results are
 * reported as success rate, total tokens, and tokens per successful answer.
 *
 * Modes
 *   --dry-run            (default) no model is called. Builds every arm's first
 *                        request, counts chars/4 tokens, and for the capsule arm
 *                        simulates ONE search_capsule call with the question's
 *                        content words. The summary arm cannot be built without a
 *                        model and is reported as "requires model". Writes
 *                        bench/results/e2e-dryrun.json. It reports NO task success.
 *   --adapter=<file.mjs> a module exporting
 *                          async function callModel({ system, messages, tools })
 *                            -> { text, toolCalls?: [{ name, args }],
 *                                 usage: { input, output, cached? }, ms }
 *                        Runs the full comparison. No adapter ships with this
 *                        package; supplying one is the caller's choice.
 *
 * Tasks file (--tasks=<file>, JSON array):
 *   { id, question, type, gold: { must_include: string[], must_not_include?: string[] } }
 *   type is one of: exact_id | updated_fact | multi_record | negation |
 *                   provenance | control
 * The bundled recovery-questions.json is accepted as a development set
 * (required_keywords -> must_include). It was written alongside the fixture and
 * is NOT held out; a published comparison needs a held-out task file.
 *
 * Run: node --experimental-strip-types scripts/e2e-harness.ts --dry-run
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compressContext, injectCapsule, searchCapsule } from '../src/index.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const arg = (name: string, dflt?: string) =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt
const fixturesDir = join(__dirname, '..', 'bench', 'fixtures')
const sessionPath = arg('session', join(fixturesDir, 'agent-session-100.json'))!
const tasksPath = arg('tasks', join(fixturesDir, 'recovery-questions.json'))!
const adapterPath = arg('adapter')
const WINDOW = Number(arg('window', '10'))
const K = Number(arg('k', '8'))
const MAX_TOOL_CALLS = Number(arg('max-tool-calls', '3'))

type Msg = { role: string; content: string }
type Task = { id: string | number; question: string; type?: string; gold: { must_include: string[]; must_not_include?: string[] } }
type Usage = { input: number; output: number; cached?: number }
type ModelReply = { text: string; toolCalls?: Array<{ name: string; args: { query?: string } }>; usage: Usage; ms?: number }
type CallModel = (req: { system: string; messages: Msg[]; tools?: unknown[] }) => Promise<ModelReply>

const session: Msg[] = JSON.parse(readFileSync(sessionPath, 'utf8'))
const tasks: Task[] = (JSON.parse(readFileSync(tasksPath, 'utf8')) as any[]).map(t => ({
  id: t.id,
  question: t.question,
  type: t.type ?? t.category ?? 'dev',
  gold: t.gold ?? { must_include: t.required_keywords ?? [] },
}))

const tok = (s: string) => Math.ceil(s.length / 4)
const fmt = (ms: Msg[]) => ms.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n')
const SYSTEM = 'Answer the question about the earlier session. Quote exact identifiers. If the information is not available to you, say so.'

const SEARCH_TOOL = {
  name: 'search_capsule',
  description: 'Return earlier session messages containing any of the given space-separated terms.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}
const toolSchemaTokens = tok(JSON.stringify(SEARCH_TOOL))

const STOP = new Set(['what', 'which', 'when', 'where', 'were', 'with', 'that', 'this', 'from', 'have', 'does', 'used', 'into', 'about', 'there', 'their', 'they', 'them', 'than', 'then', 'been', 'being', 'will', 'would', 'should', 'could', 'after', 'before', 'during'])
const contentWords = (q: string) =>
  (q.toLowerCase().match(/[a-z0-9_.@/-]+/g) ?? []).map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(w => w.length >= 4 && !STOP.has(w))

// Ordinary retrieval baseline: top-k messages by distinct-term overlap.
const topK = (q: string, k: number): Msg[] => {
  const terms = new Set(contentWords(q))
  return session
    .map((m, i) => ({ m, i, s: [...terms].filter(t => m.content.toLowerCase().includes(t)).length }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map(x => x.m)
}

const grade = (text: string, t: Task) => {
  const l = text.toLowerCase()
  return t.gold.must_include.every(k => l.includes(k.toLowerCase())) &&
    !(t.gold.must_not_include ?? []).some(k => l.includes(k.toLowerCase()))
}

const capsule = compressContext(session, { sessionId: 'e2e' })
const pointer = injectCapsule(capsule)

function firstRequest(arm: string, t: Task, summary?: string) {
  const q = { role: 'user', content: t.question }
  switch (arm) {
    case 'full': return { system: SYSTEM, messages: [{ role: 'user', content: fmt(session) }, q] }
    case 'window': return { system: SYSTEM, messages: [{ role: 'user', content: fmt(session.slice(-WINDOW)) }, q] }
    case 'retrieval': return { system: SYSTEM, messages: [{ role: 'user', content: fmt(topK(t.question, K)) }, q] }
    case 'summary': return { system: SYSTEM, messages: [{ role: 'user', content: summary ?? '' }, q] }
    case 'capsule': return { system: `${SYSTEM}\n\n${pointer}`, messages: [q], tools: [SEARCH_TOOL] }
  }
  throw new Error(`unknown arm ${arm}`)
}
const reqTokens = (r: { system: string; messages: Msg[]; tools?: unknown[] }) =>
  tok(r.system) + r.messages.reduce((n, m) => n + tok(m.content), 0) + (r.tools ? toolSchemaTokens : 0)

const ARMS = ['full', 'window', 'summary', 'retrieval', 'capsule']

async function dryRun() {
  const rows = tasks.map(t => {
    const row: Record<string, unknown> = { id: t.id, type: t.type }
    for (const arm of ARMS) {
      if (arm === 'summary') { row[arm] = { status: 'requires model' }; continue }
      const r = firstRequest(arm, t)
      const base = reqTokens(r)
      if (arm === 'capsule') {
        // Simulated single tool call with the question's content words; a real
        // model chooses its own query and may call more than once.
        const resp = searchCapsule(capsule, contentWords(t.question).join(' '))
        row[arm] = { first_request_input_tokens: base, simulated_retrieval_response_tokens: tok(resp), second_request_input_tokens: base + tok(resp) + 20 }
      } else {
        row[arm] = { first_request_input_tokens: base }
      }
    }
    return row
  })
  const mean = (arm: string, key: string) => {
    const xs = rows.map(r => (r[arm] as any)?.[key]).filter((x): x is number => typeof x === 'number')
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null
  }
  const out = {
    schema: 'context-capsule.e2e-harness.v1',
    dry_run: true,
    model_calls: 0,
    task_success_measured: false,
    note: 'Dry run: prompt sizes only. No model was called and no task success is reported. The capsule arm assumes one simulated search_capsule call; the summary arm needs a model.',
    tasks_file: tasksPath.split('/').slice(-1)[0],
    tasks_held_out: false,
    tokenizer: 'chars/4 estimate',
    tool_schema_tokens: toolSchemaTokens,
    mean_input_tokens: {
      full: mean('full', 'first_request_input_tokens'),
      window: mean('window', 'first_request_input_tokens'),
      retrieval: mean('retrieval', 'first_request_input_tokens'),
      capsule_first_request: mean('capsule', 'first_request_input_tokens'),
      capsule_after_one_search: mean('capsule', 'second_request_input_tokens'),
      capsule_both_requests: (mean('capsule', 'first_request_input_tokens') ?? 0) + (mean('capsule', 'second_request_input_tokens') ?? 0),
      summary: 'requires model',
    },
    params: { window: WINDOW, k: K },
    per_task: rows,
    node: process.version,
    timestamp: new Date().toISOString(),
  }
  const dir = join(__dirname, '..', 'bench', 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'e2e-dryrun.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ ...out, per_task: `${rows.length} rows in bench/results/e2e-dryrun.json` }, null, 2))
}

async function live(callModel: CallModel) {
  // One summarization call per session for the summary arm, counted in full.
  const sumReply = await callModel({ system: 'Summarize this session for later questions. Keep exact identifiers.', messages: [{ role: 'user', content: fmt(session) }] })
  const results: any[] = []
  for (const t of tasks) {
    for (const arm of ARMS) {
      const acc = { input: 0, output: 0, cached: 0, tool_calls: 0, retrieval_tokens: 0, ms: 0 }
      let req: any = firstRequest(arm, t, sumReply.text)
      let reply: ModelReply = await callModel(req)
      const add = (r: ModelReply) => { acc.input += r.usage.input; acc.output += r.usage.output; acc.cached += r.usage.cached ?? 0; acc.ms += r.ms ?? 0 }
      add(reply)
      while (arm === 'capsule' && reply.toolCalls?.length && acc.tool_calls < MAX_TOOL_CALLS) {
        const call = reply.toolCalls[0]
        const resp = searchCapsule(capsule, call.args.query ?? '')
        acc.tool_calls++; acc.retrieval_tokens += tok(resp)
        req = { ...req, messages: [...req.messages, { role: 'assistant', content: `search_capsule(${JSON.stringify(call.args)})` }, { role: 'user', content: resp }] }
        reply = await callModel(req)
        add(reply)
      }
      results.push({ id: t.id, type: t.type, arm, success: grade(reply.text, t), ...acc })
    }
  }
  const summary = Object.fromEntries(ARMS.map(arm => {
    const rs = results.filter(r => r.arm === arm)
    const ok = rs.filter(r => r.success).length
    const total = rs.reduce((n, r) => n + r.input + r.output, 0) + (arm === 'summary' ? sumReply.usage.input + sumReply.usage.output : 0)
    return [arm, { success: ok, tasks: rs.length, total_tokens: total, cached_tokens: rs.reduce((n, r) => n + r.cached, 0), tokens_per_success: ok ? Math.round(total / ok) : null }]
  }))
  const out = { schema: 'context-capsule.e2e-harness.v1', dry_run: false, tasks_file: tasksPath.split('/').slice(-1)[0], summary, results, summarization_usage: sumReply.usage, timestamp: new Date().toISOString() }
  console.log(JSON.stringify(out, null, 2))
}

if (adapterPath) {
  const mod = await import(pathToFileURL(resolve(adapterPath)).href)
  await live(mod.callModel as CallModel)
} else {
  await dryRun()
}
