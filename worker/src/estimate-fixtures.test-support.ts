import estimateWireFixture from '../../contracts/estimate-wire-v8.json'
import { normalizeEstimate, type Estimate, type ValuationDiagnostics } from './valuation'

/** Map immutable shared examples into the Worker's actual internal input type. */
export function estimateFixture(id: string): { wire: Record<string, unknown>; estimate: Estimate } {
  const row = estimateWireFixture.cases.find((item) => item.id === id)
  if (!row?.expected.accepted) throw new Error(`missing accepted estimate fixture: ${id}`)
  const wire = row.wire as Record<string, unknown>
  const sourceTime = String(wire.source_time ?? '')
  const base = normalizeEstimate({}, String(wire.code))
  const estimate: Estimate = {
    ...base,
    code: String(wire.code),
    name: String(wire.name),
    kind: wire.kind === 'intraday_estimate' ? 'estimate' : wire.kind as Estimate['kind'],
    status: wire.status as Estimate['status'],
    source: String(wire.source),
    isFallback: wire.is_fallback === true,
    baseNav: wire.base_nav as number | null,
    baseNavDate: String(wire.base_nav_date ?? ''),
    lastNav: wire.base_nav as number | null,
    valueNav: wire.value_nav as number | null,
    estNav: wire.value_nav as number | null,
    valueDate: String(wire.value_date ?? wire.nav_date ?? ''),
    navDate: String(wire.base_nav_date ?? ''),
    change: (wire.kind === 'official_nav' ? wire.value_change : wire.estimate_change) as number | null,
    sourceTime,
    time: String(wire.est_time ?? sourceTime),
    coverage: wire.coverage == null ? null : Number(wire.coverage),
    diagnostics: wire.diagnostics as ValuationDiagnostics,
    targetNavDate: wire.target_nav_date == null ? null : String(wire.target_nav_date),
    estimateModelVersion: wire.estimate_model_version == null ? null : String(wire.estimate_model_version),
    sampleCount: wire.sample_count == null ? null : Number(wire.sample_count),
    uncertainty: (wire.uncertainty ?? null) as Estimate['uncertainty'],
  }
  return { wire, estimate }
}
