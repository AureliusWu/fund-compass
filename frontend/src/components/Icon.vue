<script setup lang="ts">
// 描金青绿图标系统 · 宋代器物纹样 + 极简线稿
// 线宽 2px，圆角适中，青绿色，hover 描金
defineProps<{ name: string; size?: number; color?: string }>()
</script>

<template>
  <svg
    :width="size ?? 20" :height="size ?? 20"
    viewBox="0 0 24 24" fill="none"
    :stroke="color || 'currentColor'" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"
    class="sinan-icon"
  >
    <!-- 山峰（基金） -->
    <template v-if="name === 'mountain'">
      <path d="M3 20L10 6L14 14L20 4L21 20H3Z" />
      <path d="M7 20L10 14" stroke-width="1" opacity="0.4" />
    </template>

    <!-- 山脉走势（趋势） -->
    <template v-if="name === 'trend'">
      <path d="M2 18L6 10L10 14L14 6L18 12L22 4" />
      <circle cx="22" cy="4" r="1.5" fill="currentColor" stroke="none" />
    </template>

    <!-- 罗盘（分析） -->
    <template v-if="name === 'compass'">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" opacity="0.4" />
      <path d="M12 2L14 8L20 12L14 16L12 22L10 16L4 12L10 8Z" opacity="0.6" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </template>

    <!-- 卷轴（自选） -->
    <template v-if="name === 'scroll'">
      <path d="M6 3H18V21H6V3Z" />
      <path d="M3 7H6" opacity="0.5" />
      <path d="M3 17H6" opacity="0.5" />
      <path d="M18 7H21" opacity="0.5" />
      <path d="M18 17H21" opacity="0.5" />
      <path d="M9 8H15" opacity="0.3" stroke-width="1.5" />
      <path d="M9 11H15" opacity="0.3" stroke-width="1.5" />
      <path d="M9 14H13" opacity="0.3" stroke-width="1.5" />
    </template>

    <!-- 金线（收益） -->
    <template v-if="name === 'goldline'">
      <path d="M3 20C7 14 9 6 13 6C17 6 17 16 21 16" />
      <path d="M21 12V16H17" />
    </template>

    <!-- 祥云（AI） -->
    <template v-if="name === 'cloud'">
      <path d="M6 18C3 18 2 15 4 13C3 11 4 8 7 8C7 5 10 3 13 5C15 3 19 4 20 7C22 7 22 10 20 11C21 13 20 16 18 16" />
      <circle cx="14" cy="10" r="0.8" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="11" cy="8" r="0.6" fill="currentColor" stroke="none" opacity="0.4" />
      <circle cx="16" cy="7" r="0.5" fill="currentColor" stroke="none" opacity="0.4" />
    </template>

    <!-- 玉璧（设置） -->
    <template v-if="name === 'jade'">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" opacity="0.4" />
      <path d="M12 2V6M12 18V22M2 12H6M18 12H22" opacity="0.3" stroke-width="1.5" />
    </template>

    <!-- 铜镜（搜索） -->
    <template v-if="name === 'mirror'">
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16L21 21" />
      <path d="M8 11H14" opacity="0.3" stroke-width="1" />
      <path d="M11 8V14" opacity="0.3" stroke-width="1" />
    </template>

    <!-- 铜铃（通知） -->
    <template v-if="name === 'bell'">
      <path d="M8 18H16" />
      <path d="M12 2C8 2 6 5 6 8V12L4 14V16H20V14L18 12V8C18 5 16 2 12 2Z" />
      <circle cx="17" cy="6" r="2.5" fill="var(--danger)" stroke="none" opacity="0.9" />
    </template>

    <!-- 玉佩（收藏） -->
    <template v-if="name === 'jade-pendant'">
      <path d="M8 2H16L18 6L12 10L6 6L8 2Z" />
      <circle cx="12" cy="10" r="2" opacity="0.5" />
      <path d="M10 12C10 12 11 16 12 22C13 16 14 12 14 12" opacity="0.4" />
    </template>

    <!-- 房子（首页） -->
    <template v-if="name === 'home'">
      <path d="M2 10L12 2L22 10" />
      <path d="M4 9V20H20V9" opacity="0.4" />
      <path d="M9 20V13H15V20" />
    </template>

    <!-- 对比 -->
    <template v-if="name === 'compare'">
      <path d="M4 4H10V20H4Z" opacity="0.3" />
      <path d="M14 8H20V20H14Z" opacity="0.3" />
      <path d="M7 8V16" />
      <path d="M17 12V16" />
    </template>

    <!-- 资产（天平/钱袋） -->
    <template v-if="name === 'assets'">
      <path d="M6 8L12 3L18 8" />
      <path d="M6 8V20H18V8" />
      <path d="M9 16H15" opacity="0.4" />
      <path d="M12 11V20" opacity="0.3" stroke-width="1" />
    </template>

    <!-- 导出 -->
    <template v-if="name === 'export'">
      <path d="M12 3V16" />
      <path d="M7 10L12 3L17 10" />
      <path d="M4 17V21H20V17" />
    </template>

    <!-- 加号 -->
    <template v-if="name === 'plus'">
      <path d="M12 5V19" />
      <path d="M5 12H19" />
    </template>

    <!-- 叉号 -->
    <template v-if="name === 'close'">
      <path d="M6 6L18 18" />
      <path d="M18 6L6 18" />
    </template>

    <!-- 勾号 -->
    <template v-if="name === 'check'">
      <path d="M5 13L9 17L19 7" />
    </template>

    <!-- 返回箭头 -->
    <template v-if="name === 'arrow-left'">
      <path d="M16 4L6 12L16 20" />
    </template>

    <!-- 太阳 -->
    <template v-if="name === 'sun'">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1V3M12 21V23M1 12H3M21 12H23" opacity="0.3" stroke-width="1.5" />
      <path d="M4 4L6 6M18 18L20 20M4 20L6 18M18 6L20 4" opacity="0.2" stroke-width="1.5" />
    </template>

    <!-- 月亮 -->
    <template v-if="name === 'moon'">
      <path d="M19 13C18 17 14 20 10 19C8 18 7 16 7 14C7 10 10 7 14 7C16 7 18 8 19 10C18 9 16 8 14 9C11 10 10 13 11 16C12 18 14 19 16 18C17 17 18 16 19 13Z" />
    </template>

    <!-- 拍快照 -->
    <template v-if="name === 'camera'">
      <path d="M22 18C22 19 21 20 20 20H4C3 20 2 19 2 18V9C2 8 3 7 4 7H7L9 4H15L17 7H20C21 7 22 8 22 9Z" />
      <circle cx="12" cy="14" r="3.5" />
      <circle cx="12" cy="14" r="1" fill="currentColor" stroke="none" opacity="0.4" />
    </template>

    <!-- 信息 -->
    <template v-if="name === 'info'">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 10V17" />
      <circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" />
    </template>

    <!-- 警告 -->
    <template v-if="name === 'warn'">
      <path d="M12 3L2 21H22L12 3Z" />
      <path d="M12 10V14" />
      <circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </template>

    <!-- 点数（三点更多） -->
    <template v-if="name === 'dots'">
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </template>

    <!-- 刷新 -->
    <template v-if="name === 'refresh'">
      <path d="M2 12C2 7 6 3 11 3C15 3 18 5 20 8" />
      <path d="M22 12C22 17 18 21 13 21C9 21 6 19 4 16" opacity="0.4" />
      <path d="M20 4V8H16" opacity="0.5" />
    </template>

    <!-- fallback: 菱形 -->
    <template v-if="!name">
      <rect x="6" y="6" width="12" height="12" rx="3" transform="rotate(45 12 12)" />
    </template>
  </svg>
</template>

<style scoped>
.sinan-icon {
  transition: stroke 0.2s var(--ease-out);
  flex-shrink: 0;
}
.sinan-icon:hover {
  stroke: var(--gold);
}
</style>
