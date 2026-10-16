import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_TIMEOUT_MS, chat, getAiConfig } from './ai'

function config(provider = 'deepseek', baseUrl = '', extra: Record<string, unknown> = {}) {
  const value = JSON.stringify({ provider, apiKey: 'synthetic-not-a-real-key', baseUrl, model: '', ...extra })
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'sinan_ai_cfg' ? value : null })
}
function reply(provider: string, content: unknown = 'synthetic text') {
  return new Response(JSON.stringify(provider === 'anthropic'
    ? { content: [{ type: 'text', text: content }] }
    : { choices: [{ message: { content } }] }), { status: 200 })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each(['deepseek', 'anthropic'])('AI %s bounded transport', provider => {
  it('keeps provider shape but omits ambient credentials and redirects', async () => {
    config(provider)
    const fetchMock = vi.fn().mockResolvedValue(reply(provider))
    vi.stubGlobal('fetch', fetchMock)
    await expect(chat('synthetic system', 'synthetic user')).resolves.toBe('synthetic text')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(provider === 'anthropic' ? /\/v1\/messages$/ : /\/chat\/completions$/)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends at deadline even if fetch ignores abort, with no retry', async () => {
    config(provider)
    const fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const pending = chat('system', 'user')
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS)
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds response-body read and rejects a late body', async () => {
    config(provider)
    let finish!: (value: string) => void
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => new Promise<string>(resolve => { finish = resolve }) }))
    const pending = chat('system', 'user')
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(AI_TIMEOUT_MS)
    finish(JSON.stringify({ choices: [{ message: { content: 'late' } }] }))
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('supports pre-cancellation and body cancellation without leaking abort reason', async () => {
    config(provider)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => new Promise(() => {}) })
    vi.stubGlobal('fetch', fetchMock)
    const pre = new AbortController()
    pre.abort('synthetic private reason')
    await expect(chat('system', 'user', { signal: pre.signal })).rejects.toMatchObject({ kind: 'cancelled', message: '请求已取消' })
    expect(fetchMock).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = chat('system', 'user', { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled', message: '请求已取消' })
    await Promise.resolve()
    controller.abort('synthetic private reason')
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not parse or echo a failed provider body', async () => {
    config(provider)
    const text = vi.fn().mockResolvedValue('synthetic-private-key-and-prompt')
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text })
    vi.stubGlobal('fetch', fetchMock)
    await expect(chat('system', 'user')).rejects.toMatchObject({ kind: 'http', status: 429, message: 'AI API HTTP 429，请检查配置或账户状态；未自动重试' })
    expect(text).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([null, 42, {}, [], '', ' '.repeat(2), 'x'.repeat(16_385)])('rejects malformed or oversized output %#', async content => {
    config(provider)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(provider, content)))
    await expect(chat('system', 'user')).rejects.toThrow('AI 返回格式无效或为空')
  })
})

describe('AI configuration and JSON boundary', () => {
  it('cancels a streaming body reader when the caller cancels', async () => {
    config()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const controller = new AbortController()
    const pending = chat('system', 'user', { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    controller.abort()
    await assertion
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops oversized streaming bytes before downloading the remaining provider body', async () => {
    config()
    const cancel = vi.fn()
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { sent++; controller.enqueue(new Uint8Array(32_768)); }, cancel,
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    await expect(chat('system', 'user')).rejects.toMatchObject({ kind: 'network' })
    expect(sent).toBeLessThanOrEqual(4) // one additional browser-prefetched chunk is allowed
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['http://example.test', 'https://user:password@example.test', 'https://example.test?secret=synthetic', 'https://example.test#fragment', 'javascript:synthetic'])('rejects unsafe endpoint %s without transmission', async url => {
    config('custom', url, { model: 'synthetic-model' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(chat('system', 'user')).rejects.toThrow('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([{ provider: 'unknown' }, { apiKey: {} }, { model: 1 }, { baseUrl: [] }])('does not coerce malformed config %# or switch provider with its key', async extra => {
    config('deepseek', '', extra)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(getAiConfig().apiKey).toBe('')
    await expect(chat('system', 'user')).rejects.toThrow('未配置')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['null', '[]', '{"provider":"deepseek"}'])('handles corrupt stored config %s safely', raw => {
    vi.stubGlobal('localStorage', { getItem: () => raw })
    expect(getAiConfig().apiKey).toBe('')
  })
  it.each(['not JSON synthetic-private', 'x'.repeat(65_537)])('rejects malformed/large envelope without echo', async raw => {
    config()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(raw)))
    await expect(chat('system', 'user')).rejects.toMatchObject({ kind: 'network', message: '网络连接失败，请稍后重试' })
  })
})
