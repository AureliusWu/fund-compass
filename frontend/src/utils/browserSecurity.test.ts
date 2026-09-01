import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

describe('browser script boundary', () => {
  it('contains no third-party script or JSONP injection in market-data clients', () => {
    const sources = [
      read('./indices.ts'),
      read('./estimate.ts'),
      read('./holdings.ts'),
    ].join('\n')

    expect(sources).not.toMatch(/createElement\s*\(\s*['"]script['"]\s*\)/)
    expect(sources).not.toMatch(/document\.head\.appendChild\s*\(\s*script\s*\)/)
    expect(sources).not.toMatch(/https:\/\/(?:qt\.gtimg\.cn|fundf10\.eastmoney\.com)/)
    expect(sources).not.toMatch(/window\.(?:apidata|v_)/)
  })

  it("ships a same-origin script CSP that remains compatible with the external PWA registrar", () => {
    const html = read('../../index.html')
    const vite = read('../../vite.config.ts')
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || ''
    const scriptSources = /script-src ([^;]+)/.exec(policy)?.[1].trim().split(/\s+/) || []
    const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])

    expect(scriptSources).toEqual(["'self'"])
    expect(scriptUrls.length).toBeGreaterThan(0)
    expect(scriptUrls.every((url) => url.startsWith('/'))).toBe(true)
    expect(vite).toContain("injectRegister: 'script-defer'")
  })
})
