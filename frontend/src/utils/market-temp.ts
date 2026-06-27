// V4-1 市场温度计。多维度综合评估当前市场冷热。
// 数据源：东方财富 push2（CORS 友好，JSON fetch）+ 天天基金指数估值。
// 维度：股权风险溢价、PE 分位近似、成交量动量、综合温度 0–100。

export interface TempSource { label: string; value: number; color: string; detail: string }
export interface MarketTemp {
  score: number        // 0–100，越高越热/越贵
  label: string        // 极寒 / 偏冷 / 适中 / 偏热 / 过热
  color: string
  sources: TempSource[]
  updated: string
}

const LS = 'sinan_market_temp_v1'
const TTL = 4 * 3600 * 1000  // 4h 缓存
const TIMEOUT = 8000

// ── 东方财富 push2 fetch ──────────────────────────────
async function fetchEM(secid: string, fields: string): Promise<Record<string, number> | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}&fltt=2&_=${Date.now()}`,
      { signal: ctrl.signal },
    )
    clearTimeout(t)
    if (!r.ok) return null
    const j = await r.json()
    const d = j?.data
    if (!d) return null
    const out: Record<string, number> = {}
    for (const f of fields.split(',')) {
      const v = parseFloat(d[f])
      if (Number.isFinite(v)) out[f] = v
    }
    return out
  } catch { clearTimeout(t); return null }
}

// ── 天天基金指数估值（PE 分位） ──────────────────────
// 接口返回沪深 300 / 中证 500 等宽基 PE 及历史分位
async function fetchIndexPE(code: string): Promise<{ pe: number; pePct: number; pb: number; pbPct: number } | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await fetch(
      `https://api.fund.eastmoney.com/favoritasync/valuation/queryIndex?code=${code}&_=${Date.now()}`,
      { signal: ctrl.signal, headers: { Referer: 'https://fund.eastmoney.com/' } },
    )
    clearTimeout(t)
    if (!r.ok) return null
    const j = await r.json()
    const d = j?.data
    if (!d) return null
    const pe = parseFloat(d.pe)
    const pePct = parseFloat(d.pePercentile) / 100  // 转为 0–1
    const pb = parseFloat(d.pb)
    const pbPct = parseFloat(d.pbPercentile) / 100
    if (!Number.isFinite(pe) || !Number.isFinite(pePct)) return null
    return { pe, pePct, pb, pbPct }
  } catch { clearTimeout(t); return null }
}

// ── 股债性价比（股权风险溢价 ERP） ──────────────────
// ERP = 1/PE_csi300 - 10Y国债收益率
// ERP 越高 → 股票相对债券越便宜 → 偏冷
// 历史 ERP 大致在 2%–6% 之间波动
function erpScore(pe: number, bondYield: number): number {
  if (pe <= 0 || bondYield <= 0) return 50
  const erp = (1 / pe) * 100 - bondYield
  // clamp erp to [1.5, 5.5] → invert to [0, 100]
  const clamped = Math.max(1.5, Math.min(5.5, erp))
  return 100 - ((clamped - 1.5) / 4) * 100
}

// ── PE 分位映射 ─────────────────────────────────────
function peScore(pct: number): number {
  return Math.round(pct * 100)  // pct 0–1 → 0–100
}

// ── 成交量动量（近 20 日 vs 60 日均量） ────────────────
function volumeScore(volRatio: number): number {
  // volRatio > 1.3 → 放量（偏热），< 0.7 → 缩量（偏冷）
  if (volRatio > 1.5) return 85
  if (volRatio > 1.2) return 65
  if (volRatio > 0.9) return 50
  if (volRatio > 0.7) return 35
  return 20
}

function toLabel(score: number): { label: string; color: string } {
  if (score <= 20) return { label: '极寒', color: '#1989fa' }
  if (score <= 40) return { label: '偏冷', color: '#0f9d75' }
  if (score <= 60) return { label: '适中', color: '#969799' }
  if (score <= 80) return { label: '偏热', color: '#ff976a' }
  return { label: '过热', color: '#ee0a24' }
}

// ── 主入口 ──────────────────────────────────────────
export async function fetchMarketTemp(): Promise<MarketTemp> {
  // 先看缓存
  try {
    const raw = localStorage.getItem(LS)
    if (raw) {
      const cached = JSON.parse(raw) as MarketTemp & { _ts: number }
      if (Date.now() - cached._ts < TTL) return cached
    }
  } catch { /* ignore */ }

  const sources: TempSource[] = []
  let scoreSum = 0
  let weightSum = 0

  // 1. 沪深 300 PE 分位（权重 35%）
  try {
    const pe300 = await fetchIndexPE('000300')
    if (pe300) {
      const s = peScore(pe300.pePct)
      const label = s <= 20 ? '低估' : s <= 40 ? '偏低' : s <= 60 ? '中枢' : s <= 80 ? '偏高' : '高估'
      sources.push({
        label: '沪深300 PE分位', value: s,
        color: s <= 30 ? '#0f9d75' : s <= 60 ? '#969799' : '#ee0a24',
        detail: `PE ${pe300.pe.toFixed(1)} · 历史分位 ${Math.round(pe300.pePct * 100)}% · ${label}`,
      })
      scoreSum += s * 0.35; weightSum += 0.35
    }
  } catch { /* 静默 */ }

  // 2. 10Y 国债收益率 → ERP（权重 25%）
  try {
    const bond = await fetchEM('1.000001', 'f43,f57')
    const bondY = bond ? (bond.f43 > 0 ? bond.f43 : bond.f57) : 0
    if (bondY > 0) {
      // 用沪深 300 PE 算 ERP
      const peForERP = sources.length > 0 ? parseFloat(sources[0].detail.match(/PE ([\d.]+)/)?.[1] || '0') : 13
      if (peForERP > 0) {
        const es = erpScore(peForERP, bondY)
        sources.push({
          label: '股债性价比', value: Math.round(es),
          color: es <= 30 ? '#0f9d75' : es <= 60 ? '#969799' : '#ee0a24',
          detail: `10Y 国债 ${bondY.toFixed(2)}% · ERP ${((1 / peForERP) * 100 - bondY).toFixed(2)}%`,
        })
        scoreSum += es * 0.25; weightSum += 0.25
      }
    }
  } catch { /* 静默 */ }

  // 3. 沪深 300 趋势（20 日均线偏离，权重 15%）
  try {
    const idx = await fetchEM('1.000300', 'f43,f60')
    if (idx && idx.f43 > 0 && idx.f60 > 0) {
      const dev = ((idx.f43 - idx.f60) / idx.f60) * 100  // 偏离 20 日均线 %
      // 偏离 > 5% → 偏热，偏离 < -5% → 偏冷
      const devScore = Math.max(0, Math.min(100, 50 + dev * 5))
      sources.push({
        label: '均线偏离', value: Math.round(devScore),
        color: devScore <= 40 ? '#0f9d75' : devScore >= 60 ? '#ee0a24' : '#969799',
        detail: `沪深300 ${idx.f43.toFixed(0)} · MA20 ${idx.f60.toFixed(0)} · 偏离 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%`,
      })
      scoreSum += devScore * 0.15; weightSum += 0.15
    }
  } catch { /* 静默 */ }

  // 4. 成交量（权重 10%）
  try {
    const vol = await fetchEM('1.000300', 'f47,f168')
    if (vol && vol.f47 > 0 && vol.f168 > 0) {
      const ratio = vol.f47 / vol.f168  // 今日量 / 5日均量
      const vs = volumeScore(ratio)
      sources.push({
        label: '量能', value: vs,
        color: vs >= 65 ? '#ee0a24' : vs <= 35 ? '#0f9d75' : '#969799',
        detail: `量比 ${ratio.toFixed(2)}`,
      })
      scoreSum += vs * 0.10; weightSum += 0.10
    }
  } catch { /* 静默 */ }

  // 5. 股债利差历史分位（用近似：国债 + 2% 风险溢价 vs 当前股息率，权重 15%）
  try {
    const sh = await fetchEM('1.000001', 'f43')
    const csi = await fetchEM('1.000300', 'f43')
    if (sh && csi && sh.f43 > 0 && csi.f43 > 0) {
      // 简化：用上证股息率≈2.5% 近似，对比 10Y 国债
      const divYield = 2.5
      const spread = divYield - sh.f43
      // spread > 0 → 股息高于国债 → 股票吸引（偏冷）
      const spScore = Math.max(0, Math.min(100, 50 - spread * 15))
      sources.push({
        label: '股债利差', value: Math.round(spScore),
        color: spScore <= 40 ? '#0f9d75' : spScore >= 60 ? '#ee0a24' : '#969799',
        detail: `股息率 ${divYield.toFixed(1)}% vs 国债 ${sh.f43.toFixed(2)}%`,
      })
      scoreSum += spScore * 0.15; weightSum += 0.15
    }
  } catch { /* 静默 */ }

  // 综合
  const finalScore = weightSum > 0 ? Math.round(scoreSum / weightSum) : 50
  const { label, color } = toLabel(finalScore)

  const result: MarketTemp & { _ts: number } = {
    score: finalScore, label, color,
    sources: sources.length ? sources : [
      { label: '暂无数据', value: 50, color: '#969799', detail: '数据源暂不可用，显示中性温度' },
    ],
    updated: new Date().toISOString(),
    _ts: Date.now(),
  }

  try { localStorage.setItem(LS, JSON.stringify(result)) } catch { /* quota */ }
  return result
}

/** 首次渲染用的缓存骨架 */
export function cachedMarketTemp(): MarketTemp | null {
  try {
    const raw = localStorage.getItem(LS)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (obj && typeof obj.score === 'number') return obj as MarketTemp
  } catch { /* ignore */ }
  return null
}
