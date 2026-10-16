<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch as observe } from 'vue'
import { showConfirmDialog } from 'vant'
import { useWatchlistStore } from '@/stores/watchlist'
import { entryId, type WatchEntry } from '@/utils/gist'
import { parseHoldingNumber, positionKind, WatchMutationError, type EntrySnapshot, type PositionKind } from '@/utils/holding-editor'

const props = defineProps<{ code: string; name?: string }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const watch = useWatchlistStore()
const records = computed(() => watch.recordsFor(props.code))
const source = ref<EntrySnapshot | undefined>()
const sourceKind = ref<PositionKind>('watch')
const draft = reactive({ account: '', kind: 'watch' as PositionKind, shares: '', cost: '', target: '' })
const error = ref('')
const busy = ref(false)
let generation = 0

function edit(entry?: WatchEntry) {
  if (busy.value) return
  source.value = entry ? { id: entry.id || entryId(entry.code, entry.account), snapshot: JSON.stringify(entry) } : undefined
  sourceKind.value = entry ? positionKind(entry) : 'watch'
  draft.account = entry?.account?.trim() || ''
  draft.kind = sourceKind.value
  draft.shares = entry?.shares == null ? '' : String(entry.shares)
  draft.cost = entry?.cost == null ? '' : String(entry.cost)
  draft.target = entry?.target_weight == null ? '' : String(entry.target_weight)
  error.value = ''
}
observe(() => props.code, () => edit(records.value[0]), { immediate: true })
onBeforeUnmount(() => { generation++ })
function close() { generation++; emit('close') }
function failure(cause: unknown) {
  error.value = cause instanceof WatchMutationError ? cause.message : '本机保存失败，原记录未修改'
}
async function save() {
  if (busy.value) return
  const current = generation
  error.value = ''
  busy.value = true
  try {
    const input = {
      code: props.code, name: props.name, account: draft.account, position_kind: draft.kind,
      shares: draft.kind === 'holding' ? parseHoldingNumber(draft.shares, true) : null,
      cost: draft.kind === 'holding' ? parseHoldingNumber(draft.cost) : null,
      target_weight: draft.kind === 'holding' ? parseHoldingNumber(draft.target) : null,
    }
    let confirmed = false
    if (source.value && sourceKind.value === 'holding' && draft.kind === 'watch') {
      try {
        await showConfirmDialog({ title: '改为仅关注？', message: '将清除此账户的份额、成本与目标权重，不影响其他账户。', confirmButtonText: '确认改为仅关注' })
        confirmed = true
      } catch { return }
    }
    if (current !== generation) return
    watch.saveHolding(input, source.value, { confirmed })
    emit('saved')
    close()
  } catch (cause) { if (current === generation) failure(cause) }
  finally { if (current === generation) busy.value = false }
}
async function remove(entry: WatchEntry) {
  if (busy.value) return
  const id = entry.id || entryId(entry.code, entry.account)
  const snapshot = watch.entrySnapshot(id)
  if (!snapshot) { error.value = '记录已变化，请重新打开'; return }
  const current = generation
  busy.value = true
  error.value = ''
  try {
    try { await showConfirmDialog({ title: '移除此账户记录？', message: `${entry.account?.trim() || '未分组'} · ${props.code}。只移除此账户，不删除其他账户。`, confirmButtonText: '确认移除' }) }
    catch { return }
    if (current !== generation) return
    watch.remove(props.code, entry.account?.trim() || '', { confirmed: true, expected: [{ id, snapshot }] })
    if (source.value?.id === id) { busy.value = false; edit() }
    emit('saved')
  } catch (cause) { if (current === generation) failure(cause) }
  finally { if (current === generation) busy.value = false }
}
</script>

<template>
  <van-popup :show="true" position="bottom" round :safe-area-inset-bottom="true" class="holding-popup" role="dialog" aria-modal="true" aria-label="编辑账户持仓" @keydown.esc="close" @update:show="value => { if (!value) close() }">
    <header class="holding-heading"><div><h2>管理持仓</h2><p>{{ name || code }} · {{ code }}</p></div><button type="button" aria-label="关闭持仓编辑" @click="close">×</button></header>
    <section class="account-ledger" aria-label="账户记录">
      <div v-for="entry in records" :key="entry.id" class="account-record">
        <div><b>{{ entry.account?.trim() || '未分组' }}</b><span>{{ positionKind(entry) === 'holding' ? '持仓记录 · ' + (entry.shares == null ? '份额未知' : entry.shares + ' 份') : '仅关注' }}</span></div>
        <button type="button" :disabled="busy" :data-edit="entry.id" @click="edit(entry)">编辑</button>
        <button type="button" :disabled="busy" :data-remove="entry.id" @click="remove(entry)">移除</button>
      </div>
      <button type="button" class="new-account" data-action="new" :disabled="busy" @click="edit()">新增账户记录</button>
    </section>
    <form @submit.prevent="save">
      <div class="mode-field"><span>记录类型</span><van-radio-group v-model="draft.kind" direction="horizontal" :disabled="busy"><van-radio name="watch">仅关注</van-radio><van-radio name="holding">持仓记录</van-radio></van-radio-group></div>
      <van-field v-model="draft.account" name="account" label="账户" placeholder="留空为未分组" maxlength="64" :disabled="busy" />
      <div v-if="watch.accounts.length" class="account-shortcuts"><button v-for="account in watch.accounts" :key="account" type="button" :disabled="busy" @click="draft.account = account">{{ account }}</button></div>
      <template v-if="draft.kind === 'holding'">
        <van-field v-model="draft.shares" name="shares" label="持有份额" type="text" inputmode="decimal" placeholder="必填；真实 0 份可保存" maxlength="32" :disabled="busy" />
        <van-field v-model="draft.cost" name="cost" label="成本净值" type="text" inputmode="decimal" placeholder="留空为未知；0 是已知零成本" maxlength="32" :disabled="busy" />
        <van-field v-model="draft.target" name="target" label="目标权重 %" type="text" inputmode="decimal" placeholder="0–100；留空为未知" maxlength="32" :disabled="busy" />
        <p class="field-note">按账户记录目标；同基金跨账户独立。0 份记录不计为正持仓。</p>
      </template>
      <p v-else class="field-note">仅记录关注，不用 0 冒充未知份额。改为仅关注会清除此账户的持仓字段。</p>
      <p class="local-boundary">{{ watch.localStatus }}。现有私人决策基于上次确认的云端状态，不代表这次本地编辑已生效。</p>
      <p v-if="error" role="alert" class="holding-error">{{ error }}</p>
      <div class="holding-actions"><van-button native-type="button" data-action="cancel" @click="close">取消</van-button><van-button native-type="submit" type="primary" data-action="save" :loading="busy" :disabled="busy || watch.localStorageError">保存到本机</van-button></div>
    </form>
  </van-popup>
</template>

<style scoped>
.holding-popup { padding: 16px 16px calc(80px + env(safe-area-inset-bottom)); max-height: 88vh; overflow-y: auto; background: var(--card-bg); }
.holding-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }.holding-heading h2 { margin: 0; font: 700 18px var(--font-display); color: var(--ink); }.holding-heading p { margin: 8px 0 0; color: var(--text-secondary); font-size: 12px; }.holding-heading button { border: 0; background: transparent; color: var(--ink); font-size: 24px; width: 40px; height: 40px; }
.account-ledger { margin-bottom: 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }.account-record { display: flex; align-items: center; gap: 8px; padding: 12px 8px; border-bottom: 1px solid var(--border); }.account-record > div { flex: 1; min-width: 0; }.account-record b, .account-record span { display: block; overflow-wrap: anywhere; }.account-record b { font-size: 13px; color: var(--ink); }.account-record span { margin-top: 4px; font: 12px var(--font-mono); color: var(--text-secondary); }.account-record button, .new-account, .account-shortcuts button { padding: 8px; border: 0; background: transparent; color: var(--teal-deep); font: inherit; font-size: 12px; cursor: pointer; }.new-account { width: 100%; text-align: left; }
.mode-field { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 8px 16px 16px; color: var(--ink); font-size: 14px; }.account-shortcuts { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; }.account-shortcuts button { background: var(--teal-soft); border-radius: var(--radius-sm); }
.field-note, .local-boundary { margin: 16px 0; font-size: 12px; line-height: 1.6; color: var(--text-secondary); }.local-boundary { padding: 12px; border-left: 2px solid var(--gold); background: var(--gold-soft); }.holding-error { color: var(--danger); font-size: 13px; line-height: 1.6; }.holding-actions { display: flex; gap: 8px; margin-top: 16px; }.holding-actions > * { flex: 1; }button:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
@media (min-width: 720px) { .holding-popup { width: 640px; left: 50%; transform: translateX(-50%); } }
</style>
