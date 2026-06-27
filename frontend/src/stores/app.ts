import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchMarketTemp, cachedMarketTemp, type MarketTemp } from '@/utils/market-temp'

// V4-1 全局应用状态：后端连通 + 市场温度
export const useAppStore = defineStore('app', () => {
  const backendOnline = ref<boolean | null>(null)
  const marketTemp = ref<MarketTemp | null>(cachedMarketTemp())
  const tempLoading = ref(false)

  function setBackendOnline(v: boolean) {
    backendOnline.value = v
  }

  async function loadMarketTemp() {
    if (tempLoading.value) return
    tempLoading.value = true
    try {
      marketTemp.value = await fetchMarketTemp()
    } catch { /* 静默 */ }
    finally { tempLoading.value = false }
  }

  return { backendOnline, setBackendOnline, marketTemp, tempLoading, loadMarketTemp }
})
