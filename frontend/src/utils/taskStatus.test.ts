import { describe, expect, it } from 'vitest'

import { normalizeTaskStatus, type TaskConfig } from './taskStatus'

const cfg: TaskConfig = {
  id: 'estimate-push',
  label: '估值推送',
  workflow: 'estimate-push.yml',
  cadence: '交易日 14:30',
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
})
