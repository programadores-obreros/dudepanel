import { getViteConfig } from 'astro/config';
import type { ViteUserConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 🔴 `getViteConfig` de Astro y no `defineConfig` de vitest a secas.
 *
 *    Motivo concreto: `test/legibilidad.test.ts` **renderiza componentes
 *    `.astro` de verdad** para revisar el SVG que sale a la pantalla, y sin el
 *    plugin de Astro en el pipeline de Vite un `import` de un `.astro` explota
 *    con «invalid JS syntax» — el compilador nunca corre.
 *
 *    Y ese render es el punto de esa prueba: cuatro defectos seguidos pasaron
 *    la suite entera porque la suite miraba estructuras de datos y el defecto
 *    estaba en el dibujo. Auditar la salida de `construirLienzo` cubre casi
 *    todo, pero no cubre lo que agrega la plantilla — por ejemplo que los
 *    `<symbol>` del `<defs>` se cuelen en un conteo de nodos.
 *
 *    El resto de los tests no cambia: siguen corriendo en `node`, sin DOM.
 */

/**
 * La clave `test` no existe en el `UserConfig` de Vite: la agrega vitest con su
 * propio tipo. Se declara con el tipo de vitest y se le pasa a Astro tal cual;
 * en tiempo de ejecución es el mismo objeto y vitest la lee sin problema.
 */
const configuracion: ViteUserConfig = {
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
};

export default getViteConfig(configuracion as Parameters<typeof getViteConfig>[0]);
