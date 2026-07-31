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

    // 🔴 NINGÚN SCRIPT EN LÍNEA. Es un requisito, no una preferencia.
    //
    //    La CSP de este panel es `script-src 'self' 'sha256-…'` con UN solo
    //    hash: el del guioncito del tema, calculado en `lib/cabeceras.ts` sobre
    //    su texto exacto. Cualquier OTRO script en línea tiene otro hash y el
    //    navegador lo bloquea — que es justamente para lo que está la CSP.
    //
    //    Y por omisión Astro decide si deja un script en línea o lo saca a un
    //    archivo **según su tamaño**. O sea: un script chico se rompe, y el
    //    mismo script se arregla solo cuando crece. Es una trampa que espera.
    //
    //    Pasó de verdad. La página de cerrar sesión se quedaba en «Cerrando…»
    //    para siempre porque su módulo pesaba 588 bytes y quedó en línea.
    //    Compilaba, se servía, se veía bien y no hacía nada: no hay error en
    //    la compilación, no hay 404, sólo una CSP haciendo su trabajo.
    //
    //    Con el límite en 0, todo sale a un archivo servido desde `'self'` y el
    //    comportamiento deja de depender de cuántas líneas tenga el código.
    build: { assetsInlineLimit: 0 },
  },

  devToolbar: { enabled: false },
});
