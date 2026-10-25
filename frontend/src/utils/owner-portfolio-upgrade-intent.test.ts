import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { validateOwnerPortfolioUpgradeIntent, verifyOwnerPortfolioUpgradeIntent } from './owner-portfolio-upgrade-intent'

const TARGET = '6'.repeat(64), SOURCE = '5'.repeat(64), BACKUP = '4'.repeat(64)
const digest = (value: unknown) => createHash('sha256').update(canonicalOwnerLocal(value)).digest('hex')
function intent() {
  const id = 'portfolio-intent-0001'
  return { schema: 'owner-portfolio-upgrade-intent-1' as const, targetFingerprint: TARGET, id,
    hash: digest({ operation: 'portfolio-upgrade-1', target: TARGET, id, backupSha256: BACKUP }), backupSha256: BACKUP, sourceSha256: SOURCE }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('fixed persisted portfolio upgrade intent', () => {
  it('validates and freezes the closed target/source-bound shape, with no ambient IO', async () => {
    const forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    const result = validateOwnerPortfolioUpgradeIntent(intent(), TARGET, SOURCE)
    expect(result).toEqual(intent()); expect(Object.isFrozen(result)).toBe(true)
    expect(await verifyOwnerPortfolioUpgradeIntent(result, TARGET, SOURCE)).toEqual(result)
    expect(forbidden).not.toHaveBeenCalled()
  })
  it.each(['schema', 'targetFingerprint', 'sourceSha256', 'id', 'hash', 'backupSha256', 'extra'] as const)
    ('rejects invalid fixed field %s', field => {
      const row: Record<string, unknown> = { ...intent() }
      row[field] = field === 'targetFingerprint' || field === 'sourceSha256' ? '1'.repeat(64) : 'invalid'
      expect(() => validateOwnerPortfolioUpgradeIntent(row, TARGET, SOURCE)).toThrow()
    })
  it('rejects hidden/accessor/symbol fields without invoking a getter', () => {
    const getter = vi.fn()
    const accessor = Object.defineProperty({ ...intent() }, 'id', { enumerable: true, get: getter })
    expect(() => validateOwnerPortfolioUpgradeIntent(accessor, TARGET, SOURCE)).toThrow(); expect(getter).not.toHaveBeenCalled()
    expect(() => validateOwnerPortfolioUpgradeIntent(Object.defineProperty({ ...intent() }, 'hidden', { value: 1 }), TARGET, SOURCE)).toThrow()
    expect(() => validateOwnerPortfolioUpgradeIntent({ ...intent(), [Symbol('extra')]: 1 }, TARGET, SOURCE)).toThrow()
  })
  it.each(['id', 'backupSha256', 'hash'] as const)('shape checks do not falsely claim request SHA verification: %s', field => {
    const row = { ...intent(), [field]: field === 'id' ? 'portfolio-other-0001' : '1'.repeat(64) }
    expect(validateOwnerPortfolioUpgradeIntent(row, TARGET, SOURCE)).toEqual(row)
    return expect(verifyOwnerPortfolioUpgradeIntent(row, TARGET, SOURCE)).rejects.toMatchObject({ code: 'hash_mismatch' })
  })
  it('reports unavailable crypto without fabricating a verified receipt', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(() => Promise.reject(new Error('synthetic crypto failure'))) } })
    await expect(verifyOwnerPortfolioUpgradeIntent(intent(), TARGET, SOURCE)).rejects.toMatchObject({ code: 'hash_unavailable' })
  })
})
