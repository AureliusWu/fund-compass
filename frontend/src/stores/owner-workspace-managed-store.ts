/** Lazy store-owned managed facade. No ambient storage or caller-supplied guard.
 * The watchlist host owns the real locator, current handle and source image.
 */
import { watch } from 'vue'
import { createOwnerWorkspaceSync, OwnerWorkspaceSyncError } from './ownerWorkspaceSync'
import { hasOwnerSession, ownerSession, ownerSessionGeneration, getOwnerSyncTargetFingerprint } from './ownerSession'
import { createOwnerSyncHttpTransport } from '@/api/owner-sync-transport'
import { ownerApiTarget } from '@/api/request'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { OwnerWorkspaceError } from './owner-workspace'
import type { OwnerWorkspaceGuard, OwnerWorkspaceLocalState, OwnerWorkspaceSyncState } from './owner-workspace-types'

type Managed = ReturnType<typeof createOwnerWorkspaceSync>
type Methods = Omit<Managed, 'setCloudConsent' | 'notifySessionChanged' | 'close'>
export type OwnerWorkspaceSyncFacade = Readonly<Omit<Methods, 'exportPending'> & {
  getState(): OwnerWorkspaceSyncState | null
  exportPending(): Promise<(NonNullable<Awaited<ReturnType<Managed['exportPending']>>> & { readonly targetFingerprint: string }) | null>
}>
type Port = Parameters<typeof createOwnerWorkspaceSync>[0]['workspace']
export interface ManagedWatchlistHost {
  readonly target: string
  readonly lifetime: AbortSignal
  readonly port: Port
  prepare(signal: AbortSignal): Promise<void>
  capture(signal: AbortSignal, canonical: (value: unknown) => string): OwnerWorkspaceGuard
  accept(state: OwnerWorkspaceLocalState, canonical: (value: unknown) => string): void
  assertActive(): void
}
const TOTAL_MS = 12_000
function fail(code: OwnerWorkspaceSyncError['code']): never { throw new OwnerWorkspaceSyncError(code) }
function session() {
  const active = hasOwnerSession()
  return { authenticated: active && !!ownerSession.value?.scopes.includes('read_private')
    && !!ownerSession.value?.scopes.includes('write_holdings'), generation: ownerSessionGeneration.value }
}

export async function createManagedWatchlistOwner(host: ManagedWatchlistHost) {
  host.assertActive()
  const targetUrl = ownerApiTarget()
  const transport = await createOwnerSyncHttpTransport()
  host.assertActive()
  if (transport.targetFingerprint !== host.target || ownerApiTarget() !== targetUrl) fail('managed_invalid_options')
  let closed = false, enabled = false, action: AbortController | null = null, view: OwnerWorkspaceSyncState | null = null
  let publication: Readonly<{ operation: 'link' | 'prepare' | 'cancel' | 'ack'; id: string; hash: string }> | null = null
  let cleanups: Array<() => void> = []
  const sameTarget = () => { try { return ownerApiTarget() === targetUrl } catch { return false } }
  function capturedGuard(signal: AbortSignal): OwnerWorkspaceGuard {
      if (!action || action.signal.aborted) fail('managed_context_changed')
      const combined = new AbortController(), stop = () => combined.abort()
      for (const input of [signal, action.signal, host.lifetime]) {
        input.addEventListener('abort', stop, { once: true })
        cleanups.push(() => input.removeEventListener('abort', stop))
        if (input.aborted) combined.abort()
      }
      const captured = host.capture(combined.signal, canonicalOwnerLocal)
      return { signal: captured.signal, assertActive() {
        if (!sameTarget()) fail('managed_context_changed')
        captured.assertActive()
      } }
  }
  const port: Port = { ...host.port,
    linkCloudBase: (request, guard) => mutation('link', request, () => host.port.linkCloudBase(request, guard)),
    prepareCloud: (request, guard) => mutation('prepare', request, () => host.port.prepareCloud(request, guard)),
    cancelPreparedCloud: (request, guard) => mutation('cancel', request, () => host.port.cancelPreparedCloud(request, guard)),
    ackCloud: (request, guard) => mutation('ack', request, () => host.port.ackCloud(request, guard)),
  }
  async function mutation(operation: NonNullable<typeof publication>['operation'], request: { id: string; hash: string },
    work: () => Promise<OwnerWorkspaceSyncState>) {
    publication = Object.freeze({ operation, id: request.id, hash: request.hash })
    try { return await work() } catch (error) {
      if (error instanceof OwnerWorkspaceError && ['workspace_invalid_input', 'workspace_invalid_target', 'workspace_conflict',
        'workspace_pending', 'workspace_capacity', 'workspace_version_exhausted', 'workspace_noop',
        'workspace_idempotency_conflict'].includes(error.code)) publication = null
      throw error
    }
  }
  const managed = createOwnerWorkspaceSync({ workspace: port, transport, session, guard: capturedGuard })
  function disable() {
    enabled = false; view = null; action?.abort()
    if (!closed) managed.setCloudConsent(false)
  }
  const stopSession = watch(ownerSessionGeneration, () => {
    disable(); managed.notifySessionChanged()
  }, { flush: 'sync' })
  function close() {
    if (closed) return
    disable(); closed = true; stopSession(); managed.close()
    host.lifetime.removeEventListener('abort', close)
  }
  host.lifetime.addEventListener('abort', close, { once: true })
  if (host.lifetime.aborted) close()
  function check(signal?: AbortSignal) {
    if (closed) fail('managed_closed')
    if (!enabled) fail('managed_disabled')
    if (signal?.aborted || host.lifetime.aborted) fail('managed_context_changed')
    if (!sameTarget()) fail('managed_context_changed')
    host.assertActive()
    if (!session().authenticated) fail('managed_signed_out')
  }
  async function run<K extends Exclude<keyof Methods, 'status'>>(name: K,
    args: Parameters<Methods[K]>): Promise<Awaited<ReturnType<Methods[K]>>> {
    check()
    if (action) fail('managed_busy')
    if (publication && name !== 'reconcileLocal' && name !== 'exportPending') fail('managed_local_unknown')
    const controller = new AbortController(), generation = ownerSessionGeneration.value
    action = controller
    let timedOut = false, rejectAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new OwnerWorkspaceSyncError(timedOut ? 'managed_timeout' : 'managed_context_changed'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, TOTAL_MS)
    const ensure = () => { check(controller.signal); if (generation !== ownerSessionGeneration.value) fail('managed_context_changed') }
    try {
      const result = await Promise.race([(async () => {
        await host.prepare(controller.signal); ensure()
        if (await getOwnerSyncTargetFingerprint() !== host.target) fail('managed_context_changed')
        ensure()
        let value: unknown
        if (name === 'reconcileLocal' && publication && !managed.status().uncertainLocal) {
          if (args[0] !== publication.id || args[1] !== publication.hash) fail('managed_local_unknown')
          const receipt = await host.port.syncReceipt(publication.id, publication.hash, capturedGuard(controller.signal))
          ensure()
          if (receipt.state === 'matched') {
            const hydrated = await managed.hydrate(); ensure()
            if (canonicalOwnerLocal(hydrated) !== canonicalOwnerLocal(receipt.value)) fail('managed_context_changed')
          }
          value = receipt
        } else {
          const call = managed[name] as (...values: unknown[]) => Promise<unknown>
          value = await call(...args)
        }
        ensure()
        return value
      })(), cancelled])
      ensure()
      // Mirror only after the ENTIRE managed action (including hydrate/reset)
      // returns. Updating generation in a port writer would revoke our own op.
      if (result && typeof result === 'object' && 'local' in result && 'sync' in result) {
        const image = result as OwnerWorkspaceSyncState
        host.accept(image.local, canonicalOwnerLocal); view = image
      } else if (name === 'reconcileLocal' && result && typeof result === 'object'
        && 'state' in result && result.state === 'matched' && 'value' in result) {
        const image = result.value as OwnerWorkspaceSyncState
        host.accept(image.local, canonicalOwnerLocal); view = image
      }
      // Vue sync watchers can revoke consent/session during host.accept.
      // Keep the original local tuple until this final publication check wins.
      ensure()
      if (name !== 'exportPending' && (name !== 'reconcileLocal'
        || result && typeof result === 'object' && 'state' in result && result.state === 'matched')) publication = null
      return result as Awaited<ReturnType<Methods[K]>>
    } catch (error) {
      view = null
      throw error
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort)
      cleanups.splice(0).forEach(cleanup => cleanup())
      controller.abort(); if (action === controller) action = null
    }
  }
  const facade: OwnerWorkspaceSyncFacade = Object.freeze({
    status: () => {
      if (enabled && !sameTarget()) disable()
      const status = managed.status(), visible = enabled && session().authenticated
      return Object.freeze({ ...status, busy: visible && action !== null,
        ...(visible && publication ? { state: 'local_unknown' as const, uncertainLocal: publication,
          completeReady: false, resultReady: false } : {}) })
    },
    getState: () => enabled && session().authenticated && sameTarget() ? view : null,
    hydrate: () => run('hydrate', []), pullComplete: () => run('pullComplete', []),
    previewLink: id => run('previewLink', [id]), commitLink: (request, confirmed) => run('commitLink', [request, confirmed]),
    previewPreparation: id => run('previewPreparation', [id]),
    commitPreparation: (request, confirmed) => run('commitPreparation', [request, confirmed]),
    sendOnce: () => run('sendOnce', []), reconcileReceipt: () => run('reconcileReceipt', []),
    previewAcknowledgement: (id, resolutions) => run('previewAcknowledgement', [id, resolutions]),
    commitAcknowledgement: (request, confirmed) => run('commitAcknowledgement', [request, confirmed]),
    cancelPrepared: (id, confirmed) => run('cancelPrepared', [id, confirmed]),
    reconcileLocal: (id, hash) => run('reconcileLocal', [id, hash]),
    async exportPending() {
      const value = await run('exportPending', [])
      return value ? Object.freeze({ ...value, targetFingerprint: host.target }) : null
    },
  })
  // Preserve the version-bound receipt while its original local result is
  // uncertain, including after logout. Local writers must not overwrite it.
  return Object.freeze({ facade, disable, close, isBusy: () => action !== null || publication !== null,
    async enable(consent: true, signal: AbortSignal) {
      if (consent !== true) fail('managed_confirmation_required')
      if (closed) fail('managed_closed')
      if (action) fail('managed_busy')
      await host.prepare(signal)
      if (signal.aborted) fail('managed_context_changed')
      if (await getOwnerSyncTargetFingerprint() !== host.target) fail('managed_invalid_options')
      host.assertActive()
      if (signal.aborted) fail('managed_context_changed')
      if (!session().authenticated) fail('managed_signed_out')
      enabled = true; managed.setCloudConsent(true)
      return facade
    },
    sourceChanged() { view = null; action?.abort(); if (enabled && !closed) managed.setCloudConsent(true) },
  })
}
export type ManagedWatchlistOwner = Awaited<ReturnType<typeof createManagedWatchlistOwner>>
