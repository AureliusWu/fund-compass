// V4-5 持仓提醒引擎。规则驱动的前端监控 + Notification API 推送。
// 检查项：信号变级、净值异动、回撤阈值、定期再平衡提醒。
// 数据存 localStorage，前端定时检查（每次开首页 / 轮询）。

import { fetchEstimate, type Estimate } from './estimate'
import { getSignal, type SignalResp } from '@/api/client'

// ── 提醒定义 ──────────────────────────────────────────
export type AlertKind = 'signal_change' | 'nav_spike' | 'drawdown' | 'rebalance'
export interface Alert {
  id: string
  kind: AlertKind
  title: string
  body: string
  code?: string
  name?: string
  level: 'info' | 'warn' | 'danger'
  time: string       // ISO
  read: boolean
  dismissed: boolean
}

const LS = 'sinan_alerts_v1'
const MAX_ALERTS = 100
const REBALANCE_DAYS = 90  // 每 90 天提醒一次再平衡

// ── 存储 ──────────────────────────────────────────────
export function loadAlerts(): Alert[] {
  try {
    const raw = localStorage.getItem(LS)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function saveAlerts(alerts: Alert[]): void {
  const trimmed = alerts.slice(-MAX_ALERTS)
  try { localStorage.setItem(LS, JSON.stringify(trimmed)) } catch { /* quota */ }
}

function pushAlert(a: Omit<Alert, 'id' | 'time' | 'read' | 'dismissed'>): Alert {
  const alerts = loadAlerts()
  const id = `${a.kind}_${a.code || ''}_${Date.now()}`
  const full: Alert = { ...a, id, time: new Date().toISOString(), read: false, dismissed: false }

  // 去重：同 kind+code 的未读提醒超过 1 条则跳过
  const unread = alerts.filter((x) => x.kind === a.kind && x.code === a.code && !x.read && !x.dismissed)
  if (unread.length >= 2) return full

  alerts.push(full)
  saveAlerts(alerts)
  return full
}

// ── 通知 ──────────────────────────────────────────────
function notify(a: Alert): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(a.title, { body: a.body, tag: a.kind + a.code, icon: '/favicon.ico' })
  } catch { /* ignore */ }
}

// ── 检查规则 ──────────────────────────────────────────

/** 信号变级检查 */
export async function checkSignalChange(
  code: string, name: string, prevSignal: string | null, currentSignal?: SignalResp,
): Promise<Alert | null> {
  try {
    const sig: SignalResp = currentSignal ?? await getSignal(code)
    if (!prevSignal || sig.signal === prevSignal) return null

    const level: Alert['level'] =
      (prevSignal === '买入' && sig.signal === '减仓') || (prevSignal === '定投' && sig.signal === '减仓') ? 'danger' :
      sig.signal === '买入' ? 'info' : 'warn'

    const a = pushAlert({
      kind: 'signal_change', code, name, level,
      title: `信号变动 · ${name || code}`,
      body: `${prevSignal} → ${sig.signal}（${sig.advice || '建议关注'}）`,
    })
    notify(a)
    return a
  } catch { return null }
}

/** 净值异动检查（单日涨跌 > 阈值） */
export async function checkNavSpike(
  code: string, name: string, threshold = 3, estimate?: Estimate | null,
): Promise<Alert | null> {
  try {
    const est = estimate === undefined ? await fetchEstimate(code) : estimate
    if (!est || est.estChange == null) return null
    const chg = Math.abs(est.estChange)
    if (chg < threshold) return null

    const direction = est.estChange > 0 ? '涨' : '跌'
    const level: Alert['level'] = chg > 5 ? 'danger' : chg > 3 ? 'warn' : 'info'

    const a = pushAlert({
      kind: 'nav_spike', code, name, level,
      title: `异动 · ${name || code}`,
      body: `单日${direction} ${chg.toFixed(2)}%（${est.estTime || ''}）`,
    })
    notify(a)
    return a
  } catch { return null }
}

/** 再平衡提醒（距上次超过 REBALANCE_DAYS 天） */
export function checkRebalance(): Alert | null {
  const alerts = loadAlerts()
  const last = alerts.filter((a) => a.kind === 'rebalance').sort((a, b) => b.time.localeCompare(a.time))[0]
  if (last) {
    const days = (Date.now() - new Date(last.time).getTime()) / 864e5
    if (days < REBALANCE_DAYS) return null
  }

  const a = pushAlert({
    kind: 'rebalance', level: 'info',
    title: '再平衡提醒',
    body: `距上次再平衡提醒已超 ${REBALANCE_DAYS} 天，建议检查组合配置是否偏离目标。`,
  })
  notify(a)
  return a
}

// ── 批量检查 ──────────────────────────────────────────
export interface WatchItemForAlert {
  code: string
  name: string
  prevSignal?: string | null
  currentSignal?: SignalResp
  estimate?: Estimate | null
}

export async function runAllChecks(items: WatchItemForAlert[]): Promise<Alert[]> {
  const results: (Alert | null)[] = []

  // 并行执行所有检查
  const tasks: Promise<Alert | null>[] = []
  for (const it of items) {
    tasks.push(checkSignalChange(it.code, it.name, it.prevSignal ?? null, it.currentSignal))
    tasks.push(checkNavSpike(it.code, it.name, 3, it.estimate))
  }
  tasks.push(Promise.resolve(checkRebalance()))

  const settled = await Promise.allSettled(tasks)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) results.push(r.value)
  }

  return results.filter(Boolean) as Alert[]
}

/** 请求通知权限 */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const p = await Notification.requestPermission()
  return p === 'granted'
}

/** 获取未读提醒数 */
export function unreadCount(): number {
  return loadAlerts().filter((a) => !a.read && !a.dismissed).length
}

/** 标记已读 */
export function markRead(id: string): void {
  const alerts = loadAlerts()
  const a = alerts.find((x) => x.id === id)
  if (a) { a.read = true; saveAlerts(alerts) }
}

/** 标记全部已读 */
export function markAllRead(): void {
  const alerts = loadAlerts()
  alerts.forEach((a) => { a.read = true })
  saveAlerts(alerts)
}

/** 关闭提醒 */
export function dismissAlert(id: string): void {
  const alerts = loadAlerts()
  const a = alerts.find((x) => x.id === id)
  if (a) { a.dismissed = true; saveAlerts(alerts) }
}
