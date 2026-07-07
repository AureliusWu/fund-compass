import type { AssetClass } from './assetclass'
import { pullJsonFile, pushJsonFile } from './gist'

const KEY = 'sinan_manual_assets_v1'
const CLOUD_FILE = 'sinan-manual-assets.json'

export interface ManualAsset {
  id: string
  name: string
  cls: AssetClass
  value: number
  note?: string
  updated_at: string
}

export const MANUAL_ASSET_CLASSES: AssetClass[] = ['现金', '权益', '商品']

export function loadManualAssets(): ManualAsset[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (!Array.isArray(arr)) return []
    return arr.filter((a) => a?.id && a.name && typeof a.value === 'number' && a.value >= 0)
  } catch { return [] }
}

function saveManualAssets(items: ManualAsset[]): ManualAsset[] {
  const cleaned = items.filter((a) => a.value >= 0).sort((a, b) => b.value - a.value)
  try { localStorage.setItem(KEY, JSON.stringify(cleaned)) } catch { /* ignore */ }
  return cleaned
}

export function upsertManualAsset(
  items: ManualAsset[],
  input: { id?: string; name: string; cls: AssetClass; value: number; note?: string },
  now = new Date(),
): ManualAsset[] {
  const id = input.id || `manual-${now.getTime()}`
  const next: ManualAsset = {
    id,
    name: input.name.trim() || input.cls,
    cls: input.cls,
    value: Math.max(0, input.value || 0),
    note: input.note?.trim() || undefined,
    updated_at: now.toISOString(),
  }
  const idx = items.findIndex((a) => a.id === id)
  const out = idx >= 0 ? [...items.slice(0, idx), next, ...items.slice(idx + 1)] : [...items, next]
  return saveManualAssets(out)
}

export function removeManualAsset(items: ManualAsset[], id: string): ManualAsset[] {
  return saveManualAssets(items.filter((a) => a.id !== id))
}

export async function pullManualAssets(): Promise<ManualAsset[] | null> {
  const arr = await pullJsonFile<ManualAsset[]>(CLOUD_FILE)
  if (!Array.isArray(arr)) return null
  const cleaned = arr.filter((a) => a?.id && a.name && typeof a.value === 'number' && a.value >= 0)
  saveManualAssets(cleaned)
  return cleaned
}

export async function pushManualAssets(items: ManualAsset[]): Promise<boolean> {
  return pushJsonFile(CLOUD_FILE, items, '司南基金 手工资产')
}
