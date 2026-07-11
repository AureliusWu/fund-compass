import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'
import { fileURLToPath, URL } from 'node:url'

// 部署在 GitHub Pages 子路径下：https://aureliuswu.github.io/fund-compass/
export default defineConfig({
  base: '/fund-compass/',
  plugins: [
    vue(),
    // Vant 组件按需自动引入；importStyle:false → 复用 main.ts 的全量 CSS，避免缺样式
    Components({ resolvers: [VantResolver({ importStyle: false })] }),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // 大的富集/排行数据不进安装期预缓存，改运行时按需缓存
        globIgnores: ['**/data/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fc-api-v2',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 排行/富集静态数据：StaleWhileRevalidate，首次后秒开 + 离线可用 + 后台更新
            urlPattern: ({ url }) => url.pathname.includes('/data/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'fc-data',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: '司南基金',
        short_name: '司南基金',
        description: '个人基金选基与择时辅助工具',
        theme_color: '#3F765C',
        background_color: '#F8F7F1',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  build: {
    // echarts（含 PieChart）按需引入后约 533KB 已是合理下限，提高阈值消除噪音告警
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // echarts + 其渲染内核 zrender 多页共用，单独成块：浏览器可长期缓存，不重复打进各页 chunk
        manualChunks(id) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts'
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    // 开发时把 /api 代理到本地 FastAPI，绕开跨域
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true }
    }
  }
})
