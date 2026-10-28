<script setup lang="ts">
withDefaults(defineProps<{ pending?: boolean }>(), { pending: false })
</script>

<template>
  <section v-if="pending" class="local-holding-gate" role="status" aria-live="polite">
    <strong>本地变更尚未确认，当前行动已暂停</strong>
    <p>自选或持仓已在本机变更，但尚未同步到新版私人存储。旧快照不代表新输入的建议；旧 Gist 上传也不等于新版确认。</p>
    <router-link to="/outcomes">查看历史复盘</router-link>
  </section>
  <slot v-else />
</template>

<style scoped>
.local-holding-gate { padding: 16px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--card-bg); color: var(--text-secondary); }
.local-holding-gate strong { color: var(--ink); font-family: var(--font-display); font-size: 15px; }
.local-holding-gate p { margin: 8px 0; font-size: 12px; line-height: 1.7; }
.local-holding-gate a { color: var(--teal-deep); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.local-holding-gate a:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
</style>
