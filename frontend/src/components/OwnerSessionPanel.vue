<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { ApiError } from '@/api/client'
import { clearOwnerSession, loginOwnerSession, logoutOwnerSession, ownerSession } from '@/stores/ownerSession'

const show = ref(false)
const password = ref('')
const busy = ref(false)
const error = ref('')
const expiryLabel = computed(() => ownerSession.value
  ? new Date(ownerSession.value.expires_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '')

watch(show, (visible) => {
  if (visible) { error.value = ''; return }
  password.value = ''
  if (busy.value) clearOwnerSession()
})

async function login() {
  if (busy.value || !password.value) return
  busy.value = true
  error.value = ''
  try {
    await loginOwnerSession(password.value)
    busy.value = false
    show.value = false
    showToast('已登录私人会话')
  } catch (cause) {
    error.value = cause instanceof ApiError && cause.status === 401 ? '密码不正确，请重试'
      : cause instanceof ApiError && cause.status === 429 ? '尝试过于频繁，请稍后重试'
      : cause instanceof ApiError && cause.status === 503 ? '私人会话尚未启用，请先完成服务端安全配置'
      : cause instanceof ApiError && cause.kind === 'timeout' ? '服务连接超时，请稍后重试'
      : '登录未完成，请稍后重试'
  } finally { password.value = ''; busy.value = false }
}

async function logout() {
  if (busy.value) return
  busy.value = true
  try {
    await logoutOwnerSession()
    showToast('已退出私人会话')
  } catch {
    showToast('本机会话已清除；服务端退出暂未确认')
  } finally { busy.value = false; show.value = false }
}
</script>

<template>
  <section class="owner-session" aria-label="私人会话">
    <div>
      <b>{{ ownerSession ? '私人会话已登录' : '私人会话未登录' }}</b>
      <span>{{ ownerSession ? '退出或到期后立即隐藏私人快照' : '公开行情与本地自选可继续使用' }}</span>
    </div>
    <van-button size="small" plain type="primary" @click="show = true">{{ ownerSession ? '会话管理' : '私人登录' }}</van-button>
  </section>
  <van-popup
    v-model:show="show"
    position="bottom"
    round
    closeable
    :close-on-click-overlay="!busy"
    :safe-area-inset-bottom="true"
    class="owner-popup"
  >
    <h2>私人会话</h2>
    <p>仅用于读取与管理你的私人数据。会话凭据仅保存在当前页面内存，刷新后需要重新登录；不会使用 GitHub、Admin 或 Worker 密钥。</p>
    <template v-if="ownerSession">
      <p>当前会话于 {{ expiryLabel }} 到期。</p>
      <van-button block type="primary" plain :loading="busy" @click="logout">退出并清除私人快照</van-button>
    </template>
    <van-form v-else @submit="login">
      <van-field
        v-model="password"
        name="owner-password"
        label="私人密码"
        type="password"
        autocomplete="off"
        placeholder="输入已配置的 Owner 密码"
        :disabled="busy"
        :rules="[{ required: true, message: '请输入私人密码' }]"
      />
      <p v-if="error" class="owner-error" role="alert">{{ error }}</p>
      <van-button block type="primary" native-type="submit" :loading="busy">登录</van-button>
    </van-form>
  </van-popup>
</template>

<style scoped>
.owner-session, .owner-popup { --van-primary-color: var(--teal); --van-button-primary-background: var(--teal); --van-button-primary-border-color: var(--teal); }
.owner-session { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card-bg); }
.owner-session b, .owner-session span { display: block; }
.owner-session b { color: var(--ink); font-size: 13px; }
.owner-session span { color: var(--text-muted); font-size: 11px; line-height: 1.5; margin-top: 4px; }
.owner-session .van-button { flex-shrink: 0; }
.owner-popup { padding: 24px 16px calc(80px + env(safe-area-inset-bottom)); max-height: 80vh; overflow-y: auto; }
.owner-popup h2 { color: var(--ink); font-family: var(--font-display); font-size: 18px; margin: 0 32px 16px 0; }
.owner-popup p { color: var(--text-muted); font-size: 12px; line-height: 1.7; margin: 16px 0; }
.owner-popup .owner-error { color: var(--danger); }
.owner-popup form > .van-button { margin-top: 16px; }
</style>
