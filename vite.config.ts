import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/sys_design/',
  plugins: [react()],
  assetsInclude: ['**/*.md'],
})
