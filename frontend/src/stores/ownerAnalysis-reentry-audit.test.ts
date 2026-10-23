/** Independent store lifecycle audit. Only the source's unresolved wait is
 * substituted; this does not claim real workspace/locator integration proof. */
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as piniaModule from 'pinia'
import * as vueModule from 'vue'
import * as requestModule from '@/api/request'
import * as sessionModule from './ownerSession'
import { useOwnerAnalysisStore } from './ownerAnalysis'
import { clearOwnerSession, loginOwnerSession } from './ownerSession'

const stub = vi.hoisted(() => ({ workspace: {} as Record<string, unknown> }))
vi.mock('./watchlist', () => ({ useWatchlistStore: () => stub.workspace }))

let store: ReturnType<typeof useOwnerAnalysisStore> | null = null
const captured: AbortSignal[] = []
beforeEach(async () => {
  clearOwnerSession(); captured.length = 0
  vi.stubGlobal('location', { origin: 'https://analysis-audit.example' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    access_token: 'own_' + 's'.repeat(43), token_type: 'Bearer', owner_id: 'owner',
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    scopes: ['read_private', 'write_holdings', 'run_personal_analysis'],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  stub.workspace = reactive({ ownerAnalysisEpoch: 0,
    captureOwnerAnalysisSource: vi.fn((signal: AbortSignal) => {
      captured.push(signal)
      return new Promise<never>(() => { /* Held at the actual store's awaited source boundary. */ })
    }),
  })
  setActivePinia(createPinia())
  await loginOwnerSession('synthetic-only-analysis-audit')
  store = useOwnerAnalysisStore()
})
afterEach(() => {
  store?.$dispose(); store = null; clearOwnerSession()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('an obsolete enable cancellation cannot abort the newer explicit enable', async () => {
  const active = store!
  const first = active.enable(true).catch(error => error)
  expect(captured).toHaveLength(1)
  active.disable()
  const second = active.enable(true).catch(error => error)
  expect(captured).toHaveLength(2)
  expect(active.enabling).toBe(true)
  await first
  // Only A owns the cancelled continuation; B must remain live and enabling.
  expect(captured[1].aborted).toBe(false)
  expect(active.enabling).toBe(true)
  active.disable()
  await second
})

it('the same live-operation assertion detects a read-only copy with the former unconditional cleanup', async () => {
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')
  const source = readFileSync(new URL('./ownerAnalysis.ts', import.meta.url), 'utf8')
  const mutated = source.replace('if (opening === controller) stop()', 'stop()')
    .replace('if (opening === controller) { opening = null; enabling.value = false }',
      'if (opening === controller) opening = null; enabling.value = false')
  expect(mutated).not.toBe(source)
  const compiled = ts.transpileModule(mutated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const modules: Record<string, unknown> = { pinia: piniaModule, vue: vueModule,
    '@/api/request': requestModule, './ownerSession': sessionModule,
    './watchlist': { useWatchlistStore: () => stub.workspace } }
  const exports: Record<string, any> = {}
  new Function('require', 'exports', compiled)((name: string) => {
    if (!(name in modules)) throw Error('control copy must stop before lazy imports')
    return modules[name]
  }, exports)
  store!.$dispose(); setActivePinia(createPinia())
  store = exports.useOwnerAnalysisStore()
  captured.length = 0
  const active = store!
  const first = active.enable(true).catch(error => error)
  active.disable()
  const second = active.enable(true).catch(error => error)
  try {
    await first
    // The original expected-live assertion is red under this exact cleanup
    // mutation; observing that failure is the passing regression control.
    expect(() => expect(captured[1].aborted).toBe(false)).toThrow()
    expect(captured[1].aborted).toBe(true)
    expect(active.enabling).toBe(false)
  } finally { active.disable(); await second }
})
