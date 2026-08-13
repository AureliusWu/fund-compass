// 基金经理索引（V3）。懒加载 frontend/public/data/managers.json，客户端按姓名/公司搜索。
// 仅在进入「基金经理」模式时加载、SW 运行时缓存。
export interface Manager {
  id: string
  name: string
  company: string
  codes: string[]
  names: string[]
  days: string // 从业天数
  ret: string // 任职回报%
  scale: string // 在管规模
}

let cache: Manager[] | null = null

interface StaticManifest {
  schema_version: 2
  updated: string
  total: number
  collection: 'managers'
  sha256: string
  chunks: string[]
  chunk_sha256: Record<string, string>
}

const SHA256_RE = /^[a-f0-9]{64}$/
const CHUNK_RE = /^part-(\d{3})-([a-f0-9]{12})\.json$/

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function validManifest(raw: unknown): raw is StaticManifest {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  if (row.schema_version !== 2 || row.collection !== 'managers'
    || !Number.isInteger(row.total) || Number(row.total) <= 0
    || !validIsoDate(row.updated)
    || typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)
    || !Array.isArray(row.chunks) || row.chunks.length === 0
    || !row.chunk_sha256 || typeof row.chunk_sha256 !== 'object' || Array.isArray(row.chunk_sha256)) return false

  const chunks = row.chunks as unknown[]
  const hashes = row.chunk_sha256 as Record<string, unknown>
  if (new Set(chunks).size !== chunks.length || Object.keys(hashes).length !== chunks.length) return false
  return chunks.every((file, index) => {
    if (typeof file !== 'string') return false
    const match = CHUNK_RE.exec(file)
    const digest = hashes[file]
    if (!match || typeof digest !== 'string') return false
    return match[1] === String(index).padStart(3, '0')
      && SHA256_RE.test(digest) && digest.startsWith(match[2])
  })
}

function validManager(value: unknown): value is Manager {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && row.id.trim().length > 0
    && typeof row.name === 'string' && row.name.trim().length > 0
    && typeof row.company === 'string' && typeof row.days === 'string'
    && typeof row.ret === 'string' && typeof row.scale === 'string'
    && Array.isArray(row.codes) && Array.isArray(row.names) && row.codes.length === row.names.length
    && row.codes.length > 0 && row.codes.every((code) => typeof code === 'string' && /^\d{6}$/.test(code))
    && row.names.every((name) => typeof name === 'string' && name.trim().length > 0)
}

function validManagers(rows: unknown, expectedTotal?: number): rows is Manager[] {
  return Array.isArray(rows) && (expectedTotal == null || rows.length === expectedTotal)
    && rows.every(validManager)
    && new Set(rows.map((row) => (row as Manager).id)).size === rows.length
}

function validLegacy(raw: unknown): raw is { managers: Manager[] } {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  return row.schema_version === 2 && row.source === 'eastmoney_fund_managers'
    && validIsoDate(row.updated)
    && typeof row.fetched_at === 'string' && /\+08:00$/.test(row.fetched_at)
    && Number.isFinite(Date.parse(row.fetched_at)) && validManagers(row.managers)
}

export async function loadManagers(): Promise<Manager[]> {
  if (cache) return cache
  const base = `${import.meta.env.BASE_URL}data/managers`
  const manifestResponse = await fetch(`${base}/manifest.json`, { cache: 'no-cache' })
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json() as unknown
    if (!validManifest(manifest)) throw new Error('基金经理数据清单格式无效')
    const chunks = await Promise.all(manifest.chunks.map(async (file) => {
      const response = await fetch(`${base}/${file}`, { cache: 'force-cache' })
      if (!response.ok) throw new Error('基金经理数据分片加载失败')
      const text = await response.text()
      if (await sha256Text(text) !== manifest.chunk_sha256[file]) throw new Error('基金经理数据分片校验失败')
      const prefix = '{"managers":'
      if (!text.startsWith(prefix) || !text.endsWith('}')) throw new Error('基金经理数据分片格式无效')
      const arrayText = text.slice(prefix.length, -1)
      if (!arrayText.startsWith('[') || !arrayText.endsWith(']')) throw new Error('基金经理数据分片格式无效')
      let payload: unknown
      try { payload = JSON.parse(text) } catch { throw new Error('基金经理数据分片格式无效') }
      const rows = (payload as { managers?: unknown })?.managers
      if (!Array.isArray(rows) || !rows.every(validManager)) throw new Error('基金经理数据分片格式无效')
      return { rows, arrayText }
    }))
    const managers = chunks.flatMap((chunk) => chunk.rows)
    if (!validManagers(managers, manifest.total)) throw new Error('基金经理数据分片不完整')
    const datasetText = `[${chunks.map((chunk) => chunk.arrayText.slice(1, -1)).filter(Boolean).join(',')}]`
    if (await sha256Text(datasetText) !== manifest.sha256) {
      throw new Error('基金经理数据集合校验失败')
    }
    cache = managers
    return cache
  }
  const legacy = await fetch(`${import.meta.env.BASE_URL}data/managers.json`, { cache: 'no-cache' })
  if (!legacy.ok) throw new Error('暂无基金经理数据')
  const d = await legacy.json() as unknown
  if (!validLegacy(d)) throw new Error('基金经理数据格式无效')
  cache = d.managers
  return cache
}
