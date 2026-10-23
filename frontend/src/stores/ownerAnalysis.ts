/** App-owned lazy analysis session. Ordinary pages neither open a task DB nor
 * send requests. Only the explicit analysis panel enables this workflow. */
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ownerApiTarget, withRequestDeadline } from '@/api/request'
import { hasOwnerSession, ownerSession, ownerSessionGeneration } from './ownerSession'
import { useWatchlistStore } from './watchlist'
import type { OwnerAnalysisManager, OwnerAnalysisView } from './owner-analysis-manager'
import type { V8Action, V8DecisionResult } from '@/api/client'

const labels: Record<V8Action, string> = { buy: '买入', dca: '定投', watch: '观察', add: '加仓', hold: '持有', reduce: '减仓', sell: '卖出' }
export const useOwnerAnalysisStore = defineStore('owner-analysis', () => {
  const workspace = useWatchlistStore(), enabled = ref(false), enabling = ref(false)
  const view = shallowRef<OwnerAnalysisView | null>(null), tick = ref(Date.now())
  let manager: OwnerAnalysisManager | null = null, epoch = 0, endpoint = ''
  let opening: AbortController | null = null, expiry: ReturnType<typeof setTimeout> | null = null
  let clockTimer: ReturnType<typeof setInterval> | null = null
  const authenticated = () => hasOwnerSession() && ownerSession.value?.scopes.includes('read_private') === true
    && ownerSession.value.scopes.includes('run_personal_analysis')
  function stop() {
    epoch++; opening?.abort(); opening = null
    enabled.value = false; enabling.value = false; view.value = null
    const old = manager; manager = null; old?.close()
    if (expiry) clearTimeout(expiry); expiry = null
    if (clockTimer) clearInterval(clockTimer); clockTimer = null
  }
  function publish() {
    if (!manager || !enabled.value || !authenticated()) { view.value = null; return }
    try { if (ownerApiTarget() !== endpoint) { stop(); return } } catch { stop(); return }
    const current = manager, generation = ownerSessionGeneration.value
    view.value = current.view()
    // A synchronous Vue subscriber may log out or replace the manager during
    // publication; never let an old action restore its private payload.
    if (manager !== current || !enabled.value || !authenticated() || ownerSessionGeneration.value !== generation) {
      view.value = null; return
    }
    if (expiry) clearTimeout(expiry)
    const at = view.value?.qualifiedAt
    expiry = at == null ? null : setTimeout(() => { tick.value = Date.now() }, Math.max(1, at + 60_000 - Date.now()))
  }
  const stopSession = watch(ownerSessionGeneration, stop, { flush: 'sync' })
  const stopSource = watch(() => workspace.ownerAnalysisEpoch, () => {
    epoch++; opening?.abort(); manager?.invalidate(); publish()
  }, { flush: 'sync' })
  const resumed = () => { if (manager) { manager.invalidate(); publish() } }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('focus', resumed)
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', resumed)
  onScopeDispose(() => {
    stop(); stopSession(); stopSource()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('focus', resumed)
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', resumed)
  })
  async function enable(consent: true) {
    if (consent !== true || enabling.value || enabled.value || !authenticated()) throw new Error('analysis_not_ready')
    const controller = new AbortController(), captured = epoch, generation = ownerSessionGeneration.value
    opening = controller; enabling.value = true
    const created: { value: OwnerAnalysisManager | null } = { value: null }
    try {
      await withRequestDeadline(async (signal, ensure) => {
        const check = () => {
          ensure()
          if (captured !== epoch || ownerSessionGeneration.value !== generation || !authenticated()) throw new Error('analysis_context_changed')
        }
        const source = await workspace.captureOwnerAnalysisSource(signal); check()
        const url = ownerApiTarget()
        const [analysis, sync, storage, implementation] = await Promise.all([
          import('@/api/owner-analysis-transport'), import('@/api/owner-sync-transport'),
          import('./owner-analysis-outbox'), import('./owner-analysis-manager'),
        ]); check()
        const [transport, syncTransport] = await Promise.all([analysis.createOwnerAnalysisHttpTransport(), sync.createOwnerSyncHttpTransport()]); check()
        if (transport.targetFingerprint !== source.targetFingerprint || syncTransport.targetFingerprint !== source.targetFingerprint
          || ownerApiTarget() !== url) throw new Error('analysis_context_changed')
        await source.verify(signal); check()
        const outbox = await storage.openOwnerAnalysisOutbox(indexedDB, source.targetFingerprint, signal, true)
        try {
          check(); source.assertActive()
          created.value = implementation.createOwnerAnalysisManager({ outbox, transport, sync: syncTransport,
            source: active => workspace.captureOwnerAnalysisSource(active),
            session: () => ({ authenticated: authenticated(), generation: ownerSessionGeneration.value }),
            endpoint: ownerApiTarget, changed: publish })
        } catch (error) { outbox.close(); throw error }
        check(); endpoint = url; manager = created.value; enabled.value = true
        if (!manager) throw new Error('analysis_not_ready')
        await manager.hydrate(); check(); publish()
        clockTimer = setInterval(() => { tick.value = Date.now() }, 15_000)
      }, controller.signal)
    } catch (error) {
      if (created.value && manager !== created.value) created.value.close()
      // An aborted older enable may finish after a new explicit enable starts.
      // Its cleanup must not close or reset the new operation's session.
      if (opening === controller) stop()
      throw error
    } finally {
      if (opening === controller) { opening = null; enabling.value = false }
    }
  }
  const qualified = computed(() => { void tick.value; void workspace.ownerAnalysisEpoch
    return enabled.value && authenticated() && !!view.value?.result && manager?.isQualified() === true })
  const results = computed<V8DecisionResult[]>(() => qualified.value && view.value?.result
    ? view.value.result.run.components.map(row => ({ code: row.code, name: row.evidence.fund_name, type: row.evidence.fund_type,
      action: row.decision.action, action_label: labels[row.decision.action], strength: row.decision.strength,
      confidence: row.decision.confidence, summary: row.decision.summary, decision: row.decision,
      evidence: row.evidence, holding: row.holding, policy: view.value!.result!.run.policy, diff: null })) : [])
  async function invoke<K extends 'hydrate' | 'preview' | 'prepare' | 'sendOnce' | 'reconcile' | 'cancelPrepared' | 'finishMatched'>(
    name: K, ...args: Parameters<OwnerAnalysisManager[K]>) {
    if (!manager || !enabled.value || !authenticated()) throw new Error('analysis_not_ready')
    const current = manager, generation = ownerSessionGeneration.value
    const method = current[name] as (...values: unknown[]) => Promise<void>
    try { await method(...args) }
    finally { if (manager === current && generation === ownerSessionGeneration.value) publish() }
    if (manager !== current || generation !== ownerSessionGeneration.value || !authenticated()) throw new Error('analysis_context_changed')
  }
  return { enabled, enabling, view, qualified, results, enable, disable: stop,
    resultFor: (code: string) => results.value.find(row => row.code === code) ?? null,
    hydrate: () => invoke('hydrate'), preview: (id: string) => invoke('preview', id),
    prepare: (confirmed: true) => invoke('prepare', confirmed), sendOnce: (confirmed: true) => invoke('sendOnce', confirmed),
    reconcile: () => invoke('reconcile'), cancelPrepared: (confirmed: true) => invoke('cancelPrepared', confirmed),
    finishMatched: (confirmed: true) => invoke('finishMatched', confirmed),
    exportTask: () => { if (!manager || !enabled.value || !authenticated()) throw new Error('analysis_not_ready'); return manager.exportTask() },
  }
})
