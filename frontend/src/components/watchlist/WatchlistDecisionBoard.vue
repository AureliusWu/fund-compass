<script setup lang="ts">
import type { WatchDecisionFilter, WatchDecisionRow, WatchDecisionSort } from './decisionView'

defineProps<{
  rows: WatchDecisionRow[]
  total: number
  filter: WatchDecisionFilter
  sort: WatchDecisionSort
  loading: boolean
}>()

const emit = defineEmits<{
  'update:filter': [value: WatchDecisionFilter]
  'update:sort': [value: WatchDecisionSort]
  open: [code: string]
}>()

const filters: { value: WatchDecisionFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'action', label: '需要动作' },
  { value: 'buy', label: '买入/加仓' },
  { value: 'sell', label: '减仓/卖出' },
  { value: 'abnormal', label: '数据异常' },
  { value: 'rise', label: '估值上涨' },
  { value: 'fall', label: '估值下跌' },
]

const sorts: { value: WatchDecisionSort; label: string }[] = [
  { value: 'action', label: '动作优先' },
  { value: 'confidence', label: '置信度优先' },
  { value: 'change', label: '估值涨幅优先' },
]

function formatMetric(value: number | null, suffix = ''): string {
  return value == null ? '—' : `${Math.round(value)}${suffix}`
}

function formatChange(value: number | null): string {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}
</script>

<template>
  <section class="decision-board" :aria-busy="loading">
    <div class="decision-tools">
      <div class="filter-strip" role="group" aria-label="决策筛选">
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          :class="{ on: filter === item.value }"
          :aria-pressed="filter === item.value"
          @click="emit('update:filter', item.value)"
        >{{ item.label }}</button>
      </div>
      <label class="sort-control">
        <span>排序</span>
        <select :value="sort" aria-label="决策排序" @change="emit('update:sort', ($event.target as HTMLSelectElement).value as WatchDecisionSort)">
          <option v-for="item in sorts" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
    </div>

    <div class="board-count">
      <span>已显示 {{ rows.length }} / {{ total }} 只</span>
      <em v-if="loading">快照同步中</em>
      <em v-else>V8 只读快照</em>
    </div>

    <div v-if="!rows.length" class="board-empty">
      <b>{{ loading ? '正在载入决策快照' : '当前筛选下没有基金' }}</b>
      <span>{{ loading ? '本地自选与估值仍可正常查看' : '可切换到“全部”查看快照或异常状态' }}</span>
    </div>

    <div v-else class="compass-list">
      <article
        v-for="row in rows"
        :key="row.code"
        class="compass-row"
        :class="`tone-${row.actionTone}`"
        tabindex="0"
        role="link"
        @click="emit('open', row.code)"
        @keydown.enter="emit('open', row.code)"
        @keydown.space.prevent="emit('open', row.code)"
      >
        <i class="compass-mark" aria-hidden="true"></i>
        <div class="decision-main">
          <div class="decision-head">
            <div class="fund-identity">
              <b>{{ row.name }}</b>
              <span>{{ row.code }} · {{ row.type || '基金' }}</span>
            </div>
            <div class="action-stamp">
              <strong>{{ row.actionLabel }}</strong>
              <small v-if="row.gated && row.snapshotActionLabel">原快照：{{ row.snapshotActionLabel }}</small>
            </div>
          </div>

          <div class="metric-ledger">
            <span><small>强度</small><b>{{ formatMetric(row.strength, '/100') }}</b></span>
            <span><small>置信</small><b>{{ formatMetric(row.confidence, '%') }}</b></span>
            <span><small>{{ row.changeCaption }}</small><b>{{ formatChange(row.change) }}</b></span>
            <span class="data-state" :class="{ bad: row.dataAbnormal }"><small>数据</small><b>{{ row.dataLabel }}</b></span>
          </div>

          <p class="main-reason">{{ row.mainReason }}</p>
          <div class="change-line">
            <span>变化 · {{ row.changeLabel }}</span>
            <em v-if="row.changeDetail">{{ row.changeDetail }}</em>
          </div>
          <div v-if="row.gated" class="closed-note">数据恢复前不执行原快照的强动作</div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.decision-board { overflow: hidden; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.decision-tools { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.filter-strip { display: flex; flex: 1; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }.filter-strip::-webkit-scrollbar { display: none; }
.filter-strip button { flex: 0 0 auto; min-height: 30px; padding: 0 10px; border: 1px solid var(--border); border-radius: 15px; color: var(--text-muted); background: transparent; font-size: 10px; cursor: pointer; }.filter-strip button.on { color: #fff; border-color: var(--teal); background: var(--teal); }
.filter-strip button:focus-visible, .sort-control select:focus-visible, .compass-row:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.sort-control { position: relative; display: flex; align-items: center; flex: 0 0 auto; color: var(--text-hint); font-size: 9px; }.sort-control span { margin-right: 5px; }.sort-control select { max-width: 112px; height: 30px; padding: 0 23px 0 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); background: var(--card-bg); font-size: 10px; }
.board-count { display: flex; justify-content: space-between; padding: 8px 14px; color: var(--text-hint); background: color-mix(in srgb, var(--teal) 4%, var(--card-bg)); font-family: var(--font-mono); font-size: 9px; }.board-count em { color: var(--teal); font-style: normal; }
.board-empty { min-height: 112px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 18px; text-align: center; }.board-empty b { color: var(--text-secondary); font-size: 12px; }.board-empty span { max-width: 320px; color: var(--text-hint); font-size: 10px; line-height: 1.6; margin-top: 5px; }
.compass-list { padding: 0 14px; }
.compass-row { --action-color: var(--text-muted); position: relative; display: grid; grid-template-columns: 13px minmax(0, 1fr); gap: 9px; padding: 14px 0; border-bottom: 1px solid var(--border); cursor: pointer; }.compass-row:last-child { border-bottom: 0; }.compass-row.tone-buy { --action-color: var(--danger); }.compass-row.tone-sell { --action-color: var(--success); }.compass-row.tone-hold { --action-color: var(--teal); }.compass-row.tone-warn { --action-color: var(--warn); }
.compass-row::before { position: absolute; top: 0; bottom: 0; left: 5px; width: 1px; content: ''; background: var(--border); }.compass-row:first-child::before { top: 19px; }.compass-row:last-child::before { bottom: calc(100% - 20px); }
.compass-mark { position: relative; z-index: 1; width: 11px; height: 11px; margin-top: 5px; border: 2px solid var(--card-bg); border-radius: 50%; background: var(--action-color); box-shadow: 0 0 0 1px var(--action-color); }
.decision-main { min-width: 0; }.decision-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.fund-identity { min-width: 0; }.fund-identity b, .fund-identity span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.fund-identity b { color: var(--ink); font-size: 13px; font-weight: 600; }.fund-identity span { color: var(--text-hint); font-family: var(--font-mono); font-size: 9px; margin-top: 4px; }
.action-stamp { flex: 0 0 auto; text-align: right; }.action-stamp strong { display: block; color: var(--action-color); font-family: var(--font-display); font-size: 15px; }.action-stamp small { display: block; color: var(--text-hint); font-size: 8px; margin-top: 2px; }
.metric-ledger { display: grid; grid-template-columns: 58px 64px minmax(76px, .9fr) minmax(76px, 1fr); margin-top: 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }.metric-ledger span { min-width: 0; padding: 7px 8px 7px 0; }.metric-ledger span + span { padding-left: 8px; border-left: 1px solid var(--border); }.metric-ledger small, .metric-ledger b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.metric-ledger small { color: var(--text-hint); font-size: 8px; }.metric-ledger b { color: var(--text-secondary); font-family: var(--font-mono); font-size: 10px; font-weight: 500; margin-top: 3px; }.metric-ledger .data-state.bad b { color: var(--warn); }
.main-reason { color: var(--text-secondary); font-size: 11px; line-height: 1.6; margin: 9px 0 0; }.change-line { display: flex; align-items: baseline; gap: 7px; margin-top: 5px; font-size: 9px; }.change-line span { flex: 0 0 auto; color: var(--teal); }.change-line em { min-width: 0; overflow: hidden; color: var(--text-hint); font-style: normal; text-overflow: ellipsis; white-space: nowrap; }.closed-note { margin-top: 8px; padding: 6px 8px; border-left: 2px solid var(--warn); color: var(--text-muted); background: color-mix(in srgb, var(--warn) 8%, var(--card-bg)); font-size: 9px; line-height: 1.5; }
@media (max-width: 560px) { .decision-tools { display: block; }.sort-control { justify-content: flex-end; margin-top: 8px; }.sort-control select { max-width: none; }.metric-ledger { grid-template-columns: 54px 58px minmax(74px, .9fr) minmax(72px, 1fr); } }
@media (prefers-reduced-motion: no-preference) { .compass-row { transition: background-color .18s ease; }.compass-row:hover { background: color-mix(in srgb, var(--teal) 4%, transparent); } }
</style>
