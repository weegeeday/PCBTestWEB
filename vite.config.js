import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), cloudflare()],
  resolve: {
    alias: {
      '@': resolve(process.cwd(), 'src')
    },
  },
  server: {
    proxy: {
      '/git-proxy': {
        target: 'https://git.weegeeday.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/git-proxy/, '')
      }
    }
  }
})