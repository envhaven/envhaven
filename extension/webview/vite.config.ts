import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { rmSync } from 'fs';
import { resolve } from 'path';

function removeIndexHtml() {
  return {
    name: 'remove-index-html',
    closeBundle() {
      try {
        rmSync(resolve(__dirname, 'build/index.html'));
      } catch {}
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), removeIndexHtml()],
  build: {
    outDir: 'build',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
