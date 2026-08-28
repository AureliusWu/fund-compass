import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./WatchlistPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('自选页 V8 快照契约', () => {
  it('只读 V8 快照与差异，不用 legacy 信号伪装', () => {
    expect(source).toContain('getV8Decision(item.code)')
    expect(source).toContain('getV8DecisionDiff(item.code)')
    expect(source).not.toContain('getDecision(item.code)')
    expect(source).toContain("message: kind === 'decision' ? '尚未生成 V8 决策快照'")
  })

  it('保留本地首屏与逐只渐进写入契约', () => {
    expect(source).toContain('hydrateLocal()\nonMounted(refresh)')
    expect(source).toContain('Promise.allSettled([refreshItems(localItems), watch.load(true)])')
    expect(source).toContain('await Promise.allSettled(items.map(async (item) => {')
    expect(source).toContain('decisions[decision.code] = decision')
    expect(source).toContain('getV8Decision(item.code).then((decision) => {')
    expect(source.indexOf('decisions[decision.code] = decision')).toBeLessThan(source.indexOf('await Promise.allSettled([decisionTask, diffTask])'))
    expect(source).toContain('type: current?.type ?? null')
  })

  it('失败会清除旧快照并保留 null，不用 0 兜底', () => {
    expect(source).toContain('const activeCodes = new Set(watch.items.map((item) => item.code))')
    expect(source).toContain('delete decisions[item.code]')
    expect(source).toContain("decisionLoadStates[item.code] = failedLoadState(error, 'decision')")
    expect(source).not.toMatch(/(?:confidence|strength|change)\s*(?:\|\||\?\?)\s*0/)
  })

  it('明确区分 QDII 下一净值估算与正式净值涨跌', () => {
    expect(source).toContain('watchEstimateCaption(typeOrName, estimate)')
    expect(source).toContain('watchEstimateSemanticLabel(rows[code]?.type || rows[code]?.name, estimate)')
    expect(source).toContain('QDII 的最新正式净值与下一净值估算分开标注')
  })
})
