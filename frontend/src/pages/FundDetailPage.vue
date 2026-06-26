<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()
</script>

<template>
  <div class="page">
    <van-nav-bar title="基金详情" left-text="返回" left-arrow @click-left="router.back()" />
    <div class="page-body">
      <van-empty :description="`基金 ${route.params.code} · M0 骨架，建设中`" />
    </div>
  </div>
</template>
