import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeWorkerRuntime, type WorkerHealth } from '@/api/client'

describe('operations worker degradation visibility', () => {
  it('renders the latest Worker warning with warning styling', () => {
    const source = readFileSync(new URL('./OperationsPage.vue', import.meta.url), 'utf8')
    expect(source).toContain('worker?.runtime?.last_warning')
    expect(source).toContain('class="warn-text"')
    expect(source).toContain('worker?.runtime?.decision_status')
  })

  it('separates cron entry, cron outcome and actual send attempts with legacy fallbacks', () => {
    const source = readFileSync(new URL('./OperationsPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain('<span>最近调度</span>')
    expect(source).toContain('<span>调度结果</span>')
    expect(source).toContain('<span>发送尝试</span>')
    expect(source).toContain('normalizeWorkerRuntime(worker.value?.runtime)')
    expect(source).toContain('normalizedWorkerRuntime.value.lastCronResult')
    expect(source).toContain('normalizedWorkerRuntime.value.lastAttemptAt')
  })

  it('accepts the typed Worker cron health contract', () => {
    const health: WorkerHealth = {
      status: 'ok',
      service: 'sinan-estimate-push',
      version: '6.0.6',
      runtime: {
        last_cron_at: '2026-08-09T14:30:00+08:00',
        last_cron_result: 'skipped',
        last_cron_reason: 'weekend',
        last_attempt_at: null,
      },
    }

    expect(health.runtime?.last_cron_result).toBe('skipped')
    expect(health.runtime?.last_cron_reason).toBe('weekend')
    expect(health.runtime?.last_attempt_at).toBeNull()
  })

  it('falls back only for absent legacy fields and preserves explicit nulls', () => {
    expect(normalizeWorkerRuntime({
      last_cron_at: '2026-07-23T14:40:07+08:00',
      last_result: 'failed',
    })).toEqual({
      lastCronAt: '2026-07-23T14:40:07+08:00',
      lastCronResult: 'failed',
      lastCronReason: null,
      lastAttemptAt: '2026-07-23T14:40:07+08:00',
      legacyCronContract: true,
    })

    expect(normalizeWorkerRuntime({
      last_cron_at: null,
      last_cron_result: null,
      last_cron_reason: null,
      last_attempt_at: '2026-08-08T14:30:00+08:00',
      last_result: 'failed',
    })).toEqual({
      lastCronAt: null,
      lastCronResult: null,
      lastCronReason: null,
      lastAttemptAt: '2026-08-08T14:30:00+08:00',
      legacyCronContract: false,
    })

    expect(normalizeWorkerRuntime({
      last_attempt_at: '2026-08-08T14:30:00+08:00',
      last_result: 'sent',
    }).lastCronAt).toBe('2026-08-08T14:30:00+08:00')
  })

  it('declares the PWA language as Simplified Chinese', () => {
    const source = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain("lang: 'zh-CN'")
  })

  it('keeps API responses out of the service worker cache', () => {
    const source = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain("url.pathname.startsWith('/api')")
    expect(source).toContain("handler: 'NetworkOnly'")
  })
})
