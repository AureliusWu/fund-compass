import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openOwnerAuthority, OWNER_AUTHORITY_DB, OWNER_AUTHORITY_SEEN_HINT } from './owner-authority'

function storage() {
  const values = new Map<string, string>()
  return { values, hint: { getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) } as unknown as Storage }
}
const target = '1'.repeat(64), sha = '2'.repeat(64)
async function inject(factory: IDBFactory, mutate: (tx: IDBTransaction) => void) {
  await new Promise<void>((resolve, reject) => {
    const req = factory.open(OWNER_AUTHORITY_DB)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('authority', 'readwrite')
      mutate(tx); tx.oncomplete = () => { db.close(); resolve() }; tx.onabort = () => reject(tx.error)
    }
  })
}
describe('fixed application authority locator', () => {
  it('creates metadata only and never reads any business slot or target from LS', async () => {
    const factory = new IDBFactory(), { hint, values } = storage()
    values.set('sinan_watchlist_v2', '[private synthetic marker]')
    const authority = await openOwnerAuthority(factory, hint)
    expect(await authority.read()).toEqual({ schema: 'owner-authority-1', phase: 'legacy', epoch: 0,
      targetFingerprint: null, activationId: null, backupSha256: null })
    expect(hint.getItem).toHaveBeenCalledTimes(1)
    expect(hint.getItem).toHaveBeenCalledWith(OWNER_AUTHORITY_SEEN_HINT)
    expect(values.get('sinan_watchlist_v2')).toBe('[private synthetic marker]')
    expect((await factory.databases()).map(item => item.name)).toEqual([OWNER_AUTHORITY_DB])
    authority.close()
  })
  it('persists activating, requires exact CAS, and only explicitly completes that original selection', async () => {
    const factory = new IDBFactory(), { hint } = storage()
    let first = await openOwnerAuthority(factory, hint)
    const legacy = await first.read()
    const activating = await first.beginActivation(legacy, target, 'local-adopt-0001', sha)
    await expect(first.beginActivation(legacy, '3'.repeat(64), 'local-adopt-0002', sha)).rejects.toMatchObject({ code: 'authority_conflict' })
    first.close(); first = await openOwnerAuthority(factory, hint)
    expect(await first.read()).toEqual(activating)
    await expect(first.completeActivation({ ...activating, backupSha256: '4'.repeat(64) })).rejects.toMatchObject({ code: 'authority_conflict' })
    const active = await first.completeActivation(activating)
    expect(active).toMatchObject({ phase: 'active', epoch: 2, targetFingerprint: target })
    await expect(first.beginActivation(active, '3'.repeat(64), 'local-adopt-0003', sha)).rejects.toMatchObject({ code: 'authority_conflict' })
    first.close()
    const reopened = await openOwnerAuthority(factory, null)
    expect(await reopened.read()).toEqual(active) // no LS/config is needed to select the existing target
    reopened.close()
  })
  it('serializes concurrent activation attempts without replacing the winning target', async () => {
    const factory = new IDBFactory(), { hint } = storage()
    const a = await openOwnerAuthority(factory, hint), b = await openOwnerAuthority(factory, hint)
    const expected = await a.read()
    const results = await Promise.allSettled([a.beginActivation(expected, target, 'local-adopt-0001', sha),
      b.beginActivation(expected, '3'.repeat(64), 'local-adopt-0002', sha)])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
    expect((await a.read()).phase).toBe('activating')
    a.close(); b.close()
  })
  it('refuses to recreate a missing locator after a seen marker', async () => {
    const factory = new IDBFactory(), { hint, values } = storage()
    values.set(OWNER_AUTHORITY_SEEN_HINT, '1')
    await expect(openOwnerAuthority(factory, hint)).rejects.toMatchObject({ code: 'authority_missing' })
    expect(await factory.databases()).toEqual([])
  })
  it('does not trust a target or phase encoded in the non-authority hint', async () => {
    const factory = new IDBFactory(), { hint, values } = storage()
    const authority = await openOwnerAuthority(factory, hint)
    values.set(OWNER_AUTHORITY_SEEN_HINT, JSON.stringify({ target, phase: 'active' }))
    authority.close()
    const reopened = await openOwnerAuthority(factory, hint)
    expect((await reopened.read()).phase).toBe('legacy')
    reopened.close()
  })
  it.each(['missing-row', 'extra-row', 'bad-row', 'unknown-field'] as const)('refuses existing %s without repairing it', async cause => {
    const factory = new IDBFactory(), { hint } = storage()
    const authority = await openOwnerAuthority(factory, hint), legacy = await authority.read()
    authority.close()
    await inject(factory, tx => {
      const store = tx.objectStore('authority')
      if (cause === 'missing-row') store.delete('current')
      if (cause === 'extra-row') store.put(legacy, 'extra')
      if (cause === 'bad-row') store.put({ ...legacy, phase: 'active' }, 'current')
      if (cause === 'unknown-field') store.put({ ...legacy, bypass: true }, 'current')
    })
    await expect(openOwnerAuthority(factory, hint)).rejects.toMatchObject({ code: 'authority_invalid' })
  })
  it('fails unavailable metadata closed, rather than using LS', async () => {
    const { hint } = storage()
    await expect(openOwnerAuthority(undefined as unknown as IDBFactory, hint)).rejects.toMatchObject({ code: 'authority_unavailable' })
    await expect(openOwnerAuthority(new IDBFactory(), null)).rejects.toMatchObject({ code: 'authority_unavailable' })
  })
  it('invalidates a closed handle', async () => {
    const { hint } = storage(), authority = await openOwnerAuthority(new IDBFactory(), hint)
    authority.close()
    await expect(authority.read()).rejects.toMatchObject({ code: 'authority_closed' })
  })
  it('never selects a new authority if its deletion-detection hint cannot persist', async () => {
    const factory = new IDBFactory(), { hint } = storage()
    const first = await openOwnerAuthority(factory, hint)
    first.close()
    const denied = { getItem: () => null, setItem() { throw new DOMException('denied', 'SecurityError') } } as unknown as Storage
    const reopened = await openOwnerAuthority(factory, denied)
    const expected = await reopened.read()
    await expect(reopened.beginActivation(expected, target, 'local-adopt-0001', sha)).rejects.toMatchObject({ code: 'authority_unavailable' })
    expect((await reopened.read()).phase).toBe('legacy')
    reopened.close()
  })
})
