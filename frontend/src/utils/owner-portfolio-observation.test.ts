import { describe, expect, it } from 'vitest'
import { buildOwnerPortfolioHistoryExport, buildOwnerPortfolioObservation } from './owner-portfolio-observation'
import { OWNER_PORTFOLIO_MAX_HISTORY, previewOwnerPortfolioMigration, type OwnerPortfolioLocal } from './ownerPortfolioLocal'
import type { WatchEntry } from './gist'

const now = () => new Date('2026-10-25T16:02:00Z')
const id = 'observation:synthetic-operation-001'
type Entry = Omit<WatchEntry, 'updated_at'>
const held = (account: string, shares: number | null = 2, cost: number | null = 1, code = '000001'): Entry => ({
  id: `${code}::${account}`, code, account, name: `合成${account}`, position_kind: 'holding', shares, cost,
})
async function portfolio(manual = false, snapshotsRaw: string | null = null): Promise<OwnerPortfolioLocal> {
  const result = await previewOwnerPortfolioMigration({ manualRaw: manual
    ? '[{"id":"opaque|000001","name":"手工现金","cls":"现金","value":0,"updated_at":"2026-10-01T00:00:00Z"}]' : null, snapshotsRaw })
  expect(result.issues).toEqual([]); return result.portfolio!
}
describe('operation-only portfolio observation and history construction', () => {
  it('preserves positive, explicit zero and manual identities, original cost nulls and Shanghai date without modifying original state', async () => {
    const original = await portfolio(true), before = JSON.stringify(original)
    const entries = [held('正份'), held('零份已知', 0, 2), held('零份未知', 0, null),
      { ...held('仅关注', null, null, '000002'), position_kind: 'watch' as const }]
    const observation = buildOwnerPortfolioObservation(original, entries, { '000001': { nav: 3, type: '指数型' } }, id, now())
    expect(observation).toMatchObject({ id, observed_at: '2026-10-25T16:02:00.000Z', date: '2026-10-26', calendar: 'Asia/Shanghai', value: 6, cost: null,
      holdings: [{ kind: 'fund', key: '000001::正份', value: 6, cost: 2 }, { kind: 'fund', key: '000001::零份已知', value: 0, cost: 0 },
        { kind: 'fund', key: '000001::零份未知', value: 0, cost: null }, { kind: 'manual', key: 'asset:opaque|000001', value: 0, cost: null }] })
    expect(observation.holdings).toHaveLength(4); expect(Object.isFrozen(observation)).toBe(true)
    expect(JSON.stringify(original)).toBe(before); expect(original.history).toHaveLength(0)
  })
  it('prices a zero holding without NAV while unknown unit cost stays null', async () => {
    const observation = buildOwnerPortfolioObservation(await portfolio(), [held('零份', 0, null)], {}, id, now())
    expect(observation.value).toBe(0); expect(observation.cost).toBeNull()
    expect(observation.holdings).toEqual([{ kind: 'fund', key: '000001::零份', name: '合成零份', type: '其他', value: 0, cost: null }])
  })
  it('keeps all-known costs complete without inventing cost for a positive unknown input', async () => {
    const source = await portfolio(), quotes = { '000001': { nav: 3, type: '指数型' } }
    expect(buildOwnerPortfolioObservation(source, [held('已知')], quotes, id, now()).cost).toBe(2)
    expect(buildOwnerPortfolioObservation(source, [held('未知', 2, null)], quotes, id, now()).cost).toBeNull()
    expect(buildOwnerPortfolioObservation(source, [held('零成本', 2, 0)], quotes, id, now()).cost).toBe(0)
  })
  it.each([null, 0, Number.NaN, Number.POSITIVE_INFINITY])('rejects incomplete positive-position NAV %s, never a partial denominator', async nav => {
    const source = await portfolio()
    expect(() => buildOwnerPortfolioObservation(source, [held('未定价')], { '000001': { nav, type: '指数型' } }, id, now())).toThrow('portfolio_price_incomplete')
  })
  it('has no fallback for unknown or duplicate full-account inputs', async () => {
    const source = await portfolio()
    const quotes = { '000001': { nav: 3, type: '指数型' } }
    expect(() => buildOwnerPortfolioObservation(source, [held('未知', null)], quotes, id, now())).toThrow('portfolio_input_incomplete')
    expect(() => buildOwnerPortfolioObservation(source, [held('重复'), held('重复')], quotes, id, now())).toThrow('portfolio_input_incomplete')
  })
  it('rejects sum overflow, duplicate observation ids and invalid dates instead of trimming or repairing the image', async () => {
    const source = await portfolio(), quotes = { '000001': { nav: 1, type: '指数型' }, '000002': { nav: 1, type: '指数型' } }
    expect(() => buildOwnerPortfolioObservation(source, [held('甲', 1e308), held('乙', 1e308, 1, '000002')], quotes, id, now())).toThrow()
    expect(() => buildOwnerPortfolioObservation(source, [held('甲')], quotes, id, new Date(Number.NaN))).toThrow()
    const observation = buildOwnerPortfolioObservation(source, [held('甲')], quotes, id, now())
    expect(() => buildOwnerPortfolioObservation({ ...source, history: [observation] }, [held('甲')], quotes, id, now())).toThrow()
  })
  it('keeps the original history capacity gate with no drop-to-succeed', async () => {
    const raw = JSON.stringify(Array.from({ length: OWNER_PORTFOLIO_MAX_HISTORY }, () => ({ date: '2026-10-01', value: 1, cost: 1 })))
    const source = await portfolio(false, raw)
    expect(() => buildOwnerPortfolioObservation(source, [held('零份', 0)], {}, id, now())).toThrow()
    expect(source.history).toHaveLength(OWNER_PORTFOLIO_MAX_HISTORY)
  })
  it('exports duplicate old UTC rows and opaque identities without changing negative zero or presenting recovery authority', async () => {
    const source = await portfolio(false, '[{"date":"2026-10-01","value":-0,"cost":-0,"holdings":[{"id":"opaque|manual|000001","code":"000001","name":"旧项","account":"旧账户","type":"现金","value":-0,"cost":-0}]},{"date":"2026-10-01","value":2,"cost":1}]')
    const raw = buildOwnerPortfolioHistoryExport(source)
    expect(raw).toContain('"schema":"owner-portfolio-history-export-1"'); expect(raw).toContain('"value":-0'); expect(raw).toContain('"cost":-0')
    expect(raw).toContain('opaque|manual|000001'); expect(raw.match(/"calendar":"legacy-utc"/g)).toHaveLength(2)
    expect(raw).not.toContain('recovery'); expect(source.history).toHaveLength(2)
  })
})
