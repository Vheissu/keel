import { defineConfig } from 'vite';
import aurelia from '@aurelia/vite-plugin';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [aurelia(), tailwind()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': process.env.KEEL_API_URL || 'http://127.0.0.1:4040' },
  },
  build: { target: 'es2022' },
});
