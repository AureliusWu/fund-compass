import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OWNER_PORTFOLIO_LOCAL_SCHEMA, OWNER_PORTFOLIO_MAX_RAW_BYTES, OWNER_PORTFOLIO_MAX_HISTORY,
  applyOwnerPortfolioCommand, previewOwnerPortfolioMigration, validateOwnerPortfolioCommand, validateOwnerPortfolioLocal, verifyOwnerPortfolioMigration,
  type OwnerPortfolioLocal, type OwnerPortfolioMigrationSource, type OwnerPortfolioObservation,
} from './ownerPortfolioLocal'
import { canonicalOwnerLocal } from './owner-workspace-backup'

const legacy = { id: 'synthetic-cash', name: '合成现金', cls: '现金', value: 0,
  note: '', updated_at: '2026-10-22T23:00:00.12Z' }
const oldHolding = { id: 'opaque|账户|not-a-composite-key', code: 'not-a-fund-code', name: '合成旧资产',
  account: '原账户', type: '原类别', value: 0, cost: 0 }
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
const source = (rows: unknown[] = [legacy], history: unknown[] = []): OwnerPortfolioMigrationSource => ({
  manualRaw: canonicalOwnerLocal(rows), snapshotsRaw: canonicalOwnerLocal(history),
})
async function portfolio(input = source()): Promise<OwnerPortfolioLocal> {
  const preview = await previewOwnerPortfolioMigration(input)
  expect(preview.issues).toEqual([])
  return preview.portfolio!
}
const observation = (patch: Partial<OwnerPortfolioObservation> = {}): OwnerPortfolioObservation => ({
  id: 'synthetic-observation-0001', kind: 'observation', observed_at: '2026-10-22T16:00:00Z', date: '2026-10-23',
  calendar: 'Asia/Shanghai', value: 5, cost: null, holdings: [
    { kind: 'fund', key: '000001::合成账户', name: '合成基金', type: '股票型', value: 3, cost: 2 },
    { kind: 'manual', key: 'asset:synthetic-cash', name: '合成现金', cls: '现金', value: 2, cost: null },
  ], ...patch,
})
afterEach(() => vi.restoreAllMocks())

describe('explicit local portfolio migration codec', () => {
  it('retains exact raw bytes, known zero, empty note, original timestamp and opaque legacy history', async () => {
    const input = { manualRaw: ' \n' + canonicalOwnerLocal([{ ...legacy, value: -0 }]) + '\r\n',
      snapshotsRaw: '[{"date":"2026-10-22","value":-0,"cost":0,"holdings":[' + canonicalOwnerLocal(oldHolding) + ']}]' }
    const preview = await previewOwnerPortfolioMigration(input), result = preview.portfolio!
    expect(preview.issues).toEqual([])
    expect(preview.source).toEqual(input)
    expect(preview.sourceSha256).toBe(hash(canonicalOwnerLocal(input)))
    expect(result.migration.manualRaw).toBe(input.manualRaw)
    expect(result.migration.snapshotsRaw).toBe(input.snapshotsRaw)
    expect(result.manual[0]).toMatchObject({ key: 'asset:synthetic-cash', legacyId: legacy.id,
      values: { name: legacy.name, cls: legacy.cls, note: '' }, updated_at: legacy.updated_at, local_pending: true })
    expect(Object.is(result.manual[0].values.value, -0)).toBe(true)
    expect(result.history[0]).toMatchObject({ id: 'legacy:0', kind: 'legacy', calendar: 'legacy-utc',
      observed_at: null, date: '2026-10-22', holdings: [oldHolding] })
    expect(Object.is(result.history[0].value, -0)).toBe(true)
    expect(await verifyOwnerPortfolioMigration(result)).toEqual(result)
    expect(Object.isFrozen(result.manual[0].values)).toBe(true)
    expect(Object.isFrozen(result.migration.idMappings)).toBe(true)
  })

  it('supports absent legacy slots without inventing time, records or raw', async () => {
    const preview = await previewOwnerPortfolioMigration({ manualRaw: null, snapshotsRaw: null })
    expect(preview.portfolio).toEqual({ schema: OWNER_PORTFOLIO_LOCAL_SCHEMA, manual: [], history: [],
      migration: { manualRaw: null, snapshotsRaw: null, sourceSha256: hash(canonicalOwnerLocal({ manualRaw: null, snapshotsRaw: null })), idMappings: [] } })
    expect(await verifyOwnerPortfolioMigration(preview.portfolio)).toEqual(preview.portfolio)
  })

  it('maps long or padded legacy IDs explicitly without trimming or losing their original identity', async () => {
    const ids = ['x'.repeat(200), ' original id ', 'control\u0001id', '合法短ID']
    const result = await portfolio(source(ids.map(id => ({ ...legacy, id }))))
    expect(result.migration.idMappings.map(item => item.legacyId)).toEqual(ids)
    for (const [index, id] of ids.entries()) {
      const mapped = result.migration.idMappings[index]
      if (index < 3) {
        expect(mapped.mode).toBe('sha256')
        expect(mapped.idSha256).toBe(hash(canonicalOwnerLocal({ schema: 'owner-portfolio-legacy-id-1', legacyId: id })))
        expect(mapped.key).toBe('asset:legacy-' + mapped.idSha256)
      } else expect(mapped).toEqual({ legacyId: id, key: 'asset:' + id, mode: 'identity', idSha256: null })
      expect(result.manual[index].legacyId).toBe(id)
    }
    expect(await verifyOwnerPortfolioMigration(result)).toEqual(result)
  })

  it('detects a hashed ID colliding with another already wire-valid legacy ID', async () => {
    const id = ' original id ', idSha = hash(canonicalOwnerLocal({ schema: 'owner-portfolio-legacy-id-1', legacyId: id }))
    const input = source([{ ...legacy, id }, { ...legacy, id: 'legacy-' + idSha }])
    const preview = await previewOwnerPortfolioMigration(input)
    expect(preview.portfolio).toBeNull()
    expect(preview.issues).toContainEqual({ source: 'manual', index: null, code: 'id_collision' })
    expect(preview.idMappings).toHaveLength(2)
    expect(preview.source).toEqual(input)
  })

  it('keeps all duplicate dates, original order and more than 200 old snapshots', async () => {
    const history = Array.from({ length: 201 }, (_, index) => ({ date: index % 2 ? '2026-10-21' : '2026-10-22', value: index, cost: 0 }))
    const result = await portfolio(source([], history))
    expect(result.history).toHaveLength(201)
    expect(result.history.map(item => item.date)).toEqual(history.map(item => item.date))
    expect(result.history.map(item => item.value)).toEqual(history.map(item => item.value))
    expect(result.history[0].holdings).toBeNull()
  })

  it.each([
    { ...legacy, value: null }, { ...legacy, value: -1 }, { ...legacy, name: 'bad\u0001name' },
    { ...legacy, note: null }, { ...legacy, note: 'bad\nvalue' }, { ...legacy, id: '' },
    { ...legacy, extra: true }, { ...legacy, updated_at: '2026-02-30T00:00:00Z' },
    { ...legacy, updated_at: '2026-10-22T23:00:00+00:00' }, { ...legacy, updated_at: null },
  ])('blocks an incompatible entire manual source, without cleaning values or dropping the raw %#', async value => {
    const input = source([legacy, { ...value, id: value.id === legacy.id ? 'another-id' : value.id }])
    const result = await previewOwnerPortfolioMigration(input)
    expect(result.portfolio).toBeNull()
    expect(result.issues.some(item => item.source === 'manual')).toBe(true)
    expect(result.source).toEqual(input)
  })

  it.each([
    { date: '2026-02-30', value: 1, cost: 0 }, { date: '2026-10-22', value: null, cost: 0 },
    { date: '2026-10-22', value: 1, cost: null }, { date: '2026-10-22', value: 1, cost: 0, unsupported: 2 },
    { date: '2026-10-22', value: 1, cost: 0, holdings: [{ ...oldHolding, cost: null }] },
    { date: '2026-10-22', value: 1, cost: 0, holdings: null },
  ])('rejects malformed legacy history as a whole without old loader filtering %#', async bad => {
    const input = source([legacy], [{ date: '2026-10-21', value: 0, cost: 0 }, bad])
    const result = await previewOwnerPortfolioMigration(input)
    expect(result.portfolio).toBeNull()
    expect(result.issues.some(item => item.source === 'snapshots')).toBe(true)
    expect(result.source.snapshotsRaw).toBe(input.snapshotsRaw)
  })

  it.each([
    '[{"id":"a","id":"b"}]', '[{"id":"a","\\u0069d":"b"}]',
    '[{"id":"\\ud800"}]', '[9007199254740993]', 'not JSON', '{}',
  ])('uses the existing strict raw grammar, not JSON.parse repairs %#', async raw => {
    const result = await previewOwnerPortfolioMigration({ manualRaw: raw, snapshotsRaw: '[]' })
    expect(result.portfolio).toBeNull()
    expect(result.source.manualRaw).toBe(raw)
  })

  it('rejects duplicate IDs and total overflow without partially importing good records', async () => {
    for (const rows of [[legacy, legacy], [{ ...legacy, id: 'a', value: 1e308 }, { ...legacy, id: 'b', value: 1e308 }]]) {
      const preview = await previewOwnerPortfolioMigration(source(rows))
      expect(preview.portfolio).toBeNull(); expect(preview.issues).not.toHaveLength(0)
    }
  })

  it('refuses exact raw limit and excessive count, preserving every original byte rather than trimming', async () => {
    const raw = ' '.repeat(OWNER_PORTFOLIO_MAX_RAW_BYTES)
    const overRaw = await previewOwnerPortfolioMigration({ manualRaw: raw, snapshotsRaw: null })
    expect(overRaw.portfolio).toBeNull(); expect(overRaw.source.manualRaw).toBe(raw)
    expect(overRaw.sourceSha256).toBeNull()
    expect(overRaw.issues).toEqual([{ source: 'manual', index: null, code: 'capacity_exceeded' }])
    const input = source([], Array.from({ length: OWNER_PORTFOLIO_MAX_HISTORY + 1 }, () => ({ date: '2026-10-22', value: 0, cost: 0 })))
    const excessive = await previewOwnerPortfolioMigration(input)
    expect(excessive.portfolio).toBeNull(); expect(excessive.source).toEqual(input)
    expect(excessive.issues).toContainEqual({ source: 'snapshots', index: null, code: 'capacity_exceeded' })
  })

  it('distinguishes synchronous shape checks from actual asynchronous raw and ID digest verification', async () => {
    const result = await portfolio(source([{ ...legacy, id: 'x'.repeat(200) }]))
    const changedHash = { ...result, migration: { ...result.migration, sourceSha256: 'a'.repeat(64) } }
    expect(validateOwnerPortfolioLocal(changedHash).migration.sourceSha256).toBe('a'.repeat(64))
    await expect(verifyOwnerPortfolioMigration(changedHash)).rejects.toMatchObject({ code: 'hash_mismatch' })
    const fakeIdHash = 'b'.repeat(64), key = 'asset:legacy-' + fakeIdHash
    const changedId = { ...result, manual: [{ ...result.manual[0], key }], migration: { ...result.migration,
      idMappings: [{ ...result.migration.idMappings[0], key, idSha256: fakeIdHash }] } }
    expect(validateOwnerPortfolioLocal(changedId).manual[0].key).toBe(key)
    await expect(verifyOwnerPortfolioMigration(changedId)).rejects.toMatchObject({ code: 'hash_mismatch' })
  })

  it('does not silently lose or mutate origin mappings and the full immutable legacy history prefix', async () => {
    const result = await portfolio(source([legacy], [{ date: '2026-10-22', value: 1, cost: 0, holdings: [oldHolding] }]))
    const mutations = [
      { ...result, manual: [] },
      { ...result, manual: [{ ...result.manual[0], legacyId: null }] },
      { ...result, history: [] },
      { ...result, history: [{ ...result.history[0], date: '2026-10-23' }] },
      { ...result, history: [{ ...result.history[0], cost: -0 }] },
      { ...result, migration: { ...result.migration, idMappings: [] } },
      { ...result, migration: { ...result.migration, manualRaw: '[]' } },
    ]
    for (const input of mutations) expect(() => validateOwnerPortfolioLocal(input)).toThrow()
  })

  it('matches all original identities by key even after reordering, without allowing a duplicate to hide a missing origin', async () => {
    const result = await portfolio(source(Array.from({ length: 32 }, (_, index) => ({ ...legacy, id: 'synthetic-' + index }))))
    const reversed = { ...result, manual: [...result.manual].reverse() }
    expect(validateOwnerPortfolioLocal(reversed).manual.map(item => item.legacyId)).toEqual(reversed.manual.map(item => item.legacyId))
    const missing = { ...reversed, manual: reversed.manual.slice(1) }
    expect(() => validateOwnerPortfolioLocal(missing)).toThrow()
    const duplicated = { ...reversed, manual: [reversed.manual[1], ...reversed.manual.slice(1)] }
    expect(() => validateOwnerPortfolioLocal(duplicated)).toThrow()
    const wrongOrigin = { ...reversed, manual: [{ ...reversed.manual[0], legacyId: reversed.manual[1].legacyId }, ...reversed.manual.slice(1)] }
    expect(() => validateOwnerPortfolioLocal(wrongOrigin)).toThrow()
  })

  it('rejects getters, hidden fields, symbols and sparse/augmented arrays before reading untrusted values', async () => {
    const result = await portfolio(source([legacy], [{ date: '2026-10-22', value: 0, cost: 0 }]))
    const getter = vi.fn(() => '2026-10-22')
    const history = { ...result.history[0] }; Object.defineProperty(history, 'date', { get: getter, enumerable: true })
    expect(() => validateOwnerPortfolioLocal({ ...result, history: [history] })).toThrow()
    const top = { ...result }; Object.defineProperty(top, 'secret', { value: 'not-read', enumerable: false })
    expect(() => validateOwnerPortfolioLocal(top)).toThrow()
    expect(() => validateOwnerPortfolioLocal({ ...result, [Symbol('extra')]: 1 })).toThrow()
    const sparse = new Array(1)
    expect(() => validateOwnerPortfolioLocal({ ...result, manual: sparse })).toThrow()
    const rows = [...result.manual]; Object.defineProperty(rows, 'extra', { value: true })
    expect(() => validateOwnerPortfolioLocal({ ...result, manual: rows })).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it('fails closed when SHA is unavailable, leaving the original source available', async () => {
    const input = source()
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('unavailable'))
    const preview = await previewOwnerPortfolioMigration(input)
    expect(preview.portfolio).toBeNull(); expect(preview.sourceSha256).toBeNull(); expect(preview.source).toEqual(input)
    expect(preview.issues).toEqual([{ source: 'portfolio', index: null, code: 'hash_unavailable' }])
  })

  it('enforces the full 8 MiB image cap before copying the remainder of an oversized history', async () => {
    const before = await portfolio({ manualRaw: null, snapshotsRaw: null })
    const holdings = Array.from({ length: 100 }, (_, index) => ({ kind: 'fund' as const,
      key: String(index).padStart(6, '0') + '::合成账户', name: '名'.repeat(200), type: '类'.repeat(200), value: 1, cost: 0 }))
    const history: unknown[] = Array.from({ length: 200 }, (_, index) => observation({
      id: 'synthetic-capacity-' + index, value: 100, cost: 0, holdings,
    }))
    const lateGetter = vi.fn(() => 'observation')
    Object.defineProperty(history[199], 'kind', { get: lateGetter, enumerable: true })
    expect(() => validateOwnerPortfolioLocal({ ...before, history })).toThrowError(expect.objectContaining({ code: 'capacity_exceeded' }))
    expect(lateGetter).not.toHaveBeenCalled()
  })
})

describe('pure portfolio business postimages', () => {
  it('creates and edits manual assets without mutating the input, fabricating revisions or normalizing negative zero', async () => {
    const before = await portfolio(), beforeRaw = canonicalOwnerLocal(before)
    const created = applyOwnerPortfolioCommand(before, { type: 'save_manual', key: 'asset:new-manual',
      values: { name: ' 新资产 ', cls: '商品', value: -0, note: null }, updated_at: '2026-10-23T00:00:00Z' })
    expect(created.changedKeys).toEqual(['asset:new-manual'])
    expect(created.portfolio.manual[1]).toMatchObject({ key: 'asset:new-manual', legacyId: null, deleted: false,
      values: { name: ' 新资产 ', cls: '商品', note: null }, local_pending: true })
    expect(Object.is(created.portfolio.manual[1].values.value, -0)).toBe(true)
    expect(canonicalOwnerLocal(before)).toBe(beforeRaw)
    // Complete values are deliberately closed: legacy id/updated_at may not enter the DTO.
    expect(() => applyOwnerPortfolioCommand(created.portfolio, { type: 'save_manual', key: 'asset:synthetic-cash',
      values: { ...legacy, value: 4, note: null, id: undefined }, updated_at: '2026-10-23T00:00:00Z' })).toThrow()
  })

  it('edits only mutable business fields and retains original migration identity and raw', async () => {
    const before = await portfolio()
    const result = applyOwnerPortfolioCommand(before, { type: 'save_manual', key: before.manual[0].key,
      values: { ...before.manual[0].values, value: 5, note: null }, updated_at: '2026-10-23T00:00:00Z' }).portfolio
    expect(result.manual[0]).toMatchObject({ legacyId: legacy.id, values: { value: 5, note: null } })
    expect(result.migration).toEqual(before.migration)
    expect(await verifyOwnerPortfolioMigration(result)).toEqual(result)
  })

  it('deletes via a retained tombstone, rejects silent resurrection or missing delete', async () => {
    const before = await portfolio()
    const deleted = applyOwnerPortfolioCommand(before, { type: 'remove_manual', key: before.manual[0].key, updated_at: '2026-10-23T00:00:00Z' }).portfolio
    expect(deleted.manual).toHaveLength(1)
    expect(deleted.manual[0]).toEqual({ ...before.manual[0], deleted: true, updated_at: '2026-10-23T00:00:00Z' })
    expect(() => applyOwnerPortfolioCommand(deleted, { type: 'save_manual', key: before.manual[0].key,
      values: before.manual[0].values, updated_at: '2026-10-23T01:00:00Z' })).toThrowError(expect.objectContaining({ code: 'deleted_asset' }))
    expect(() => applyOwnerPortfolioCommand(before, { type: 'remove_manual', key: 'asset:missing', updated_at: '2026-10-23T00:00:00Z' }))
      .toThrowError(expect.objectContaining({ code: 'missing_asset' }))
  })

  it('appends new Shanghai balance observations without changing old UTC dates or overwriting the same day', async () => {
    const before = await portfolio(source([legacy], [{ date: '2026-10-22', value: 0, cost: 0 }]))
    const first = applyOwnerPortfolioCommand(before, { type: 'append_observation', observation: observation() })
    const second = applyOwnerPortfolioCommand(first.portfolio, { type: 'append_observation',
      observation: observation({ id: 'synthetic-observation-0002', observed_at: '2026-10-23T01:00:00Z' }) })
    expect(second.portfolio.history).toHaveLength(3)
    expect(second.portfolio.history.map(item => item.date)).toEqual(['2026-10-22', '2026-10-23', '2026-10-23'])
    expect(second.portfolio.history.map(item => item.cost)).toEqual([0, null, null])
    expect(first.changedKeys).toEqual(['history:synthetic-observation-0001'])
    expect(() => applyOwnerPortfolioCommand(first.portfolio, { type: 'append_observation', observation: observation() }))
      .toThrowError(expect.objectContaining({ code: 'duplicate_history' }))
  })

  it.each([
    { date: '2026-10-22' }, { observed_at: '2026-10-22T16:00:00+00:00' }, { cost: 4 }, { value: 6 },
    { holdings: [{ kind: 'manual', key: 'asset:synthetic-cash', name: '现金', cls: '现金', value: 5, cost: 5 }] },
    { holdings: [{ kind: 'fund', key: '000001::acct ', name: '基金', type: '股票', value: 5, cost: null }] },
    { holdings: [{ kind: 'fund', key: '000001::acct', name: '基金', type: '股票', value: 5, cost: 1 }] },
    { holdings: [{ kind: 'fund', key: '000001::acct', name: '基金\u0001', type: '股票', value: 5, cost: null }] },
    { unsupported: true }, { observed_at: '2026-02-30T16:00:00Z' },
  ])('rejects unsupported, misdated or fabricated performance observations %#', async patch => {
    const before = await portfolio()
    expect(() => applyOwnerPortfolioCommand(before, { type: 'append_observation', observation: { ...observation(), ...patch } })).toThrow()
  })

  it('supports fully known fund-only cost and null missing fund cost without replacing it by zero', async () => {
    const before = await portfolio()
    const known = observation({ value: 3, cost: 2, holdings: [observation().holdings[0]] })
    expect(applyOwnerPortfolioCommand(before, { type: 'append_observation', observation: known }).portfolio.history[0].cost).toBe(2)
    const missing = observation({ value: 3, holdings: [{ ...observation().holdings[0], cost: null }] })
    expect(applyOwnerPortfolioCommand(before, { type: 'append_observation', observation: missing }).portfolio.history[0].cost).toBeNull()
  })

  it('checks complete command shapes/getters and never reads a command getter', async () => {
    const before = await portfolio(), getter = vi.fn(() => 'save_manual')
    const input = { key: 'asset:new', values: before.manual[0].values, updated_at: '2026-10-23T00:00:00Z' }
    Object.defineProperty(input, 'type', { enumerable: true, get: getter })
    expect(() => applyOwnerPortfolioCommand(before, input)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    for (const extra of [{ expected_revision: 1 }, { observation: observation() }, { legacyId: 'spoof' }]) {
      expect(() => applyOwnerPortfolioCommand(before, { type: 'save_manual', key: 'asset:new',
        values: before.manual[0].values, updated_at: '2026-10-23T00:00:00Z', ...extra })).toThrow()
    }
  })

  it('makes a deeply frozen command copy before asynchronous callers hash it', async () => {
    const input = { type: 'append_observation', observation: { ...observation(), holdings: [...observation().holdings] } }
    const checked = validateOwnerPortfolioCommand(input)
    input.observation.holdings[0] = { ...input.observation.holdings[0], value: 99 }
    input.observation.value = 100
    expect(checked.type).toBe('append_observation')
    if (checked.type !== 'append_observation') throw new Error('wrong command')
    expect(checked.observation.value).toBe(5)
    expect(checked.observation.holdings[0].value).toBe(3)
    expect(Object.isFrozen(checked.observation.holdings[0])).toBe(true)
  })

  it('does not roll an existing manual timestamp backwards or normalize an invalid key', async () => {
    const before = await portfolio()
    expect(() => applyOwnerPortfolioCommand(before, { type: 'save_manual', key: before.manual[0].key,
      values: before.manual[0].values, updated_at: '2026-10-20T00:00:00Z' })).toThrow()
    expect(() => validateOwnerPortfolioCommand({ type: 'save_manual', key: 'asset: padded ',
      values: before.manual[0].values, updated_at: '2026-10-23T00:00:00Z' })).toThrow()
  })
})
