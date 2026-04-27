// import { defineConfig } from 'vite'
// import react from '@vitejs/plugin-react'

// export default defineConfig({
//   plugins: [react()],
//   server: {
//     proxy: {
//       '/auth':    { target: 'http://localhost:8000', changeOrigin: true },
//       '/patients':{ target: 'http://localhost:8000', changeOrigin: true },
//       '/scans':   { target: 'http://localhost:8000', changeOrigin: true },
//       '/blocks':  { target: 'http://localhost:8000', changeOrigin: true },
//       '/stains':  { target: 'http://localhost:8000', changeOrigin: true },
//       '/cohorts': { target: 'http://localhost:8000', changeOrigin: true },
//       '/health':  { target: 'http://localhost:8000', changeOrigin: true },
//     }
//   },
//   build: {
//     outDir: '../api/static',
//     emptyOutDir: true,
//   }
// })
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // One rule to rule them all
      '/api': { 
        target: 'http://localhost:8000', 
        changeOrigin: true 
      },
    }
  },
  build: {
    outDir: '../api/static',
    emptyOutDir: true,
  }
})