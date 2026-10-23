/** Manual, exact-preimage completion of the existing physical v4 store only. */
import { isOwnerSyncOutboxDatabase, OWNER_SYNC_OUTBOX_DB_PREFIX, ownerSyncOutboxStorage } from './ownerSyncOutbox'
import { emptyOwnerWorkspaceSyncMetadata, validateOwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import { assertGuard, canonical, code, CURRENT, fail, METADATA, OwnerWorkspaceError, RECEIPTS, STORES, SYNC, WORKING } from './owner-workspace-shared'
import type { CloudUpgradeHost, OwnerWorkspace, OwnerWorkspaceErrorCode, OwnerWorkspaceGuard, OwnerWorkspaceLocalState } from './owner-workspace-types'

export function reconcileUpgrade(host: CloudUpgradeHost, factory: IDBFactory, expected: OwnerWorkspaceLocalState,
  guard: OwnerWorkspaceGuard, signal: AbortSignal, abortCode: () => OwnerWorkspaceErrorCode): Promise<OwnerWorkspace> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, handle: OwnerWorkspace | undefined, settled = false
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      if (!problem) { try { assertGuard(guard) } catch (error) { problem = code(error) } }
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) {
        try { tx?.abort() } catch { /* Already committed/aborted is not proof of rollback. */ }
        handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem))
      } else resolve(handle!)
    }
    const abort = () => finish(abortCode())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      assertGuard(guard)
      const request = factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + host.target)
      request.onupgradeneeded = () => { request.transaction?.abort(); finish('workspace_invalid_database') }
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish('workspace_invalid_database')
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        db.onversionchange = () => finish('workspace_closed')
        db.onclose = () => finish('workspace_closed')
        try {
          assertGuard(guard)
          if (db.version !== 4 || !isOwnerSyncOutboxDatabase(db)) fail('workspace_invalid_database')
          tx = db.transaction([...STORES, SYNC], 'readwrite', { durability: 'strict' })
          if (tx.durability !== 'strict') fail('workspace_unavailable')
          for (const name of [...STORES, SYNC]) {
            const store = tx.objectStore(name)
            if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
          }
          const slot = tx.objectStore('slot'), working = tx.objectStore(WORKING), metadata = tx.objectStore(METADATA), sync = tx.objectStore(SYNC)
          const reads = [slot.get(CURRENT), slot.count(), working.get(CURRENT), working.count(), metadata.get(CURRENT), metadata.count(),
            tx.objectStore(RECEIPTS).count(), sync.get(CURRENT), sync.count()]
          let remaining = reads.length
          for (const read of reads) read.onsuccess = () => {
            if (--remaining || settled) return
            try {
              assertGuard(guard)
              if (reads[1].result !== 1 || reads[3].result !== 1 || reads[5].result !== 1 || reads[6].result !== 0) fail('workspace_invalid_database')
              const snapshot = host.working(reads[2].result, host.target).snapshot
              const row = ownerSyncOutboxStorage.rowShape(reads[0].result, host.target)
              const local = host.localState({ snapshot, metadata: host.checkedMetadata(reads[4].result, snapshot),
                outbox: { version: row.version, entry: row.entry }, receiptCount: reads[6].result }, host.target)
              if (canonical(local) !== canonical(expected)) fail('workspace_conflict')
              const empty = emptyOwnerWorkspaceSyncMetadata(host.target)
              if (reads[8].result === 0 && reads[7].result === undefined) {
                assertGuard(guard); sync.add(empty, CURRENT)
              } else if (reads[8].result === 1 && reads[7].result !== undefined) {
                const checked = validateOwnerWorkspaceSyncMetadata(reads[7].result, host.target,
                  { snapshot: local.snapshot, metadata: local.metadata, outbox: local.outbox })
                if (canonical(checked) !== canonical(empty)) fail('workspace_conflict')
              } else fail('workspace_invalid_database')
            } catch (error) { finish(code(error)) }
          }
          tx.onerror = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.onabort = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.oncomplete = () => {
            if (settled) { db?.close(); return }
            try {
              assertGuard(guard)
              handle = host.makeWorkspace(db!, host.target)
              handle.readSyncState(guard).then(() => finish(), error => finish(code(error)))
            } catch (error) { finish(code(error)) }
          }
        } catch (error) { finish(code(error)) }
      }
    } catch (error) { finish(code(error)) }
  })
}
