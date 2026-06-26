import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as gist from '@/utils/gist'
import type { WatchEntry } from '@/utils/gist'

const LS = 'sinan_watchlist_v1'
const PUSH_DELAY = 4000
const TOMB_DAYS = 30

const nowISO = () => new Date().toISOString()

function loadLS(): WatchEntry[] {
  try {
    const a = JSON.parse(localStorage.getItem(LS) || '[]')
    return Array.isArray(a) ? a : []
  } catch {
    return []
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

  // 对外仍是 {code,name,type,added_at} 形状，页面无需改
  const items = computed(() =>
    entries.value
      .filter((e) => !e.deleted)
      .map((e) => ({ code: e.code, name: e.name ?? null, type: null as string | null, added_at: e.updated_at })),
  )

  const persist = () => saveLS(entries.value)

  function prune() {
    const cutoff = new Date(Date.now() - TOMB_DAYS * 864e5).toISOString()
    const before = entries.value.length
    entries.value = entries.value.filter((e) => !e.deleted || e.updated_at > cutoff)
    if (entries.value.length !== before) persist()
  }

  function merge(cloud: WatchEntry[]) {
    const map = new Map(entries.value.map((e) => [e.code, e]))
    for (const c of cloud) {
      const local = map.get(c.code)
      if (!local || (c.updated_at || '') > (local.updated_at || '')) map.set(c.code, { ...local, ...c })
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

  function has(code: string) {
    const e = entries.value.find((x) => x.code === code)
    return !!e && !e.deleted
  }

  function upsert(code: string, name: string | undefined, deleted: boolean) {
    const e = entries.value.find((x) => x.code === code)
    if (e) {
      e.deleted = deleted
      e.updated_at = nowISO()
      if (name) e.name = name
    } else {
      entries.value.push({ code, name, updated_at: nowISO(), deleted })
    }
    entries.value = [...entries.value]
    persist()
    schedulePush()
  }

  const add = (code: string, name?: string) => upsert(code, name, false)
  const remove = (code: string) => upsert(code, undefined, true)
  const toggle = (code: string, name?: string) => (has(code) ? remove(code) : add(code, name))

  function setHolding(code: string, shares: number, cost: number, name?: string, account?: string) {
    const e = entries.value.find((x) => x.code === code)
    if (e) {
      e.shares = shares
      e.cost = cost
      e.account = account
      e.deleted = false
      e.updated_at = nowISO()
      if (name) e.name = name
    } else {
      entries.value.push({ code, name, shares, cost, account, updated_at: nowISO() })
    }
    entries.value = [...entries.value]
    persist()
    schedulePush()
  }

  // 已知账户名（持仓里出现过的，供选择器快捷选用）
  const accounts = computed(() => {
    const set = new Set<string>()
    for (const e of entries.value) {
      if (!e.deleted && e.account && e.account.trim()) set.add(e.account.trim())
    }
    return [...set]
  })

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
    items, entries, accounts, loaded, syncing, lastSync, hasToken,
    load, has, add, remove, toggle, setHolding,
    setToken, manualUpload, manualDownload, clearCloud, push, pull,
  }
})
