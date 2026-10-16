import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const vuePlugin = vue()
const transformVue = vuePlugin.transform
if (typeof transformVue !== 'function') throw new Error('Vue test transform is unavailable')

// Keep PWA plugins out of tests; Vue's custom renderer exercises real SFCs
// without installing a browser/DOM implementation for pure-function tests.
export default defineConfig({
  plugins: [{
    ...vuePlugin,
    // The node runner normally asks for SSR compilation. These mounted tests
    // intentionally exercise the client render function via a custom renderer.
    transform(code, id, options) {
      return transformVue.call(this, code, id, { ...options, ssr: false })
    },
  }],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
