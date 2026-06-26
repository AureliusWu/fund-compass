<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getToken } from '@/utils/gist'
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

// 云同步设置
const showSync = ref(false)
const token = ref(getToken())

async function loadOne(code: string, name: string | null) {
  rows[code] = { name: name || code, nav: null, ret1y: null, signal: '', star: null }
  try {
    const [d, s, sig] = await Promise.all([funds.detail(code), funds.score(code), funds.signal(code)])
    rows[code] = { name: d.name || code, nav: d.latest_nav, ret1y: d.ret_1y, star: s.star, signal: sig.signal }
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

async function saveToken() {
  watch.setToken(token.value)
  showToast(token.value ? '已保存 Token' : '已清空 Token')
}
async function upload() {
  if (!watch.hasToken) { showToast('请先填 Token'); return }
  await watch.manualUpload()
  showToast(watch.lastSync ? '已上传到云端' : '上传失败，检查 Token')
}
async function download() {
  if (!watch.hasToken) { showToast('请先填 Token'); return }
  await watch.manualDownload()
  await refresh()
  showToast('已从云端同步')
}
function clearCloud() {
  watch.clearCloud()
  token.value = ''
  showToast('已清除云同步配置')
}

onMounted(refresh)
</script>

<template>
  <div class="page">
    <van-nav-bar title="自选">
      <template #right>
        <van-icon name="cloud-o" size="20" @click="showSync = true" />
      </template>
    </van-nav-bar>
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
            <van-icon name="cross" color="#c8c9cc" size="18" style="margin-left:8px" @click.stop="remove(it.code)" />
          </template>
        </van-cell>
      </van-cell-group>
    </div>

    <van-popup v-model:show="showSync" position="bottom" round :style="{ padding: '16px' }">
      <div class="sync-title">云同步（GitHub Gist）</div>
      <div class="sync-sub">
        自选存在本机，配置 Token 后可备份到私有 Gist、多设备同步。
        需 <code>gist</code> 权限，<a href="https://github.com/settings/tokens" target="_blank" rel="noopener">创建 Token</a>。
      </div>
      <van-field v-model="token" type="password" label="Token" placeholder="ghp_xxx" />
      <div class="sync-status">
        {{ watch.syncing ? '同步中…' : watch.lastSync ? '上次同步：' + new Date(watch.lastSync).toLocaleString() : '未同步' }}
      </div>
      <div class="sync-btns">
        <van-button size="small" @click="saveToken">保存 Token</van-button>
        <van-button size="small" type="primary" @click="upload">上传</van-button>
        <van-button size="small" type="primary" plain @click="download">下载</van-button>
      </div>
      <van-button size="small" block plain @click="clearCloud" style="margin-top:8px;color:#ee0a24">清除云同步配置</van-button>
    </van-popup>
  </div>
</template>

<style scoped>
.wl-val { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.sig { font-size: 14px; font-weight: 500; }
.nav { font-size: 12px; color: #646566; }
.nav em { font-style: normal; margin-left: 4px; }
.sync-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.sync-sub { font-size: 12px; color: #969799; line-height: 1.6; margin-bottom: 10px; }
.sync-sub code { background: #f2f3f5; padding: 1px 4px; border-radius: 3px; }
.sync-sub a { color: #0f9d75; }
.sync-status { font-size: 12px; color: #646566; margin: 10px 2px; }
.sync-btns { display: flex; gap: 8px; }
.sync-btns .van-button { flex: 1; }
</style>
