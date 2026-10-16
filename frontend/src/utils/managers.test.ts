import { afterEach, describe, expect, it, vi } from 'vitest'
import { managerSnapshotFreshness } from './managers'

describe('manager snapshot dates are collection dates, not metric dates', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules() })

  it('uses Beijing midnight and keeps the seven-day boundary explicit', () => {
    expect(managerSnapshotFreshness('2026-09-24', new Date('2026-10-01T15:59:59Z'))).toEqual({ ageDays: 7, stale: false })
    expect(managerSnapshotFreshness('2026-09-24', new Date('2026-10-01T16:00:00Z'))).toEqual({ ageDays: 8, stale: true })
  })

  it.each([null, '', '2026-02-30', '2026-10-02'])('does not turn unknown, invalid or future collection dates into age zero: %s', value => {
    expect(managerSnapshotFreshness(value, new Date('2026-10-01T12:00:00Z'))).toEqual({ ageDays: null, stale: true })
  })

  it('fails closed for invalid or out-of-range clocks', () => {
    expect(managerSnapshotFreshness('2026-10-01', new Date(NaN))).toEqual({ ageDays: null, stale: true })
    expect(managerSnapshotFreshness('2026-10-01', new Date(8.64e15))).toEqual({ ageDays: null, stale: true })
  })

  it('preserves legacy fetch metadata, leaves metric date unknown, and recomputes cached age without network', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T15:59:59Z'))
    const manager = { id: '1', name: '合成经理', company: '公司', codes: ['000001'], names: ['基金'], days: '1', ret: '0', scale: '' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
        schema_version: 2, source: 'eastmoney_fund_managers', updated: '2026-09-24',
        fetched_at: '2026-09-24T10:00:00+08:00', managers: [manager],
      }) })
    vi.stubGlobal('fetch', fetchMock)
    const { loadManagerDataset, loadManagers } = await import('./managers')
    expect(await loadManagerDataset()).toMatchObject({ collectedOn: '2026-09-24', fetchedAt: '2026-09-24T10:00:00+08:00', valueDate: null, ageDays: 7, stale: false })
    vi.setSystemTime(new Date('2026-10-01T16:00:00Z'))
    expect(await loadManagerDataset()).toMatchObject({ valueDate: null, ageDays: 8, stale: true })
    expect(await loadManagers()).toEqual([manager])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not invent a fetch timestamp or metric date for a verified manifest', async () => {
    const manager = { id: '1', name: '合成经理', company: '公司', codes: ['000001'], names: ['基金'], days: '1', ret: '0', scale: '' }
    const rows = JSON.stringify([manager])
    const body = `{"managers":${rows}}`
    const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const chunkHash = await hash(body)
    const file = `part-000-${chunkHash.slice(0, 12)}.json`
    const datasetHash = await hash(rows)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ schema_version: 2, updated: '2026-09-28', total: 1, collection: 'managers', sha256: datasetHash, chunks: [file], chunk_sha256: { [file]: chunkHash } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => body }))
    const { loadManagerDataset } = await import('./managers')
    expect(await loadManagerDataset()).toMatchObject({ managers: [manager], collectedOn: '2026-09-28', fetchedAt: null, valueDate: null })
  })

  it('does not call an empty fallback generation a fresh manager collection', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ schema_version: 2, source: 'eastmoney_fund_managers', updated: '2026-09-28', fetched_at: '2026-09-28T10:00:00+08:00', managers: [] }) }))
    const { loadManagerDataset } = await import('./managers')
    await expect(loadManagerDataset()).rejects.toThrow('基金经理数据格式无效')
  })
})

describe('loadManagers integrity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function response(body: unknown, ok = true) {
    const text = JSON.stringify(body)
    return { ok, status: ok ? 200 : 404, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue(text) }
  }

  it('rejects duplicate manager ids across immutable chunks', async () => {
    const manager = { id: '1', name: '经理', company: '公司', codes: ['000001'], names: ['基金'], days: '1', ret: '1', scale: '1' }
    const body = JSON.stringify({ managers: [manager, manager] })
    const chunkDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    const chunkHash = [...new Uint8Array(chunkDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const file = `part-000-${chunkHash.slice(0, 12)}.json`
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({
        schema_version: 2, updated: '2026-08-12', total: 2, collection: 'managers', chunks: [file],
        sha256: 'a'.repeat(64), chunk_sha256: { [file]: chunkHash },
      }))
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(body) }))
    const { loadManagers } = await import('./managers')

    await expect(loadManagers()).rejects.toThrow('基金经理数据分片不完整')
  })

  it('rejects a chunk whose bytes do not match its declared digest', async () => {
    const file = `part-000-${'b'.repeat(12)}.json`
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({
        schema_version: 2, updated: '2026-08-12', total: 1, collection: 'managers',
        sha256: 'a'.repeat(64), chunks: [file],
        chunk_sha256: { [file]: 'b'.repeat(12) + 'c'.repeat(52) },
      }))
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue('{"managers":[]}') }))
    const { loadManagers } = await import('./managers')

    await expect(loadManagers()).rejects.toThrow('基金经理数据分片校验失败')
  })

  it('accepts only schema-v2 manager monolith fallback', async () => {
    const manager = { id: '1', name: '经理', company: '公司', codes: ['000001'], names: ['基金'], days: '1', ret: '1', scale: '1' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({}, false))
      .mockResolvedValueOnce(response({
        schema_version: 1,
        updated: '2026-08-12',
        fetched_at: '2026-08-12T10:00:00+08:00',
        source: 'eastmoney_fund_managers',
        managers: [manager],
      })))
    const { loadManagers } = await import('./managers')

    await expect(loadManagers()).rejects.toThrow('基金经理数据格式无效')
  })
})
