import { describe, expect, it } from 'vitest'

import { buildWranglerArgs, normalizeGitSha } from './deploy.mjs'

const sha = '0123456789abcdef0123456789abcdef01234567'

describe('Worker deployment identity', () => {
  it('accepts only a complete Git commit SHA', () => {
    expect(normalizeGitSha(sha.toUpperCase())).toBe(sha)
    expect(() => normalizeGitSha('0123456')).toThrow('full 40-character')
    expect(() => normalizeGitSha('g'.repeat(40))).toThrow('full 40-character')
  })

  it('injects the exact SHA as an esbuild string definition', () => {
    expect(buildWranglerArgs(sha)).toEqual([
      'deploy',
      '--define',
      `WORKER_BUILD_SHA:${JSON.stringify(sha)}`,
    ])
  })
})
