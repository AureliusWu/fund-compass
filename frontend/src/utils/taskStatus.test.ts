import { describe, expect, it, vi } from 'vitest'

import { normalizeTaskStatus, type TaskConfig } from './taskStatus'

const cfg: TaskConfig = {
  id: 'estimate-push',
  label: '估值推送',
  workflow: 'manual-estimate-push.yml',
  cadence: '人工应急',
  staleHours: 72,
}

const NOW = Date.parse('2026-07-04T08:00:00Z')

describe('normalizeTaskStatus', () => {
  it('成功且未过期为 ok', () => {
    const s = normalizeTaskStatus(cfg, {
      status: 'completed',
      conclusion: 'success',
      updated_at: '2026-07-04T07:30:00Z',
      html_url: 'https://example.test/run',
    }, NOW)
    expect(s.ok).toBe(true)
    expect(s.stale).toBe(false)
    expect(s.ageMinutes).toBe(30)
    expect(s.note).toBe('最近成功')
  })

  it('成功但超过 staleHours 标记过期', () => {
    const s = normalizeTaskStatus(cfg, {
      status: 'completed',
      conclusion: 'success',
      updated_at: '2026-06-30T07:30:00Z',
    }, NOW)
    expect(s.ok).toBe(false)
    expect(s.stale).toBe(true)
    expect(s.note).toBe('最近成功，但可能过期')
  })

  it('失败结论不是 ok', () => {
    const s = normalizeTaskStatus(cfg, {
      status: 'completed',
      conclusion: 'failure',
      updated_at: '2026-07-04T07:50:00Z',
    }, NOW)
    expect(s.ok).toBe(false)
    expect(s.stale).toBe(false)
    expect(s.note).toBe('最近failure')
  })

  it('无运行记录返回 unknown', () => {
    const s = normalizeTaskStatus(cfg, null, NOW)
    expect(s.status).toBe('unknown')
    expect(s.ok).toBe(false)
    expect(s.stale).toBe(true)
    expect(s.note).toBe('暂无运行记录')
  })

  it('人工工作流不因长时间未运行而误报过期', () => {
    const manual = { ...cfg, staleHours: 0, manual: true }
    const s = normalizeTaskStatus(manual, null, NOW)
    expect(s.stale).toBe(false)
    expect(s.note).toBe('按需手动运行')
  })

  it('current manual contract queries workflow_dispatch instead of old schedules', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ workflow_runs: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    const { fetchTaskStatuses } = await import('./taskStatus')

    await fetchTaskStatuses(true)

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.find((url) => url.includes('manual-estimate-push.yml'))).toContain('event=workflow_dispatch')
    expect(urls.find((url) => url.includes('notify.yml'))).toContain('event=workflow_dispatch')
    expect(urls.some((url) => url.includes('calibrate-strategy.yml'))).toBe(true)
    expect(urls.some((url) => url.includes('fund-universe.yml'))).toBe(true)
    expect(urls.some((url) => url.includes('ci.yml'))).toBe(true)
    expect(urls.some((url) => url.includes('deploy.yml'))).toBe(false)
    expect(urls.some((url) => url.includes('post-deploy-smoke.yml'))).toBe(false)
    for (const workflow of [
      'enrich-holdings.yml', 'enrich-managers.yml', 'calibrate-strategy.yml',
      'fund-universe.yml', 'overseas-accuracy.yml',
    ]) {
      expect(urls.find((url) => url.includes(workflow))).toContain('event=schedule')
    }
    expect(urls.find((url) => url.includes('ci.yml'))).not.toContain('event=')
    vi.unstubAllGlobals()
  })
})
