import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/agent/',
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  plugins: [react()],
});
