import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',  // Serve from root (not subdirectory)
  build: {
    outDir: 'dist',
    sourcemap: false,  // No source maps in production
    minify: 'terser',  // Aggressive minification
    target: 'es2020',  // Modern browser support
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Code splitting for better caching
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('axios')) {
              return 'vendor'
            }
            if (id.includes('lucide-react')) {
              return 'icons'
            }
          }
        },
        // Asset naming for cache busting
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          // Handle case where name might be undefined (e.g., CSS files)
          if (!assetInfo.name) {
            return 'assets/[name]-[hash][extname]'
          }
          const info = assetInfo.name.split('.')
          const ext = info[info.length - 1]
          if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name)) {
            return 'assets/images/[name]-[hash][extname]'
          }
          if (/\.(woff2?|ttf|otf|eot)$/i.test(assetInfo.name)) {
            return 'assets/fonts/[name]-[hash][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        }
      }
    },
    // Optimize chunk size
    chunkSizeWarningLimit: 1000
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false
      }
    }
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
