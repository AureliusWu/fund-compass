export const TEMPERATURE_DEFINITION = '数值越高，市场越拥挤，短期回撤风险越高'

export const TEMPERATURE_BANDS = [
  { max: 20, label: '清冷' },
  { max: 40, label: '偏冷' },
  { max: 60, label: '适中' },
  { max: 80, label: '偏热' },
  { max: 100, label: '过热' },
] as const

export function temperatureLabel(score: number | null | undefined): string {
  if (score == null) return '计算中'
  return TEMPERATURE_BANDS.find((band) => score <= band.max)?.label ?? '过热'
}

export const ANALYSIS_TERMS = {
  valuation: '估值分位',
  trend: '趋势状态',
  momentum: '动量状态',
  coverage: '数据覆盖率',
  evidence: '证据强度',
} as const
