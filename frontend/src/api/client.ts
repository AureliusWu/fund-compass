// 后端基址：开发走 Vite 代理 /api → localhost:8000；
// 生产可用环境变量 VITE_API_BASE 指向已部署的后端（Railway/Render）。
const BASE = (import.meta.env.VITE_API_BASE as string) || '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json() as Promise<T>
}

export interface Health {
  status: string
  service: string
  version: string
}

export function getHealth() {
  return request<Health>('/health')
}
