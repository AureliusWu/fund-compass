import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { assertDeploymentToolchainSecurity, buildWranglerArgs, normalizeGitSha } from './deploy.mjs'

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

  it('does not equate a clean registry audit with a safe bundled CLI', () => {
    expect(assertDeploymentToolchainSecurity).toThrow('GHSA-xjj6-f33q-929c')
    expect(assertDeploymentToolchainSecurity).toThrow('GHSA-2m5v-pch6-74hx')
  })

  it('blocks the real entry point before Git identity or Wrangler startup', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./deploy.mjs', import.meta.url))], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Worker deployment blocked: Wrangler bundles unpatched Undici')
    expect(result.stderr).not.toContain('dirty worktree')
  })
})
