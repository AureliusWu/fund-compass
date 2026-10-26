/** Lazy store-owned full fund/manual reconciliation and packet workflow.
 * The app owns locator, current memory and guards; no second outbox is opened.
 * Only an independently confirmed original packet may make one explicit POST.
 * Unknown retains the original and permits receipt/export only, never resend.
 * Complete-D strict ACK is separate; personal analysis remains unavailable.
 */
import { watch } from 'vue'
import { createOwnerSyncHttpTransport } from '@/api/owner-sync-transport'
import { ownerApiTarget } from '@/api/request'
import { hasOwnerSession, ownerSession, ownerSessionGeneration, getOwnerSyncTargetFingerprint } from './ownerSession'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import { parseSyncChangesPage, type OwnerSyncCursor } from '@/utils/ownerSyncContract'
import { createOwnerSyncBoundedFold } from '@/utils/owner-sync-bounded-fold'
import { previewOwnerPortfolioInitialMerge, type OwnerPortfolioInitialMergePreview,
  type OwnerPortfolioInitialMergeResolution } from '@/utils/owner-portfolio-merge'
import { buildOwnerWorkspaceFullSyncLinkRequest, OwnerWorkspaceError } from './owner-workspace'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerWorkspace, OwnerWorkspaceFullSyncLinkRequest, OwnerWorkspaceFullSyncState,
  OwnerWorkspaceGuard, OwnerWorkspaceLocalState } from './owner-workspace-types'
import type { createOwnerPortfolioWorkspaceSync } from './ownerPortfolioWorkspaceSync'
import type { OwnerPortfolioAckResolution } from '@/utils/owner-portfolio-ack'
import type { OwnerPortfolioRefreshResolution } from '@/utils/owner-portfolio-refresh'
import type { OwnerWorkspaceFullSyncPrepareRequest, OwnerWorkspaceFullSyncAckRequest, OwnerWorkspaceFullSyncRefreshRequest } from './owner-workspace-types'

type PacketManaged = ReturnType<typeof createOwnerPortfolioWorkspaceSync>
type PacketMethods = Omit<PacketManaged, 'setCloudConsent' | 'notifySessionChanged' | 'close'>
export type OwnerFullSyncPacketFacade = Readonly<PacketMethods & { getState(): OwnerWorkspaceFullSyncState | null }>

export interface FullSyncInitialPreview { readonly preview: OwnerPortfolioInitialMergePreview; readonly token: string | null }
export interface OwnerFullSyncFacade {
  status(): Readonly<{ enabled: boolean; busy: boolean; completeReady: boolean; minimumObservedRevision: number | null;
    linked: boolean; uncertainLocal: Readonly<{ id: string; hash: string }> | null }>
  pullComplete(): Promise<Readonly<{ revision: number; records: number }>>
  previewInitial(resolutions: readonly OwnerPortfolioInitialMergeResolution[]): Promise<FullSyncInitialPreview>
  commitInitial(token: string, confirmed: true): Promise<OwnerWorkspaceFullSyncState>
  invalidatePreview(): void
  reconcileLocal(): Promise<Readonly<{ state: 'unknown' }> | Readonly<{ state: 'matched'; value: OwnerWorkspaceFullSyncState }>>
  enablePackets(consent: true): Promise<OwnerFullSyncPacketFacade>
}
export interface FullSyncManagedHost {
  readonly target: string
  readonly lifetime: AbortSignal
  readonly port: Pick<OwnerWorkspace, 'readFullSyncState' | 'linkFullSyncBase' | 'fullSyncReceipt'
    | 'prepareFullSync' | 'cancelPreparedFullSync' | 'transitionFullSyncDelivery' | 'ackFullSync' | 'refreshFullSync'>
  prepare(signal: AbortSignal, allowUnknown: boolean): Promise<OwnerWorkspaceFullSyncState>
  capture(signal: AbortSignal, canonical: (input: unknown) => string): OwnerWorkspaceGuard
  assertActive(): void
  accept(state: OwnerWorkspaceLocalState): void
  pending(value: Readonly<{ id: string; hash: string }> | null): void
  hidden(): void
}
function fail(): never { throw new Error('full_sync_context_rejected') }
function signedIn() { return hasOwnerSession() && !!ownerSession.value?.scopes.includes('read_private') && !!ownerSession.value?.scopes.includes('write_holdings') }
export async function createManagedFullSyncOwner(host: FullSyncManagedHost) {
  host.assertActive()
  const targetUrl = ownerApiTarget(), transport = await createOwnerSyncHttpTransport()
  host.assertActive()
  if (transport.targetFingerprint !== host.target || ownerApiTarget() !== targetUrl) fail()
  let enabled = false, closed = false, action: AbortController | null = null
  let complete: OwnerSyncBaseline | null = null, expected: OwnerWorkspaceFullSyncState | null = null
  let request: OwnerWorkspaceFullSyncLinkRequest | null = null
  let observedHead = 0, linked = false
  let publication: Readonly<{ operation: 'link' | 'prepare' | 'cancel' | 'ack' | 'refresh'; id: string; hash: string }> | null = null
  let packets: PacketManaged | null = null, packetsEnabled = false, packetView: OwnerWorkspaceFullSyncState | null = null
  let packetCleanups: Array<() => void> = []
  const sameTarget = () => { try { return ownerApiTarget() === targetUrl } catch { return false } }
  function clear() { complete = null; expected = null; request = null }
  function disable() {
    enabled = false; packetsEnabled = false; packetView = null; clear(); action?.abort()
    if (!closed) packets?.setCloudConsent(false)
    host.hidden()
  }
  const stopSession = watch(ownerSessionGeneration, disable, { flush: 'sync' })
  const endpointChanged = () => { if (!sameTarget()) disable() }
  const surface = typeof window === 'undefined' ? null : window
  surface?.addEventListener('storage', endpointChanged)
  surface?.addEventListener('focus', endpointChanged)
  function check(signal?: AbortSignal, localReceipt = false) {
    if (closed || signal?.aborted || host.lifetime.aborted || !sameTarget()) { disable(); fail() }
    host.assertActive()
    if (!localReceipt && (!enabled || !signedIn())) fail()
  }
  async function run<T>(work: (signal: AbortSignal, guard: OwnerWorkspaceGuard, state: OwnerWorkspaceFullSyncState,
    ensure: () => void) => Promise<T>, localReceipt = false, startedAt = performance.now()): Promise<T> {
    check(undefined, localReceipt)
    if (action || publication && !localReceipt) fail()
    const controller = new AbortController(), generation = ownerSessionGeneration.value
    action = controller
    const abort = () => controller.abort()
    host.lifetime.addEventListener('abort', abort, { once: true })
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error('full_sync_cancelled'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const start = startedAt; let last = start
    const timerAt = performance.now(), validClock = Number.isFinite(start) && Number.isFinite(timerAt) && timerAt >= start
    if (!validClock) controller.abort()
    else last = timerAt
    const remaining = validClock ? Math.max(0, 12_000 - (timerAt - start)) : 0
    const timer = setTimeout(abort, remaining)
    const ensure = () => {
      const now = performance.now()
      if (!Number.isFinite(start) || !Number.isFinite(now) || now < last || now - start >= 12_000) controller.abort()
      last = now
      check(controller.signal, localReceipt); if (generation !== ownerSessionGeneration.value) fail()
    }
    try {
      return await Promise.race([(async () => {
        ensure()
        const state = await host.prepare(controller.signal, localReceipt); ensure()
        if (await getOwnerSyncTargetFingerprint() !== host.target) fail()
        ensure()
        const captured = host.capture(controller.signal, canonicalOwnerLocal)
        const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() { ensure(); captured.assertActive() } }
        const value = await work(controller.signal, guard, state, ensure); ensure(); return value
      })(), cancelled])
    } catch (error) { clear(); throw error }
    finally {
      clearTimeout(timer); host.lifetime.removeEventListener('abort', abort)
      packetCleanups.splice(0).forEach(cleanup => cleanup())
      controller.signal.removeEventListener('abort', rejectAbort); controller.abort()
      if (action === controller) action = null
    }
  }
  function packetGuard(signal: AbortSignal): OwnerWorkspaceGuard {
    if (!action || action.signal.aborted) fail()
    const controller = new AbortController(), stop = () => controller.abort()
    for (const source of [signal, action.signal, host.lifetime]) {
      source.addEventListener('abort', stop, { once: true }); packetCleanups.push(() => source.removeEventListener('abort', stop))
      if (source.aborted) controller.abort()
    }
    const captured = host.capture(controller.signal, canonicalOwnerLocal)
    return { signal: controller.signal, assertActive() { check(controller.signal); if (!packetsEnabled) fail(); captured.assertActive() } }
  }
  async function packetMutation(operation: 'prepare' | 'cancel' | 'ack' | 'refresh', request: { id: string; hash: string },
    work: () => Promise<OwnerWorkspaceFullSyncState>) {
    const original = Object.freeze({ operation, id: request.id, hash: request.hash })
    publication = original; host.pending(original)
    try { return await work() }
    catch (error) {
      if (publication === original && error instanceof OwnerWorkspaceError && ['workspace_invalid_input', 'workspace_invalid_target', 'workspace_conflict',
        'workspace_pending', 'workspace_capacity', 'workspace_version_exhausted', 'workspace_noop', 'workspace_idempotency_conflict'].includes(error.code)) {
        publication = null; host.pending(null)
      }
      throw error
    }
  }
  async function packetRun<K extends Exclude<keyof PacketMethods, 'status'>>(name: K,
    args: Parameters<PacketMethods[K]>, startedAt = performance.now()): Promise<Awaited<ReturnType<PacketMethods[K]>>> {
    check()
    if (!packetsEnabled || !packets || action || publication && !['reconcileLocal', 'exportPending'].includes(name)) fail()
    const originalPublication = publication
    const controller = new AbortController(), generation = ownerSessionGeneration.value
    action = controller
    const abort = () => controller.abort(), start = startedAt; let last = start
    host.lifetime.addEventListener('abort', abort, { once: true })
    let rejectAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error('full_packet_cancelled')); controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timerAt = performance.now(), validClock = Number.isFinite(start) && Number.isFinite(timerAt) && timerAt >= start
    if (!validClock) controller.abort()
    else last = timerAt
    const remaining = validClock ? Math.max(0, 12_000 - (timerAt - start)) : 0
    const timer = setTimeout(abort, remaining)
    const ensure = () => {
      const now = performance.now()
      if (!Number.isFinite(start) || !Number.isFinite(now) || now < last || now - start >= 12_000) controller.abort()
      last = now; check(controller.signal)
      if (!packetsEnabled || generation !== ownerSessionGeneration.value) fail()
    }
    try {
      // The public entry captured start BEFORE its descriptor-safe copy. No
      // host preparation, locator read or coordinator work may start on a
      // spent/bad/backwards clock, and the timer uses only the remaining time.
      const result = await Promise.race([(async () => {
        ensure()
        await host.prepare(controller.signal, name === 'reconcileLocal'); ensure()
        if (await getOwnerSyncTargetFingerprint() !== host.target) fail()
        ensure()
        if (name === 'reconcileLocal' && publication && !packets!.status().uncertainLocal) {
          if (args[0] !== publication.id || args[1] !== publication.hash) fail()
          const value = await host.port.fullSyncReceipt(publication.id, publication.hash, packetGuard(controller.signal)); ensure()
          if (value.state === 'matched') {
            const hydrated = await packets!.hydrate(); ensure()
            if (canonicalOwnerLocal(hydrated) !== canonicalOwnerLocal(value.value)) fail()
          }
          return value
        }
        const call = packets![name] as (...values: unknown[]) => Promise<unknown>
        const value = await call(...args); ensure(); return value
      })(), cancelled])
      ensure()
      if (result && typeof result === 'object' && 'local' in result && 'fullSync' in result) {
        const image = result as OwnerWorkspaceFullSyncState
        host.accept(image.local); packetView = image
      } else if (name === 'reconcileLocal' && result && typeof result === 'object' && 'state' in result && result.state === 'matched' && 'value' in result) {
        const image = result.value as OwnerWorkspaceFullSyncState
        host.accept(image.local); packetView = image
      }
      // All coordinator hydration/reset and host publication finished. A sync
      // logout/source watcher above can still leave the original tuple unknown.
      ensure()
      if (name !== 'exportPending' && (name !== 'reconcileLocal' || result && typeof result === 'object' && 'state' in result && result.state === 'matched')) {
        if (!originalPublication || publication === originalPublication) { publication = null; host.pending(null) }
      }
      return result as Awaited<ReturnType<PacketMethods[K]>>
    } catch (error) { packetView = null; throw error }
    finally {
      clearTimeout(timer); host.lifetime.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort)
      packetCleanups.splice(0).forEach(cleanup => cleanup()); controller.abort(); if (action === controller) action = null
    }
  }
  const packetFacade: OwnerFullSyncPacketFacade = Object.freeze({
    status: () => {
      if (!sameTarget()) disable()
      const status = packets?.status() ?? { state: 'disabled' as const, busy: false, completeReady: false, resultReady: false, uncertainLocal: null }
      const uncertain = publication && publication.operation !== 'link'
        ? Object.freeze({ operation: publication.operation, id: publication.id, hash: publication.hash }) : null
      return Object.freeze({ ...status, ...(packetsEnabled && signedIn() && uncertain
        ? { state: 'local_unknown' as const, uncertainLocal: uncertain, completeReady: false, resultReady: false } : {}) })
    },
    getState: () => packetsEnabled && signedIn() && sameTarget() ? packetView : null,
    hydrate: () => packetRun('hydrate', []), pullComplete: () => packetRun('pullComplete', []),
    previewPreparation: (id: string) => packetRun('previewPreparation', [id]),
    commitPreparation: (request: OwnerWorkspaceFullSyncPrepareRequest, confirmed: true) => {
      const startedAt = performance.now()
      const owned = copyOwnerFullSyncInput(request) as OwnerWorkspaceFullSyncPrepareRequest
      return packetRun('commitPreparation', [owned, confirmed], startedAt)
    },
    sendOnce: () => packetRun('sendOnce', []), reconcileReceipt: () => packetRun('reconcileReceipt', []),
    previewAcknowledgement: (id: string, resolutions: readonly OwnerPortfolioAckResolution[] = []) => {
      const startedAt = performance.now()
      const owned = copyOwnerFullSyncInput(resolutions) as readonly OwnerPortfolioAckResolution[]
      return packetRun('previewAcknowledgement', [id, owned], startedAt)
    },
    commitAcknowledgement: (request: OwnerWorkspaceFullSyncAckRequest, confirmed: true) => {
      const startedAt = performance.now()
      const owned = copyOwnerFullSyncInput(request) as OwnerWorkspaceFullSyncAckRequest
      return packetRun('commitAcknowledgement', [owned, confirmed], startedAt)
    },
    previewRefresh: (id: string, resolutions: readonly OwnerPortfolioRefreshResolution[] = []) => {
      const startedAt = performance.now()
      const owned = copyOwnerFullSyncInput(resolutions) as readonly OwnerPortfolioRefreshResolution[]
      return packetRun('previewRefresh', [id, owned], startedAt)
    },
    commitRefresh: (request: OwnerWorkspaceFullSyncRefreshRequest, confirmed: true) => {
      const startedAt = performance.now()
      const owned = copyOwnerFullSyncInput(request) as OwnerWorkspaceFullSyncRefreshRequest
      return packetRun('commitRefresh', [owned, confirmed], startedAt)
    },
    cancelPrepared: (id: string, confirmed: true) => packetRun('cancelPrepared', [id, confirmed]),
    reconcileLocal: (id: string, hash: string) => packetRun('reconcileLocal', [id, hash]), exportPending: () => packetRun('exportPending', []),
  })
  const facade: OwnerFullSyncFacade = Object.freeze({
    status() {
      if (!sameTarget()) disable()
      const visible = enabled && signedIn()
      return Object.freeze({ enabled: visible, busy: action !== null, completeReady: visible && complete !== null,
        minimumObservedRevision: visible ? observedHead : null, linked: visible && linked, uncertainLocal: publication })
    },
    pullComplete: () => run(async (signal, guard, state, ensure) => {
      clear()
      if (state.fullSync.base !== null || state.fullSync.pending !== null || state.local.outbox.entry !== null) fail()
      const fold = createOwnerSyncBoundedFold()
      let upper: number | undefined, cursor: OwnerSyncCursor | undefined
      for (let pages = 0; pages <= 100_000; pages++) {
        guard.assertActive()
        const parameters = { sinceRevision: 0, limit: 200,
          ...(upper === undefined ? {} : { upperRevision: upper }), ...(cursor === undefined ? {} : { cursor }) }
        const response = await transport.changes(parameters, signal)
        guard.assertActive()
        if (response.status !== 200) fail()
        const folded = fold.accumulateOwnerSyncPage(response.rawBody, parameters), page = folded.page
        upper = page.upper_revision
        // Retained on later failures, never promoted from a partial page to C.
        observedHead = Math.max(observedHead, upper)
        if (folded.capacityIssue || folded.baselineIssue) fail()
        if (page.complete) {
          if (upper < observedHead) fail()
          const base = folded.completedBaseline
          if (!base) fail()
          const current = await host.prepare(signal, false); guard.assertActive(); ensure()
          if (canonicalOwnerLocal(current) !== canonicalOwnerLocal(state)) fail()
          complete = base; expected = state
          return Object.freeze({ revision: upper, records: base.records.length })
        }
        cursor = page.next_cursor!
      }
      return fail()
    }),
    previewInitial(resolutions: readonly OwnerPortfolioInitialMergeResolution[]) {
      // Descriptor-safe own copy before run can reach its first await.
      const startedAt = performance.now()
      const choices = copyOwnerFullSyncInput(resolutions) as readonly OwnerPortfolioInitialMergeResolution[]
      return run(async (_signal, guard, state) => {
        request = null
        if (!complete || !expected || canonicalOwnerLocal(state) !== canonicalOwnerLocal(expected) || !state.local.portfolio) fail()
        const preview = previewOwnerPortfolioInitialMerge({ base: state.local.sync?.base ?? null,
          localSnapshot: state.local.snapshot, portfolio: state.local.portfolio, completeBaseline: complete,
          minimumObservedRevision: observedHead, resolutions: choices })
        if (!preview.issues.length && preview.nextSnapshot && preview.nextPortfolio && preview.baseC) {
          request = await buildOwnerWorkspaceFullSyncLinkRequest(host.target, { id: 'portfolio-initial-' + crypto.randomUUID(),
            expected: state, base: complete, minimumObservedRevision: observedHead, resolutions: choices })
          guard.assertActive()
        }
        return Object.freeze({ preview, token: request?.hash ?? null })
      }, false, startedAt)
    },
    commitInitial(token: string, confirmed: true) {
      return run(async (_signal, guard, state, ensure) => {
        const original = request
        if (confirmed !== true || !original || token !== original.hash || !expected
          || canonicalOwnerLocal(state) !== canonicalOwnerLocal(expected)) fail()
        publication = Object.freeze({ operation: 'link', id: original.id, hash: original.hash }); host.pending(publication)
        try {
          const value = await host.port.linkFullSyncBase(original, guard)
          guard.assertActive(); ensure()
          const current = await host.port.readFullSyncState(guard); guard.assertActive()
          if (canonicalOwnerLocal(current) !== canonicalOwnerLocal(value)) fail()
          host.accept(value.local); ensure()
          publication = null; host.pending(null); linked = true; clear()
          return value
        } catch (error) {
          if (error instanceof OwnerWorkspaceError && ['workspace_invalid_input', 'workspace_invalid_target', 'workspace_conflict',
            'workspace_pending', 'workspace_capacity', 'workspace_version_exhausted', 'workspace_noop', 'workspace_idempotency_conflict'].includes(error.code)) {
            publication = null; host.pending(null)
          }
          throw error
        }
      })
    },
    invalidatePreview() { request = null },
    reconcileLocal() {
      if (publication && publication.operation !== 'link') return packetFacade.reconcileLocal(publication.id, publication.hash)
      return run(async (_signal, guard, _state, ensure) => {
      const original = publication
      if (!original) fail()
      const result = await host.port.fullSyncReceipt(original.id, original.hash, guard)
      guard.assertActive(); ensure()
      if (result.state === 'matched') {
        const current = await host.port.readFullSyncState(guard); guard.assertActive()
        if (canonicalOwnerLocal(current) !== canonicalOwnerLocal(result.value)) fail()
        host.accept(result.value.local); ensure()
        publication = null; host.pending(null); linked = result.value.fullSync.base !== null; clear()
      }
      return result
      }, true)
    },
    enablePackets(consent: true) {
      return run(async (signal, guard, state, ensure) => {
        if (consent !== true || !signedIn() || !state.fullSync.base || publication?.operation === 'link') fail()
        if (!packets) {
          const module = await import('./ownerPortfolioWorkspaceSync'); guard.assertActive()
          const guardedTransport = { ...transport,
            async changes(parameters: Parameters<typeof transport.changes>[0], active: AbortSignal) {
              const response = await transport.changes(parameters, active)
              if (response.status === 200) {
                const page = parseSyncChangesPage(response.rawBody, parameters)
                const previousFloor = observedHead; observedHead = Math.max(observedHead, page.upper_revision)
                if (page.upper_revision < previousFloor) fail()
              }
              return response
            },
          }
          packets = module.createOwnerPortfolioWorkspaceSync({
            workspace: { ...host.port, targetFingerprint: host.target,
              prepareFullSync: (request, active) => packetMutation('prepare', request, () => host.port.prepareFullSync(request, active)),
              cancelPreparedFullSync: (request, active) => packetMutation('cancel', request, () => host.port.cancelPreparedFullSync(request, active)),
              ackFullSync: (request, active) => packetMutation('ack', request, () => host.port.ackFullSync(request, active)),
              refreshFullSync: (request, active) => packetMutation('refresh', request, () => host.port.refreshFullSync(request, active)),
            }, transport: guardedTransport, session: () => ({ authenticated: signedIn(), generation: ownerSessionGeneration.value }), guard: packetGuard,
          })
        }
        packetsEnabled = true; packets.setCloudConsent(true)
        if (!publication) {
          const image = await packets.hydrate(); guard.assertActive(); ensure()
          host.accept(image.local); packetView = image; ensure()
        }
        return packetFacade
      }, true)
    },
  })
  function close() {
    if (closed) return
    disable(); packets?.close(); closed = true; stopSession(); host.lifetime.removeEventListener('abort', close)
    surface?.removeEventListener('storage', endpointChanged); surface?.removeEventListener('focus', endpointChanged)
  }
  host.lifetime.addEventListener('abort', close, { once: true })
  return Object.freeze({ facade, disable, close, isBusy: () => action !== null || publication !== null,
    isRunning: () => action !== null,
    sourceChanged() { disable() },
    async enable(consent: true, signal: AbortSignal) {
      if (consent !== true || closed || action || signal.aborted || !sameTarget() || !signedIn()) fail()
      const state = await host.prepare(signal, publication !== null)
      if (signal.aborted || !sameTarget() || !signedIn()) fail()
      linked = state.fullSync.base !== null; enabled = true; return facade
    } })
}
export type ManagedFullSyncOwner = Awaited<ReturnType<typeof createManagedFullSyncOwner>>
