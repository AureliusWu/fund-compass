import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/
const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(args) {
  const result = spawnSync('git', args, {
    cwd: workerRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return String(result.stdout).trim()
}

export function normalizeGitSha(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!FULL_GIT_SHA_RE.test(normalized)) {
    throw new Error('Worker deployment requires a full 40-character Git commit SHA')
  }
  return normalized
}

export function buildWranglerArgs(sha) {
  const normalized = normalizeGitSha(sha)
  return [
    'deploy',
    '--define',
    `WORKER_BUILD_SHA:${JSON.stringify(normalized)}`,
  ]
}

export function deploymentIdentity() {
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'])
  if (dirty) {
    throw new Error('Refusing to deploy a dirty worktree: commit the complete release source first')
  }
  return normalizeGitSha(git(['rev-parse', '--verify', 'HEAD^{commit}']))
}

function main() {
  if (process.argv.length > 2) {
    throw new Error('Worker deploy wrapper does not accept pass-through arguments')
  }
  const sha = deploymentIdentity()
  const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const result = spawnSync(process.execPath, [wranglerBin, ...buildWranglerArgs(sha)], {
    cwd: workerRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error(`Wrangler terminated by ${result.signal}`)
  process.exitCode = result.status ?? 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
