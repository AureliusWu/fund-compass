/** Operation-only, pure v5 balance construction/export. No storage or network.
 * Loading or constructing an observation does not authorize a workspace write.
 */
import type { WatchEntry } from './gist'
import { aggregateFundHoldings } from './holding-aggregation'
import { holdingCostBasis, holdingMarketValue } from './portfolioCoverage'
import { canonicalOwnerLocal } from './owner-workspace-backup'
import { applyOwnerPortfolioCommand, validateOwnerPortfolioLocal,
  type OwnerPortfolioObservation, type OwnerPortfolioObservationHolding } from './ownerPortfolioLocal'

type Entry = Omit<WatchEntry, 'updated_at'>
export interface OwnerPortfolioObservationQuote { readonly nav: number | null; readonly type: string }

/** All accounts, including explicit zero holdings, are checked before pricing.
 * Cash/manual balances have unknown purchase cost; old ids are never parsed as
 * new fund/manual identities. The existing codec owns total/capacity validation.
 */
export function buildOwnerPortfolioObservation(portfolio: unknown, entries: readonly Entry[],
  quotes: Readonly<Record<string, OwnerPortfolioObservationQuote>>, id: string, now: Date): OwnerPortfolioObservation {
  const original = validateOwnerPortfolioLocal(portfolio)
  if (!aggregateFundHoldings(entries).complete) throw new Error('portfolio_input_incomplete')
  const positive = entries.filter(row => !row.deleted && row.position_kind !== 'watch' && typeof row.shares === 'number' && row.shares > 0)
  const zero = entries.filter(row => !row.deleted && row.position_kind === 'holding' && row.shares === 0)
  const rows: OwnerPortfolioObservationHolding[] = [...positive, ...zero].map(row => {
    const quote = quotes[row.code], shares = row.shares!
    const value = shares === 0 ? 0 : holdingMarketValue(shares, quote?.nav)
    if (value === null) throw new Error('portfolio_price_incomplete')
    const cost = shares === 0 ? typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0
      ? shares * row.cost : null : holdingCostBasis(shares, row.cost)
    return { kind: 'fund', key: `${row.code}::${row.account?.trim() || ''}`, name: row.name || row.code,
      type: quote?.type || '其他', value, cost }
  })
  for (const asset of original.manual) if (!asset.deleted) rows.push({ kind: 'manual', key: asset.key,
    name: asset.values.name, cls: asset.values.cls, value: asset.values.value, cost: null })
  const observed_at = now.toISOString(), observation: OwnerPortfolioObservation = { id, kind: 'observation', observed_at,
    date: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10), calendar: 'Asia/Shanghai',
    value: rows.reduce((sum, row) => sum + row.value, 0),
    cost: rows.some(row => row.cost === null) ? null : rows.reduce((sum, row) => sum + row.cost!, 0), holdings: rows }
  // This validates the complete proposed image, without writing it or changing
  // the original archive. It is not a replacement for the facade's strict CAS.
  const checked = applyOwnerPortfolioCommand(original, { type: 'append_observation', observation }).portfolio
  return checked.history[checked.history.length - 1] as OwnerPortfolioObservation
}

/** Preserve raw numeric semantics, immutable legacy UTC/opaque identities and
 * duplicate dates. This export is not a workspace recovery/replay capability. */
export function buildOwnerPortfolioHistoryExport(portfolio: unknown): string {
  const checked = validateOwnerPortfolioLocal(portfolio)
  return canonicalOwnerLocal({ schema: 'owner-portfolio-history-export-1', history: checked.history })
}
