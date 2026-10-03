import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fund = { c: '000001', n: '合成基金', t: '混合型', r1m: null, r3m: null, r6m: 3, r1y: 4, r3y: 5, ytd: null, fee: 0.1 }
const manager = { id: '1', name: '合成经理', company: '合成公司', codes: ['000001'], names: ['合成基金'], days: '1', ret: '1', scale: '1' }
const loaders = [
  { name: 'screener', collection: 'funds', rows: [fund], source: 'eastmoney_fund_ranking', load: async () => (await import('./screener')).loadScreener },
  { name: 'managers', collection: 'managers', rows: [manager], source: 'eastmoney_fund_managers', load: async () => (await import('./managers')).loadManagers },
] as const

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue(JSON.stringify(body)) }
}

function legacy(loader: typeof loaders[number]) {
  return response({ schema_version: 2, updated: '2026-07-01', fetched_at: '2026-07-01T10:00:00+08:00', source: loader.source, [loader.collection]: loader.rows })
}

async function chunkGeneration(loader: typeof loaders[number]) {
  const rows = Array.from({ length: 8 }, (_, index) => loader.collection === 'funds'
    ? { ...fund, c: String(index + 1).padStart(6, '0') }
    : { ...manager, id: String(index + 1) })
  const textByIndex = rows.map(row => JSON.stringify({ [loader.collection]: [row] }))
  const datasetText = JSON.stringify(rows)
  const bytesByText = new Map<string, ArrayBuffer>()
  for (const value of [...textByIndex, datasetText]) {
    bytesByText.set(value, await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  }
  const hashFor = (value: string) => [...new Uint8Array(bytesByText.get(value)!)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const files = textByIndex.map((value, index) => `part-${String(index).padStart(3, '0')}-${hashFor(value).slice(0, 12)}.json`)
  // Resolve known synthetic digests deterministically so queue timing does not
  // depend on native crypto thread-pool scheduling. Existing integrity tests
  // separately exercise native SHA-256.
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
    const value = bytesByText.get(new TextDecoder().decode(data))
    if (!value) throw new Error('unexpected synthetic digest input')
    return value
  })
  return {
    rows, files, textByIndex,
    manifest: {
      schema_version: 2, updated: '2026-07-01', collection: loader.collection, total: rows.length,
      sha256: hashFor(datasetText), chunks: files,
      chunk_sha256: Object.fromEntries(files.map((file, index) => [file, hashFor(textByIndex[index])])),
    },
  }
}

function chunkResponse(text: string, status = 200) {
  return { ok: status === 200, status, text: () => Promise.resolve(text) }
}

describe.each(loaders)('$name loader boundaries', loader => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-02T04:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('only falls back when the manifest is exactly HTTP 404', async () => {
    const load = await loader.load()
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, 503))
    vi.stubGlobal('fetch', fetchMock)
    await expect(load()).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(legacy(loader))
    await expect(load()).resolves.toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' })
  })

  it('rejects an empty successful manifest without legacy fallback', async () => {
    const load = await loader.load()
    const fetchMock = vi.fn().mockResolvedValueOnce(response(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await expect(load()).rejects.toThrow('清单格式无效')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['fetch', 'body'])('bounds a hanging manifest %s even if abort is ignored, then recovers', async phase => {
    const load = await loader.load()
    const fetchMock = vi.fn().mockImplementationOnce(() => phase === 'fetch'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }))
    vi.stubGlobal('fetch', fetchMock)
    const result = load()
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(12_001)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(legacy(loader))
    await expect(load()).resolves.toBeTruthy()
  })

  it('does not let cancelling one caller cancel an unrelated load', async () => {
    const load = await loader.load()
    let resolveLegacy!: (value: ReturnType<typeof response>) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(response({}, 404))
      .mockImplementationOnce(() => new Promise(resolve => { resolveLegacy = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const first = load({ signal: controller.signal })
    const firstAssertion = expect(first).rejects.toMatchObject({ kind: 'cancelled' })
    const second = load()
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await firstAssertion
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(false)
    resolveLegacy(legacy(loader))
    await expect(second).resolves.toBeTruthy()
  })

  it('aborts its outstanding sibling chunks when one chunk fails', async () => {
    const load = await loader.load()
    const files = [`part-000-${'a'.repeat(12)}.json`, `part-001-${'b'.repeat(12)}.json`]
    const fetchMock = vi.fn().mockResolvedValueOnce(response({
      schema_version: 2, updated: '2026-07-01', collection: loader.collection, total: 2,
      sha256: 'c'.repeat(64), chunks: files,
      chunk_sha256: { [files[0]]: 'a'.repeat(64), [files[1]]: 'b'.repeat(64) },
    })).mockResolvedValueOnce(response({}, 503)).mockImplementationOnce(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    await expect(load()).rejects.toThrow('分片加载失败')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true)
    expect(fetchMock.mock.calls[2][1].cache).toBe('force-cache')
  })

  it.each(['body', 'hash'])('bounds an unfinished chunk %s without falling back', async phase => {
    const load = await loader.load()
    const file = `part-000-${'a'.repeat(12)}.json`
    const chunkText = JSON.stringify({ [loader.collection]: loader.rows })
    const fetchMock = vi.fn().mockResolvedValueOnce(response({
      schema_version: 2, updated: '2026-07-01', collection: loader.collection, total: 1,
      sha256: 'b'.repeat(64), chunks: [file], chunk_sha256: { [file]: 'a'.repeat(64) },
    })).mockResolvedValueOnce({
      ok: true, status: 200,
      text: () => phase === 'body' ? new Promise(() => {}) : Promise.resolve(chunkText),
    })
    if (phase === 'hash') vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const pending = load()
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(12_001)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true)
  })

  it('keeps the whole-loader deadline active through final collection hashing', async () => {
    const load = await loader.load()
    const arrayText = JSON.stringify(loader.rows)
    const text = `{"${loader.collection}":${arrayText}}`
    const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const hash = [...new Uint8Array(digestBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const file = `part-000-${hash.slice(0, 12)}.json`
    const digestMock = vi.spyOn(crypto.subtle, 'digest').mockResolvedValueOnce(digestBytes).mockImplementation(() => new Promise(() => {}))
    const fetchMock = vi.fn().mockResolvedValueOnce(response({
      schema_version: 2, updated: '2026-07-01', collection: loader.collection, total: 1,
      sha256: 'a'.repeat(64), chunks: [file], chunk_sha256: { [file]: hash },
    })).mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(text) })
    vi.stubGlobal('fetch', fetchMock)
    const pending = load()
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(0)
    expect(digestMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(12_001)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a cancelled legacy body that finishes late', async () => {
    const load = await loader.load()
    let resolveBody!: (value: unknown) => void
    const fetchMock = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce({
      ok: true, status: 200, json: () => new Promise(resolve => { resolveBody = resolve }),
    }).mockResolvedValueOnce(response({}, 503))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = load({ signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    resolveBody(await legacy(loader).json())
    await vi.advanceTimersByTimeAsync(0)
    await expect(load()).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('limits chunks to six, starts one new chunk per completed slot, and preserves manifest order', async () => {
    const load = await loader.load()
    const generation = await chunkGeneration(loader)
    const finish: ((value: ReturnType<typeof chunkResponse>) => void)[] = []
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/manifest.json')) return Promise.resolve(response(generation.manifest))
      const index = generation.files.findIndex(file => url.endsWith('/' + file))
      return new Promise(resolve => { finish[index] = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = load()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(7) // One manifest plus six chunks.
    expect(finish[6]).toBeUndefined()
    expect(finish[7]).toBeUndefined()
    finish[5](chunkResponse(generation.textByIndex[5]))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(finish[6]).toBeTypeOf('function')
    expect(finish[7]).toBeUndefined()
    finish[2](chunkResponse(generation.textByIndex[2]))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(9)
    // Finish out of order; whole-collection digest and output must still follow
    // manifest order, not arrival order.
    for (const index of [7, 6, 4, 3, 1, 0]) finish[index](chunkResponse(generation.textByIndex[index]))
    const result = await pending
    expect(Array.isArray(result) ? result : result.funds).toEqual(generation.rows)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'failure'])('does not start queued chunks after %s, even when active fetches finish late', async stop => {
    const load = await loader.load()
    const generation = await chunkGeneration(loader)
    const finish: ((value: ReturnType<typeof chunkResponse>) => void)[] = []
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/manifest.json')) return Promise.resolve(response(generation.manifest))
      const index = generation.files.findIndex(file => url.endsWith('/' + file))
      signals[index] = init.signal!
      return new Promise(resolve => { finish[index] = resolve })
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = load({ signal: controller.signal })
    const assertion = stop === 'cancel'
      ? expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
      : expect(pending).rejects.toThrow('分片加载失败')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    if (stop === 'cancel') controller.abort()
    else finish[0](chunkResponse('', 503))
    await assertion
    expect(signals).toHaveLength(6)
    // A failed response has already cleaned up its request signal; all still
    // outstanding siblings must be aborted.
    expect(signals.slice(stop === 'failure' ? 1 : 0).every(signal => signal.aborted)).toBe(true)
    for (let index = 0; index < 6; index++) finish[index](chunkResponse(generation.textByIndex[index]))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(finish[6]).toBeUndefined()
    expect(finish[7]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
