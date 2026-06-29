import { describe, expect, it } from 'vitest'

import { colorOf, num, pct, signalColor, stars } from './format'

describe('pct', () => {
  it('正数带正号', () => expect(pct(1.234)).toBe('+1.23%'))
  it('负数', () => expect(pct(-2.5)).toBe('-2.50%'))
  it('零按非负处理', () => expect(pct(0)).toBe('+0.00%'))
  it('自定义小数位', () => expect(pct(1.2, 1)).toBe('+1.2%'))
  it('空值/NaN → --', () => {
    expect(pct(null)).toBe('--')
    expect(pct(undefined)).toBe('--')
    expect(pct(NaN)).toBe('--')
  })
})

describe('num', () => {
  it('默认 4 位', () => expect(num(1.5)).toBe('1.5000'))
  it('自定义位数', () => expect(num(1.23456, 2)).toBe('1.23'))
  it('空值 → --', () => expect(num(null)).toBe('--'))
})

describe('colorOf', () => {
  it('涨为红', () => expect(colorOf(1)).toBe('#ee0a24'))
  it('跌为绿', () => expect(colorOf(-1)).toBe('#07c160'))
  it('零/空为中性变量', () => {
    expect(colorOf(0)).toContain('var(')
    expect(colorOf(null)).toContain('var(')
  })
})

describe('signalColor', () => {
  it('买入红', () => expect(signalColor('买入')).toBe('#ee0a24'))
  it('定投橙', () => expect(signalColor('定投')).toBe('#ff976a'))
  it('减仓绿', () => expect(signalColor('减仓')).toBe('#07c160'))
  it('其他（持有等）灰', () => expect(signalColor('持有')).toBe('#969799'))
})

describe('stars', () => {
  it('3 星', () => expect(stars(3)).toBe('★★★☆☆'))
  it('满星', () => expect(stars(5)).toBe('★★★★★'))
  it('空值/0 全空星', () => {
    expect(stars(null)).toBe('☆☆☆☆☆')
    expect(stars(0)).toBe('☆☆☆☆☆')
  })
})
