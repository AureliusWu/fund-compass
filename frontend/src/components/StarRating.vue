<script setup lang="ts">
defineProps<{ star: number | null }>()
</script>

<template>
  <span class="stars" :title="(star ?? 0) + ' 星'">
    <span class="on">{{ '★'.repeat(star ?? 0) }}</span><span class="off">{{ '☆'.repeat(Math.max(0, 5 - (star ?? 0))) }}</span>
  </span>
</template>

<style scoped>
.stars { font-size: 13px; letter-spacing: 1px; }
.on { color: #ffb400; }
.off { color: #dcdee0; }
</style>
