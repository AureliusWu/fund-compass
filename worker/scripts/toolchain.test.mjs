import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const miniflareRequire = createRequire(require.resolve('miniflare'))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))

describe('Miniflare external HTTP toolchain', () => {
  it('resolves the reviewed security patch through a parent-scoped override', () => {
    // This does not patch Wrangler's separately bundled Undici. That upstream
    // security gate remains open even when npm audit reports no advisories.
    expect(manifest.overrides).toEqual({
      'miniflare@5.20261006.1-alpha': { undici: '7.30.1' },
    })
    expect(require('wrangler/package.json').version).toBe('4.149.0')
    expect(require('miniflare/package.json').version).toBe('5.20261006.1-alpha')
    expect(miniflareRequire('undici/package.json').version).toBe('7.30.1')
    const lockedUndici = Object.entries(lock.packages)
      .filter(([name]) => /(?:^|\/)node_modules\/undici$/.test(name))
      .map(([, entry]) => entry.version)
    expect(lockedUndici).toEqual(['7.30.1'])
  })

  it('supports real local workerd request, response, stream and cancellation paths', async () => {
    const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare')
    const mf = new Miniflare(convertV4MiniflareOptions({
      // No cf.json lookup, project config, project bindings or cloud connection.
      cf: false,
      host: '127.0.0.1',
      port: 0,
      log: new Log(LogLevel.NONE),
      modules: true,
      compatibilityDate: '2026-07-11',
      outboundService() { throw new Error('External requests are forbidden in this smoke') },
      script: `export default { async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/empty') return new Response(null, { status: 204 });
        if (path === '/redirect') return new Response(null, {
          status: 302, headers: { location: 'https://external.invalid/forbidden' }
        });
        if (path === '/stream') return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('local-stream'));
            controller.close();
          }
        }));
        const copy = request.clone();
        return Response.json({ method: request.method, body: await copy.text() }, {
          headers: { 'x-smoke': 'local-only' }
        });
      } }`,
    }))
    try {
      const response = await mf.dispatchFetch('http://smoke.invalid/echo', {
        method: 'POST', body: 'synthetic-body',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-smoke')).toBe('local-only')
      expect(await response.clone().json()).toEqual({ method: 'POST', body: 'synthetic-body' })
      expect(await response.json()).toEqual({ method: 'POST', body: 'synthetic-body' })
      expect(await (await mf.dispatchFetch('http://smoke.invalid/echo')).json())
        .toEqual({ method: 'GET', body: '' })
      expect(await (await mf.dispatchFetch('http://smoke.invalid/stream')).text()).toBe('local-stream')
      const empty = await mf.dispatchFetch('http://smoke.invalid/empty')
      expect(empty.status).toBe(204)
      expect(await empty.text()).toBe('')
      const redirect = await mf.dispatchFetch('http://smoke.invalid/redirect', { redirect: 'manual' })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('location')).toBe('https://external.invalid/forbidden')
      const controller = new AbortController()
      controller.abort()
      await expect(mf.dispatchFetch('http://smoke.invalid/echo', { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await mf.dispose()
    }
  }, 15000)
})
