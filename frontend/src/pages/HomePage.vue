<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getHealth } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { signalColor } from '@/utils/format'
import IndexBar from '@/components/IndexBar.vue'

const router = useRouter()
const watch = useWatchlistStore()
const funds = useFundsStore()
const health = ref('检查中…')
const sigs = reactive<Record<string, string>>({})

onMounted(() => {
  // 后端健康检查非阻塞：Render 冷启动时也不卡住自选信号加载
  getHealth()
    .then((r) => { health.value = `正常 · 收录 ${r.universe} 只` })
    .catch(() => { health.value = '未连接（请启动后端）' })
  // 自选信号与健康检查并行；首屏（指数条 + 温度骨架）立即可见
  watch.load(true)
    .then(() => Promise.all(watch.items.map(async (it) => {
      try { sigs[it.code] = (await funds.signal(it.code)).signal } catch { /* skip */ }
    })))
    .catch(() => { /* skip */ })
})

const SIG_WEIGHT: Record<string, number> = { 买入: 100, 定投: 70, 持有: 45, 减仓: 15 }

const temp = computed(() => {
  const vals = Object.values(sigs)
  if (!vals.length) return null
  return Math.round(vals.reduce((a, s) => a + (SIG_WEIGHT[s] ?? 45), 0) / vals.length)
})

const dist = computed(() => {
  const d: Record<string, number> = { 买入: 0, 定投: 0, 持有: 0, 减仓: 0 }
  Object.values(sigs).forEach((s) => { if (s in d) d[s]++ })
  return d
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="司南基金" />
    <IndexBar />
    <div class="page-body">
      <van-cell-group inset>
        <van-cell title="后端" :value="health" />
      </van-cell-group>

      <div class="sec">自选温度</div>
      <div class="card temp" v-if="temp != null">
        <div class="t">{{ temp }}<small>/100</small></div>
        <div class="d">
          <span style="color:#ee0a24">买入 {{ dist['买入'] }}</span>
          <span style="color:#ff976a">定投 {{ dist['定投'] }}</span>
          <span style="color:#969799">持有 {{ dist['持有'] }}</span>
          <span style="color:#07c160">减仓 {{ dist['减仓'] }}</span>
        </div>
        <div class="note">基于自选基金择时信号的简易温度（非全市场）</div>
      </div>
      <van-empty v-else description="自选为空，去选基页添加后这里显示信号温度" />

      <template v-if="watch.items.length">
        <div class="sec">自选信号</div>
        <van-cell-group inset>
          <van-cell v-for="it in watch.items" :key="it.code"
            :title="it.name || it.code" :label="it.code"
            is-link @click="router.push('/fund/' + it.code)">
            <template #value>
              <span :style="{ color: signalColor(sigs[it.code] || '') }">{{ sigs[it.code] || '…' }}</span>
            </template>
          </van-cell>
        </van-cell-group>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sec { font-size: 13px; color: #969799; margin: 18px 4px 8px; }
.card { background: #fff; border-radius: 10px; padding: 16px; }
.temp .t { font-size: 40px; font-weight: 600; color: #0f9d75; }
.temp .t small { font-size: 14px; color: #c8c9cc; font-weight: 400; }
.temp .d { display: flex; gap: 14px; font-size: 13px; margin-top: 6px; }
.temp .note { font-size: 11px; color: #c8c9cc; margin-top: 8px; }
</style>
