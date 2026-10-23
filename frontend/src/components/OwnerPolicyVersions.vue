<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { OwnerPolicyState } from '@/utils/ownerPolicyState'
import { ownerPolicyDiff } from '@/utils/ownerPolicyDiff'

const props = defineProps<{ state: OwnerPolicyState | null; fresh: boolean; busy: boolean }>()
defineEmits<{ review: [] }>()
const selectedId = ref(''), page = ref(0), fullRules = ref(false)
watch(() => props.state, state => {
  selectedId.value = state?.current?.policy_version ?? state?.history[0]?.policy_version ?? ''
  page.value = 0
}, { immediate: true })
watch(selectedId, () => { fullRules.value = false })
function toggleRules(event: Event) { fullRules.value = (event.target as HTMLDetailsElement).open === true }
const selected = computed(() => props.state?.history.find(row => row.policy_version === selectedId.value) ?? null)
const previous = computed(() => props.state?.history.find(row => row.policy_version === selected.value?.supersedes) ?? null)
const changes = computed(() => selected.value && previous.value ? ownerPolicyDiff(previous.value, selected.value) : [])
const pages = computed(() => Math.max(1, Math.ceil((props.state?.history.length ?? 0) / 10)))
const rows = computed(() => props.state?.history.slice(page.value * 10, (page.value + 1) * 10) ?? [])
function status(id: string) {
  const state = props.state
  if (!state) return '历史'
  if (id === state.current?.policy_version) return '核对时生效'
  // The parser already verifies exact microsecond order. Re-parsing with
  // Date here would round a legitimately scheduled +1us version into history.
  const currentIndex = state.history.findIndex(row => row.policy_version === state.current?.policy_version)
  return currentIndex < 0 || state.history.findIndex(row => row.policy_version === id) < currentIndex ? '待生效' : '历史'
}
</script>

<template>
  <section class="policy-versions" aria-label="策略版本核对">
    <header><h3>策略版本</h3><button type="button" :disabled="busy" @click="$emit('review')">读取策略版本</button></header>
    <p>这里只读查看已发布护栏，不会修改策略、执行通知或自动生成分析。</p>
    <template v-if="state">
      <p>核对时刻：<time>{{ state.observed_at }}</time> · 完整版本 {{ state.history.length }} 份</p>
      <p v-if="!fresh" class="policy-warning" role="status">本次核对已过期或已到下一版本生效时刻。以下只作历史；请手动重新读取，不自动恢复旧分析资格。</p>
      <p v-if="state.next_effective_at">已知下一生效时刻：<time>{{ state.next_effective_at }}</time>，旧分析资格最晚在此暂停。</p>
      <p v-if="!state.current">核对时没有已生效策略，不能生成当前持仓分析。</p>
      <ul class="version-list"><li v-for="row in rows" :key="row.policy_version">
        <button type="button" :aria-pressed="selectedId === row.policy_version" @click="selectedId = row.policy_version">
          <span>{{ status(row.policy_version) }}</span> {{ row.name }} · {{ row.effective_at }}<code>{{ row.policy_version }}</code>
        </button>
      </li></ul>
      <nav v-if="pages > 1" aria-label="策略版本分页"><button type="button" :disabled="page === 0" @click="page--">上一页</button><span>{{ page + 1 }} / {{ pages }}</span><button type="button" :disabled="page + 1 >= pages" @click="page++">下一页</button></nav>
      <template v-if="selected">
        <h4>与直接前驱比较</h4>
        <p v-if="!previous">本次完整链的起点没有前驱；不据此推断基金首次分析或动作变化。</p>
        <p v-else-if="!changes.length">业务字段未变；版本身份与生效时刻仍按原记录保留。</p>
        <div v-else class="diff-table"><table><thead><tr><th>字段</th><th>前驱</th><th>所选版本</th></tr></thead><tbody>
          <tr v-for="row in changes" :key="row.key"><th>{{ row.label }}</th><td>{{ row.before }}</td><td>{{ row.after }}</td></tr>
        </tbody></table></div>
        <details :open="fullRules" @toggle="toggleRules"><summary>查看所选版本完整规则</summary><pre v-if="fullRules">{{ JSON.stringify(selected, null, 2) }}</pre></details>
      </template>
    </template>
    <p v-else>尚未读取版本。登录或打开页面不会自动请求。</p>
  </section>
</template>

<style scoped>
.policy-versions { border-top: 1px solid var(--border-strong); margin-top: 16px; padding-top: 8px; }
header, nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; }
h3, h4 { color: var(--ink); font-family: var(--font-display); } h3 { font-size: 15px; } h4 { font-size: 13px; }
button { padding: 7px 12px; border: 1px solid var(--border-strong); border-radius: 5px; background: var(--card-bg); color: var(--teal-deep); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; } button:focus-visible, summary:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.version-list { list-style: none; padding: 0; } .version-list button { width: 100%; text-align: left; margin-bottom: 6px; }
.version-list button[aria-pressed="true"] { border-left: 3px solid var(--teal); background: var(--bg); }
code { display: block; overflow-wrap: anywhere; font-size: 10px; } time { font-family: var(--font-mono, monospace); }
.policy-warning { border-left: 3px solid var(--border-strong); padding-left: 10px; color: var(--ink); }
.diff-table { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; }
td, th { padding: 8px; border-bottom: 1px solid var(--border-strong); vertical-align: top; overflow-wrap: anywhere; min-width: 90px; }
pre { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
summary { cursor: pointer; color: var(--ink); padding: 8px 0; }
</style>
