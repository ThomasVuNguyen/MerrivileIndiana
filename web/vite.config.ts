import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // The Worker (API, Durable Objects, R2) runs in workerd inside the dev server.
  plugins: [react(), cloudflare()],
  server: { host: '0.0.0.0', port: 5180, allowedHosts: ['.ts.net'], fs: { allow: ['..'] } },
})
