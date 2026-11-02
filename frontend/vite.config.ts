import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The syntax worker loads each language on demand, which needs an ES module worker.
  worker: {format: 'es'},
})
