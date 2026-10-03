// Explicitly constructed candidate: no app registration, default transport,
// watchlist/Gist import, credential persistence or automatic network activity.
import {
  buildOwnerSyncRequest, restoreOwnerSyncRequest, parseSyncWriteResponse,
  parseSyncReceiptResponse, parseSyncChangesPage,
  type BuiltOwnerSyncRequest, type OwnerSyncRecord, type OwnerSyncCursor,
  type OwnerSyncRequestInput,
} from '@/utils/ownerSyncContract'
import type {
  OwnerSyncOutbox, OwnerSyncOutboxEntry, OwnerSyncOutboxSnapshot,
} from '@/stores/ownerSyncOutbox'

export interface OwnerSyncCandidateTransport {
  readonly targetFingerprint: string
  write(packet: BuiltOwnerSyncRequest, signal: AbortSignal): Promise<{ status: number; rawBody: string }>
  receipt(requestId: string, requestHash: string, signal: AbortSignal): Promise<{ status: number; rawBody: string }>
  changes(parameters: {
    sinceRevision: number; upperRevision?: number; cursor?: OwnerSyncCursor; limit: number
  }, signal: AbortSignal): Promise<{ status: number; rawBody: string }>
}

interface SessionContext { authenticated: boolean; generation: number }
export type OwnerSyncCandidateState = 'disabled' | 'signed_out' | 'idle' | 'prepared'
  | 'sending' | 'unknown' | 'confirmed' | 'conflict' | 'blocked'
export interface OwnerSyncCandidateStatus {
  readonly state: OwnerSyncCandidateState
  readonly busy: boolean
  readonly lastCompletePulledRevision: number | null
  readonly latestObservedHead: number | null
  readonly baselineReady: boolean
}
type DraftOperation = Omit<OwnerSyncRequestInput['operations'][number], 'base_values'>
type WriteOutcome = ReturnType<typeof parseSyncWriteResponse>

export class OwnerSyncCandidateError extends Error {
  constructor(readonly code: 'sync_disabled' | 'sync_signed_out' | 'sync_context_changed'
    | 'sync_busy' | 'sync_pending' | 'sync_pull_required' | 'sync_invalid_transition'
    | 'sync_target_mismatch' | 'sync_unknown_resend_requires_confirmation'
    | 'sync_invalid_response' | 'sync_unavailable' | 'sync_timeout') {
    super('Owner sync candidate operation unavailable')
    this.name = 'OwnerSyncCandidateError'
  }
}

const TOTAL_DEADLINE_MS = 12_000
const MAX_CHANGES = 100_000

export function createOwnerSyncCandidate(options: {
  outbox: OwnerSyncOutbox
  transport: OwnerSyncCandidateTransport
  session: () => SessionContext
}) {
  if (!/^[0-9a-f]{64}(?![\s\S])/.test(options.transport.targetFingerprint)
    || options.transport.targetFingerprint !== options.outbox.targetFingerprint) {
    throw new OwnerSyncCandidateError('sync_target_mismatch')
  }
  let enabled = false
  let epoch = 0
  let busy = false
  let state: OwnerSyncCandidateState = 'idle'
  let controller: AbortController | null = null
  let baseline = new Map<string, OwnerSyncRecord>()
  let baselineGeneration: number | null = null
  let lastCompletePulledRevision: number | null = null
  let latestObservedHead: number | null = null
  let baselineReady = false
  let lastResult: WriteOutcome | null = null

  function context(): SessionContext {
    const current = options.session()
    if (!current || typeof current.authenticated !== 'boolean'
      || !Number.isSafeInteger(current.generation) || current.generation < 0) {
      return { authenticated: false, generation: -1 }
    }
    return current
  }

  function clearPrivateView(): void {
    baseline = new Map()
    baselineGeneration = null
    lastCompletePulledRevision = null
    latestObservedHead = null
    baselineReady = false
    lastResult = null
  }

  function invalidate(): void {
    epoch++
    controller?.abort('owner-sync-context-changed')
    clearPrivateView()
  }

  function assertActive(captured?: { epoch: number; generation: number }): void {
    const current = context()
    if (!enabled) throw new OwnerSyncCandidateError('sync_disabled')
    if (!current.authenticated) throw new OwnerSyncCandidateError('sync_signed_out')
    if (captured && (captured.epoch !== epoch || captured.generation !== current.generation)) {
      throw new OwnerSyncCandidateError('sync_context_changed')
    }
  }

  async function exclusively(operation: (captured: { epoch: number; generation: number }) => Promise<unknown>): Promise<OwnerSyncCandidateStatus> {
    assertActive()
    if (busy) throw new OwnerSyncCandidateError('sync_busy')
    const captured = { epoch, generation: context().generation }
    busy = true
    try { await operation(captured) } finally { busy = false }
    return status()
  }

  // One budget covers all pagination or one POST/receipt. No retries. An abort
  // stops local waiting even when the injected transport ignores its signal.
  async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const active = new AbortController()
    controller = active
    let timedOut = false
    let rejectAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new OwnerSyncCandidateError(timedOut ? 'sync_timeout' : 'sync_context_changed'))
      active.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = globalThis.setTimeout(() => { timedOut = true; active.abort() }, TOTAL_DEADLINE_MS)
    try { return await Promise.race([Promise.resolve().then(() => {
      // Revoke/timeout can happen before this microtask runs. A transport may
      // ignore AbortSignal, so do not invoke it at all once locally cancelled.
      if (active.signal.aborted) throw new OwnerSyncCandidateError(timedOut ? 'sync_timeout' : 'sync_context_changed')
      return operation(active.signal)
    }), cancelled]) }
    finally {
      globalThis.clearTimeout(timer)
      if (rejectAbort) active.signal.removeEventListener('abort', rejectAbort)
      if (controller === active) controller = null
    }
  }

  function status(): OwnerSyncCandidateStatus {
    const current = context()
    const visible = enabled && current.authenticated
      && (baselineGeneration === null || baselineGeneration === current.generation)
    return Object.freeze({
      state: !enabled ? 'disabled' : !visible ? 'signed_out' : busy ? 'sending' : state,
      busy: visible && busy,
      lastCompletePulledRevision: visible ? lastCompletePulledRevision : null,
      latestObservedHead: visible ? latestObservedHead : null,
      baselineReady: visible && baselineReady,
    })
  }

  async function packet(snapshot: OwnerSyncOutboxSnapshot): Promise<BuiltOwnerSyncRequest> {
    if (!snapshot.entry) throw new OwnerSyncCandidateError('sync_invalid_transition')
    return restoreOwnerSyncRequest(snapshot.entry.rawBody, snapshot.entry.requestHash)
  }

  async function markUnknown(snapshot: OwnerSyncOutboxSnapshot): Promise<void> {
    lastResult = null
    if (snapshot.entry?.state === 'confirmed' || snapshot.entry?.state === 'conflict') {
      state = snapshot.entry.state
      return
    }
    state = 'unknown'
    if (snapshot.entry?.state === 'attempted') {
      try { await options.outbox.compareAndSwap(snapshot.version, { ...snapshot.entry, state: 'unknown' }) }
      catch { /* Never clear/replace the original packet after a local failure. */ }
    }
  }

  function verifyResult(result: WriteOutcome, original: BuiltOwnerSyncRequest): void {
    if (result.kind !== 'success') return
    if (result.result.revision < original.request.expected_revision) {
      throw new OwnerSyncCandidateError('sync_invalid_response')
    }
    const requested = new Map(original.request.operations.map(item => [item.key, item]))
    for (const record of result.result.records) {
      const operation = requested.get(record.key)
      if (!operation || operation.kind !== record.kind || operation.deleted !== record.deleted) {
        throw new OwnerSyncCandidateError('sync_invalid_response')
      }
      for (const [field, value] of Object.entries(operation.changes ?? {})) {
        // Contract parsing already rejects non-finite/coerced values. Strict
        // scalar equality retains null/zero/type distinctions while accepting
        // business-equivalent numeric representations (1 and 1.0).
        if (!Object.prototype.hasOwnProperty.call(record.values, field) || record.values[field] !== value) {
          throw new OwnerSyncCandidateError('sync_invalid_response')
        }
      }
    }
    // Success for deleting an absent record can legitimately have no record.
    for (const operation of original.request.operations) {
      if (!operation.deleted && !result.result.records.some(record => record.key === operation.key)) {
        throw new OwnerSyncCandidateError('sync_invalid_response')
      }
    }
  }

  async function acceptResult(snapshot: OwnerSyncOutboxSnapshot, original: BuiltOwnerSyncRequest,
    result: WriteOutcome, captured: { epoch: number; generation: number }): Promise<void> {
    assertActive(captured)
    verifyResult(result, original)
    if (result.kind !== 'success' && result.kind !== 'conflict') {
      await markUnknown(snapshot)
      return
    }
    const nextState = result.kind === 'success' ? 'confirmed' : 'conflict'
    if (snapshot.entry!.state !== nextState) {
      await options.outbox.compareAndSwap(snapshot.version, { ...snapshot.entry!, state: nextState })
    }
    assertActive(captured)
    state = nextState
    lastResult = result
    if (result.kind === 'success') {
      latestObservedHead = Math.max(latestObservedHead ?? 0, result.result.revision)
      // A global head observed in POST is NOT a completed pull checkpoint.
      // Do not rebase old drafts or fill other records with that newer revision.
      baselineReady = false
    }
  }

  return {
    status,
    setCloudConsent(value: boolean): void {
      if (typeof value !== 'boolean') throw new OwnerSyncCandidateError('sync_disabled')
      enabled = value
      invalidate()
    },
    notifySessionChanged(): void { invalidate() },
    getLastResult(): WriteOutcome | null {
      const current = context()
      return enabled && current.authenticated && baselineGeneration === current.generation ? lastResult : null
    },
    async hydratePending(): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        const snapshot = await options.outbox.read()
        assertActive(captured)
        state = !snapshot.entry ? 'idle' : snapshot.entry.state === 'attempted' ? 'unknown' : snapshot.entry.state
        lastResult = null
        return status()
      })
    },
    async pullBaseline(): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        const currentGeneration = context().generation
        const sinceRevision = baselineGeneration === currentGeneration ? lastCompletePulledRevision ?? 0 : 0
        const candidate = sinceRevision === 0 ? new Map<string, OwnerSyncRecord>() : new Map(baseline)
        let upperRevision: number | undefined
        let cursor: OwnerSyncCursor | undefined
        let count = 0
        try {
          await deadline(async signal => {
            for (let pages = 0; pages <= MAX_CHANGES; pages++) {
              assertActive(captured)
              if (signal.aborted) throw new OwnerSyncCandidateError('sync_context_changed')
              const parameters = { sinceRevision, limit: 200,
                ...(upperRevision === undefined ? {} : { upperRevision }),
                ...(cursor === undefined ? {} : { cursor }) }
              const response = await options.transport.changes(parameters, signal)
              assertActive(captured)
              if (signal.aborted) throw new OwnerSyncCandidateError('sync_context_changed')
              if (response.status !== 200) throw new OwnerSyncCandidateError('sync_unavailable')
              const page = parseSyncChangesPage(response.rawBody, parameters)
              upperRevision = page.upper_revision
              count += page.changes.length
              if (count > MAX_CHANGES) throw new OwnerSyncCandidateError('sync_invalid_response')
              for (const record of page.changes) candidate.set(record.key, record)
              if (candidate.size > MAX_CHANGES) throw new OwnerSyncCandidateError('sync_invalid_response')
              if (page.complete) return
              cursor = page.next_cursor!
            }
            throw new OwnerSyncCandidateError('sync_invalid_response')
          })
          assertActive(captured)
          if (upperRevision === undefined || upperRevision < (latestObservedHead ?? 0)) {
            throw new OwnerSyncCandidateError('sync_invalid_response')
          }
          baseline = candidate
          baselineGeneration = captured.generation
          lastCompletePulledRevision = upperRevision!
          latestObservedHead = Math.max(latestObservedHead ?? 0, upperRevision!)
          baselineReady = true
          return status()
        } catch {
          state = 'blocked'
          baselineReady = false
          throw new OwnerSyncCandidateError('sync_unavailable')
        }
      })
    },
    async prepare(requestId: string, drafts: readonly DraftOperation[]): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        if (!baselineReady || baselineGeneration !== captured.generation || lastCompletePulledRevision === null) {
          throw new OwnerSyncCandidateError('sync_pull_required')
        }
        const current = await options.outbox.read()
        assertActive(captured)
        if (current.entry) throw new OwnerSyncCandidateError('sync_pending')
        const normalized = await buildOwnerSyncRequest({
          request_id: requestId, expected_revision: lastCompletePulledRevision,
          operations: drafts.map(draft => ({ ...draft, base_values: {} })),
        })
        const operations = normalized.request.operations.map(operation => {
          const previous = baseline.get(operation.key)
          return { ...operation, base_values: previous ? {
            ...previous.values, kind: previous.kind, deleted: previous.deleted,
          } : {} }
        })
        const original = await buildOwnerSyncRequest({ ...normalized.request, operations })
        assertActive(captured)
        const entry: OwnerSyncOutboxEntry = {
          schema: 'owner-sync-outbox-1', state: 'prepared',
          rawBody: original.rawBody, requestHash: original.requestHash,
        }
        await options.outbox.compareAndSwap(current.version, entry)
        assertActive(captured)
        state = 'prepared'
        return status()
      })
    },
    async sendPrepared(): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        let pending = await options.outbox.read()
        assertActive(captured)
        if (pending.entry?.state !== 'prepared') throw new OwnerSyncCandidateError('sync_invalid_transition')
        const original = await packet(pending)
        assertActive(captured)
        pending = await options.outbox.compareAndSwap(pending.version, { ...pending.entry!, state: 'attempted' })
        try {
          assertActive(captured)
          const result = await deadline(async signal => {
            assertActive(captured)
            const response = await options.transport.write(original, signal)
            assertActive(captured)
            if (signal.aborted) throw new OwnerSyncCandidateError('sync_context_changed')
            return parseSyncWriteResponse(response.status, response.rawBody)
          })
          await acceptResult(pending, original, result, captured)
        } catch { await markUnknown(pending) }
        return status()
      })
    },
    async reconcilePending(): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        const pending = await options.outbox.read()
        assertActive(captured)
        if (!pending.entry || pending.entry.state === 'prepared') throw new OwnerSyncCandidateError('sync_invalid_transition')
        const original = await packet(pending)
        try {
          assertActive(captured)
          const reconciliation = await deadline(async signal => {
            assertActive(captured)
            const response = await options.transport.receipt(original.request.request_id, original.requestHash, signal)
            assertActive(captured)
            if (signal.aborted) throw new OwnerSyncCandidateError('sync_context_changed')
            return parseSyncReceiptResponse(response.status, response.rawBody)
          })
          if (reconciliation.state === 'matched') {
            const result: WriteOutcome = reconciliation.status === 200
              ? { kind: 'success', status: 200, result: reconciliation.result }
              : { kind: 'conflict', status: 409, result: reconciliation.result }
            await acceptResult(pending, original, result, captured)
          } else { await markUnknown(pending) }
        } catch { await markUnknown(pending) }
        return status()
      })
    },
    // This is a caller's explicit manual action, never an online/focus handler,
    // reload effect, timer, timeout recovery or automatic retry.
    async resendUnknown(acknowledgeUnknownResend: true): Promise<OwnerSyncCandidateStatus> {
      if (acknowledgeUnknownResend !== true) throw new OwnerSyncCandidateError('sync_unknown_resend_requires_confirmation')
      return exclusively(async captured => {
        let pending = await options.outbox.read()
        assertActive(captured)
        if (!pending.entry || !['attempted', 'unknown'].includes(pending.entry.state)) {
          throw new OwnerSyncCandidateError('sync_invalid_transition')
        }
        const original = await packet(pending)
        if (pending.entry.state === 'attempted') {
          pending = await options.outbox.compareAndSwap(pending.version, { ...pending.entry, state: 'unknown' })
        }
        assertActive(captured)
        pending = await options.outbox.compareAndSwap(pending.version, { ...pending.entry!, state: 'attempted' })
        try {
          assertActive(captured)
          const result = await deadline(async signal => {
            assertActive(captured)
            const response = await options.transport.write(original, signal)
            assertActive(captured)
            if (signal.aborted) throw new OwnerSyncCandidateError('sync_context_changed')
            return parseSyncWriteResponse(response.status, response.rawBody)
          })
          await acceptResult(pending, original, result, captured)
        } catch { await markUnknown(pending) }
        return status()
      })
    },
    async clearResolvedOrUnsent(): Promise<OwnerSyncCandidateStatus> {
      return exclusively(async captured => {
        const pending = await options.outbox.read()
        assertActive(captured)
        if (!pending.entry || !['prepared', 'confirmed', 'conflict'].includes(pending.entry.state)) {
          throw new OwnerSyncCandidateError('sync_invalid_transition')
        }
        await options.outbox.compareAndSwap(pending.version, null)
        assertActive(captured)
        state = 'idle'
        lastResult = null
        return status()
      })
    },
  }
}
