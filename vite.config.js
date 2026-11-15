import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In dev, forward API calls to the Express server (`npm run serve`)
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
})
