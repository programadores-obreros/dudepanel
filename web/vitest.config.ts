import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Los tests de la capa de datos comparten una única base; en paralelo se
    // pisarían entre sí al truncar tablas.
    fileParallelism: false,
  },
});
