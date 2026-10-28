import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  confirmEntriesApplied,
  confirmPulledFile,
  pullEntries,
  pullJsonFile,
  pushJsonFile,
  pushEntries,
  setToken,
  clearConfig,
} from './gist'
import { pullManualAssets, pushManualAssets } from './manualAssets'
import { getLegacySyncConsent, getLegacySyncGeneration, setLegacySyncConsent } from './cloud-consent'

const TOKEN_KEY = 'sinan_gist_token'
const ID_KEY = 'sinan_gist_id'
const LOCAL_DATA_KEY = 'sinan_watchlist_v2'
const WATCHLIST_FILE = 'sinan-watchlist.json'
const MANUAL_ASSETS_FILE = 'sinan-manual-assets.json'
const API = 'https://api.github.com/gists'
const STALE_ID = 'stale-cached-gist'
const REPLACEMENT_ID = 'replacement-gist'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function notFoundResponse(): Response {
  return new Response(null, { status: 404 })
}

function stubFetch(...responses: Response[]) {
  const pending = [...responses]
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const response = pending.shift()
    if (!response) throw new Error('unexpected fetch')
    return response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function replacementList(file: string): Response {
  return jsonResponse([
    { id: STALE_ID, files: { [file]: {} } },
    { id: REPLACEMENT_ID, files: { [file]: {} } },
  ])
}

function expectLocalDataPreserved() {
  expect(storage.getItem(TOKEN_KEY)).toBe('test-token')
  expect(storage.getItem(LOCAL_DATA_KEY)).toBe('local-data')
}

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
  storage.setItem(TOKEN_KEY, 'test-token')
  storage.setItem(ID_KEY, STALE_ID)
  storage.setItem(LOCAL_DATA_KEY, 'local-data')
  vi.stubGlobal('localStorage', storage)
  setLegacySyncConsent(true)
})

afterEach(() => {
  setLegacySyncConsent(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('explicit legacy cloud consent', () => {
  it('does not treat an existing PAT as consent, across every cloud entry point', async () => {
    storage.removeItem('sinan_legacy_sync_consent_v1')
    const fetchMock = stubFetch()
    expect(getLegacySyncConsent()).toBe(false)
    await expect(pullEntries()).resolves.toBeNull()
    await expect(pullJsonFile(WATCHLIST_FILE)).resolves.toBeNull()
    await expect(pushEntries([])).resolves.toBe(false)
    await expect(pushJsonFile(WATCHLIST_FILE, [])).resolves.toBe(false)
    await expect(pullManualAssets()).resolves.toBeNull()
    await expect(pushManualAssets([])).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expectLocalDataPreserved()
  })

  it('stays revoked in memory when consent persistence fails', async () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('synthetic-storage-denied') })
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('synthetic-storage-denied') })
    setLegacySyncConsent(false)
    expect(getLegacySyncConsent()).toBe(false)
    const fetchMock = stubFetch()
    await expect(pushEntries([])).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('cancels on credential save and retains local data when config is cleared', async () => {
    let finish!: (response: Response) => void
    const fetchMock = vi.fn((_url, _init) => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = pullEntries()
    const generation = getLegacySyncGeneration()
    setToken('new-synthetic-token')
    expect(getLegacySyncGeneration()).toBeGreaterThan(generation)
    expect(getLegacySyncConsent()).toBe(false)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    finish(jsonResponse({ files: { [WATCHLIST_FILE]: { content: '[]' } } }))
    await expect(pending).resolves.toBeNull()
    clearConfig()
    expect(storage.getItem(LOCAL_DATA_KEY)).toBe('local-data')
    expect(storage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('revokes in-flight body parsing and never commits late cloud metadata', async () => {
    let finishBody!: (value: unknown) => void
    const body = new Promise(resolve => { finishBody = resolve })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => body }))
    const pending = pushJsonFile(WATCHLIST_FILE, [])
    await Promise.resolve(); await Promise.resolve()
    setLegacySyncConsent(false)
    finishBody({ id: 'late-gist' })
    await expect(pending).resolves.toBe(false)
    expect(storage.getItem(ID_KEY)).toBe(STALE_ID)
    expect(storage.getItem('sinan_gist_sync_time')).toBeNull()
    expectLocalDataPreserved()
  })

  it('uses the shared deadline for slow body parsing, with fixed safe errors', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }))
    const pending = pullEntries()
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout', message: '请求超时，请稍后重试' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })

  it('cancels an older same-file pull and ignores its later reverse-order result', async () => {
    const finishes: Array<(response: Response) => void> = []
    const fetchMock = vi.fn((_url, _init) => new Promise<Response>(resolve => { finishes.push(resolve) }))
    vi.stubGlobal('fetch', fetchMock)
    const older = pullEntries()
    const newer = pullEntries()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    const latest = [{ code: '000002', updated_at: '2026-10-01' }]
    finishes[1](jsonResponse({ files: { [WATCHLIST_FILE]: { content: JSON.stringify(latest) } } }))
    await expect(newer).resolves.toEqual(latest)
    finishes[0](jsonResponse({ files: { [WATCHLIST_FILE]: { content: '[]' } } }))
    await expect(older).resolves.toBeNull()
    expect(storage.getItem(ID_KEY)).toBe(STALE_ID)
  })

  it('honors another tab revocation immediately and does not continue 404 discovery', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    setLegacySyncConsent(true)
    let finish!: (response: Response) => void
    const fetchMock = vi.fn((_url, _init) => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = pullEntries()
    const event = Object.assign(new Event('storage'), { key: 'sinan_legacy_sync_consent_v1', newValue: null, storageArea: storage })
    browser.dispatchEvent(event)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    finish(notFoundResponse())
    await expect(pending).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(storage.getItem(ID_KEY)).toBe(STALE_ID)
    expectLocalDataPreserved()
  })

  it('cancels immediately when another tab changes the stored token', async () => {
    const browser = new EventTarget()
    vi.stubGlobal('window', browser)
    setLegacySyncConsent(true)
    let finish!: (response: Response) => void
    const fetchMock = vi.fn((_url, _init) => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = pushJsonFile(WATCHLIST_FILE, [])
    storage.setItem(TOKEN_KEY, 'synthetic-other-tab-token')
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: TOKEN_KEY, newValue: 'synthetic-other-tab-token', storageArea: storage }))
    expect(getLegacySyncConsent()).toBe(false)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    finish(jsonResponse({ id: 'late-token-gist' }))
    await expect(pending).resolves.toBe(false)
    expect(storage.getItem(ID_KEY)).toBe(STALE_ID)
    expect(storage.getItem('sinan_gist_sync_time')).toBeNull()
  })

  it('propagates revocation between two independent tabs without storage-write echo loops', async () => {
    const tabs = [new EventTarget(), new EventTarget()]
    const state = new Map<string, string>()
    const queued: Array<{ tab: number; key: string; value: string | null }> = []
    let currentTab = 0
    let writes = 0
    const sharedStorage = {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => {
        const previous = state.get(key)
        state.set(key, value); writes++
        if (previous !== value) queued.push({ tab: 1 - currentTab, key, value })
      },
      removeItem: (key: string) => { state.delete(key); writes++; queued.push({ tab: 1 - currentTab, key, value: null }) },
    }
    vi.stubGlobal('localStorage', sharedStorage)
    vi.stubGlobal('window', tabs[0])
    vi.resetModules()
    const first = await import('./cloud-consent')
    first.setLegacySyncConsent(true)
    currentTab = 1; vi.stubGlobal('window', tabs[1])
    vi.resetModules()
    const second = await import('./cloud-consent')
    expect(second.getLegacySyncConsent()).toBe(true)
    queued.splice(0)
    first.subscribeLegacySyncConsent(() => {})
    second.subscribeLegacySyncConsent(() => {})
    currentTab = 0; vi.stubGlobal('window', tabs[0])
    first.setLegacySyncConsent(false)
    let delivered = 0
    while (queued.length && delivered < 10) {
      const message = queued.shift()!
      currentTab = message.tab; vi.stubGlobal('window', tabs[currentTab])
      tabs[currentTab].dispatchEvent(Object.assign(new Event('storage'), { key: message.key, newValue: message.value, storageArea: sharedStorage }))
      delivered++
    }
    expect(queued).toHaveLength(0)
    expect(delivered).toBe(1)
    expect(writes).toBe(2) // one opt-in and one local revoke, no external echo.
    currentTab = 0; vi.stubGlobal('window', tabs[0]); expect(first.getLegacySyncConsent()).toBe(false)
    currentTab = 1; vi.stubGlobal('window', tabs[1]); expect(second.getLegacySyncConsent()).toBe(false)
  })

  it.each([
    { shares: -1 }, { cost: -1 }, { target_weight: 101 }, { account: 1 },
    { account: 'A', id: '000001::B' }, { position_kind: 'watch', shares: 1 },
    { updated_at: '2026-02-30' }, { unexpected: 'synthetic-extra' },
  ])('rejects malformed cloud row %o without applying it or making a write request', async invalid => {
    const row = { code: '000001', updated_at: '2026-10-01', ...invalid }
    const fetchMock = stubFetch(jsonResponse({ files: { [WATCHLIST_FILE]: { content: JSON.stringify([row]) } } }))
    await expect(pullEntries()).resolves.toBeNull()
    await expect(pushEntries([row as never])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expectLocalDataPreserved()
  })

  it('rejects duplicate cloud account identities instead of last-wins', async () => {
    const row = { code: '000001', updated_at: '2026-10-01', account: 'A' }
    const fetchMock = stubFetch(jsonResponse({ files: { [WATCHLIST_FILE]: { content: JSON.stringify([row, row]) } } }))
    await expect(pullEntries()).resolves.toBeNull()
    await expect(pushEntries([row, row])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not turn non-finite generic JSON values into null on upload', async () => {
    const fetchMock = stubFetch()
    await expect(pushJsonFile(WATCHLIST_FILE, { value: Infinity })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not leak provider bodies and refuses redirects for authenticated requests', async () => {
    const fetchMock = stubFetch(jsonResponse({ error: 'private-provider-marker' }, 403))
    await expect(pullEntries()).resolves.toBeNull()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expectLocalDataPreserved()
  })
})

describe('cached Gist replacement recovery', () => {
  it('recovers pullEntries from a deleted cached Gist in the same call', async () => {
    const entries = [{ code: '000001', updated_at: '2026-08-12T01:00:00.000Z' }]
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(WATCHLIST_FILE),
      jsonResponse({ files: { [WATCHLIST_FILE]: { content: JSON.stringify(entries) } } }),
    )

    await expect(pullEntries()).resolves.toEqual(entries)
    expect(storage.getItem(ID_KEY)).toBe(REPLACEMENT_ID)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API}/${STALE_ID}`,
      `${API}?per_page=100&page=1`,
      `${API}/${REPLACEMENT_ID}`,
    ])
    expectLocalDataPreserved()
  })

  it('recovers pullJsonFile from a deleted cached Gist in the same call', async () => {
    const assets = [{ id: 'asset-1', name: '现金', value: 100 }]
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(MANUAL_ASSETS_FILE),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify(assets) } } }),
    )

    await expect(pullJsonFile(MANUAL_ASSETS_FILE)).resolves.toEqual(assets)
    expect(storage.getItem(ID_KEY)).toBe(REPLACEMENT_ID)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expectLocalDataPreserved()
  })

  it('rebinds a deleted cached Gist read-only and blocks writes until a successful pull', async () => {
    const assets = [{ id: 'asset-1', name: '现金', value: 100 }]
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(MANUAL_ASSETS_FILE),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify(assets) } } }),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify(assets) } } }),
      jsonResponse({ id: REPLACEMENT_ID }),
    )

    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    expect(storage.getItem(ID_KEY)).toBe(REPLACEMENT_ID)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'PATCH',
      'GET',
      'GET',
    ])

    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await expect(pullJsonFile(MANUAL_ASSETS_FILE)).resolves.toEqual(assets)
    await expect(pushJsonFile(MANUAL_ASSETS_FILE, assets)).resolves.toBe(false)
    confirmPulledFile(MANUAL_ASSETS_FILE)
    await expect(pushJsonFile(MANUAL_ASSETS_FILE, assets)).resolves.toBe(true)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'PATCH',
      'GET',
      'GET',
      'GET',
      'PATCH',
    ])
    expectLocalDataPreserved()
  })

  it('finds a replacement by the requested file instead of another Sinan file', async () => {
    const assets = [{ id: 'asset-1', name: '现金', value: 100 }]
    const fetchMock = stubFetch(
      notFoundResponse(),
      jsonResponse([
        { id: 'watchlist-only', files: { [WATCHLIST_FILE]: {} } },
        { id: REPLACEMENT_ID, files: { [MANUAL_ASSETS_FILE]: {} } },
      ]),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify(assets) } } }),
    )

    await expect(pullJsonFile(MANUAL_ASSETS_FILE)).resolves.toEqual(assets)
    expect(storage.getItem(ID_KEY)).toBe(REPLACEMENT_ID)
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${API}/${REPLACEMENT_ID}`)
  })

  it.each([
    ['pullEntries', () => pullEntries(), null],
    ['pullJsonFile', () => pullJsonFile(MANUAL_ASSETS_FILE), null],
    ['pushJsonFile', () => pushJsonFile(MANUAL_ASSETS_FILE, []), false],
  ])('fails %s safely when no replacement Gist exists', async (_name, operation, expected) => {
    const fetchMock = stubFetch(notFoundResponse(), jsonResponse([]))

    await expect(operation()).resolves.toBe(expected)
    expect(storage.getItem(ID_KEY)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
    expectLocalDataPreserved()
  })

  it('keeps a failed migrated push blocked instead of creating a new Gist later', async () => {
    const fetchMock = stubFetch(notFoundResponse(), jsonResponse([]))

    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
  })

  it('keeps writes blocked after a failed pull recovery', async () => {
    const fetchMock = stubFetch(notFoundResponse(), jsonResponse([]))

    await expect(pullEntries()).resolves.toBeNull()
    await expect(pushJsonFile(WATCHLIST_FILE, [])).resolves.toBe(false)
    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
  })

  it('keeps other managed files locked after the watchlist is applied', async () => {
    const entries = [{ code: '000001', updated_at: '2026-08-12T01:00:00.000Z' }]
    const fetchMock = stubFetch(
      notFoundResponse(),
      jsonResponse([{ id: REPLACEMENT_ID, files: {
        [WATCHLIST_FILE]: {}, [MANUAL_ASSETS_FILE]: {},
      } }]),
      jsonResponse({ files: {
        [WATCHLIST_FILE]: { content: JSON.stringify(entries) },
        [MANUAL_ASSETS_FILE]: { content: '[]' },
      } }),
      jsonResponse({ id: REPLACEMENT_ID }),
    )

    await expect(pullEntries()).resolves.toEqual(entries)
    confirmEntriesApplied()
    await expect(pushJsonFile(MANUAL_ASSETS_FILE, [])).resolves.toBe(false)
    await expect(pushJsonFile(WATCHLIST_FILE, entries)).resolves.toBe(true)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET', 'GET', 'GET', 'PATCH',
    ])
  })

  it('stops after the single replacement retry also returns 404', async () => {
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(WATCHLIST_FILE),
      notFoundResponse(),
    )

    await expect(pullEntries()).resolves.toBeNull()
    expect(storage.getItem(ID_KEY)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expectLocalDataPreserved()
  })

  it('does not unlock migrated manual-asset writes for invalid cloud rows', async () => {
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(MANUAL_ASSETS_FILE),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify([
        { id: 'asset-1', name: '现金', cls: '现金', value: 100 },
      ]) } } }),
    )

    await expect(pullManualAssets()).resolves.toBeNull()
    await expect(pushManualAssets([])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST')
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('PATCH')
  })

  it('does not unlock manual-asset writes when local persistence fails', async () => {
    const assets = [{
      id: 'asset-1', name: '现金', cls: '现金', value: 100,
      updated_at: '2026-08-12T01:00:00.000Z',
    }]
    const originalSetItem = storage.setItem.bind(storage)
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'sinan_manual_assets_v1') throw new DOMException('quota', 'QuotaExceededError')
      originalSetItem(key, value)
    })
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(MANUAL_ASSETS_FILE),
      jsonResponse({ files: { [MANUAL_ASSETS_FILE]: { content: JSON.stringify(assets) } } }),
    )

    await expect(pullManualAssets()).resolves.toBeNull()
    await expect(pushManualAssets(assets as never)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('PATCH')
  })

  it('does not unlock migrated watchlist writes for invalid cloud rows', async () => {
    const fetchMock = stubFetch(
      notFoundResponse(),
      replacementList(WATCHLIST_FILE),
      jsonResponse({ files: { [WATCHLIST_FILE]: { content: '[null]' } } }),
    )

    await expect(pullEntries()).resolves.toBeNull()
    await expect(pushJsonFile(WATCHLIST_FILE, [])).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
