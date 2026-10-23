import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { applySpec, parseSpecOutput, specSummary, validateSpec } from './nlselect'
import type { ScreenFund } from './screener'

const row = (code: string, value: number | null): ScreenFund => ({
  c: code, n: '合成基金', t: '混合型', r1m: value, r3m: value, r6m: value,
  r1y: value, r3y: value, ytd: value, fee: value == null ? null : 0,
})

describe('strict proposed filter contract', () => {
  it('keeps the frozen schema enums and numeric limits aligned with runtime validation', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../contracts/nl-filter-spec-v1.json', import.meta.url), 'utf8'))
    expect(Object.keys(schema.properties).sort()).toEqual([
      'type', 'r1m_min', 'r3m_min', 'r6m_min', 'r1y_min', 'r3y_min', 'ytd_min', 'fee_max', 'sort', 'unsupported',
    ].sort())
    for (const type of schema.properties.type.enum) expect(validateSpec({ type })).toEqual({ type })
    for (const sort of schema.properties.sort.enum) expect(validateSpec({ sort })).toEqual({ sort })
    for (const field of ['r1m_min', 'r3m_min', 'r6m_min', 'r1y_min', 'r3y_min', 'ytd_min']) {
      const { minimum, maximum } = schema.$defs.return_threshold
      expect(validateSpec({ [field]: minimum })[field as 'r1m_min']).toBe(minimum)
      expect(validateSpec({ [field]: maximum })[field as 'r1m_min']).toBe(maximum)
      expect(() => validateSpec({ [field]: minimum - 1 })).toThrow()
      expect(() => validateSpec({ [field]: maximum + 1 })).toThrow()
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.fee_max).toMatchObject({ minimum: 0, maximum: 100 })
  })
  it.each(['股票型', '混合型', '债券型', '指数型', 'QDII', 'FOF'])('accepts supported type %s', type => {
    expect(parseSpecOutput(JSON.stringify({ type }))).toEqual({ type })
  })
  it.each(['r1m', 'r3m', 'r6m', 'r1y', 'r3y', 'ytd', 'fee'])('accepts and summarizes actual sort %s', sort => {
    const spec = parseSpecOutput(JSON.stringify({ sort }))
    expect(specSummary(spec).join('')).not.toContain(sort)
  })
  it('accepts finite boundary thresholds and real zero without normalization', () => {
    expect(validateSpec({ r1m_min: -100, r3y_min: 100_000, fee_max: 0 })).toEqual({ r1m_min: -100, r3y_min: 100_000, fee_max: 0 })
    expect(parseSpecOutput('{"type":null,"sort":"r1y","unsupported":["最大回撤"]}').unsupported).toEqual(['最大回撤'])
  })
  it.each([
    '{}', '[]', 'null', '{"type":"货币型"}', '{"type":42}', '{"sort":"score"}',
    '{"r1y_min":"15"}', '{"r1y_min":true}', '{"r1y_min":null}', '{"r1y_min":1e999}',
    '{"r1m_min":-100.001}', '{"r3y_min":100001}', '{"fee_max":-1}', '{"fee_max":100.1}',
    '{"fee_max":{}}', '{"max_drawdown":5}', '{"__proto__":{}}', '{"constructor":"x"}',
    '{"unsupported":null}', '{"unsupported":"规模"}', '{"unsupported":[1]}', '{"unsupported":[""]}',
    '解释：{"sort":"r1y"}', '```json\n{"sort":"r1y"}\n```', '{"sort":"r1y"} {"sort":"fee"}',
    '{"sort":"fee","sort":"r1y"}', '{"sort":"fee","\\u0073ort":"r1y"}',
  ])('rejects model output without silently dropping/coercing %#', output => {
    expect(() => parseSpecOutput(output)).toThrow('AI 筛选条件无效')
  })
  it('does not mistake punctuation/escaped quotes inside unsupported text for keys', () => {
    const spec = { sort: 'fee', unsupported: ['含有 "sort": {以及逗号,} 的未知条件'] }
    expect(parseSpecOutput(JSON.stringify(spec))).toEqual(spec)
  })
  it('bounds output and unsupported entries', () => {
    expect(() => parseSpecOutput(' '.repeat(4097))).toThrow()
    expect(() => validateSpec({ unsupported: Array(21).fill('规模') })).toThrow()
    expect(() => validateSpec({ unsupported: ['x'.repeat(101)] })).toThrow()
  })
})

describe('local execution never invents fund data', () => {
  it('filters a zero threshold with null distinct from zero and does not mutate inputs', () => {
    const rows = [row('000001', null), row('000002', 0), row('000003', -1), row('000004', 2)]
    expect(applySpec(rows, { r1y_min: 0, sort: 'r1y' }).map(fund => fund.c)).toEqual(['000004', '000002'])
    expect(rows.map(fund => fund.c)).toEqual(['000001', '000002', '000003', '000004'])
    expect(applySpec(rows, { sort: 'fee' }).at(-1)?.c).toBe('000001')
  })
  it('never partially executes unsupported or unknown conditions', () => {
    expect(() => applySpec([row('000001', 10)], { r1y_min: 0, unsupported: ['规模'] })).toThrow('未执行筛选')
    expect(() => applySpec([], { sort: 'evil' } as never)).toThrow()
    expect(() => applySpec([], { type: null, unsupported: [] })).toThrow('未提供可执行条件')
  })
})
