import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from './client'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('API request resilience', () => {
  it('aborts a request after its deadline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))

    const pending = request('/slow', undefined, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)

    await assertion
  })

  it('preserves HTTP status for failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    await expect(request('/down')).rejects.toMatchObject({
      kind: 'http',
      status: 503,
    })
  })
})
