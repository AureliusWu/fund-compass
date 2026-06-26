<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { getFunds, type FundListItem } from '@/api/client'
import { useWatchlistStore } from '@/stores/watchlist'

const router = useRouter()
const watch = useWatchlistStore()
const TYPES = ['', '股票型', '混合型', '债券型', '指数型', 'QDII', 'ETF', '货币型', 'FOF']
const type = ref('')
const q = ref('')
const items = ref<FundListItem[]>([])
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const finished = ref(false)

async function load() {
  if (finished.value) return
  loading.value = true
  try {
    const r = await getFunds({
      q: q.value || undefined, type: type.value || undefined,
      page: page.value, page_size: 20,
    })
    total.value = r.total
    items.value.push(...r.items)
    page.value++
    if (items.value.length >= r.total) finished.value = true
  } catch {
    showToast('加载失败，后端是否已启动？')
    finished.value = true
  } finally {
    loading.value = false
  }
}

function reset() {
  page.value = 1
  items.value = []
  finished.value = false
  load()
}

function pick(t: string) {
  type.value = t
  reset()
}

async function toggleWatch(code: string) {
  try {
    await watch.toggle(code)
    showToast(watch.has(code) ? '已加入自选' : '已移出自选')
  } catch {
    showToast('操作失败')
  }
}

onMounted(() => {
  watch.load().catch(() => {})
  reset()
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="选基" />
    <van-search v-model="q" placeholder="代码 / 名称 / 拼音" @search="reset" @clear="reset" />
    <div class="chips">
      <span v-for="t in TYPES" :key="t" class="chip" :class="{ on: type === t }" @click="pick(t)">
        {{ t || '全部' }}
      </span>
    </div>
    <div class="page-body" style="padding-top:8px">
      <div class="hint">共 {{ total }} 只</div>
      <van-list v-model:loading="loading" :finished="finished" finished-text="没有更多了" @load="load">
        <van-cell
          v-for="it in items" :key="it.code"
          :title="it.name" :label="it.code + ' · ' + it.type"
          @click="router.push('/fund/' + it.code)"
        >
          <template #right-icon>
            <van-icon
              :name="watch.has(it.code) ? 'star' : 'star-o'"
              :color="watch.has(it.code) ? '#ffb400' : '#c8c9cc'"
              size="20" @click.stop="toggleWatch(it.code)"
            />
          </template>
        </van-cell>
      </van-list>
    </div>
  </div>
</template>

<style scoped>
.chips { display: flex; gap: 8px; overflow-x: auto; padding: 8px 16px; background: #fff; }
.chip {
  flex: none; font-size: 13px; padding: 4px 12px; border-radius: 14px;
  background: #f2f3f5; color: #646566; white-space: nowrap;
}
.chip.on { background: #0f9d75; color: #fff; }
.hint { font-size: 12px; color: #969799; margin-bottom: 8px; }
</style>
