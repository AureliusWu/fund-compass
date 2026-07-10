<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getIndices, cachedIndices, type IndexQuote } from '@/utils/indices'
import { colorOf } from '@/utils/format'

const items = ref<IndexQuote[]>(cachedIndices())
let timer: ReturnType<typeof setInterval> | null = null

async function tick() {
  if (document.hidden) return
  try { items.value = await getIndices() } catch { /* 保留上次 */ }
}

function onVisible() { if (!document.hidden) tick() }

onMounted(() => {
  tick()
  timer = setInterval(tick, 30000)
  document.addEventListener('visibilitychange', onVisible)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '--')
const sign = (c: number) => (Number.isFinite(c) && c >= 0 ? '+' : '')
</script>

<template>
  <div class="ibar">
    <div class="ibar-inner">
      <div class="item" v-for="it in items" :key="it.name">
        <span class="nm">{{ it.name }}</span>
        <span class="px" :style="{ color: colorOf(it.changePct) }">{{ fmt(it.price) }}</span>
        <span class="ch" :style="{ color: colorOf(it.changePct) }">
          {{ Number.isFinite(it.changePct) ? sign(it.changePct) + fmt(it.changePct) + '%' : '--' }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ibar { background: var(--card-bg); border-bottom: 1px solid var(--border); overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ibar::-webkit-scrollbar { display: none; }
.ibar-inner { display: flex; gap: 24px; padding: 9px 16px; width: max-content; margin: 0 auto; }
.item { display: flex; flex-direction: column; align-items: flex-start; min-width: 70px; line-height: 1.35; }
.nm { font-size: 11px; color: var(--text-muted); }
.px { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ch { font-size: 11px; font-variant-numeric: tabular-nums; }
@media (min-width: 900px) {
  .ibar-inner { width: min(100%, 920px); justify-content: center; }
}
</style>
