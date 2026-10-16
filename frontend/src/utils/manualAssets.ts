import type { AssetClass } from './assetclass'
import { confirmPulledFile, pullJsonFile, pushJsonFile } from './gist'
import { getLegacySyncConsent, getLegacySyncGeneration } from './cloud-consent'

const KEY = 'sinan_manual_assets_v1'
const CLOUD_FILE = 'sinan-manual-assets.json'
let pullGeneration = 0
let localMutationGeneration = 0

export interface ManualAsset {
  id: string
  name: string
  cls: AssetClass
  value: number
  note?: string
  updated_at: string
}

export const MANUAL_ASSET_CLASSES: AssetClass[] = ['现金', '权益', '商品']
export type ManualAssetStorageStatus = 'idle' | 'saved' | 'invalid' | 'storage-error'
let storageStatus: ManualAssetStorageStatus = 'idle'
export const getManualAssetStorageStatus = () => storageStatus
const FIELDS = new Set(['id', 'name', 'cls', 'value', 'note', 'updated_at'])
function validTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
}
function validAsset(value: unknown): value is ManualAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).every(key => FIELDS.has(key))
    && typeof row.id === 'string' && row.id.trim().length > 0 && row.id.length <= 200
    && typeof row.name === 'string' && row.name.trim().length > 0 && row.name.length <= 200
    && typeof row.cls === 'string' && MANUAL_ASSET_CLASSES.includes(row.cls as AssetClass)
    && typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 0
    && (row.note === undefined || typeof row.note === 'string' && row.note.length <= 2000)
    && validTimestamp(row.updated_at)
}
function validAssets(value: unknown): value is ManualAsset[] {
  if (!Array.isArray(value) || !value.every(validAsset) || new Set(value.map(row => row.id)).size !== value.length) return false
  let total = 0
  for (const item of value) { total += item.value; if (!Number.isFinite(total)) return false }
  return true
}
function signature(item: ManualAsset): string {
  return JSON.stringify([item.id, item.name, item.cls, item.value, item.note ?? null, new Date(item.updated_at).toISOString()])
}
function sameItems(first: ManualAsset[], second: ManualAsset[]): boolean {
  if (first.length !== second.length) return false
  const secondById = new Map(second.map(item => [item.id, signature(item)]))
  return first.every(item => signature(item) === secondById.get(item.id))
}
function readSaved(): { raw: string | null; items: ManualAsset[] } | null {
  try {
    const raw = localStorage.getItem(KEY)
    let items: unknown
    try { items = raw == null ? [] : JSON.parse(raw) } catch { storageStatus = 'invalid'; return null }
    if (!validAssets(items)) { storageStatus = 'invalid'; return null }
    storageStatus = 'idle'
    return { raw, items }
  } catch { storageStatus = 'storage-error'; return null }
}

export function loadManualAssets(): ManualAsset[] {
  return readSaved()?.items ?? [] // Never overwrite or silently repair malformed historical storage.
}

function readLocalBaseline(items: ManualAsset[]): { raw: string | null; items: ManualAsset[] } | null {
  if (!validAssets(items)) { storageStatus = 'invalid'; return null }
  const current = readSaved()
  if (!current) return null
  if (!sameItems(current.items, items)) {
    // A caller with an older tab's work copy may not replace a newer record set.
    // Native get/set is not an atomic cross-tab transaction; recheck raw at save.
    storageStatus = 'storage-error'
    return null
  }
  return current
}

function saveManualAssets(items: ManualAsset[], expectedRaw?: { raw: string | null }): ManualAsset[] | null {
  if (!validAssets(items)) { storageStatus = 'invalid'; return null }
  const previous = readSaved()
  if (!previous) return null
  if (expectedRaw && previous.raw !== expectedRaw.raw) return null
  const cleaned = [...items].sort((a, b) => b.value - a.value)
  try {
    const serialized = JSON.stringify(cleaned)
    localStorage.setItem(KEY, serialized)
    if (localStorage.getItem(KEY) !== serialized) throw new Error('storage-verification')
    storageStatus = 'saved'
    localMutationGeneration++
    return cleaned
  } catch {
    storageStatus = 'storage-error'
    // Native setItem failures leave the previous value intact. A failed readback
    // may instead mean another tab wrote newer data; never roll that data back.
    return null
  }
}

export function upsertManualAsset(
  items: ManualAsset[],
  input: { id?: string; name: string; cls: AssetClass; value: number; note?: string },
  now = new Date(),
): ManualAsset[] {
  if (!input || typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0
    || !MANUAL_ASSET_CLASSES.includes(input.cls) || typeof input.name !== 'string'
    || (input.id != null && (typeof input.id !== 'string' || !input.id.trim()))
    || (input.note != null && typeof input.note !== 'string') || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    storageStatus = 'invalid'; return items
  }
  const baseline = readLocalBaseline(items)
  if (!baseline) return items
  const id = input.id || `manual-${now.getTime()}`
  const next: ManualAsset = {
    id,
    name: input.name.trim() || input.cls,
    cls: input.cls,
    value: input.value,
    note: input.note?.trim() || undefined,
    updated_at: now.toISOString(),
  }
  const idx = items.findIndex((a) => a.id === id)
  const out = idx >= 0 ? [...items.slice(0, idx), next, ...items.slice(idx + 1)] : [...items, next]
  return saveManualAssets(out, { raw: baseline.raw }) ?? items
}

export function removeManualAsset(items: ManualAsset[], id: string): ManualAsset[] {
  const baseline = readLocalBaseline(items)
  if (!baseline) return items
  return saveManualAssets(items.filter((a) => a.id !== id), { raw: baseline.raw }) ?? items
}

export async function pullManualAssets(): Promise<ManualAsset[] | null> {
  if (!getLegacySyncConsent()) return null
  const baseline = readSaved()
  if (!baseline) return null
  const mutationGeneration = localMutationGeneration
  const consentGeneration = getLegacySyncGeneration()
  const requestGeneration = ++pullGeneration
  const arr = await pullJsonFile<ManualAsset[]>(CLOUD_FILE)
  const active = () => getLegacySyncConsent() && getLegacySyncGeneration() === consentGeneration
    && pullGeneration === requestGeneration
  if (!active()) return null
  if (!Array.isArray(arr)) return null
  if (!validAssets(arr)) return null
  const current = readSaved()
  if (!current || current.raw !== baseline.raw || mutationGeneration !== localMutationGeneration) return null
  if (!arr.length && baseline.items.length) return null // Empty/old cloud data is not a deletion acknowledgement.
  const merged = new Map(baseline.items.map(item => [item.id, item]))
  for (const item of arr) {
    const local = merged.get(item.id)
    if (local && Date.parse(item.updated_at) === Date.parse(local.updated_at)
      && signature(item) !== signature(local)) return null
    if (!local || Date.parse(item.updated_at) > Date.parse(local.updated_at)) merged.set(item.id, item)
  }
  if (!active() || mutationGeneration !== localMutationGeneration) return null
  const cleaned = saveManualAssets([...merged.values()], { raw: baseline.raw })
  if (!cleaned) return null
  if (!active()) return null
  confirmPulledFile(CLOUD_FILE)
  return cleaned
}

export async function pushManualAssets(items: ManualAsset[]): Promise<boolean> {
  if (!getLegacySyncConsent() || !validAssets(items)) return false
  const baseline = readSaved()
  if (!baseline || !sameItems(baseline.items, items)) return false
  const mutation = localMutationGeneration, consent = getLegacySyncGeneration(), request = ++pullGeneration
  const success = await pushJsonFile(CLOUD_FILE, items, '司南基金 手工资产')
  const current = readSaved()
  return success && getLegacySyncConsent() && getLegacySyncGeneration() === consent && request === pullGeneration
    && mutation === localMutationGeneration && current?.raw === baseline.raw
}
