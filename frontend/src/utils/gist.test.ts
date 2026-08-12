import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  confirmEntriesApplied,
  confirmPulledFile,
  pullEntries,
  pullJsonFile,
  pushJsonFile,
} from './gist'
import { pullManualAssets, pushManualAssets } from './manualAssets'

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
})

afterEach(() => {
  vi.unstubAllGlobals()
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
