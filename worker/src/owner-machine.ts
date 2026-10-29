/** Explicit candidate consumer. It never reads Gist or replays an unknown POST. */
import { resolveValuations, type Estimate } from './valuation'

export interface MachineEnv {
  OWNER_MACHINE_MODE?: string
  FUND_API_BASE: string
  WORKER_TOKEN: string
  WECHAT_SENDKEY: string
}
type Row = Record<string, unknown>
type Slot = '14:30' | '14:40'
type Outcome = 'sent' | 'delivery_rejected' | 'delivery_ambiguous' | 'pre_delivery_failed'
const SHA = /^[0-9a-f]{64}$/
const CODE = /^\d{6}$/
const MAX_RESPONSE = 2 * 1024 * 1024
const MAX_REQUEST = 128 * 1024
const TOTAL_MS = 60_000
const PREFIX = '/api/v2/worker/portfolio'

export class MachineError extends Error {
  constructor(readonly reason: string, readonly phase: string, readonly original?: Row) {
    super(reason)
    this.name = 'MachineError'
  }
}

export function machineMode(env: Pick<MachineEnv, 'OWNER_MACHINE_MODE'>): boolean {
  if (env.OWNER_MACHINE_MODE == null || env.OWNER_MACHINE_MODE === '' || env.OWNER_MACHINE_MODE === 'off') return false
  if (env.OWNER_MACHINE_MODE === 'candidate') return true
  throw new MachineError('machine_mode_invalid', 'configuration')
}

function fail(): never { throw new MachineError('machine_response_invalid', 'response') }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Row
}
function exact(value: unknown, fields: string): Row {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== fields.split(' ').sort().join(',')) fail()
  return row
}
function string(value: unknown, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || (pattern && !pattern.test(value))) return fail()
  return value
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return fail()
  return value
}
function flag(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value }
function strings(value: unknown, maximum: number, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length > maximum) return fail()
  return value.map((item) => string(item, pattern))
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function time(value: unknown): number {
  const raw = string(value)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return fail()
  const stamp = Date.parse(raw)
  if (!Number.isFinite(stamp)) return fail()
  return stamp
}
function date(value: unknown): string {
  const raw = string(value, /^\d{4}-\d\d-\d\d$/)
  if (new Date(raw + 'T00:00:00Z').toISOString().slice(0, 10) !== raw) return fail()
  return raw
}

/** Preserve raw subtrees for SHA checks: JSON.stringify changes Python REAL lexemes. */
export function parseMachineJson(raw: string): { value: unknown; rawOf: (value: unknown) => string } {
  if (new TextEncoder().encode(raw).length > MAX_RESPONSE) fail()
  const spans = new WeakMap<object, [number, number]>()
  let position = 0
  let nodes = 0
  function whitespace() { while (/[\t\n\r ]/.test(raw[position] || 'x')) position++ }
  function quoted(): string {
    const start = position++
    while (position < raw.length) {
      const char = raw[position++]
      if (char === '\\') { position++; continue }
      if (char === '"') {
        try { return JSON.parse(raw.slice(start, position)) as string } catch { return fail() }
      }
    }
    return fail()
  }
  function value(depth: number): unknown {
    if (depth > 40 || ++nodes > 100_000) fail()
    whitespace()
    const start = position
    const char = raw[position]
    if (char === '{' || char === '[') {
      position++
      const array = char === '['
      const end = array ? ']' : '}'
      const result: Row | unknown[] = array ? [] : Object.create(null) as Row
      const keys = new Set<string>()
      whitespace()
      if (raw[position] !== end) {
        while (true) {
          whitespace()
          if (array) (result as unknown[]).push(value(depth + 1))
          else {
            if (raw[position] !== '"') fail()
            const key = quoted()
            if (keys.has(key)) fail()
            keys.add(key)
            whitespace()
            if (raw[position++] !== ':') fail()
            ;(result as Row)[key] = value(depth + 1)
          }
          whitespace()
          if (raw[position] !== ',') break
          position++
        }
      }
      if (raw[position++] !== end) fail()
      spans.set(result, [start, position])
      return result
    }
    if (char === '"') return quoted()
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(position))?.[0]
    if (!token) return fail()
    position += token.length
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail()
    return parsed
  }
  const parsed = value(0)
  whitespace()
  if (position !== raw.length) fail()
  return { value: parsed, rawOf(item) {
    if (!item || typeof item !== 'object') return fail()
    const span = spans.get(item)
    if (!span) return fail()
    return raw.slice(...span)
  } }
}

async function hash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

class Budget {
  private readonly start = performance.now()
  private readonly wall = Date.now()
  private last = this.start
  private lastWall = this.wall
  constructor(private readonly initial: Date) {
    if (!Number.isFinite(initial.getTime())) throw new MachineError('machine_clock_invalid', 'clock')
  }
  remaining(): number {
    const now = performance.now(), wall = Date.now()
    if (!Number.isFinite(now) || now < this.last || wall < this.lastWall) throw new MachineError('machine_clock_invalid', 'clock')
    this.last = now; this.lastWall = wall
    const remaining = TOTAL_MS - Math.max(now - this.start, wall - this.wall)
    if (remaining <= 0) throw new MachineError('machine_time_limit', 'clock')
    return remaining
  }
  now(): Date { this.remaining(); return new Date(this.initial.getTime() + Math.max(this.last - this.start, this.lastWall - this.wall)) }
  async within<T>(operation: Promise<T>, limit = 15_000): Promise<T> {
    const remaining = Math.min(this.remaining(), limit)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MachineError('machine_time_limit', 'transport')), remaining)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
}

function until(deadline: number): number {
  const remaining = deadline - performance.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new MachineError('machine_time_limit', 'transport')
  return remaining
}

function configuration(env: MachineEnv, buildSha: string | null, sending = true) {
  if (!buildSha || !/^[0-9a-f]{40}$/.test(buildSha) || !env.WORKER_TOKEN || (sending && !env.WECHAT_SENDKEY)) {
    throw new MachineError('machine_configuration_incomplete', 'configuration')
  }
  let url: URL
  try { url = new URL(env.FUND_API_BASE) } catch { throw new MachineError('machine_origin_invalid', 'configuration') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new MachineError('machine_origin_invalid', 'configuration')
  }
  return { origin: url.origin, buildSha }
}

async function boundedText(response: Response, budget: Budget, maximum = MAX_RESPONSE, deadline = performance.now() + budget.remaining()): Promise<string> {
  until(deadline)
  const declared = response.headers.get('Content-Length')
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { void response.body?.cancel().catch(() => undefined); fail() }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let size = 0, result = ''
  try {
    while (true) {
      const { value, done } = await budget.within(reader.read(), until(deadline))
      until(deadline)
      if (done) break
      size += value.byteLength
      if (size > maximum) fail()
      result += decoder.decode(value, { stream: true })
    }
    const complete = result + decoder.decode()
    until(deadline)
    return complete
  } catch (error) { void reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
}

async function api(env: MachineEnv, origin: string, path: string, budget: Budget, body?: Row, original?: Row) {
  const phase = path.split('/').at(-1) || 'source'
  const raw = body ? JSON.stringify(body) : undefined
  const maximum = path === '/evidence' ? MAX_REQUEST : 16 * 1024
  if (raw && new TextEncoder().encode(raw).length > maximum) throw new MachineError('machine_request_too_large', phase)
  if (original) {
    original.phase = phase
    if (raw) original[phase + '_request_hash'] = await hash(raw)
  }
  try {
    // This absolute deadline is shared by headers, every body chunk and JSON
    // validation. A slowly streaming body must not renew a 15-second lease.
    const deadline = performance.now() + Math.min(budget.remaining(), 15_000)
    const response = await budget.within(fetch(origin + PREFIX + path, {
      method: raw ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${env.WORKER_TOKEN}`, ...(raw ? { 'Content-Type': 'application/json' } : {}) },
      body: raw, signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(budget.remaining(), until(deadline))))),
    }), until(deadline))
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => undefined); throw new MachineError(raw ? 'machine_write_unknown' : 'machine_read_failed', phase) }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail()
    const result = parseMachineJson(await boundedText(response, budget, MAX_RESPONSE, deadline))
    until(deadline); budget.remaining()
    return result
  } catch (error) {
    // In particular, neither HTTP 5xx nor malformed success proves rollback.
    throw new MachineError(raw ? 'machine_write_unknown' : 'machine_read_failed', phase)
  }
}

function source(value: unknown) {
  const row = exact(value, 'schema revision source_hash record_count scope codes policy_version')
  if (row.schema !== 'owner-machine-source-1' || row.scope !== 'fund_only') fail()
  const codes = strings(row.codes, 100, CODE)
  if (!equal(codes, [...new Set(codes)].sort())) fail()
  return { revision: integer(row.revision), source_hash: string(row.source_hash, SHA),
    record_count: integer(row.record_count), policy_version: string(row.policy_version, /^pol_[0-9a-f]{64}$/), codes }
}
type Source = ReturnType<typeof source>
function sameSource(left: Source, right: Source): boolean { return equal(left, right) }

function evidence(value: unknown, original: Source): Array<{ code: string; evidence_id: string }> {
  const row = exact(value, 'schema revision source_hash policy_version evidence')
  if (row.schema !== 'owner-machine-evidence-1' || row.revision !== original.revision || row.source_hash !== original.source_hash || row.policy_version !== original.policy_version || !Array.isArray(row.evidence)) fail()
  const refs = row.evidence.map((value) => {
    const item = exact(value, 'code evidence_id')
    return { code: string(item.code, CODE), evidence_id: string(item.evidence_id, /^ev_[0-9a-f]{64}$/) }
  })
  if (!equal(refs.map((item) => item.code), original.codes)) fail()
  return refs
}

interface Run { row: Row; components: Row[]; ids: string[]; digest: string }
async function runImage(value: unknown, document: ReturnType<typeof parseMachineJson>, original: Source, task: Row): Promise<Run> {
  const row = exact(value, 'schema request_id request_hash run_id source policy strategy_version created_at pricing_complete unavailable_codes components')
  if (row.schema !== 'owner-analysis-run-1' || row.request_id !== task.analysis_request_id || row.request_hash !== task.analysis_request_hash || row.run_id !== task.run_id || row.strategy_version !== task.strategy_version || row.created_at !== task.created_at) fail()
  time(row.created_at); flag(row.pricing_complete); strings(row.unavailable_codes, 100, CODE)
  const origin = exact(row.source, 'revision sha256 record_count scope')
  if (origin.revision !== original.revision || origin.sha256 !== original.source_hash || origin.record_count !== original.record_count || origin.scope !== 'fund_only') fail()
  const policy = object(row.policy)
  if (policy.schema_version !== 'v8-policy-1' || policy.policy_version !== original.policy_version || time(policy.effective_at) > time(row.created_at)) fail()
  if (!Array.isArray(row.components) || row.components.length !== original.codes.length) fail()
  const components = row.components.map((value) => {
    const item = exact(value, 'code account_count holding evidence decision')
    string(item.code, CODE); integer(item.account_count, 200)
    const proof = object(item.evidence), holding = object(item.holding), decision = object(item.decision)
    if (proof.schema_version !== 'v8-evidence-1' || holding.schema_version !== 'v8-holding-1' || decision.schema_version !== 'v8-decision-1' || [proof.fund_code, holding.fund_code, decision.fund_code].some((code) => code !== item.code)) fail()
    string(proof.evidence_id, /^ev_[0-9a-f]{64}$/); string(holding.holding_version, /^hold_[0-9a-f]{64}$/); string(decision.decision_id, /^dec_[0-9a-f]{64}$/)
    if (decision.evidence_id !== proof.evidence_id || decision.holding_version !== holding.holding_version || decision.policy_version !== original.policy_version || decision.strategy_version !== row.strategy_version || decision.user_state !== holding.user_state) fail()
    const actions = holding.user_state === 'held' ? ['add', 'hold', 'reduce', 'sell'] : holding.user_state === 'unheld' ? ['buy', 'dca', 'watch'] : []
    if (!actions.includes(String(decision.action))) fail()
    integer(decision.confidence, 100); integer(decision.strength, 100)
    if (proof.estimate !== null && (typeof proof.estimate !== 'number' || !Number.isFinite(proof.estimate) || proof.estimate < -100 || proof.estimate > 1000)) fail()
    string(proof.estimate_status); strings(proof.stale_fields, 50); time(proof.created_at)
    if (proof.market_time !== null) time(proof.market_time)
    if (proof.target_nav_date !== null) date(proof.target_nav_date)
    return item
  })
  if (!equal(components.map((item) => item.code), original.codes)) fail()
  const ids = components.map((item) => string(object(item.decision).decision_id))
  if (!equal(ids, task.decision_ids) || new Set(ids).size !== ids.length) fail()
  const digest = await hash(document.rawOf(row))
  if (digest !== task.run_response_hash) fail()
  return { row, components, ids, digest }
}

async function prepared(document: ReturnType<typeof parseMachineJson>, original: Source, day: string, refs: Array<{ code: string; evidence_id: string }>) {
  const row = exact(document.value, 'task task_hash run source_current duplicate')
  const task = exact(row.task, 'schema occurrence_id analysis_request_id analysis_request_hash run_id run_response_hash source_revision source_hash policy_version strategy_version created_at worker_build_sha decision_ids')
  if (task.schema !== 'owner-machine-task-1' || task.occurrence_id !== day || task.analysis_request_id !== 'machine-portfolio-' + day || task.source_revision !== original.revision || task.source_hash !== original.source_hash || task.policy_version !== original.policy_version || row.source_current !== true) fail()
  string(task.analysis_request_hash, SHA); string(task.run_response_hash, SHA); string(task.run_id); string(task.strategy_version); string(task.worker_build_sha, /^[0-9a-f]{40}$/)
  strings(task.decision_ids, 100, /^dec_[0-9a-f]{64}$/)
  const digest = string(row.task_hash, SHA)
  if (await hash(document.rawOf(task)) !== digest) fail()
  const run = await runImage(row.run, document, original, task)
  if (!flag(row.duplicate) && !equal(run.components.map((item) => ({ code: item.code, evidence_id: object(item.evidence).evidence_id })), refs)) fail()
  return { task, task_hash: digest, run }
}

function freshCount(run: Run, now: Date): number {
  const stamp = now.getTime(), day = beijing(now).day
  return run.components.filter((item) => {
    const proof = object(item.evidence)
    if (proof.market_time === null) return false
    const market = time(proof.market_time), created = time(proof.created_at)
    return proof.estimate_status === 'fresh' && proof.estimate !== null && proof.target_nav_date === null
      && !(proof.stale_fields as string[]).some((field) => field === 'estimate' || field === 'market_time')
      && beijing(new Date(market)).day === day && market <= stamp && created <= stamp && stamp - market <= 90 * 60_000 && stamp - created <= 90 * 60_000
  }).length
}

function beijing(now: Date) {
  const local = new Date(now.getTime() + 8 * 60 * 60_000)
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours(), minute: local.getUTCMinutes(), weekday: local.getUTCDay() }
}
function deliveryWindow(now: Date, day: string, slot: Slot): void {
  const local = beijing(now)
  if (local.day !== day || local.hour !== 14 || local.minute < (slot === '14:30' ? 30 : 40) || local.minute >= 50 || local.weekday === 0 || local.weekday === 6) throw new MachineError('machine_outside_delivery_window', 'pre_delivery')
}

function message(run: Run, day: string, slot: Slot, taskHash: string): string {
  const labels: Record<string, string> = { buy: '考虑买入', dca: '定投观察', watch: '继续关注', add: '考虑加仓', hold: '持有观察', reduce: '考虑减仓', sell: '考虑退出' }
  const lines = [`## 司南基金 · 完整基金组合摘要（${day} ${slot}）`, '',
    run.row.pricing_complete ? '完整定价；以下仅为辅助参考。' : '组合定价不完整，不构造部分组合权重；以下仅为辅助参考。', '']
  for (const item of run.components) {
    const proof = object(item.evidence), decision = object(item.decision)
    const estimate = proof.estimate === null ? '估值未知' : proof.estimate_status === 'fresh' ? `${Number(proof.estimate).toFixed(2)}%（盘中参考）` : `历史/降级数据（${String(proof.estimate_status)}）`
    lines.push(`- ${String(item.code)}：${estimate}；${labels[String(decision.action)]}，置信度 ${String(decision.confidence)}%`)
  }
  lines.push('', `原任务：${taskHash}`, `原分析：${String(run.row.run_id)}`, '', '不构成投资建议，不执行交易。')
  const result = lines.join('\n')
  if (result.length > 8000 || new TextEncoder().encode(result).length > 24_000) throw new MachineError('machine_message_too_large', 'pre_delivery')
  return result
}

/** One physical POST only. All unproven acceptance/rejection is ambiguous. */
async function sendOnce(env: MachineEnv, title: string, content: string, budget: Budget): Promise<Outcome> {
  try {
    const deadline = performance.now() + Math.min(budget.remaining(), 10_000)
    const response = await budget.within(fetch(`https://sctapi.ftqq.com/${env.WECHAT_SENDKEY}.send`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp: content }), signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(budget.remaining(), until(deadline))))),
    }), until(deadline))
    // An HTTP failure by itself does not prove that the provider did not send.
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => undefined); return 'delivery_ambiguous' }
    const raw = await boundedText(response, budget, 16_384, deadline)
    const parsed = object(parseMachineJson(raw).value)
    until(deadline); budget.remaining()
    const codes = [parsed.code, parsed.errno].filter((value) => value !== undefined)
    if (!codes.length || codes.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value))) return 'delivery_ambiguous'
    if (codes.some((value) => value !== 0)) return codes.some((value) => value === 0) ? 'delivery_ambiguous' : 'delivery_rejected'
    return 'sent'
  } catch { return 'delivery_ambiguous' }
}

export async function runOwnerMachine(
  env: MachineEnv, manual: boolean, clock: Date, buildSha: string | null,
  makeContext: (estimate?: Estimate) => unknown, requestedSlot?: Slot,
): Promise<{ status: 'sent' | 'failed' | 'skipped'; reason: string; original: Row; funds?: number; phase?: string; warning?: string | null }> {
  const config = configuration(env, buildSha), budget = new Budget(clock)
  const local = beijing(budget.now())
  const slot: Slot = requestedSlot || (local.minute >= 40 ? '14:40' : '14:30')
  const invocation = { occurrence_date: local.day, request_id: 'machine-' + crypto.randomUUID(),
    trigger: manual ? 'manual' : 'scheduled', slot, worker_build_sha: config.buildSha }
  const original: Row = { occurrence_date: local.day, slot, request_id: invocation.request_id }
  try {
    deliveryWindow(budget.now(), local.day, slot)
    const initial = source((await api(env, config.origin, '/source', budget, undefined, original)).value)
    original.expected_revision = initial.revision; original.source_hash = initial.source_hash; original.policy_version = initial.policy_version
    if (!initial.codes.length) return { status: 'skipped', reason: 'machine_empty_source', original }
    const quotes = await budget.within(resolveValuations(initial.codes, budget.now(), { requestBudget: 34 }), 25_000)
    budget.remaining()
    const observations = initial.codes.map((code) => ({ code, estimate_context: makeContext(quotes.estimates.get(code)) }))
    const refs = evidence((await api(env, config.origin, '/evidence', budget, {
      ...invocation, expected_revision: initial.revision, source_hash: initial.source_hash,
      policy_version: initial.policy_version, observations,
    }, original)).value, initial)
    const preparedDocument = await api(env, config.origin, '/tasks/prepare', budget, {
      ...invocation, expected_revision: initial.revision, source_hash: initial.source_hash,
      policy_version: initial.policy_version, evidence: refs,
    }, original)
    const task = await prepared(preparedDocument, initial, local.day, refs)
    original.task_hash = task.task_hash
    const claimDocument = await api(env, config.origin, '/tasks/claim', budget, { ...invocation, task_hash: task.task_hash }, original)
    const claim = object(claimDocument.value)
    if (claim.claimed === false && claim.duplicate === true) return { status: 'skipped', reason: 'machine_not_claimed', original }
    exact(claim, 'claimed duplicate attempt attempt_hash run')
    if (claim.claimed !== true || claim.duplicate !== false) fail()
    const attempt = exact(claim.attempt, 'schema occurrence_id analysis_request_id task_hash slot attempt_no natural_schedule scheduled_window scheduled_at created_at request_id worker_build_sha trigger decision_ids execution_status artifact_status valid_count expected_count')
    const attemptHash = string(claim.attempt_hash, SHA)
    if (attempt.schema !== 'owner-machine-attempt-1' || attempt.occurrence_id !== local.day || attempt.task_hash !== task.task_hash || attempt.analysis_request_id !== task.task.analysis_request_id || attempt.slot !== slot || attempt.request_id !== invocation.request_id || attempt.worker_build_sha !== config.buildSha || attempt.trigger !== invocation.trigger || attempt.natural_schedule !== !manual || !equal(attempt.decision_ids, task.run.ids) || attempt.execution_status !== 'running' || await hash(claimDocument.rawOf(attempt)) !== attemptHash) fail()
    const claimedRun = await runImage(claim.run, claimDocument, initial, task.task)
    if (claimedRun.digest !== task.run.digest || integer(attempt.expected_count, 100) !== initial.codes.length || !['fresh', 'partial'].includes(String(attempt.artifact_status))) fail()
    integer(attempt.valid_count, initial.codes.length); integer(attempt.attempt_no, 2)
    const freshAtClaim = freshCount(claimedRun, new Date(time(attempt.created_at)))
    const artifact = claimedRun.row.pricing_complete && freshAtClaim === initial.codes.length ? 'fresh' : 'partial'
    if (attempt.attempt_no === 0 || (slot === '14:30' && attempt.attempt_no !== 1) || attempt.valid_count === 0 || attempt.valid_count !== freshAtClaim || attempt.artifact_status !== artifact || attempt.scheduled_at !== `${local.day}T${slot}:00+08:00` || attempt.scheduled_window !== `${local.day}T${slot}+08:00`) fail()
    original.attempt_hash = attemptHash
    let outcome: Outcome
    try {
      // Claim is not a lease: re-read source and actual time immediately before transport.
      const current = source((await api(env, config.origin, '/source', budget, undefined, original)).value)
      if (!sameSource(current, initial)) throw new MachineError('machine_source_changed', 'pre_delivery')
      deliveryWindow(budget.now(), local.day, slot)
      if (!freshCount(claimedRun, budget.now())) throw new MachineError('machine_no_current_intraday', 'pre_delivery')
      const content = message(claimedRun, local.day, slot, task.task_hash)
      budget.remaining(); deliveryWindow(budget.now(), local.day, slot)
      outcome = await sendOnce(env, `司南基金 · 完整基金组合摘要（${slot}）`, content, budget)
    } catch { outcome = 'pre_delivery_failed' }
    original.outcome = outcome
    const finished = await api(env, config.origin, '/tasks/finish', budget, {
      occurrence_date: local.day, slot, attempt_hash: attemptHash, outcome,
    }, original)
    const receipt = exact(finished.value, 'result result_hash duplicate')
    const result = object(receipt.result)
    if (result.schema !== 'owner-machine-result-1' || result.occurrence_id !== local.day || result.analysis_request_id !== task.task.analysis_request_id || result.attempt_hash !== attemptHash || result.outcome !== outcome || result.artifact_digest !== claimedRun.digest || await hash(finished.rawOf(result)) !== string(receipt.result_hash, SHA)) fail()
    flag(receipt.duplicate)
    return { status: outcome === 'sent' ? 'sent' : 'failed', reason: outcome, funds: initial.codes.length, original }
  } catch (error) {
    let failure = error instanceof MachineError ? error : new MachineError('machine_run_failed', 'runtime')
    if (failure.phase === 'response' && ['evidence', 'prepare', 'claim', 'finish'].includes(String(original.phase))) {
      failure = new MachineError('machine_write_unknown', String(original.phase))
    }
    // No automatic GET/replay can convert an unknown POST into transport permission.
    return { status: 'failed', reason: failure.reason, phase: failure.phase, original }
  }
}

export async function readOwnerMachineStatus(env: MachineEnv, day: string, buildSha: string | null) {
  date(day)
  const config = configuration(env, buildSha, false), budget = new Budget(new Date())
  const document = await api(env, config.origin, '/tasks/' + day, budget)
  const row = exact(document.value, 'schema task attempts observations')
  if (row.schema !== 'owner-machine-status-1' || !Array.isArray(row.attempts) || row.attempts.length > 2 || !Array.isArray(row.observations) || row.observations.length > 200) fail()
  return row
}
