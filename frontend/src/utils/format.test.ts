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
  it('涨走 --danger', () => expect(colorOf(1)).toBe('var(--danger)'))
  it('跌走 --success', () => expect(colorOf(-1)).toBe('var(--success)'))
  it('零/空走 --text-muted', () => {
    expect(colorOf(0)).toBe('var(--text-muted)')
    expect(colorOf(null)).toBe('var(--text-muted)')
  })
})

describe('signalColor', () => {
  it('买入走 --danger', () => expect(signalColor('买入')).toBe('var(--danger)'))
  it('定投走 --warn', () => expect(signalColor('定投')).toBe('var(--warn)'))
  it('减仓走 --success', () => expect(signalColor('减仓')).toBe('var(--success)'))
  it('持有走 --text-muted', () => expect(signalColor('持有')).toBe('var(--text-muted)'))
})

describe('stars', () => {
  it('3 星', () => expect(stars(3)).toBe('★★★☆☆'))
  it('满星', () => expect(stars(5)).toBe('★★★★★'))
  it('空值/0 全空星', () => {
    expect(stars(null)).toBe('☆☆☆☆☆')
    expect(stars(0)).toBe('☆☆☆☆☆')
  })
})
