// AI Provider 抽象（V3）。统一多家大模型的浏览器直连调用，可切换、易扩展。
// 形态：'openai'（/chat/completions，Bearer）兼容 DeepSeek/OpenAI/Qwen/Gemini/Kimi；
//       'anthropic'（/v1/messages，x-api-key + dangerous-direct-browser-access）。
// 浏览器直连是否可用以当前服务的 CORS/账户配置为准；不自动重试收费请求。
// 用户自带 Key 存本机 localStorage；后续加新 Provider 只需往 PROVIDERS 添一项。
import { ApiError, fetchWithDeadline } from '@/api/request'

export type ProviderId = 'deepseek' | 'qwen' | 'openai' | 'gemini' | 'moonshot' | 'anthropic' | 'custom'

export interface ProviderDef {
  id: ProviderId
  label: string
  shape: 'openai' | 'anthropic'
  baseUrl: string // 默认 Base URL
  model: string // 默认模型
  keyHint: string
  getKeyUrl?: string
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'deepseek', label: 'DeepSeek', shape: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyHint: 'sk-...', getKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', label: '通义千问 Qwen', shape: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyHint: 'sk-...', getKeyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'openai', label: 'OpenAI', shape: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHint: 'sk-...', getKeyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', label: 'Gemini', shape: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', keyHint: 'AIza...', getKeyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'moonshot', label: 'Kimi（Moonshot）', shape: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyHint: 'sk-...', getKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'anthropic', label: 'Claude（Anthropic）', shape: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', keyHint: 'sk-ant-...', getKeyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', shape: 'openai', baseUrl: '', model: '', keyHint: 'sk-...' },
]

export interface AiConfig { provider: ProviderId; apiKey: string; baseUrl: string; model: string }
export interface AiRequestOptions { signal?: AbortSignal }
export const AI_TIMEOUT_MS = 30_000
export const FREE_TEXT_AI_UNAVAILABLE = '自由文本 AI 解读暂不可用：尚不能可靠核验数字和动作，请使用规则解读。'
const EMPTY_CONFIG: AiConfig = { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' }

const CFG_KEY = 'sinan_ai_cfg'
const OLD_KEY = 'sinan_ai_key' // V2-5 旧版只存 Anthropic key，做迁移

export function providerDef(id: ProviderId): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0]
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) {
      const c: unknown = JSON.parse(raw)
      if (!c || typeof c !== 'object' || Array.isArray(c)) return { ...EMPTY_CONFIG }
      const row = c as Record<string, unknown>
      if (!PROVIDERS.some(provider => provider.id === row.provider)
        || !['apiKey', 'baseUrl', 'model'].every(field => typeof row[field] === 'string')) return { ...EMPTY_CONFIG }
      return { provider: row.provider as ProviderId, apiKey: row.apiKey as string, baseUrl: row.baseUrl as string, model: row.model as string }
    }
    const old = localStorage.getItem(OLD_KEY)
    if (old) return { provider: 'anthropic', apiKey: old, baseUrl: '', model: '' }
  } catch { /* ignore */ }
  return { ...EMPTY_CONFIG }
}

export function setAiConfig(c: AiConfig): void {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)) } catch { /* ignore */ }
}

export const hasAiKey = (): boolean => !!getAiConfig().apiKey

// 统一对话：system + user → 文本。按当前 Provider 形态分流。
export async function chat(system: string, user: string, options: AiRequestOptions = {}): Promise<string> {
  const cfg = getAiConfig()
  if (!cfg.apiKey) throw new Error('未配置 AI Key')
  const d = providerDef(cfg.provider)
  const baseUrl = (cfg.baseUrl || d.baseUrl).replace(/\/+$/, '')
  const model = cfg.model || d.model
  if (!baseUrl || !model) throw new Error('请填写 Base URL 与 Model')
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe')
  } catch { throw new Error('AI Base URL 必须是无凭据、查询参数或片段的 HTTPS 地址') }
  return d.shape === 'anthropic'
    ? callAnthropic(baseUrl, cfg.apiKey, model, system, user, options)
    : callOpenAI(baseUrl, cfg.apiKey, model, system, user, options)
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function aiJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    return await fetchWithDeadline(url, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error' }, async (response, signal) => {
      const raw = await readAiBody(response, signal)
      return JSON.parse(raw) as unknown
    }, AI_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http') {
      // Never echo an upstream body: it can contain the prompt, key or private data.
      throw new ApiError(`AI API HTTP ${error.status}，请检查配置或账户状态；未自动重试`, 'http', error.status)
    }
    throw error
  }
}

async function readAiBody(response: Response, signal: AbortSignal): Promise<string> {
  // Enforce the byte limit while streaming, not after allocating an arbitrary
  // provider response. text() remains a bounded fallback for body-less mocks.
  if (!response.body) {
    const raw = await response.text()
    if (new TextEncoder().encode(raw).byteLength > 65_536) throw new Error('oversized')
    return raw
  }
  const reader = response.body.getReader()
  const stop = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return text + decoder.decode()
      size += part.value.byteLength
      if (size > 65_536) throw new Error('oversized')
      text += decoder.decode(part.value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', stop)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function textResult(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) throw new Error('AI 返回格式无效或为空')
  return value.trim()
}

async function callOpenAI(baseUrl: string, key: string, model: string, system: string, user: string, options: AiRequestOptions): Promise<string> {
  const j = await aiJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: options.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 700, temperature: 0.4,
    }),
  })
  if (!object(j) || !Array.isArray(j.choices) || !object(j.choices[0]) || !object(j.choices[0].message)) {
    throw new Error('AI 返回格式无效或为空')
  }
  return textResult(j.choices[0].message.content)
}

async function callAnthropic(baseUrl: string, key: string, model: string, system: string, user: string, options: AiRequestOptions): Promise<string> {
  const j = await aiJson(`${baseUrl}/v1/messages`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'content-type': 'application/json', 'x-api-key': key,
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!object(j) || !Array.isArray(j.content) || !j.content.length || j.content.length > 32
    || !j.content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string')) {
    throw new Error('AI 返回格式无效或为空')
  }
  return textResult(j.content.map(block => block.text).join(''))
}
