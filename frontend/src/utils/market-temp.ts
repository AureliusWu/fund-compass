// 市场温度计（V4-1，P0 重写）。
// 旧版多个数据源失效/字段用错（PE 接口 404、把上证点位当国债收益率、均线用昨收、量能字段错），
// 综合分大半是垃圾。重写为「全部基于沪深300指数日K + 量比」的可靠正确计算，并如实标注：
// 这是「点位 / 趋势 / 情绪 / 量能」温度，非 PE/PB 基本面估值（真·PE 分位需鉴权数据源，暂缺）。
// 数据源：push2his 指数日K（CORS 友好）+ push2 量比 f168。

export interface TempSource { label: string; value: number; color: string; detail: string }
export interface MarketTemp {
  status: 'fresh' | 'stale' | 'unavailable'
  score: number // 0–100，越高越热/越贵
  label: string // 极寒 / 偏冷 / 适中 / 偏热 / 过热
  color: string
  sources: TempSource[]
  updated: string
}

const LS = 'sinan_market_temp_v1'
const TTL = 4 * 3600 * 1000
const TIMEOUT = 8000
const SECID = '1.000300' // 沪深300，作市场代表
const POS_WINDOW = 2500 // 点位分位回看 ≈10 年

async function fetchCloses(secid: string): Promise<number[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      `&fields1=f1&fields2=f51,f53&klt=101&fqt=0&beg=0&end=20500101&lmt=${POS_WINDOW}&_=${Date.now()}`,
      { signal: ctrl.signal },
    )
    clearTimeout(t)
    if (!r.ok) return []
    const j = await r.json()
    const klines: string[] = j?.data?.klines || []
    return klines.map((k) => parseFloat(k.split(',')[1])).filter((v) => Number.isFinite(v) && v > 0)
  } catch { clearTimeout(t); return [] }
}

async function fetchVolRatio(secid: string): Promise<number | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f168&fltt=2&_=${Date.now()}`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) return null
    const j = await r.json()
    const v = parseFloat(j?.data?.f168)
    return Number.isFinite(v) ? v : null
  } catch { clearTimeout(t); return null }
}

function ma(vals: number[], n: number): number | null {
  return vals.length >= n ? vals.slice(-n).reduce((a, b) => a + b, 0) / n : null
}
function percentile(vals: number[], cur: number): number {
  if (!vals.length) return 50
  return Math.round((vals.filter((v) => v <= cur).length / vals.length) * 1000) / 10
}
function rsi(vals: number[], period = 14): number | null {
  if (vals.length < period + 1) return null
  const d = vals.slice(1).map((v, i) => v - vals[i])
  let g = d.slice(0, period).reduce((a, x) => a + Math.max(x, 0), 0) / period
  let l = d.slice(0, period).reduce((a, x) => a + Math.max(-x, 0), 0) / period
  for (let i = period; i < d.length; i++) {
    g = (g * (period - 1) + Math.max(d[i], 0)) / period
    l = (l * (period - 1) + Math.max(-d[i], 0)) / period
  }
  if (l === 0) return g === 0 ? 50 : 100
  return Math.round((100 - 100 / (1 + g / l)) * 10) / 10
}

export function directionalVolumeScore(ratio: number, dailyChange: number): number {
  // 放量本身没有冷热方向：上涨放量升温，下跌放量降温；缩量保持接近中性。
  const strength = Math.max(0, Math.min(1, (ratio - 0.8) / 0.7))
  const direction = Math.max(-1, Math.min(1, dailyChange / 2))
  return Math.round(50 + 35 * strength * direction)
}
// 山峦色阶：深松→青绿→墨→琥珀→朱砂（对应《千里江山图》色系，Canvas 必须用 hex）
function toLabel(score: number): { label: string; color: string } {
  if (score <= 20) return { label: '极寒', color: '#315A46' }
  if (score <= 40) return { label: '偏冷', color: '#4C7E67' }
  if (score <= 60) return { label: '适中', color: '#5A6A60' }
  if (score <= 80) return { label: '偏热', color: '#C8963E' }
  return { label: '过热', color: '#C44536' }
}
const heatColor = (s: number) => {
  if (s <= 20) return '#315A46'
  if (s <= 40) return '#4C7E67'
  if (s <= 60) return '#5A6A60'
  if (s <= 80) return '#C8963E'
  return '#C44536'
}

export async function fetchMarketTemp(): Promise<MarketTemp> {
  let previous: (MarketTemp & { _ts: number }) | null = null
  try {
    const raw = localStorage.getItem(LS)
    if (raw) {
      const c = JSON.parse(raw) as MarketTemp & { _ts: number }
      previous = c
      if (Date.now() - c._ts < TTL) return { ...c, status: 'fresh' }
    }
  } catch { /* ignore */ }

  const [closes, volRatio] = await Promise.all([fetchCloses(SECID), fetchVolRatio(SECID)])
  const sources: TempSource[] = []
  let scoreSum = 0
  let weightSum = 0

  if (closes.length >= 120) {
    const cur = closes[closes.length - 1]

    // 1. 点位分位（近 ~10 年，权重 40%；接口 lmt 不稳，客户端截窗）
    const posCloses = closes.slice(-POS_WINDOW)
    const pct = percentile(posCloses, cur)
    const posLabel = pct <= 20 ? '低位' : pct <= 40 ? '偏低' : pct <= 60 ? '中位' : pct <= 80 ? '偏高' : '高位'
    sources.push({ label: '点位分位', value: Math.round(pct), color: heatColor(pct), detail: `沪深300 ${cur.toFixed(0)} · 近${Math.round(posCloses.length / 250)}年分位 ${pct}% · ${posLabel}` })
    scoreSum += pct * 0.4; weightSum += 0.4

    // 2. 均线偏离（真 MA60，权重 25%）
    const m60 = ma(closes, 60)
    if (m60) {
      const dev = ((cur - m60) / m60) * 100
      const devScore = Math.max(0, Math.min(100, 50 + dev * 4))
      sources.push({ label: '均线偏离', value: Math.round(devScore), color: heatColor(devScore), detail: `现价 ${cur.toFixed(0)} · MA60 ${m60.toFixed(0)} · 偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%` })
      scoreSum += devScore * 0.25; weightSum += 0.25
    }

    // 3. 情绪 RSI14（权重 20%）
    const rs = rsi(closes)
    if (rs != null) {
      sources.push({ label: '情绪 RSI', value: Math.round(rs), color: heatColor(rs), detail: `RSI14 ${rs} · ${rs >= 70 ? '超买' : rs <= 30 ? '超卖' : '中性'}` })
      scoreSum += rs * 0.2; weightSum += 0.2
    }
  }

  // 4. 量能（量比，权重 15%）
  if (volRatio != null && closes.length >= 2) {
    const current = closes[closes.length - 1]
    const previousClose = closes[closes.length - 2]
    const dailyChange = (current / previousClose - 1) * 100
    const vs = directionalVolumeScore(volRatio, dailyChange)
    sources.push({ label: '量价确认', value: vs, color: heatColor(vs), detail: `量比 ${volRatio.toFixed(2)} · 当日 ${dailyChange >= 0 ? '+' : ''}${dailyChange.toFixed(2)}%` })
    scoreSum += vs * 0.15; weightSum += 0.15
  }

  if (weightSum === 0) {
    if (previous && typeof previous.score === 'number') {
      return { ...previous, status: 'stale' }
    }
    return {
      score: 50,
      label: '不可用',
      color: '#969799',
      sources: [{ label: '数据源不可用', value: 0, color: '#969799', detail: '本次未取得有效市场数据' }],
      updated: new Date().toISOString(),
      status: 'unavailable',
    }
  }

  const finalScore = Math.round(scoreSum / weightSum)
  const { label, color } = toLabel(finalScore)
  const result: MarketTemp & { _ts: number } = {
    score: finalScore, label, color,
    sources: sources.length ? sources : [{ label: '暂无数据', value: 50, color: '#969799', detail: '数据源暂不可用，显示中性温度' }],
    updated: new Date().toISOString(), status: 'fresh',
    _ts: Date.now(),
  }
  try { localStorage.setItem(LS, JSON.stringify(result)) } catch { /* quota */ }
  return result
}

export function cachedMarketTemp(): MarketTemp | null {
  try {
    const raw = localStorage.getItem(LS)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (obj && typeof obj.score === 'number') {
      return { ...obj, status: Date.now() - obj._ts < TTL ? 'fresh' : 'stale' } as MarketTemp
    }
  } catch { /* ignore */ }
  return null
}
