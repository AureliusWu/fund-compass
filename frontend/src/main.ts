import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'vant/lib/index.css' // 保留全量样式，避免按需引入时 Toast/Dialog 等缺样式
import App from './App.vue'
import router from './router'
import './styles.css'
import { initTheme } from './utils/theme'

// 暗黑模式初始化（早于 mount，避免闪烁）
initTheme()

// Vant 组件由 unplugin-vue-components + VantResolver 按需自动引入（见 vite.config），
// 不再 app.use(Vant) 全量注册，首屏 JS 大幅减小。
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
