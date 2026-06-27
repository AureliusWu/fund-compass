<script setup lang="ts">
import { ref } from 'vue'
import { getTheme, toggleTheme, type Theme } from './utils/theme'

const theme = ref<Theme>(getTheme())
function onToggleTheme() {
  theme.value = toggleTheme()
}
</script>

<template>
  <div class="app">
    <router-view class="app-main" />
    <van-tabbar route>
      <van-tabbar-item to="/" icon="wap-home-o">首页</van-tabbar-item>
      <van-tabbar-item to="/screen" icon="search">选基</van-tabbar-item>
      <van-tabbar-item to="/watch" icon="star-o">自选</van-tabbar-item>
      <van-tabbar-item to="/assets" icon="balance-o">资产</van-tabbar-item>
      <van-tabbar-item to="/compare" icon="exchange">对比</van-tabbar-item>
    </van-tabbar>
    <span class="theme-btn" @click="onToggleTheme">
      {{ theme === 'dark' ? '☀' : '☾' }}
    </span>
  </div>
</template>

<style scoped>
.app { position: relative; }
.theme-btn {
  position: fixed;
  right: 12px;
  bottom: 66px;
  z-index: 99;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--card-bg);
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  cursor: pointer;
  user-select: none;
}
</style>
