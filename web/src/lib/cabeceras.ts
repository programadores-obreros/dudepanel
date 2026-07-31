import { createHash } from 'node:crypto';

/**
 * Cabeceras de seguridad, y sobre todo la CSP.
 *
 * 🔴 El panel no tenía NINGUNA: ni `Content-Security-Policy`, ni
 *    `X-Content-Type-Options`, ni `X-Frame-Options`, ni `Referrer-Policy`.
 *
 * Por qué la CSP importa acá más que en otro lado: este panel **incrusta SVG
 * ajeno en su propio documento**. Los iconos salen de `files/`, un directorio
 * que vive en un Windows 7 RTM sin parches con el 445 abierto a toda la red de
 * gestión. O sea que «quién puede escribir un archivo ahí» es una pregunta con
 * una respuesta incómoda.
 *
 * El higienizador de `iconos.ts` es la primera línea y ahora es lista blanca.
 * Pero un higienizador es código que hay que acertar; la CSP es una regla que
 * el navegador aplica aunque nos hayamos equivocado. Van las dos, y la segunda
 * existe justamente para el día que la primera falle.
 */

/**
 * El script que resuelve el tema antes del primer pintado.
 *
 * Vive acá y no suelto en `Base.astro` por una razón concreta: la CSP necesita
 * su hash exacto. Teniendo el texto en un solo lugar, el hash se calcula de
 * ese mismo texto y **no se puede desincronizar**. Si estuviera duplicado,
 * cualquier retoque al script dejaría la CSP bloqueándolo y volvería el flash
 * blanco — que es el problema que el script vino a resolver.
 */
export const GUION_TEMA = `(() => {
  try {
    const g = localStorage.getItem('tema');
    const oscuro = g === 'oscuro' || (!g && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', oscuro);
  } catch {
    /* localStorage bloqueado: queda el tema claro, que es el valor por defecto. */
  }
})();`;

/** El hash va sobre el texto EXACTO que se emite entre las etiquetas. */
const HASH_TEMA = `'sha256-${createHash('sha256').update(GUION_TEMA, 'utf8').digest('base64')}'`;

/**
 * La política.
 *
 * Decisiones que no son obvias:
 *
 *  · `default-src 'none'` — todo prohibido salvo lo que se habilita abajo. Al
 *    revés (permitir y prohibir) siempre se olvida algo.
 *
 *  · `script-src 'self' <hash>` — SIN `'unsafe-inline'`. Esto es lo que corta
 *    un `<script>` que se cuele adentro de un SVG incrustado, que es el
 *    escenario real. El único script en línea es el del tema, por hash.
 *
 *  · `style-src 'self' 'unsafe-inline'` — acá hay una concesión y la digo
 *    derecho: las barras de proporción de `/mapas` usan `style="width:…%"`
 *    calculado por fila, y un atributo `style` en línea necesita
 *    `'unsafe-inline'`. Se podría sacar pasando los porcentajes por variables
 *    CSS, pero eso también es un atributo `style`. La alternativa real es
 *    emitir una clase por valor, que para 40 mapas con porcentajes arbitrarios
 *    no cierra. Vale el cambio porque CSS no ejecuta código: lo que se puede
 *    hacer con estilos es afear la página, y `img-src` ya impide que un
 *    `url()` se lleve datos a otro lado.
 *
 *  · `img-src 'self' data:` — los iconos rasterizados salen de `/iconos/…`
 *    (propio) y el higienizador deja pasar `data:image/…` incrustado.
 *
 *  · `frame-ancestors 'none'` — que nadie lo meta en un iframe. Es la versión
 *    moderna de `X-Frame-Options`, que igual va por los que no la entienden.
 *
 *  · `form-action 'self'` y `base-uri 'none'` — el buscador es un `<form
 *    method=get>`; sin `base-uri` un `<base>` inyectado reescribe adónde van
 *    todas las rutas relativas.
 */
export const CSP = [
  "default-src 'none'",
  `script-src 'self' ${HASH_TEMA}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Todo lo que se agrega a cada respuesta.
 *
 * `X-Content-Type-Options` no es decorativo en este panel: `/iconos/…` sirve
 * bytes que puso otro, y sin esto el navegador puede adivinar el tipo por el
 * contenido y tratar como HTML algo declarado imagen.
 */
export const CABECERAS: ReadonlyArray<readonly [string, string]> = [
  ['content-security-policy', CSP],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  // `no-referrer`: no hay nada afuera a donde navegar, y las rutas del panel
  // llevan ids de equipos que no tienen por qué viajar en un encabezado.
  ['referrer-policy', 'no-referrer'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
  // El panel no usa ninguna de estas. Apagarlas es gratis.
  //
  // 🔴 NO volver a agregar `interest-cohort=()`.
  //
  //    Era el opt-out de FLoC, la propuesta de Google de 2021 para segmentar
  //    publicidad por «cohortes de interés». En 2021 se agregó en todas partes.
  //    **Google abandonó FLoC en enero de 2022** y Chrome borró el nombre de
  //    su lista, así que hoy imprime en consola:
  //
  //        Error with Permissions-Policy header: Unrecognized feature:
  //        'interest-cohort'
  //
  //    No rompía nada —el navegador descarta el token que no conoce y aplica
  //    el resto— pero ensuciaba la consola de todos los que abrían el panel.
  //    Y una consola con ruido es una consola que se deja de mirar: el día que
  //    aparezca un error de verdad, va a estar abajo de este.
  //
  //    Tampoco se pone `browsing-topics=()`, que es el reemplazo moderno:
  //    Firefox y Safari no lo conocen y devolveríamos exactamente el mismo
  //    aviso, sólo que en otros navegadores. Este panel está detrás de una
  //    contraseña y no muestra publicidad; no hay nada que optar por afuera.
  ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
];
