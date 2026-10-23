/** Explicit Owner analysis transport. Construction hashes only the configured
 * API endpoint; it never opens storage, authenticates or issues a request. */
import type { BuiltOwnerAnalysisRequest } from '@/utils/ownerAnalysisContract'
import { getOwnerSyncTargetFingerprint, requestOwnerAnalysis, type OwnerAnalysisHttpResponse } from '@/stores/ownerSession'

export interface OwnerAnalysisTransport {
  readonly targetFingerprint: string
  write(packet: BuiltOwnerAnalysisRequest, signal: AbortSignal): Promise<OwnerAnalysisHttpResponse>
  receipt(packet: BuiltOwnerAnalysisRequest, signal: AbortSignal): Promise<OwnerAnalysisHttpResponse>
  policy(signal: AbortSignal): Promise<OwnerAnalysisHttpResponse>
  policyState(signal: AbortSignal): Promise<OwnerAnalysisHttpResponse>
  evidence(code: string, signal: AbortSignal): Promise<OwnerAnalysisHttpResponse>
}

export async function createOwnerAnalysisHttpTransport(): Promise<OwnerAnalysisTransport> {
  const targetFingerprint = await getOwnerSyncTargetFingerprint()
  return Object.freeze({
    targetFingerprint,
    write(packet, signal) { return requestOwnerAnalysis({ kind: 'write', packet }, signal, targetFingerprint) },
    receipt(packet, signal) { return requestOwnerAnalysis({ kind: 'receipt', packet }, signal, targetFingerprint) },
    policy(signal) { return requestOwnerAnalysis({ kind: 'policy' }, signal, targetFingerprint) },
    policyState(signal) { return requestOwnerAnalysis({ kind: 'policy_state' }, signal, targetFingerprint) },
    evidence(code, signal) { return requestOwnerAnalysis({ kind: 'evidence', code }, signal, targetFingerprint) },
  } satisfies OwnerAnalysisTransport)
}
