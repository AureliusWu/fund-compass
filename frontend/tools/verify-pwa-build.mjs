import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const read = (name) => readFileSync(resolve(dist, name), 'utf8')
const index = read('index.html')
const registrar = read('registerSW.js')
const worker = read('sw.js')

const checks = [
  ['index references one same-origin registrar',
    (index.match(/src="\/fund-compass\/registerSW\.js"/g) || []).length === 1],
  ['registrar bypasses HTTP cache for worker updates', registrar.includes("updateViaCache: 'none'")],
  ['registrar forces an immediate update check', registrar.includes('registration.update()')],
  ['registrar guards controller reloads',
    registrar.includes("navigator.serviceWorker.addEventListener('controllerchange'")
      && registrar.includes('fund-compass:sw-controller-reload-at')],
  ['worker activates without waiting', /self\.skipWaiting\(\)/.test(worker)],
  ['worker claims existing clients', /\.clientsClaim\(\)/.test(worker)],
  ['runtime data cache is schema-versioned', worker.includes('cacheName:"fc-data-v8"')],
]

const failed = checks.filter(([, passed]) => !passed).map(([label]) => label)
if (failed.length) {
  console.error(`PWA build verification failed: ${failed.join('; ')}`)
  process.exit(1)
}

console.log(`PWA build verification passed (${checks.length}/${checks.length})`)
