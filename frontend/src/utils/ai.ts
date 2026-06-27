// AI Provider 抽象（V3）。统一多家大模型的浏览器直连调用，可切换、易扩展。
// 形态：'openai'（/chat/completions，Bearer）兼容 DeepSeek/OpenAI/Qwen/Gemini/Kimi；
//       'anthropic'（/v1/messages，x-api-key + dangerous-direct-browser-access）。
// 已实测 DeepSeek/OpenAI/Qwen 均放行浏览器 CORS，故前端直连，无需后端代理。
// 用户自带 Key 存本机 localStorage；后续加新 Provider 只需往 PROVIDERS 添一项。

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

const CFG_KEY = 'sinan_ai_cfg'
const OLD_KEY = 'sinan_ai_key' // V2-5 旧版只存 Anthropic key，做迁移

export function providerDef(id: ProviderId): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0]
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) {
      const c = JSON.parse(raw) as Partial<AiConfig>
      return { provider: c.provider || 'deepseek', apiKey: c.apiKey || '', baseUrl: c.baseUrl || '', model: c.model || '' }
    }
    const old = localStorage.getItem(OLD_KEY)
    if (old) return { provider: 'anthropic', apiKey: old, baseUrl: '', model: '' }
  } catch { /* ignore */ }
  return { provider: 'deepseek', apiKey: '', baseUrl: '', model: '' }
}

export function setAiConfig(c: AiConfig): void {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)) } catch { /* ignore */ }
}

export const hasAiKey = (): boolean => !!getAiConfig().apiKey

// 统一对话：system + user → 文本。按当前 Provider 形态分流。
export async function chat(system: string, user: string): Promise<string> {
  const cfg = getAiConfig()
  if (!cfg.apiKey) throw new Error('未配置 AI Key')
  const d = providerDef(cfg.provider)
  const baseUrl = (cfg.baseUrl || d.baseUrl).replace(/\/+$/, '')
  const model = cfg.model || d.model
  if (!baseUrl || !model) throw new Error('请填写 Base URL 与 Model')
  return d.shape === 'anthropic'
    ? callAnthropic(baseUrl, cfg.apiKey, model, system, user)
    : callOpenAI(baseUrl, cfg.apiKey, model, system, user)
}

interface OpenAiResp { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
async function callOpenAI(baseUrl: string, key: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 700, temperature: 0.4,
    }),
  })
  const j = (await res.json().catch(() => ({}))) as OpenAiResp
  if (!res.ok) throw new Error(`API ${res.status}：${j.error?.message || '调用失败，检查 Key / Base URL / Model / 余额'}`)
  const t = j.choices?.[0]?.message?.content?.trim()
  if (!t) throw new Error('返回为空')
  return t
}

interface AnthropicResp { content?: { type: string; text?: string }[]; error?: { message?: string } }
async function callAnthropic(baseUrl: string, key: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': key,
      'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
  })
  const j = (await res.json().catch(() => ({}))) as AnthropicResp
  if (!res.ok) throw new Error(`API ${res.status}：${j.error?.message || '调用失败'}`)
  const t = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim()
  if (!t) throw new Error('返回为空')
  return t
}
