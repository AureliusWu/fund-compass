export function pct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--'
  const s = n >= 0 ? '+' : ''
  return s + n.toFixed(digits) + '%'
}

export function num(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '--'
  return n.toFixed(digits)
}

export function colorOf(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'var(--van-text-color-2)'
  // 红涨绿跌
  return n > 0 ? '#ee0a24' : n < 0 ? '#07c160' : 'var(--van-text-color-2)'
}

// 信号 → 颜色（买入/定投偏红，持有中性，减仓绿）
export function signalColor(sig: string): string {
  if (sig === '买入') return '#ee0a24'
  if (sig === '定投') return '#ff976a'
  if (sig === '减仓') return '#07c160'
  return '#969799'
}

export function stars(star: number | null | undefined): string {
  const s = star ?? 0
  return '★'.repeat(s) + '☆'.repeat(Math.max(0, 5 - s))
}
