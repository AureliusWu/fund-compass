// 暗黑模式（V3-11）。CSS 变量驱动，localStorage 持久化偏好。
// 切换 document.documentElement data-theme 属性，CSS 通过 [data-theme="dark"] 覆盖变量。

const KEY = 'sinan_theme'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light') return v
  } catch { /* ignore */ }
  // 跟随系统偏好
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

export function setTheme(t: Theme): void {
  try { localStorage.setItem(KEY, t) } catch { /* ignore */ }
  applyTheme(t)
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute('data-theme', t)
  // 更新 meta theme-color（浏览器地址栏/状态栏颜色）
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1a1a2e' : '#0f9d75')
}

export function toggleTheme(): Theme {
  const cur = getTheme()
  const next: Theme = cur === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

// 初始化时调用一次
export function initTheme(): void {
  applyTheme(getTheme())
  // 监听系统主题变化（用户未手动设置时跟随）
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem(KEY)) applyTheme(getTheme())
  })
}
