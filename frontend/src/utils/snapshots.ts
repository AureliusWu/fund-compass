// 组合历史快照（V3-10）。定期/手动记录组合市值与成本，绘制历史曲线。
// 数据存 localStorage，每个快照 ≤ 1KB，按 200 个上限自动裁剪旧数据。

const KEY = 'sinan_snapshots'
const MAX_SNAPS = 200

export interface Snapshot {
  date: string   // ISO date
  value: number  // 组合总市值
  cost: number   // 组合总成本
  holdings?: SnapshotHolding[]
}

export interface SnapshotHolding {
  id: string
  code: string
  name: string
  account: string
  type: string
  value: number
  cost: number
}

export function loadSnapshots(): Snapshot[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((s: any) => s.date && typeof s.value === 'number' && typeof s.cost === 'number')
  } catch { return [] }
}

function saveSnapshots(snaps: Snapshot[]): void {
  // 按日期去重（同一天只保留最新），按日期排序，裁剪
  const map = new Map<string, Snapshot>()
  for (const s of snaps) map.set(s.date, s)
  const sorted = [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
  const trimmed = sorted.slice(-MAX_SNAPS)
  try { localStorage.setItem(KEY, JSON.stringify(trimmed)) } catch { /* quota exceeded */ }
}

function snapshotDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** 拍摄当前快照（同一天覆盖） */
export function takeSnapshot(value: number, cost: number, now = new Date(), holdings?: SnapshotHolding[]): Snapshot[] {
  const snaps = loadSnapshots()
  const today = snapshotDate(now)
  snaps.push({ date: today, value, cost, holdings })
  saveSnapshots(snaps)
  return loadSnapshots()
}

/** 每天自动记录一次；当天已有快照时不覆盖用户手动快照 */
export function takeDailySnapshot(value: number, cost: number, now = new Date(), holdings?: SnapshotHolding[]): Snapshot[] {
  if (!(value > 0)) return loadSnapshots()
  const today = snapshotDate(now)
  const snaps = loadSnapshots()
  if (snaps.some((s) => s.date === today)) return snaps
  snaps.push({ date: today, value, cost, holdings })
  saveSnapshots(snaps)
  return loadSnapshots()
}

/** 生成图表 option（ECharts 格式），用于前端 Chart 组件 */
export interface SnapChartOption {
  grid: { left: number; right: number; top: number; bottom: number }
  tooltip: { trigger: 'axis' }
  legend: { top: number; data: string[]; textStyle: { fontSize: number } }
  xAxis: { type: 'category'; data: string[]; boundaryGap: boolean; axisLabel: { fontSize: number } }
  yAxis: { type: 'value'; scale: boolean; axisLabel: { fontSize: number } }
  series: { name: string; type: 'line'; showSymbol: boolean; data: number[]; lineStyle: { color: string }; areaStyle?: { color: string } }[]
}

export function buildSnapChart(snaps: Snapshot[]): Record<string, unknown> | null {
  if (snaps.length < 2) return null
  const profit = snaps.map((s) => s.value - s.cost)
  return {
    grid: { left: 48, right: 16, top: 30, bottom: 28 },
    tooltip: { trigger: 'axis' },
    legend: { top: 0, data: ['市值', '成本', '盈亏'], textStyle: { fontSize: 11 } },
    xAxis: { type: 'category', data: snaps.map((s) => s.date.slice(5)), boundaryGap: false, axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
    series: [
      { name: '市值', type: 'line', showSymbol: false, data: snaps.map((s) => s.value), lineStyle: { color: '#0f9d75' }, areaStyle: { color: 'rgba(15,157,117,0.08)' } },
      { name: '成本', type: 'line', showSymbol: false, data: snaps.map((s) => s.cost), lineStyle: { color: '#969799' } },
      { name: '盈亏', type: 'line', showSymbol: false, data: profit, lineStyle: { color: '#ee0a24' } },
    ],
  }
}
