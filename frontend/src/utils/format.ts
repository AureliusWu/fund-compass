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
  if (n === null || n === undefined || Number.isNaN(n)) return 'var(--text-muted)'
  // 红涨绿跌：朱砂 / 松绿（走 CSS 变量，自动适配暗色主题）
  return n > 0 ? 'var(--danger)' : n < 0 ? 'var(--success)' : 'var(--text-muted)'
}

// 信号 → 颜色（买入=朱砂，定投=琥珀，持有=墨，减仓=松绿）
export function signalColor(sig: string): string {
  if (sig === '买入') return 'var(--danger)'
  if (sig === '定投') return 'var(--warn)'
  if (sig === '减仓') return 'var(--success)'
  return 'var(--text-muted)'
}

export function stars(star: number | null | undefined): string {
  const s = star ?? 0
  return '★'.repeat(s) + '☆'.repeat(Math.max(0, 5 - s))
}
