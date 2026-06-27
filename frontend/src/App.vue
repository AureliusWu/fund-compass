<script setup lang="ts">
import { ref } from 'vue'
import { getTheme, toggleTheme, type Theme } from './utils/theme'
import Icon from '@/components/Icon.vue'

const theme = ref<Theme>(getTheme())
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

    <van-tabbar route :safe-area-inset-bottom="true">
      <van-tabbar-item to="/">
        <template #icon>
          <Icon name="home" :size="20" />
        </template>
        首页
      </van-tabbar-item>
      <van-tabbar-item to="/screen">
        <template #icon>
          <Icon name="mirror" :size="20" />
        </template>
        选基
      </van-tabbar-item>
      <van-tabbar-item to="/watch">
        <template #icon>
          <Icon name="scroll" :size="20" />
        </template>
        自选
      </van-tabbar-item>
      <van-tabbar-item to="/assets">
        <template #icon>
          <Icon name="assets" :size="20" />
        </template>
        资产
      </van-tabbar-item>
      <van-tabbar-item to="/compare">
        <template #icon>
          <Icon name="compare" :size="20" />
        </template>
        对比
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
