<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getTheme, toggleTheme, type Theme } from './utils/theme'
import Icon from '@/components/Icon.vue'
import { MAIN_NAV_ITEMS } from '@/utils/presentation'

const theme = ref<Theme>(getTheme())
const appError = ref(false)

function showAppError() {
  appError.value = true
}

function reloadPage() {
  window.location.reload()
}

onMounted(() => window.addEventListener('fund-compass-error', showAppError))
onBeforeUnmount(() => window.removeEventListener('fund-compass-error', showAppError))

function onToggleTheme() {
  theme.value = toggleTheme()
}
</script>

<template>
  <div class="app">
    <!-- 顶部远山装饰 -->
    <svg class="mountain-decor top" viewBox="0 0 1440 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mt-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6B8E78" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#6B8E78" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="mt-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#4C7E67" stop-opacity="0.12" />
          <stop offset="100%" stop-color="#4C7E67" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="mt-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#C8A75B" stop-opacity="0.08" />
          <stop offset="100%" stop-color="#C8A75B" stop-opacity="0" />
        </linearGradient>
      </defs>
      <!-- 远山 -->
      <path d="M0 200L0 120Q120 90 200 110Q280 130 360 85Q440 40 520 75Q600 110 680 60Q760 10 840 55Q920 100 1000 50Q1080 0 1160 40Q1240 80 1320 30Q1400 -20 1440 20V200Z" fill="url(#mt-far)" />
      <!-- 近山 -->
      <path d="M0 200L0 145Q180 110 360 140Q540 170 720 120Q900 70 1080 105Q1260 140 1440 95V200Z" fill="url(#mt-near)" />
      <!-- 描金山脊 -->
      <path d="M0 155Q180 125 360 152Q540 178 720 133Q900 88 1080 118Q1260 148 1440 108" fill="none" stroke="#C8A75B" stroke-opacity="0.06" stroke-width="2" />
    </svg>

    <!-- 底部云雾 -->
    <svg class="mountain-decor bottom" viewBox="0 0 1440 160" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="mt-mist" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="#8FAE91" stop-opacity="0.08" />
          <stop offset="100%" stop-color="#8FAE91" stop-opacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="300" cy="140" rx="400" ry="40" fill="url(#mt-mist)" />
      <ellipse cx="900" cy="130" rx="500" ry="50" fill="url(#mt-mist)" />
      <ellipse cx="1300" cy="145" rx="350" ry="35" fill="url(#mt-mist)" />
    </svg>

    <router-view class="app-main" />

    <div v-if="appError" class="app-error" role="alert">
      <span>页面运行异常，请刷新后重试</span>
      <button type="button" @click="reloadPage">刷新</button>
    </div>

    <van-tabbar route :safe-area-inset-bottom="true">
      <van-tabbar-item v-for="item in MAIN_NAV_ITEMS" :key="item.to" :to="item.to">
        <template #icon>
          <Icon :name="item.icon" :size="20" />
        </template>
        {{ item.label }}
      </van-tabbar-item>
    </van-tabbar>

    <!-- 描金主题切换 -->
    <span class="theme-btn gold-hover" @click="onToggleTheme">
      <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="16" />
    </span>
  </div>
</template>

<style scoped>
.app { position: relative; min-height: 100%; }

.app-error {
  position: fixed;
  left: 50%;
  bottom: 76px;
  z-index: 120;
  width: min(420px, calc(100% - 32px));
  transform: translateX(-50%);
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--card-bg);
  box-shadow: var(--shadow-sm);
  color: var(--ink);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.app-error button {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
}

.theme-btn {
  position: fixed;
  right: 14px;
  bottom: 70px;
  z-index: 99;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--card-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  color: var(--teal);
}

.theme-btn:hover {
  color: var(--gold);
  border-color: var(--gold);
}

/* 让 tabbar icon 默认墨色，选中青绿 */
:deep(.van-tabbar-item__icon) {
  color: var(--ink-muted);
  transition: color 0.2s ease;
}
:deep(.van-tabbar-item--active .van-tabbar-item__icon) {
  color: var(--teal);
}
</style>
