import { ApiError } from '@/api/request'

export const STATIC_CHUNK_CONCURRENCY = 6

/** Preserve manifest order while bounding each loader's active chunk work.
 * The caller owns the whole-loader deadline and aborts its active requests.
 */
export async function mapStaticCollection<T, R>(
  items: readonly T[],
  signal: AbortSignal,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (signal.aborted) throw new ApiError('请求已取消', 'cancelled')
  const results = new Array<R>(items.length)
  let next = 0
  let stopped = false
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      stopped = true
      reject(new ApiError('请求已取消', 'cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

  async function worker() {
    while (!stopped && !signal.aborted && next < items.length) {
      const index = next++
      try {
        results[index] = await map(items[index], index)
      } catch (error) {
        // Set this before propagating failure so siblings cannot dequeue more.
        stopped = true
        throw error
      }
    }
  }

  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(STATIC_CHUNK_CONCURRENCY, items.length) }, worker)),
      cancelled,
    ])
    if (signal.aborted) throw new ApiError('请求已取消', 'cancelled')
    return results
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
