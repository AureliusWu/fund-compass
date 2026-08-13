import { afterEach, describe, expect, it, vi } from 'vitest'

describe('loadManagers integrity', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function response(body: unknown, ok = true) {
    const text = JSON.stringify(body)
    return { ok, json: vi.fn().mockResolvedValue(body), text: vi.fn().mockResolvedValue(text) }
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
