/** Explicit HTTP adapter for the existing opt-in controller. Constructing it
 * performs only endpoint hashing; no request, storage or candidate is started.
 * A fingerprint identifies the configured API endpoint, not a cloud database
 * or its migration/durability state. Token handling stays inside ownerSession.
 */
import type { OwnerSyncCandidateTransport } from '@/stores/ownerSyncCandidate'
import { getOwnerSyncTargetFingerprint, requestOwnerSync } from '@/stores/ownerSession'

export async function createOwnerSyncHttpTransport(): Promise<OwnerSyncCandidateTransport> {
  const targetFingerprint = await getOwnerSyncTargetFingerprint()
  return Object.freeze({
    targetFingerprint,
    write(packet, signal) {
      return requestOwnerSync({ kind: 'write', packet }, signal, targetFingerprint)
    },
    receipt(requestId, requestHash, signal) {
      return requestOwnerSync({ kind: 'receipt', requestId, requestHash }, signal, targetFingerprint)
    },
    changes(parameters, signal) {
      return requestOwnerSync({ kind: 'changes', parameters }, signal, targetFingerprint)
    },
  } satisfies OwnerSyncCandidateTransport)
}
