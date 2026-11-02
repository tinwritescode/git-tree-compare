import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import {redact} from '@tanstack/redact/vite'

export default defineConfig({
  plugins: [react(), redact(), tailwindcss()]
})
