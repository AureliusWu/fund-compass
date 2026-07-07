import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as gist from '@/utils/gist'
import type { WatchEntry } from '@/utils/gist'
import { entryId, migrateEntries } from '@/utils/gist'

const LS = 'sinan_watchlist_v2' // V3-12: 升级到 v2（复合键）
const PUSH_DELAY = 4000
const TOMB_DAYS = 30

const nowISO = () => new Date().toISOString()

function loadLS(): WatchEntry[] {
  try {
    const a = JSON.parse(localStorage.getItem(LS) || '[]')
    if (!Array.isArray(a)) return []
    // 迁移 v1 → v2
    return migrateEntries(a)
  } catch {
    // 尝试迁移旧版 v1 key
    try {
      const old = JSON.parse(localStorage.getItem('sinan_watchlist_v1') || '[]')
      if (!Array.isArray(old) || !old.length) return []
      return migrateEntries(old)
    } catch { return [] }
  }
}
function saveLS(e: WatchEntry[]) {
  localStorage.setItem(LS, JSON.stringify(e))
}

export const useWatchlistStore = defineStore('watchlist', () => {
  const entries = ref<WatchEntry[]>(loadLS())
  const loaded = ref(false)
  const syncing = ref(false)
  const lastSync = ref(gist.getSyncTime())
  const hasToken = ref(gist.hasConfig())
  let pushTimer: ReturnType<typeof setTimeout> | null = null

  // V3-12：对外仍是 {code,name,type,added_at}，按 code 去重（优先有持仓的）
  const items = computed(() => {
    const seen = new Map<string, WatchEntry>()
    for (const e of entries.value) {
      if (e.deleted) continue
      const cur = seen.get(e.code)
      // 优先保留有持仓的条目
      if (!cur || (!cur.shares && e.shares && e.shares > 0)) seen.set(e.code, e)
    }
    return [...seen.values()].map((e) => ({ code: e.code, name: e.name ?? null, type: null as string | null, added_at: e.updated_at }))
  })

  const persist = () => saveLS(entries.value)

  function prune() {
    const cutoff = new Date(Date.now() - TOMB_DAYS * 864e5).toISOString()
    const before = entries.value.length
    entries.value = entries.value.filter((e) => !e.deleted || e.updated_at > cutoff)
    if (entries.value.length !== before) persist()
  }

  function merge(cloud: WatchEntry[]) {
    const map = new Map(entries.value.map((e) => [e.id || entryId(e.code, e.account), e]))
    for (const c of cloud) {
      const id = c.id || entryId(c.code, c.account)
      const local = map.get(id)
      if (!local || (c.updated_at || '') > (local.updated_at || '')) map.set(id, { ...local, ...c, id })
    }
    entries.value = [...map.values()]
    persist()
  }

  async function pull() {
    if (!gist.hasConfig()) return
    syncing.value = true
    try {
      const cloud = await gist.pullEntries()
      if (cloud) merge(cloud)
      lastSync.value = gist.getSyncTime()
    } catch { /* 静默 */ } finally {
      syncing.value = false
    }
  }

  async function push() {
    if (!gist.hasConfig()) return
    syncing.value = true
    try {
      if (await gist.pushEntries(entries.value)) lastSync.value = gist.getSyncTime()
    } catch { /* 静默 */ } finally {
      syncing.value = false
    }
  }

  function schedulePush() {
    if (!gist.hasConfig()) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(push, PUSH_DELAY)
  }

  async function load(force = false) {
    if (loaded.value && !force) return
    prune()
    await pull()
    loaded.value = true
  }

  function has(code: string, account?: string) {
    if (account) {
      const id = entryId(code, account)
      return entries.value.some((x) => x.id === id && !x.deleted)
    }
    return entries.value.some((x) => x.code === code && !x.deleted)
  }

  function removeCode(code: string, account?: string) {
    const targets = account
      ? entries.value.filter((x) => (x.id || entryId(x.code, x.account)) === entryId(code, account))
      : entries.value.filter((x) => x.code === code)
    if (!targets.length) {
      entries.value.push({ id: entryId(code, account), code, account, updated_at: nowISO(), deleted: true })
    } else {
      for (const e of targets) {
        e.deleted = true
        e.updated_at = nowISO()
        e.id = e.id || entryId(e.code, e.account)
      }
    }
    entries.value = [...entries.value]
    persist()
    schedulePush()
  }

  function upsert(code: string, name: string | undefined, deleted: boolean, account?: string) {
    if (deleted) {
      removeCode(code, account)
      return
    }
    const id = entryId(code, account)
    const e = entries.value.find((x) => (x.id || entryId(x.code, x.account)) === id)
    if (e) {
      e.deleted = deleted
      e.updated_at = nowISO()
      if (name) e.name = name
      if (!e.id) e.id = id
    } else {
      entries.value.push({ id, code, name, account, updated_at: nowISO(), deleted })
    }
    entries.value = [...entries.value]
    persist()
    schedulePush()
  }

  const add = (code: string, name?: string) => upsert(code, name, false)
  const remove = (code: string, account?: string) => upsert(code, undefined, true, account)
  const toggle = (code: string, name?: string) => (has(code) ? remove(code) : add(code, name))

  function setHolding(code: string, shares: number, cost: number, name?: string, account?: string) {
    const id = entryId(code, account)
    const e = entries.value.find((x) => (x.id || entryId(x.code, x.account)) === id)
    if (e) {
      e.shares = shares
      e.cost = cost
      e.account = account
      e.deleted = false
      e.updated_at = nowISO()
      e.id = id
      if (name) e.name = name
    } else {
      entries.value.push({ id, code, name, shares, cost, account, updated_at: nowISO() })
    }
    entries.value = [...entries.value]
    persist()
    schedulePush()
  }

  // V3-12：列出某基金在所有账户下的持仓（跨账户视图）
  function holdingsFor(code: string): WatchEntry[] {
    return entries.value.filter((e) => e.code === code && !e.deleted && e.shares && e.shares > 0)
  }

  // 已知账户名（持仓里出现过的，供选择器快捷选用）
  const accounts = computed(() => {
    const set = new Set<string>()
    for (const e of entries.value) {
      if (!e.deleted && e.account && e.account.trim()) set.add(e.account.trim())
    }
    return [...set]
  })

  // V3-12：所有有效持仓（复合键，含跨账户重复），供资产页直接消费
  const activeHoldings = computed(() =>
    entries.value.filter((e) => !e.deleted),
  )

  // 云同步配置（设置 UI 用）
  function setToken(t: string) {
    gist.setToken(t.trim())
    hasToken.value = gist.hasConfig()
  }
  const manualUpload = () => push()
  const manualDownload = () => pull()
  function clearCloud() {
    gist.clearConfig()
    hasToken.value = false
    lastSync.value = ''
  }

  return {
    items, entries, activeHoldings, accounts, loaded, syncing, lastSync, hasToken,
    load, has, add, remove, toggle, setHolding, holdingsFor,
    setToken, manualUpload, manualDownload, clearCloud, push, pull,
  }
})
