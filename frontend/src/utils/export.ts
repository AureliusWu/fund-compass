// 组合数据导出（V3-11）。支持持仓 CSV、自选清单等导出。

import type { PeriodAttribution } from './attribution'
import type { Snapshot } from './snapshots'

/** 生成 CSV 字符串（自动处理中文/逗号/引号转义） */
export function toCSV(rows: Record<string, any>[]): string {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const esc = (v: any): string => {
    const s = v == null ? '' : String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const header = keys.map(esc).join(',')
  const body = rows.map((r) => keys.map((k) => esc(r[k])).join(',')).join('\n')
  return header + '\n' + body
}

/** 触发浏览器下载 */
function download(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const bom = '﻿' // BOM for Excel UTF-8 Chinese
  const blob = new Blob([bom + content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function dateStamp(): string {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
}

/** 导出持仓为 CSV */
export function exportHoldingsCSV(holdings: {
  code: string; name: string; account: string; type: string
  shares: number; cost: number; nav: number | null
  value: number; profit: number
}[]): void {
  const rows = holdings.map((h) => ({
    代码: h.code,
    名称: h.name,
    账户: h.account,
    类型: h.type,
    份额: h.shares.toFixed(2),
    成本净值: h.cost.toFixed(4),
    最新净值: h.nav != null ? h.nav.toFixed(4) : '',
    市值: h.value.toFixed(2),
    盈亏: h.profit.toFixed(2),
  }))
  download(`司南基金_持仓_${dateStamp()}.csv`, toCSV(rows))
}

/** 导出自选清单为 CSV */
export function exportWatchlistCSV(watchlist: { code: string; name?: string | null }[]): void {
  const rows = watchlist.map((w) => ({ 代码: w.code, 名称: w.name || '' }))
  download(`司南基金_自选_${dateStamp()}.csv`, toCSV(rows))
}

/** 导出选基排行结果为 CSV */
export function exportRankCSV(funds: { c: string; n: string; t: string; r1m: number | null; r3m: number | null; r6m: number | null; r1y: number | null; r3y: number | null; ytd: number | null; fee: number | null }[]): void {
  const rows = funds.map((f) => ({
    代码: f.c,
    名称: f.n,
    类型: f.t,
    近1月: f.r1m != null ? f.r1m.toFixed(2) + '%' : '',
    近3月: f.r3m != null ? f.r3m.toFixed(2) + '%' : '',
    近6月: f.r6m != null ? f.r6m.toFixed(2) + '%' : '',
    近1年: f.r1y != null ? f.r1y.toFixed(2) + '%' : '',
    近3年: f.r3y != null ? f.r3y.toFixed(2) + '%' : '',
    今年来: f.ytd != null ? f.ytd.toFixed(2) + '%' : '',
    手续费: f.fee != null ? f.fee.toFixed(2) + '%' : '',
  }))
  download(`司南基金_排行_${dateStamp()}.csv`, toCSV(rows))
}

/** 导出组合快照 */
export function exportSnapshotsCSV(snaps: Snapshot[]): void {
  const rows = snaps.map((s) => ({
    日期: s.date,
    市值: s.value.toFixed(2),
    成本: s.cost.toFixed(2),
    盈亏: (s.value - s.cost).toFixed(2),
    持仓明细数: s.holdings?.length ?? 0,
  }))
  download(`司南基金_组合快照_${dateStamp()}.csv`, toCSV(rows))
}

/** 导出近30日归因 */
export function exportPeriodAttributionCSV(attr: PeriodAttribution): void {
  const rows = attr.holdings.map((h) => ({
    区间: `${attr.startDate}~${attr.endDate}`,
    代码: h.key.includes('|') ? h.key.split('|').pop() : h.key,
    名称: h.name,
    账户: h.account,
    类型: h.type,
    期初市值: h.startValue.toFixed(2),
    期末市值: h.endValue.toFixed(2),
    区间变动: h.delta.toFixed(2),
    贡献占比: h.contribPct.toFixed(4) + '%',
  }))
  download(`司南基金_近30日归因_${dateStamp()}.csv`, toCSV(rows))
}
