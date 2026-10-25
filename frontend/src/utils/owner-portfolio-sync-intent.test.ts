import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import {
  validateOwnerPortfolioSyncUpgradeIntent, verifyOwnerPortfolioSyncUpgradeIntent,
} from './owner-portfolio-sync-intent'

const TARGET = '6'.repeat(64), BACKUP = '4'.repeat(64)
const digest = (value: unknown) => createHash('sha256').update(canonicalOwnerLocal(value)).digest('hex')
function intent() {
  const id = 'portfolio-sync-intent-0001'
  return { schema: 'owner-portfolio-sync-upgrade-1' as const, targetFingerprint: TARGET, id,
    hash: digest({ operation: 'portfolio-sync-upgrade-1', target: TARGET, id, backupSha256: BACKUP }), backupSha256: BACKUP }
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('fixed complete portfolio sync upgrade intent', () => {
  it('copies the exact five fields, accepts null prototype and performs no ambient IO', async () => {
    const forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden })
    vi.stubGlobal('localStorage', { getItem: forbidden }); vi.spyOn(Date, 'now').mockImplementation(forbidden)
    const source = Object.assign(Object.create(null), intent())
    const result = validateOwnerPortfolioSyncUpgradeIntent(source, TARGET)
    expect(result).toEqual(intent()); expect(Object.isFrozen(result)).toBe(true); expect(result).not.toBe(source)
    expect(Object.keys(result).sort()).toEqual(['backupSha256', 'hash', 'id', 'schema', 'targetFingerprint'])
    expect(await verifyOwnerPortfolioSyncUpgradeIntent(result, TARGET)).toEqual(result)
    source.id = 'later-mutation-0001'; expect(result.id).toBe(intent().id)
    expect(forbidden).not.toHaveBeenCalled()
  })
  it('always recomputes SHA even for a previously verified frozen result', async () => {
    const compute = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle))
    vi.stubGlobal('crypto', { subtle: { digest: compute } })
    const checked = await verifyOwnerPortfolioSyncUpgradeIntent(intent(), TARGET)
    expect(await verifyOwnerPortfolioSyncUpgradeIntent(checked, TARGET)).toEqual(checked)
    expect(compute).toHaveBeenCalledTimes(2)
    compute.mockRejectedValueOnce(new Error('synthetic unavailable'))
    await expect(verifyOwnerPortfolioSyncUpgradeIntent(checked, TARGET)).rejects.toMatchObject({ code: 'hash_unavailable' })
    expect(compute).toHaveBeenCalledTimes(3)
  })
  it('does no crypto during synchronous shape validation', () => {
    const forbidden = vi.fn(() => { throw new Error('no crypto in transaction') })
    vi.stubGlobal('crypto', { subtle: { digest: forbidden } })
    expect(validateOwnerPortfolioSyncUpgradeIntent(intent(), TARGET)).toEqual(intent())
    expect(forbidden).not.toHaveBeenCalled()
  })
  it.each(['schema', 'targetFingerprint', 'id', 'hash', 'backupSha256', 'extra', 'sourceSha256'] as const)
    ('rejects invalid fixed field %s', field => {
      const row: Record<string, unknown> = { ...intent() }
      row[field] = field === 'targetFingerprint' ? '1'.repeat(64) : 'invalid'
      expect(() => validateOwnerPortfolioSyncUpgradeIntent(row, TARGET)).toThrow(expect.objectContaining({ code: 'invalid_intent' }))
      delete row[field]
      if (field !== 'extra' && field !== 'sourceSha256') expect(() => validateOwnerPortfolioSyncUpgradeIntent(row, TARGET)).toThrow()
    })
  it.each(['targetFingerprint', 'hash', 'backupSha256'] as const)('requires strict native lowercase hash %s', field => {
    for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64) + '\n', new String('a'.repeat(64)), null]) {
      expect(() => validateOwnerPortfolioSyncUpgradeIntent({ ...intent(), [field]: value }, TARGET)).toThrow()
    }
    expect(() => validateOwnerPortfolioSyncUpgradeIntent(intent(), '6'.repeat(64) + '\n')).toThrow()
  })
  it.each(['short-1', '_invalid-0001', 'with space-0001', 'a'.repeat(129), 'valid-id-0001\n', new String('valid-id-0001')])
    ('requires original native id grammar %#', id => {
      expect(() => validateOwnerPortfolioSyncUpgradeIntent({ ...intent(), id }, TARGET)).toThrow()
    })
  it('rejects accessor, hidden, symbol and inherited fields without invoking a getter', () => {
    const getter = vi.fn(() => { throw new Error('getter must stay uncalled') })
    for (const attack of [
      Object.defineProperty({ ...intent() }, 'id', { enumerable: true, get: getter }),
      Object.defineProperty({ ...intent() }, 'hidden', { value: 1 }),
      { ...intent(), [Symbol('extra')]: 1 }, Object.setPrototypeOf({ ...intent() }, { inherited: 1 }),
      Object.defineProperty({ ...intent() }, 'id', { value: intent().id, enumerable: false }),
    ]) expect(() => validateOwnerPortfolioSyncUpgradeIntent(attack, TARGET)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it.each(['id', 'backupSha256', 'hash', 'targetFingerprint'] as const)
    ('shape checks do not certify the fixed SHA binding: %s', field => {
      const row = { ...intent(), [field]: field === 'id' ? 'portfolio-sync-other-0001' : '1'.repeat(64) }
      const target = field === 'targetFingerprint' ? row.targetFingerprint : TARGET
      expect(validateOwnerPortfolioSyncUpgradeIntent(row, target)).toEqual(row)
      return expect(verifyOwnerPortfolioSyncUpgradeIntent(row, target)).rejects.toMatchObject({ code: 'hash_mismatch' })
    })
  it('refuses the old v5 hash domain even when all new shape fields are valid', async () => {
    const row = intent()
    row.hash = digest({ operation: 'portfolio-upgrade-1', target: TARGET, id: row.id, backupSha256: BACKUP })
    await expect(verifyOwnerPortfolioSyncUpgradeIntent(row, TARGET)).rejects.toMatchObject({ code: 'hash_mismatch' })
  })
})
