import { defineStore } from 'pinia'
import { ref } from 'vue'
import { addWatch, getWatchlist, removeWatch, type WatchItem } from '@/api/client'

export const useWatchlistStore = defineStore('watchlist', () => {
  const items = ref<WatchItem[]>([])
  const loaded = ref(false)

  async function load(force = false) {
    if (loaded.value && !force) return
    const r = await getWatchlist()
    items.value = r.items
    loaded.value = true
  }

  function has(code: string) {
    return items.value.some((i) => i.code === code)
  }

  async function add(code: string) {
    await addWatch(code)
    await load(true)
  }

  async function remove(code: string) {
    await removeWatch(code)
    items.value = items.value.filter((i) => i.code !== code)
  }

  async function toggle(code: string) {
    if (has(code)) await remove(code)
    else await add(code)
  }

  return { items, loaded, load, has, add, remove, toggle }
})
