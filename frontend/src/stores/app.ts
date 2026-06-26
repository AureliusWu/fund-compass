import { defineStore } from 'pinia'
import { ref } from 'vue'

// 全局应用状态（M0 占位，后续放市场温度、当前择时信号等）
export const useAppStore = defineStore('app', () => {
  const backendOnline = ref<boolean | null>(null)
  function setBackendOnline(v: boolean) {
    backendOnline.value = v
  }
  return { backendOnline, setBackendOnline }
})
