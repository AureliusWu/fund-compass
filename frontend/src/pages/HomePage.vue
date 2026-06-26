<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getHealth } from '@/api/client'
import { useAppStore } from '@/stores/app'

const router = useRouter()
const app = useAppStore()
const health = ref('检查中…')

onMounted(async () => {
  try {
    const r = await getHealth()
    const ok = r.status === 'ok'
    health.value = ok ? `正常 ✓ (${r.version})` : '异常'
    app.setBackendOnline(ok)
  } catch {
    health.value = '未连接（请先启动 backend）'
    app.setBackendOnline(false)
  }
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="司南基金" />
    <div class="page-body">
      <van-cell-group inset>
        <van-cell title="后端状态" :value="health" />
        <van-cell title="开发阶段" value="M0 · 骨架" />
      </van-cell-group>
      <van-button type="primary" block style="margin-top:16px"
        @click="router.push('/fund/110020')">查看示例基金详情</van-button>
    </div>
  </div>
</template>
