<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getHealth } from '@/api/client'
import { useAppStore } from '@/stores/app'
import { useWatchlistStore } from '@/stores/watchlist'
import { useFundsStore } from '@/stores/funds'
import { signalColor } from '@/utils/format'
import IndexBar from '@/components/IndexBar.vue'
import { checkBackend, getSourceSummary, type SourceStatus } from '@/utils/resilience'
import { loadAlerts, runAllChecks, markRead, markAllRead, dismissAlert, requestNotifyPermission, unreadCount, type Alert } from '@/utils/alerts'

const router = useRouter()
const app = useAppStore()
const watch = useWatchlistStore()
const funds = useFundsStore()
const health = ref('检查中…')
const sources = ref<SourceStatus[]>([])
const sigs = ref<Record<string, string>>({})
const alerts = ref<Alert[]>(loadAlerts())
const unread = ref(unreadCount())

onMounted(async () => {
  // 多源健康检查
  checkBackend().then((ok) => {
    sources.value = getSourceSummary()
    if (ok) {
      getHealth().then((r) => { health.value = `正常 · 收录 ${r.universe} 只` }).catch(() => {})
    } else {
      health.value = '未连接（请启动后端）'
    }
  })

  // 市场温度（缓存优先，后台刷新）
  app.loadMarketTemp()

  // 自选信号
  try {
    await watch.load(true)
    const tasks = watch.items.map(async (it) => {
      try { sigs.value[it.code] = (await funds.signal(it.code)).signal } catch { /* skip */ }
    })
    await Promise.all(tasks)
  } catch { /* skip */ }

  // V4-5 提醒检查
  requestNotifyPermission()
  runAllChecks(
    watch.items.map((it) => ({ code: it.code, name: it.name || it.code, prevSignal: sigs.value[it.code] })),
  ).then((newAlerts) => {
    if (newAlerts.length) {
      alerts.value = loadAlerts()
      unread.value = unreadCount()
    }
  })
})

const SIG_WEIGHT: Record<string, number> = { 买入: 100, 定投: 70, 持有: 45, 减仓: 15 }

const watchTemp = computed(() => {
  const vals = Object.values(sigs.value)
  if (!vals.length) return null
  return Math.round(vals.reduce((a, s) => a + (SIG_WEIGHT[s] ?? 45), 0) / vals.length)
})

const dist = computed(() => {
  const d: Record<string, number> = { 买入: 0, 定投: 0, 持有: 0, 减仓: 0 }
  Object.values(sigs.value).forEach((s) => { if (s in d) d[s]++ })
  return d
})

// V4-5 提醒操作
function onMarkAllRead() { markAllRead(); alerts.value = loadAlerts(); unread.value = 0 }
function onDismiss(id: string) { dismissAlert(id); alerts.value = loadAlerts(); unread.value = unreadCount() }
function onMarkOne(id: string) { markRead(id); alerts.value = loadAlerts(); unread.value = unreadCount() }

const levelColor = (l: string) => ({ info: '#1989fa', warn: '#ff976a', danger: '#ee0a24' }[l] || '#969799')
const levelIcon = (l: string) => ({ info: 'ℹ', warn: '⚠', danger: '🛑' }[l] || '·')

// 温度计角度：0 → 左 -90deg, 100 → 右 90deg
</script>

<template>
  <div class="page">
    <van-nav-bar>
      <template #title>
        <div style="text-align:center">
          <div style="font-size:16px;font-weight:600;line-height:1.2">司南基金</div>
          <div style="font-size:10px;color:var(--text-hint);font-weight:400;line-height:1.2">v5.0.0</div>
        </div>
      </template>
    </van-nav-bar>
    <IndexBar />

    <div class="page-body">

      <!-- ═══ 市场温度计 ═══ -->
      <div class="sec">市场温度</div>
      <div class="card temp-card" @click="app.loadMarketTemp()">
        <div class="temp-header">
          <span class="temp-score" :style="{ color: app.marketTemp?.color || '#969799' }">
            {{ app.marketTemp?.score ?? '…' }}
          </span>
          <span v-if="app.marketTemp" class="temp-label" :style="{ color: app.marketTemp.color }">
            {{ app.marketTemp.label }}
          </span>
          <van-loading v-if="app.tempLoading" size="16" style="margin-left:6px" />
        </div>

        <!-- 温度计柱状条 -->
        <div class="gauge-track">
          <div class="gauge-fill" :style="{
            width: (app.marketTemp?.score ?? 50) + '%',
            background: app.marketTemp?.color || '#969799',
          }" />
        </div>

        <!-- 分维度详情 -->
        <div class="temp-sources" v-if="app.marketTemp?.sources?.length">
          <div class="ts-row" v-for="s in app.marketTemp.sources" :key="s.label">
            <span class="ts-dot" :style="{ background: s.color }" />
            <span class="ts-label">{{ s.label }}</span>
            <span class="ts-val" :style="{ color: s.color }">{{ s.value }}</span>
            <span class="ts-detail">{{ s.detail }}</span>
          </div>
        </div>

        <div class="temp-updated" v-if="app.marketTemp?.updated">
          更新于 {{ new Date(app.marketTemp.updated).toLocaleString('zh-CN') }} · 点击刷新
        </div>
        <van-skeleton v-if="app.tempLoading && !app.marketTemp" :row="3" />
      </div>

      <!-- ═══ V4-5 持仓提醒 ═══ -->
      <div class="sec alert-sec" v-if="alerts.length">
        <span>持仓提醒</span>
        <span class="alert-badge" v-if="unread">{{ unread }}</span>
        <span class="alert-allread" v-if="unread" @click="onMarkAllRead">全部已读</span>
      </div>
      <div class="card alert-card" v-if="alerts.length">
        <div class="alert-item" v-for="a in alerts.filter((x) => !x.dismissed).slice(0, 8).sort((a, b) => b.time.localeCompare(a.time))" :key="a.id"
          :class="{ unread: !a.read }" @click="onMarkOne(a.id)">
          <span class="al-icon" :style="{ color: levelColor(a.level) }">{{ levelIcon(a.level) }}</span>
          <div class="al-body">
            <div class="al-title">{{ a.title }}</div>
            <div class="al-text">{{ a.body }}</div>
            <div class="al-time">{{ new Date(a.time).toLocaleString('zh-CN') }}</div>
          </div>
          <span class="al-close" @click.stop="onDismiss(a.id)">✕</span>
        </div>
      </div>

      <!-- ═══ 后端 & 源状态 ═══ -->
      <div class="sec">系统状态</div>
      <van-cell-group inset>
        <van-cell title="后端" :value="health" />
        <van-cell v-if="sources.length > 0" title="多源">
          <template #value>
            <span class="src-dot" v-for="s in sources" :key="s.id"
              :class="{ ok: s.ok, err: !s.ok }"
              :title="s.label + (s.ok ? ' 正常' : s.consecutive + '次失败')">●</span>
          </template>
        </van-cell>
      </van-cell-group>

      <!-- ═══ 自选温度 ═══ -->
      <div class="sec">自选温度</div>
      <div class="card watch-temp-card" v-if="watchTemp != null">
        <div class="wt-score" :style="{
          color: watchTemp >= 70 ? '#ee0a24' : watchTemp >= 50 ? '#ff976a' : watchTemp >= 30 ? '#969799' : '#0f9d75'
        }">
          {{ watchTemp }}<small>/100</small>
        </div>
        <div class="wt-dist">
          <span style="color:#ee0a24">买入 {{ dist['买入'] }}</span>
          <span style="color:#ff976a">定投 {{ dist['定投'] }}</span>
          <span style="color:#969799">持有 {{ dist['持有'] }}</span>
          <span style="color:#07c160">减仓 {{ dist['减仓'] }}</span>
        </div>
        <div class="wt-note">基于自选基金择时信号的简易温度（非全市场）</div>
      </div>
      <van-empty v-else description="自选为空，去选基页添加后这里显示信号温度" />

      <!-- ═══ 自选信号列表 ═══ -->
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
.sec { font-size: 13px; color: var(--text-muted, #969799); margin: 18px 4px 8px; }

/* ── 市场温度 ── */
.temp-card {
  background: var(--card-bg, #fff);
  border-radius: 10px;
  padding: 18px 16px;
  cursor: pointer;
}
.temp-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.temp-score { font-size: 48px; font-weight: 700; line-height: 1; }
.temp-label { font-size: 18px; font-weight: 600; }

/* 温度计轨 */
.gauge-track {
  height: 8px;
  border-radius: 4px;
  background: var(--chip-bg, #f2f3f5);
  overflow: hidden;
  margin-bottom: 14px;
}
.gauge-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.6s ease;
  min-width: 4px;
}

/* 分维度 */
.temp-sources { display: flex; flex-direction: column; gap: 6px; }
.ts-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.ts-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.ts-label { color: var(--text-secondary, #646566); width: 80px; flex-shrink: 0; }
.ts-val { font-weight: 700; width: 24px; text-align: right; flex-shrink: 0; }
.ts-detail { color: var(--text-muted, #969799); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.temp-updated { font-size: 11px; color: var(--text-hint, #c8c9cc); margin-top: 10px; }

/* ── 系统状态 ── */
.src-dot { font-size: 10px; margin-left: 4px; }
.src-dot.ok { color: #07c160; }
.src-dot.err { color: #ee0a24; }

/* ── 自选温度 ── */
.watch-temp-card {
  background: var(--card-bg, #fff);
  border-radius: 10px;
  padding: 16px;
}
.wt-score { font-size: 40px; font-weight: 600; }
.wt-score small { font-size: 14px; color: var(--text-hint, #c8c9cc); font-weight: 400; }
.wt-dist { display: flex; gap: 14px; font-size: 13px; margin-top: 6px; }
.wt-note { font-size: 11px; color: var(--text-hint, #c8c9cc); margin-top: 8px; }
/* ── V4-5 提醒 ── */
.alert-sec { display: flex; align-items: center; gap: 8px; }
.alert-badge { background: #ee0a24; color: #fff; font-size: 10px; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
.alert-allread { font-size: 11px; color: var(--teal); cursor: pointer; }
.alert-card { background: var(--card-bg, #fff); border-radius: 10px; padding: 4px 12px; }
.alert-item { display: flex; align-items: flex-start; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--border, #f0f0f0); cursor: pointer; }
.alert-item:last-child { border-bottom: none; }
.alert-item.unread { background: rgba(15,157,117,0.03); margin: 0 -12px; padding-left: 12px; padding-right: 12px; }
.al-icon { font-size: 14px; width: 20px; text-align: center; flex-shrink: 0; }
.al-body { flex: 1; min-width: 0; }
.al-title { font-size: 13px; font-weight: 600; color: var(--text); }
.al-text { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.al-time { font-size: 10px; color: var(--text-hint); margin-top: 3px; }
.al-close { font-size: 14px; color: var(--text-hint); padding: 4px; cursor: pointer; }
</style>
