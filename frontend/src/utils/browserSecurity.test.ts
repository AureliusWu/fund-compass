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

  it("ships a same-origin script CSP with an explicit fail-safe PWA registrar", () => {
    const html = read('../../index.html')
    const vite = read('../../vite.config.ts')
    const registrar = read('../../public/registerSW.js')
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || ''
    const scriptSources = /script-src ([^;]+)/.exec(policy)?.[1].trim().split(/\s+/) || []
    const scriptUrls = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])

    expect(scriptSources).toEqual(["'self'"])
    expect(scriptUrls.length).toBeGreaterThan(0)
    expect(scriptUrls.every((url) => url.startsWith('/'))).toBe(true)
    expect(scriptUrls).toContain('/registerSW.js')
    expect(vite).toContain('injectRegister: false')
    expect(vite).toContain('skipWaiting: true')
    expect(vite).toContain('clientsClaim: true')
    expect(vite).toContain("cacheName: 'fc-data-v8'")
    expect(registrar).toContain("updateViaCache: 'none'")
    expect(registrar).toContain("addEventListener('controllerchange'")
    expect(registrar).toContain('registration.update()')
    expect(registrar).toContain('fund-compass:sw-controller-reload-at')
  })
})
