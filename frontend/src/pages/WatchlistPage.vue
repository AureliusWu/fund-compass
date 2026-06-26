<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { pct, num, colorOf, signalColor } from '@/utils/format'
import StarRating from '@/components/StarRating.vue'

interface Row {
  name: string; nav: number | null; ret1y: number | null
  signal: string; star: number | null
}

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()
const rows = reactive<Record<string, Row>>({})
const loading = ref(true)

async function loadOne(code: string, name: string | null) {
  rows[code] = { name: name || code, nav: null, ret1y: null, signal: '', star: null }
  try {
    const [d, s, sig] = await Promise.all([
      funds.detail(code), funds.score(code), funds.signal(code),
    ])
    rows[code] = {
      name: d.name || code, nav: d.latest_nav, ret1y: d.ret_1y,
      star: s.star, signal: sig.signal,
    }
  } catch { /* 保留占位 */ }
}

async function refresh() {
  loading.value = true
  await watch.load(true)
  await Promise.all(watch.items.map((i) => loadOne(i.code, i.name)))
  loading.value = false
}

async function remove(code: string) {
  await watch.remove(code)
  delete rows[code]
  showToast('已移除')
}

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="自选" />
    <div class="page-body">
      <van-loading v-if="loading" style="text-align:center;padding:40px" />
      <van-empty v-else-if="watch.items.length === 0" description="还没有自选，去选基页添加" />
      <van-cell-group v-else inset>
        <van-cell
          v-for="it in watch.items" :key="it.code"
          :title="rows[it.code]?.name || it.name || it.code" :label="it.code"
          @click="router.push('/fund/' + it.code)"
        >
          <template #value>
            <div class="wl-val">
              <span class="sig" :style="{ color: signalColor(rows[it.code]?.signal || '') }">
                {{ rows[it.code]?.signal || '…' }}
              </span>
              <StarRating :star="rows[it.code]?.star ?? null" />
              <span class="nav">
                {{ num(rows[it.code]?.nav) }}
                <em :style="{ color: colorOf(rows[it.code]?.ret1y) }">{{ pct(rows[it.code]?.ret1y) }}</em>
              </span>
            </div>
          </template>
          <template #right-icon>
            <van-icon name="cross" color="#c8c9cc" size="18" style="margin-left:8px"
              @click.stop="remove(it.code)" />
          </template>
        </van-cell>
      </van-cell-group>
    </div>
  </div>
</template>

<style scoped>
.wl-val { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.sig { font-size: 14px; font-weight: 500; }
.nav { font-size: 12px; color: #646566; }
.nav em { font-style: normal; margin-left: 4px; }
</style>
