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

    // 🔴 SIN ESTO, NINGÚN FORMULARIO FUNCIONA DETRÁS DE UN PROXY. Medido.
    //
    //    Astro trae protección CSRF encendida de fábrica: rechaza un POST de
    //    formulario si la cabecera `Origin` no coincide con `Astro.url.origin`.
    //    La protección es correcta y la queremos — con autenticación básica, el
    //    navegador manda las credenciales también en un POST desde otro sitio,
    //    así que sin ella una página maliciosa podría dar equipos de baja.
    //
    //    El problema es de dónde sale `Astro.url`. El adaptador de Node
    //    DESCARTA el `Host` y las `X-Forwarded-*` salvo que el dominio esté en
    //    esta lista, y sin ella cae a `http://localhost`. Medido parcheando el
    //    middleware de Astro:
    //
    //      origin     = http://127.0.0.1:4466   ← lo que manda el navegador
    //      url.origin = http://localhost        ← lo que Astro cree que es
    //      host       = 127.0.0.1:4466
    //
    //    Nunca pueden coincidir, así que TODO formulario da 403 «Cross-site
    //    POST form submissions are forbidden» — en cualquier despliegue que no
    //    sea exactamente `http://localhost:80`.
    //
    //    🔴 Y el fallo es INVISIBLE en desarrollo: `astro dev` no aplica este
    //       middleware. Compila bien, anda perfecto en la máquina de uno, y se
    //       rompe sólo en producción. Se descubrió porque un botón nuevo
    //       devolvía 403 y el mensaje mandaba a buscar un problema de CORS que
    //       no existía.
    //
    // ── Por qué `true` y no el dominio ──────────────────────────────────────
    //
    // La imagen es la MISMA para cualquier ISP que la despliegue, y esto se
    // resuelve al compilar: poner un dominio acá obligaría a recompilar por
    // cliente. Con `true`, Astro confía en el `Host` que le llega — y quien se
    // lo manda es Caddy, que es la ÚNICA puerta: el contenedor `web` no publica
    // ningún puerto.
    //
    // La protección CSRF no se pierde: se hace en `src/middleware.ts`, contra
    // el host que reenvía el proxy en vez de contra una URL reconstruida. Ver
    // `security.checkOrigin` más abajo.
    allowedHosts: true,
  },

  // 🔴 Se apaga la comprobación de origen de Astro y se hace la nuestra.
  //
  //    NO es aflojar la seguridad: es que la de Astro no puede funcionar acá.
  //    Compara `Origin` contra `Astro.url.origin`, y detrás de un proxy esa URL
  //    no es la del navegador — el adaptador de Node descarta el `Host` salvo
  //    que el dominio esté en una lista blanca COMPILADA dentro del build, y
  //    esta imagen es la misma para cualquier ISP que la despliegue.
  //
  //    Medido parcheando su middleware: `origin=http://127.0.0.1:4466` contra
  //    `url.origin=http://localhost`. Nunca coinciden, así que rechaza TODO
  //    formulario en cualquier despliegue real.
  //
  //    La nuestra está en `src/middleware.ts` (`origenAjeno`) y compara el host
  //    del `Origin` con `x-forwarded-host`. Mismo objetivo, y se puede probar.
  security: { checkOrigin: false },

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
