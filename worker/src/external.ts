export type ExternalFailureReason =
  | 'network_timeout'
  | 'network_error'
  | 'http_4xx'
  | 'http_429'
  | 'http_5xx'
  | 'response_too_large'
  | 'json_invalid'
  | 'schema_invalid'
  | 'upstream_empty'
  | 'request_budget_exhausted'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BODY_BYTES = 2_000_000

export class ExternalDataError extends Error {
  constructor(
    readonly reason: ExternalFailureReason,
    readonly status: number | null = null,
  ) {
    super(reason)
    this.name = 'ExternalDataError'
  }
}

export interface ExternalRequestBudget {
  readonly limit: number
  remaining: number
  used: number
}

export function createExternalRequestBudget(limit: number): ExternalRequestBudget {
  const normalized = Math.max(0, Math.floor(Number(limit) || 0))
  return { limit: normalized, remaining: normalized, used: 0 }
}

function consumeRequestBudget(budget: ExternalRequestBudget | undefined): void {
  if (!budget) return
  if (budget.remaining <= 0) throw new ExternalDataError('request_budget_exhausted')
  budget.remaining -= 1
  budget.used += 1
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function networkFailure(error: unknown): ExternalDataError {
  if (error instanceof ExternalDataError) return error
  const name = error instanceof Error ? error.name : ''
  return new ExternalDataError(
    name === 'AbortError' || name === 'TimeoutError' ? 'network_timeout' : 'network_error',
  )
}

/**
 * Bounded idempotent GET. Only network failures, 429 and 5xx receive one retry.
 * Error messages are stable reason codes so upstream URLs, response bodies and
 * credentials cannot leak into public responses or persisted runtime state.
 */
export async function externalGet(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number; budget?: ExternalRequestBudget } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? 1
  let lastError: ExternalDataError | null = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // Synchronous consumption is isolate-concurrency safe: every actual
      // fetch attempt, including retries, owns a slot before it can yield.
      consumeRequestBudget(options.budget)
      const response = await fetch(url, {
        ...init,
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok) return response
      const reason: ExternalFailureReason = response.status === 429
        ? 'http_429'
        : response.status >= 500
          ? 'http_5xx'
          : 'http_4xx'
      lastError = new ExternalDataError(reason, response.status)
      await response.body?.cancel().catch(() => undefined)
      if (!isRetryableStatus(response.status) || attempt >= retries) throw lastError
    } catch (error) {
      lastError = networkFailure(error)
      if (lastError.reason === 'request_budget_exhausted') throw lastError
      if (lastError.status != null || attempt >= retries) throw lastError
    }
  }
  throw lastError || new ExternalDataError('network_error')
}

export async function readBoundedText(
  response: Response,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ExternalDataError('response_too_large', response.status)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBodyBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ExternalDataError('response_too_large', response.status)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function readJson(
  response: Response,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const text = await readBoundedText(response, maxBodyBytes)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ExternalDataError('json_invalid', response.status)
  }
}

export function stableFailureReason(error: unknown): string {
  return error instanceof ExternalDataError ? error.reason : 'upstream_error'
}
