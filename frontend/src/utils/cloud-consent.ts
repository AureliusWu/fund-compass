// Legacy PAT sync is a separate, explicit opt-in. Saving a credential is not consent.
const CONSENT_KEY = 'sinan_legacy_sync_consent_v1'
const TOKEN_KEY = 'sinan_gist_token'
type Subscriber = (consent: boolean, generation: number) => void
const subscribers = new Set<Subscriber>()
let generation = 0
let currentStorage: Storage | null | undefined
let currentRaw: string | null = null
let enabled = false
let localRevoke = false
let listeningWindow: Window | undefined

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
function parse(raw: string | null): boolean {
  try { return JSON.parse(raw || 'null')?.enabled === true } catch { return false }
}
function publish() {
  for (const listener of [...subscribers]) { try { listener(enabled, generation) } catch { /* one UI subscriber cannot prevent cancellation */ } }
}
function observe() {
  const target = storage()
  let raw: string | null = null
  try { raw = target?.getItem(CONSENT_KEY) ?? null } catch { /* unavailable means no consent */ }
  if (target !== currentStorage || raw !== currentRaw) {
    if (target !== currentStorage) localRevoke = false
    currentStorage = target; currentRaw = raw; enabled = parse(raw) && !localRevoke; generation++
    publish()
  }
  if (typeof window !== 'undefined' && window !== listeningWindow) {
    listeningWindow?.removeEventListener('storage', storageChanged)
    window.addEventListener('storage', storageChanged)
    listeningWindow = window
  }
}
function storageChanged(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== storage()) return
  if (event.key === TOKEN_KEY || event.key === null) {
    revokeFromStorage()
  } else if (event.key === CONSENT_KEY) {
    // A revocation is effective immediately, even if another write races it.
    if (!parse(event.newValue)) revokeFromStorage()
    else observe()
  }
}
function revokeFromStorage() {
  // Storage events already describe another tab's write. Never echo a new
  // revision back to disk: two tabs would otherwise revoke each other forever.
  const target = storage()
  let raw: string | null = null
  try { raw = target?.getItem(CONSENT_KEY) ?? null } catch { /* unavailable remains revoked */ }
  currentStorage = target; currentRaw = raw; enabled = false; localRevoke = true
  generation++
  publish()
}

export function getLegacySyncConsent(): boolean { observe(); return enabled }
export function getLegacySyncGeneration(): number { observe(); return generation }
export function setLegacySyncConsent(value: boolean): void {
  observe()
  const target = storage()
  const raw = JSON.stringify({ enabled: value === true, revision: `${Date.now()}:${generation + 1}` })
  let saved = false
  try { target?.setItem(CONSENT_KEY, raw); saved = target?.getItem(CONSENT_KEY) === raw } catch { /* fail closed */ }
  localRevoke = !saved || value !== true
  currentStorage = target; currentRaw = saved ? raw : null; enabled = saved && value === true
  if (!saved) { try { target?.removeItem(CONSENT_KEY) } catch { /* no cloud activity allowed */ } }
  generation++
  publish()
}
export function subscribeLegacySyncConsent(callback: Subscriber): () => void {
  observe(); subscribers.add(callback)
  return () => subscribers.delete(callback)
}
