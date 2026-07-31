// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // SSR completo: cada página consulta PostgreSQL en el momento. No hay build
  // estático posible — los estados cambian cada 30 s y un HTML pregenerado
  // mentiría, que es justamente el problema que venimos a resolver.
  output: 'server',

  adapter: node({ mode: 'standalone' }),

  server: {
    host: true,
    port: Number(process.env.PORT ?? 4321),
  },

  // Sin prefetch agresivo: los operadores suelen estar en 4G desde el celular.
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },

  vite: {
    plugins: [tailwindcss()],
    // `pg` es nativo de Node; que Vite no intente empaquetarlo para el cliente.
    ssr: { external: ['pg'] },
  },

  devToolbar: { enabled: false },
});
