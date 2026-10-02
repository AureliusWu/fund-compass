// V4-6 数据故事。组合周报/月报数据聚合。
// 从持仓数据、信号、估值等维度生成结构化故事卡片。

import { FREE_TEXT_AI_UNAVAILABLE } from './ai'
import {
  costBasisCoverage,
  holdingCostBasis,
  holdingMarketValue,
  valuationCoverage,
} from './portfolioCoverage'

export interface StoryCoverage {
  /** 数值覆盖是否完整；不代表日期和新鲜度门禁已经通过。 */
  complete: boolean
  /** 可否发布组合值/排行。 */
  publishable: boolean
  covered: number
  total: number
  missing: string[]
  /** 有数值且有合法、非未来来源日期的持仓数。 */
  dated: number
  /** 规范化到 YYYY-MM-DD 的真实数值日期。 */
  dates: string[]
  stale: string[]
  freshnessUnknown: string[]
  futureDate: string[]
}

export interface StoryHolding {
  code: string
  name: string
  type: string
  value: number | null
  costBasis: number | null
  profit: number | null
  rate: number | null
  today: number | null
  signal: string | null
  score: number | null
  star: number | null
  navDate: string | null
  todayDate: string | null
  signalDate: string | null
  scoreDate: string | null
  navStale: boolean | null
  todayStale: boolean | null
  signalStale: boolean | null
  scoreStale: boolean | null
  navDateFuture: boolean
  todayDateFuture: boolean
  signalDateFuture: boolean
  scoreDateFuture: boolean
}

export interface StoryData {
  generated: string           // 报告生成时间，不是金融数据日期
  totalValue: number | null
  pricedValue: number
  totalCost: number | null
  knownCost: number
  totalProfit: number | null
  totalRate: number | null
  todayEst: number | null
  coverage: {
    valuation: StoryCoverage
    cost: StoryCoverage
    returns: StoryCoverage
    today: StoryCoverage
    signal: StoryCoverage
    score: StoryCoverage
  }
  holdingCount: number
  bestHolding: StoryHolding | null   // by total return, only after all gates pass
  worstHolding: StoryHolding | null
  bestToday: StoryHolding | null     // by aligned daily move, only after all gates pass
  worstToday: StoryHolding | null
  signalDist: Record<string, number>
  holdings: StoryHolding[]
}

export interface RawStorySignalEvidence {
  value?: string | null
  coverage?: number | null
  stale?: boolean | null
  asOfDate?: string | null
}

export interface RawStoryScoreEvidence {
  score?: number | null
  star?: number | null
  coverage?: number | null
  eligible?: boolean | null
  stale?: boolean | null
  asOfDate?: string | null
}

export interface RawStoryHolding {
  code: string
  name: string
  type: string
  shares: number
  cost: number | null
  nav: number | null
  navDate?: string | null
  navStale?: boolean | null
  today: number | null
  todayDate?: string | null
  todayStale?: boolean | null
  detailStale?: boolean | null
  signalEvidence?: RawStorySignalEvidence | null
  scoreEvidence?: RawStoryScoreEvidence | null
  /** @deprecated Ungated values are intentionally ignored. */
  signal?: string | null
  /** @deprecated Ungated values are intentionally ignored. */
  score?: number | null
  /** @deprecated Ungated values are intentionally ignored. */
  star?: number | null
}

interface ParsedSourceDate {
  value: string | null
  future: boolean
}

interface MetricCoverageOptions {
  dateOf?: (holding: StoryHolding) => string | null
  staleOf?: (holding: StoryHolding) => boolean | null
  futureOf?: (holding: StoryHolding) => boolean
  requireKnownDate?: boolean
  requireAlignedDate?: boolean
  rejectStale?: boolean
  rejectUnknownFreshness?: boolean
  rejectFutureDate?: boolean
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function validCoverage(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.7 && value <= 1
}

function beijingDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))
  const part = (type: string) => parts.find(item => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function sourceDate(value: string | null | undefined, now: number): ParsedSourceDate {
  const text = typeof value === 'string' ? value.trim() : ''
  // Validate the complete source string, not just its date prefix. Minute precision
  // is supported by estimate providers; seconds/fractions and explicit ISO offsets
  // remain optional. Do not infer a timezone or convert the source market date.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/.exec(text)
  if (!match) return { value: null, future: false }
  if ((match[4] != null && Number(match[4]) > 23)
    || (match[5] != null && Number(match[5]) > 59)
    || (match[6] != null && Number(match[6]) > 59)
    || (match[7] != null && Number(match[7]) > 23)
    || (match[8] != null && Number(match[8]) > 59)) {
    return { value: null, future: false }
  }
  const normalized = `${match[1]}-${match[2]}-${match[3]}`
  const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (!Number.isFinite(probe.getTime()) || probe.toISOString().slice(0, 10) !== normalized) {
    return { value: null, future: false }
  }
  if (normalized > beijingDate(now)) return { value: null, future: true }
  return { value: normalized, future: false }
}

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function names(holdings: StoryHolding[]): string[] {
  return [...new Set(holdings.map(holding => holding.name))]
}

function metricCoverage(
  holdings: StoryHolding[],
  valueOf: (holding: StoryHolding) => unknown,
  options: MetricCoverageOptions = {},
): StoryCoverage {
  const covered = holdings.filter(holding => valueOf(holding) != null)
  const dated = options.dateOf
    ? covered.filter(holding => options.dateOf?.(holding) != null)
    : []
  const dates = options.dateOf
    ? distinct(dated.map(holding => options.dateOf?.(holding) as string))
    : []
  const stale = options.staleOf ? names(holdings.filter(holding => options.staleOf?.(holding) === true)) : []
  const freshnessUnknown = options.staleOf ? names(holdings.filter(holding => options.staleOf?.(holding) == null)) : []
  const futureDate = options.futureOf ? names(holdings.filter(holding => options.futureOf?.(holding) === true)) : []
  const complete = holdings.length > 0 && covered.length === holdings.length
  const datesKnown = !options.requireKnownDate || dated.length === covered.length
  const datesAligned = !options.requireAlignedDate || dates.length === 1
  const staleAllowed = !options.rejectStale || stale.length === 0
  const unknownFreshnessAllowed = !options.rejectUnknownFreshness || freshnessUnknown.length === 0
  const futureAllowed = !options.rejectFutureDate || futureDate.length === 0
  return {
    complete,
    publishable: complete && datesKnown && datesAligned && staleAllowed && unknownFreshnessAllowed && futureAllowed,
    covered: covered.length,
    total: holdings.length,
    missing: names(holdings.filter(holding => valueOf(holding) == null)),
    dated: dated.length,
    dates,
    stale,
    freshnessUnknown,
    futureDate,
  }
}

/**
 * 给覆盖元数据生成保守日期标签。缺日期保持“未知”，多日期明确标作跨日期，
 * 从不拿报告生成时间或请求时间冒充数值日期。
 */
export function storyCoverageDateText(coverage: StoryCoverage): string {
  if (coverage.covered === 0 || coverage.dated === 0 || coverage.dates.length === 0) {
    return coverage.futureDate.length ? '未知（未来日期已拒绝）' : '未知'
  }
  const first = coverage.dates[0]
  const last = coverage.dates[coverage.dates.length - 1]
  const range = first === last ? first : `${first} 至 ${last}`
  const notes: string[] = []
  if (coverage.dates.length > 1) notes.push('跨日期')
  if (coverage.dated !== coverage.covered) notes.push(`${coverage.dated}/${coverage.covered} 日期可用`)
  if (coverage.futureDate.length) notes.push('未来日期已拒绝')
  return notes.length ? `${range}（${notes.join('；')}）` : range
}

/**
 * 聚合持仓数据为故事输入。组合级指标只在全部持仓都有有限值时发布；
 * 单日聚合还必须满足同一真实数值日期、非未来且新鲜度明确。
 *
 * 旧调用方传入的 totals 字段仅保留为兼容输入，聚合时一律忽略，避免错误合计绕过门禁。
 */
export function compileStoryData(raw: {
  holdings: RawStoryHolding[]
  totalValue?: number
  totalCost?: number
  totalProfit?: number
  totalRate?: number | null
  todayEst?: number | null
}, options: { now?: number } = {}): StoryData {
  const now = options.now ?? Date.now()
  const holdings: StoryHolding[] = raw.holdings.map((holding) => {
    const value = holdingMarketValue(holding.shares, holding.nav)
    const costBasis = holdingCostBasis(holding.shares, holding.cost)
    const profit = value != null && costBasis != null ? value - costBasis : null
    const rate = profit != null && costBasis != null && costBasis > 0
      ? profit / costBasis * 100
      : null
    const navDate = sourceDate(holding.navDate, now)
    const todayDate = sourceDate(holding.todayDate, now)
    const signalDate = sourceDate(holding.signalEvidence?.asOfDate, now)
    const scoreDate = sourceDate(holding.scoreEvidence?.asOfDate, now)
    const detailFresh = holding.detailStale === false
    const signalText = typeof holding.signalEvidence?.value === 'string'
      ? holding.signalEvidence.value.trim()
      : ''
    const signalTrusted = Boolean(signalText)
      && detailFresh
      && holding.signalEvidence?.stale === false
      && validCoverage(holding.signalEvidence.coverage)
      && signalDate.value != null
      && !signalDate.future
    const rawScore = finiteOrNull(holding.scoreEvidence?.score)
    const rawStar = finiteOrNull(holding.scoreEvidence?.star)
    const scoreTrusted = detailFresh
      && holding.scoreEvidence?.eligible === true
      && holding.scoreEvidence?.stale === false
      && validCoverage(holding.scoreEvidence.coverage)
      && rawScore != null && rawScore >= 0 && rawScore <= 100
      && scoreDate.value != null
      && !scoreDate.future
    return {
      code: holding.code,
      name: holding.name,
      type: holding.type,
      value,
      costBasis,
      profit,
      rate,
      today: finiteOrNull(holding.today),
      signal: signalTrusted ? signalText : null,
      score: scoreTrusted ? rawScore : null,
      star: scoreTrusted && rawStar != null && rawStar >= 0 && rawStar <= 5 ? rawStar : null,
      navDate: navDate.value,
      todayDate: todayDate.value,
      signalDate: signalDate.value,
      scoreDate: scoreDate.value,
      navStale: holding.navStale ?? null,
      todayStale: holding.todayStale ?? null,
      signalStale: holding.signalEvidence?.stale ?? null,
      scoreStale: holding.scoreEvidence?.stale ?? null,
      navDateFuture: navDate.future,
      todayDateFuture: todayDate.future,
      signalDateFuture: signalDate.future,
      scoreDateFuture: scoreDate.future,
    }
  })

  const valuationBase = valuationCoverage(holdings.map(holding => ({
    code: holding.code,
    name: holding.name,
    value: holding.value,
  })))
  const costBase = costBasisCoverage(holdings.map(holding => ({
    code: holding.code,
    name: holding.name,
    basis: holding.costBasis,
  })))
  const valuation = metricCoverage(holdings, holding => holding.value, {
    dateOf: holding => holding.navDate,
    staleOf: holding => holding.navStale,
    futureOf: holding => holding.navDateFuture,
    rejectFutureDate: true,
  })
  const cost = metricCoverage(holdings, holding => holding.costBasis)
  const returns = metricCoverage(holdings, holding => holding.rate, {
    dateOf: holding => holding.navDate,
    staleOf: holding => holding.navStale,
    futureOf: holding => holding.navDateFuture,
    requireKnownDate: true,
    requireAlignedDate: true,
    rejectStale: true,
    rejectUnknownFreshness: true,
    rejectFutureDate: true,
  })
  const today = metricCoverage(holdings, holding => holding.today, {
    dateOf: holding => holding.todayDate,
    staleOf: holding => holding.todayStale,
    futureOf: holding => holding.todayDateFuture,
    requireKnownDate: true,
    requireAlignedDate: true,
    rejectStale: true,
    rejectUnknownFreshness: true,
    rejectFutureDate: true,
  })
  const signal = metricCoverage(holdings, holding => holding.signal, {
    dateOf: holding => holding.signalDate,
    staleOf: holding => holding.signalStale,
    futureOf: holding => holding.signalDateFuture,
    requireKnownDate: true,
    rejectStale: true,
    rejectUnknownFreshness: true,
    rejectFutureDate: true,
  })
  const score = metricCoverage(holdings, holding => holding.score, {
    dateOf: holding => holding.scoreDate,
    staleOf: holding => holding.scoreStale,
    futureOf: holding => holding.scoreDateFuture,
    requireKnownDate: true,
    rejectStale: true,
    rejectUnknownFreshness: true,
    rejectFutureDate: true,
  })

  const totalValue = valuation.publishable ? valuationBase.pricedValue : null
  const totalCost = cost.publishable ? costBase.knownCost : null
  const totalProfit = totalValue != null && totalCost != null ? totalValue - totalCost : null
  const totalRate = totalProfit != null && totalCost != null && totalCost > 0
    ? totalProfit / totalCost * 100
    : null
  const todayEst = today.publishable
    ? holdings.reduce((sum, holding) => sum + (holding.today as number), 0)
    : null

  const sorted = returns.publishable
    ? [...holdings].sort((a, b) => (b.rate as number) - (a.rate as number))
    : []
  const byToday = today.publishable
    ? [...holdings].sort((a, b) => (b.today as number) - (a.today as number))
    : []

  const signalDist: Record<string, number> = {}
  for (const holding of holdings) {
    const signalName = holding.signal || '未知'
    signalDist[signalName] = (signalDist[signalName] || 0) + 1
  }

  return {
    generated: new Date(now).toISOString(),
    totalValue,
    pricedValue: valuationBase.pricedValue,
    totalCost,
    knownCost: costBase.knownCost,
    totalProfit,
    totalRate,
    todayEst,
    coverage: { valuation, cost, returns, today, signal, score },
    holdingCount: holdings.length,
    bestHolding: sorted[0] || null,
    worstHolding: sorted[sorted.length - 1] || null,
    bestToday: byToday[0] || null,
    worstToday: byToday[byToday.length - 1] || null,
    signalDist,
    holdings,
  }
}

/** 暂停自由文本摘要；不得将未经完整性核验的规则降级结果标作模型输出。 */
export async function generateStorySummary(_data: StoryData): Promise<string> {
  throw new Error(FREE_TEXT_AI_UNAVAILABLE)
}
