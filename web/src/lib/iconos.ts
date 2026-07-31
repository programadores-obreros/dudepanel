import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';
import { texto } from './entorno';

/**
 * Iconos de los nodos del mapa.
 *
 * Los SVG reales de The Dude viven en `data/files/` (el blob de la base trae 0
 * bytes: sólo el índice). Acá se leen del disco, se limpian y se **incrustan**
 * en la página como `<symbol>`.
 *
 * Por qué incrustar y no servirlos con `<image href="/iconos/...">`:
 *
 *  1. El mapa más grande tiene 401 elementos y apenas un puñado de iconos
 *     distintos. Con `<image>` serían cientos de peticiones para repetir cinco
 *     archivos; con `<symbol>` + `<use>` se transfiere cada uno una sola vez.
 *  2. Un SVG cargado por `<image>` es un documento aparte: no hereda
 *     `currentColor` ni las variables del tema. Los iconos de repuesto quedarían
 *     negros sobre fondo oscuro.
 *  3. Sin peticiones extra, el mapa termina de dibujarse con el HTML.
 *
 * El precio es que incrustamos SVG ajeno en nuestro documento, así que hay que
 * higienizarlo. Ver `higienizar`.
 */

export interface IconoSVG {
  viewBox: string;
  /** Contenido interno del `<svg>`, ya higienizado. */
  cuerpo: string;
  /** Los de repuesto usan `currentColor` y se tiñen según el estado. */
  monocromo: boolean;
}

/**
 * Extensiones que el panel acepta como imagen, y su tipo MIME.
 *
 * 🔴 Es una LISTA BLANCA y tiene que seguir siéndolo. En `data/files/` de
 *    el ISP, al lado de los iconos, viven `certificate.pem`, 123 `.log` y
 *    109 `.txt`. Lo que no esté acá no se lee del disco ni se sirve.
 */
export const TIPOS_IMAGEN: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
};

/** Extensión en minúsculas, sin punto. `null` si no tiene. */
export function extension(rel: string | null | undefined): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(rel ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Cómo se pinta el icono de un nodo.
 *
 * Dos caminos, y la elección no es de estilo sino de formato:
 *
 *  · **SVG → `simbolo`.** Se incrusta una vez en la página y se referencia con
 *    `<use>`. Sin peticiones y hereda el tema.
 *  · **PNG/JPG/BMP → `imagen`.** No se puede incrustar sin inflar el HTML, así
 *    que va por URL. Son la mayoría: 47 de los 56 iconos que usan los mapas
 *    reales. El navegador los cachea y los reusa entre mapas.
 */
export type Pincel = { tipo: 'simbolo'; clave: string } | { tipo: 'imagen'; url: string };

/**
 * Directorio `files/` de The Dude, montado junto a la base.
 *
 * 🔴 Se aceptan los DOS nombres, y no es capricho.
 *
 *    El `docker-compose.yml` definía `DUDE_FILES` —que es lo que lee el ETL— y
 *    acá se leía `DUDE_FILES_DIR`. Nadie se dio cuenta porque el panel no se
 *    queja cuando no encuentra un icono: dibuja el de repuesto y sigue. En el
 *    contenedor esto resolvía a `/app/datos/files`, que no existe, así que
 *    **los 56 iconos caían al repuesto en silencio** y 47 de ellos eran PNG o
 *    JPG de catálogo. Un panel que parece roto sin decir por qué.
 *
 *    Aceptar los dos nombres hace que la variable de cualquiera de los dos
 *    lados alcance. Y si igual no está el directorio, `avisarSiFaltaFiles()`
 *    lo grita al arrancar en vez de degradar callado.
 */
const RAIZ = resolve(texto('DUDE_FILES_DIR') ?? texto('DUDE_FILES', './datos/files'));

/**
 * `realpath` de la raíz, una sola vez.
 *
 * Hace falta resolverla para poder comparar rutas reales contra rutas reales:
 * en un contenedor `/origen/files` puede ser un enlace, y entonces la raíz
 * léxica y la raíz real no coinciden. Comparar una contra la otra rechazaría
 * todo.
 */
let raizReal: Promise<string | null> | undefined;
function raizResuelta(): Promise<string | null> {
  raizReal ??= realpath(RAIZ).catch(() => null);
  return raizReal;
}

/**
 * Avisa fuerte si el directorio de iconos no está donde se lo espera.
 *
 * Un icono que falta es cosmético. Cincuenta y seis que faltan en silencio es
 * un panel que parece roto y nadie sabe por qué. Esto se llama al arrancar.
 */
export async function avisarSiFaltaFiles(): Promise<boolean> {
  const raiz = await raizResuelta();
  if (raiz) {
    console.info(`[iconos] directorio de iconos: ${raiz}`);
    return true;
  }
  console.error(
    `[iconos] 🔴 NO EXISTE el directorio de iconos: ${RAIZ}\n` +
      `[iconos]    Todos los iconos van a salir con el dibujo de repuesto.\n` +
      `[iconos]    Se lee DUDE_FILES_DIR y, si no está, DUDE_FILES.\n` +
      `[iconos]    Valores actuales — DUDE_FILES_DIR=${texto('DUDE_FILES_DIR') ?? '(sin definir)'}` +
      ` · DUDE_FILES=${texto('DUDE_FILES') ?? '(sin definir)'}`,
  );
  return false;
}

// Los mapas se repintan cada 30 s: releer los mismos cinco archivos del disco
// en cada carga es desperdicio puro. Los SVG de The Dude no cambian nunca.
const cache = new Map<string, IconoSVG | null>();

/**
 * Resuelve una ruta relativa dentro de `RAIZ`, o `null` si se escapa.
 *
 * `rel_path` sale de la base, y la base la llena un ETL que lee blobs de un
 * archivo de 2011. No es entrada de usuario, pero tampoco es de fiar: un
 * `../../etc/passwd` ahí adentro no debe poder leer nada.
 */
export function rutaSegura(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const limpio = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = resolve(RAIZ, limpio);
  if (abs !== RAIZ && !abs.startsWith(RAIZ + sep)) return null;
  return abs;
}

/**
 * La ruta REAL de un archivo servible, o `null`.
 *
 * 🔴 `rutaSegura` sola NO alcanza, y esto no es teoría: estaba explotado.
 *
 *    `path.resolve()` normaliza `..` pero **no sigue enlaces simbólicos**. Un
 *    enlace con nombre de imagen dentro de `files/` servía cualquier archivo
 *    del disco con los permisos del usuario `node`:
 *
 *        ln -sfn /etc/passwd files/enlace.png
 *        curl .../iconos/enlace.png    → root:x:0:0:...
 *
 *    Y el directorio donde hace falta poder escribir para montar eso es el
 *    `files/` de un Windows 7 RTM sin parches con el 445 abierto a toda la red
 *    de gestión. Ahí mismo vive `certificate.pem`.
 *
 * Por qué se rechaza el enlace en vez de sólo resolverlo:
 *
 *    Verificar que el destino cae dentro de la raíz —lo obvio— NO alcanza,
 *    porque `certificate.pem` YA ESTÁ DENTRO de la raíz. La lista blanca de
 *    extensiones mira la ruta PEDIDA (`cert.png` → png → pasa) y después se
 *    servía el contenido del destino. Contención y lista blanca, las dos
 *    juntas, seguían dejando pasar `cert.png -> certificate.pem`.
 *
 *    Así que acá se rechaza el enlace de plano. En `files/` viven archivos que
 *    escribió The Dude sobre un CIFS de Windows: enlaces simbólicos no hay, no
 *    puede haberlos, y no se pierde nada legítimo al prohibirlos.
 *
 * Las capas, y qué ataca cada una:
 *
 *  1. `rutaSegura`  — `../` y rutas absolutas (chequeo léxico, sin tocar disco).
 *  2. `lstat`       — el enlace simbólico en el último tramo.
 *  3. `realpath` + contención — un directorio padre que sea enlace y salga.
 *  4. extensión del archivo REAL — cinturón y tiradores.
 */
export async function rutaDeArchivo(rel: string): Promise<string | null> {
  const abs = rutaSegura(rel);
  if (!abs) return null;

  const raiz = await raizResuelta();
  if (!raiz) return null;

  try {
    // `lstat` y no `stat`: `stat` SIGUE el enlace y devolvería los datos del
    // destino, o sea que un enlace a un archivo común pasaría por archivo común.
    const info = await lstat(abs);
    if (info.isSymbolicLink() || !info.isFile()) return null;

    const real = await realpath(abs);
    if (real !== raiz && !real.startsWith(raiz + sep)) return null;

    const ext = extension(real);
    if (!ext || !Object.hasOwn(TIPOS_IMAGEN, ext)) return null;

    return real;
  } catch {
    // No está, no se puede leer, o se lo llevaron en el medio. Sin icono.
    return null;
  }
}

// ── Higienizado del SVG ─────────────────────────────────────────────────────
//
// 🔴 Acá había una LISTA NEGRA de expresiones regulares, y estaba rota. Medido:
//
//    ANIDADO    <svg><scr<script>x</script>ipt>alert(1)</scr<script>y</script>ipt></svg>
//               → <svg><script>alert(1)</script></svg>
//               El reemplazo de `<script>…</script>` sacaba el de adentro y al
//               sacarlo PEGABA los pedazos de afuera: `scr` + `ipt`. O sea que
//               el higienizador CONSTRUÍA la etiqueta que venía a sacar.
//
//    SIN CIERRE <svg><script>alert(1)</svg>
//               → idéntico. El patrón exigía `</script>`; sin cierre no
//               coincidía con nada y pasaba entero.
//
//    ANIMATE    <svg><a><animate attributeName="href" values="javascript:alert(1)"/>…
//               → idéntico. El patrón buscaba un atributo `href=`, y acá el
//               `javascript:` viaja adentro de `values`.
//
// Una lista negra sólo conoce los ataques que ya vimos. Esto es una LISTA
// BLANCA: se parsea, y sale únicamente lo que está explícitamente permitido.
// Lo que no se reconoce no se "limpia" — no se emite.
//
// El inventario de abajo NO es de memoria: sale de contar qué usan los 26 SVG
// reales del ISP. Importa porque una lista blanca entusiasta deja el icono
// en blanco, y ahí `style=` aparece 479 veces y `xlink:href` 10.

/** Nombre en minúsculas → nombre canónico. SVG distingue mayúsculas. */
const ELEMENTOS = new Map<string, string>(
  (
    [
      'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
      'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
      'text', 'tspan', 'textPath', 'image',
      'linearGradient', 'radialGradient', 'stop', 'pattern',
      'clipPath', 'mask', 'marker', 'filter',
      'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComposite',
      'feFlood', 'feMerge', 'feMergeNode', 'feMorphology', 'feDropShadow', 'feTile',
    ] as const
  ).map((n) => [n.toLowerCase(), n as string]),
);

/**
 * Elementos que se van CON TODO SU CONTENIDO.
 *
 * `animate` y `set` están acá porque animar `attributeName="href"` es
 * exactamente el bypass que se midió: la carga no está en un atributo `href`,
 * está en `values`/`to`, y la animación la escribe en el `href` después.
 */
const TRAGAR = new Set([
  'script', 'style', 'foreignobject', 'metadata', 'handler', 'listener',
  'animate', 'animatetransform', 'animatemotion', 'animatecolor', 'set', 'mpath',
]);

/**
 * Atributos permitidos.
 *
 * Los `on*` no están —ni hace falta enumerarlos, porque lo que no está en esta
 * lista no sale— y tampoco los `inkscape:*`/`sodipodi:*`, que son basura del
 * editor y no dibujan nada.
 */
const ATRIBUTOS = new Map<string, string>(
  (
    [
      // Identidad y agrupación
      'id', 'class', 'transform', 'style',
      // Geometría
      'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
      'width', 'height', 'dx', 'dy', 'rotate', 'textLength',
      // Lienzo
      'viewBox', 'preserveAspectRatio', 'overflow', 'display', 'visibility',
      'enable-background', 'version', 'xmlns', 'xmlns:xlink', 'xml:space',
      // Pintura
      'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
      'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
      'stroke-miterlimit', 'opacity', 'color', 'clip-rule', 'vector-effect',
      'shape-rendering',
      // Degradados y patrones
      'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
      'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform',
      'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerUnits',
      'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
      // Texto
      'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
      'text-anchor', 'dominant-baseline', 'baseline-shift', 'writing-mode',
      // Filtros
      'result', 'in', 'in2', 'stdDeviation', 'mode', 'values', 'type', 'operator',
      'flood-color', 'flood-opacity', 'k1', 'k2', 'k3', 'k4', 'radius', 'filterUnits',
    ] as const
  ).map((n) => [n.toLowerCase(), n as string]),
);

/**
 * Atributos cuyo VALOR es una referencia y hay que mirar aparte.
 *
 * El case canónico se conserva —`viewBox`, no `viewbox`— para no depender de
 * la tabla de corrección del parser de HTML. Adentro de un `<svg>` en HTML esa
 * tabla existe y arreglaría el nombre, pero apoyarse en ella es apoyarse en un
 * detalle del parser que no controlamos.
 */
const REFERENCIAS = new Map<string, string>(
  (['href', 'xlink:href', 'clip-path', 'mask', 'filter',
    'marker-start', 'marker-mid', 'marker-end'] as const).map((n) => [n, n as string]),
);

/** Sólo referencias internas al mismo documento: `#loQueSea`. */
const FRAGMENTO = /^#[A-Za-z_][\w.:-]*$/;

/** Imágenes incrustadas. Nada de traer bytes de la red. */
const DATOS_IMAGEN = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;

/** `url(#algo)` sí; `url(http…)` no. */
const URL_EN_VALOR = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function pinturaSegura(valor: string): boolean {
  URL_EN_VALOR.lastIndex = 0;
  for (const m of valor.matchAll(URL_EN_VALOR)) {
    if (!FRAGMENTO.test((m[2] ?? '').trim())) return false;
  }
  return !/javascript:|expression\(|@import|behavior\s*:|-moz-binding/i.test(valor);
}

/**
 * Limpia un `style=` declaración por declaración.
 *
 * Por declaración y no todo o nada: si una sola regla es sospechosa, tirar el
 * atributo entero dejaría el icono sin colores. Se tira la regla, no el icono.
 */
function limpiarEstilo(css: string): string {
  return css
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && pinturaSegura(d))
    .join('; ');
}

function valorDeAtributo(nombre: string, valor: string): string | null {
  if (REFERENCIAS.has(nombre)) {
    const v = valor.trim();
    if (FRAGMENTO.test(v)) return v;
    if (nombre.endsWith('href') && DATOS_IMAGEN.test(v)) return v;
    return null;
  }
  if (nombre === 'style') {
    const limpio = limpiarEstilo(valor);
    return limpio || null;
  }
  return pinturaSegura(valor) ? valor : null;
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escaparValor(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Índice del `>` que cierra la etiqueta abierta en `desde`, respetando comillas. */
function finDeEtiqueta(s: string, desde: number): number {
  let comilla = '';
  for (let i = desde; i < s.length; i++) {
    const c = s[i]!;
    if (comilla) {
      if (c === comilla) comilla = '';
    } else if (c === '"' || c === "'") {
      comilla = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

const ATRIBUTO = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function atributosLimpios(bruto: string): string {
  let salida = '';
  for (const m of bruto.matchAll(ATRIBUTO)) {
    const nombre = m[1]!.toLowerCase();
    const canonico = ATRIBUTOS.get(nombre) ?? REFERENCIAS.get(nombre);
    if (!canonico) continue;
    const valor = m[2] ?? m[3] ?? m[4] ?? '';
    const limpio = valorDeAtributo(nombre, valor);
    if (limpio === null) continue;
    salida += ` ${canonico}="${escaparValor(limpio)}"`;
  }
  return salida;
}

/**
 * Deja pasar sólo dibujo.
 *
 * Recorre el documento como etiquetas y texto, y emite únicamente los
 * elementos y atributos de las listas de arriba. No intenta "arreglar" lo que
 * no reconoce: lo descarta.
 *
 * Lo que SÍ se conserva, porque es lo que hace que un icono se vea: las
 * referencias internas. `fill="url(#grad1)"` y `<use xlink:href="#c1">` pasan;
 * `url(http://…)` y `href="javascript:…"` no.
 */
export function higienizar(svg: string): string {
  let salida = '';
  let i = 0;

  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt < 0) {
      salida += escapar(svg.slice(i));
      break;
    }
    salida += escapar(svg.slice(i, lt));

    // Comentarios, CDATA, DOCTYPE e instrucciones de proceso: nada que dibujar.
    if (svg.startsWith('<!--', lt)) {
      const f = svg.indexOf('-->', lt + 4);
      i = f < 0 ? svg.length : f + 3;
      continue;
    }
    if (svg.startsWith('<![CDATA[', lt)) {
      const f = svg.indexOf(']]>', lt + 9);
      i = f < 0 ? svg.length : f + 3;
      continue;
    }
    if (svg.startsWith('<!', lt) || svg.startsWith('<?', lt)) {
      const f = finDeEtiqueta(svg, lt + 1);
      i = f < 0 ? svg.length : f + 1;
      continue;
    }

    const fin = finDeEtiqueta(svg, lt + 1);
    if (fin < 0) {
      // Un `<` suelto que no abre nada: es texto.
      salida += '&lt;';
      i = lt + 1;
      continue;
    }

    const interior = svg.slice(lt + 1, fin);
    i = fin + 1;

    // Etiqueta de cierre.
    if (interior.startsWith('/')) {
      const nombre = /^\/\s*([A-Za-z][\w.:-]*)/.exec(interior)?.[1]?.toLowerCase();
      const canonico = nombre ? ELEMENTOS.get(nombre) : undefined;
      if (canonico) salida += `</${canonico}>`;
      continue;
    }

    const nombre = /^([A-Za-z][\w.:-]*)/.exec(interior)?.[1]?.toLowerCase();
    if (!nombre) continue;

    const soloCierra = interior.trimEnd().endsWith('/');
    const canonico = ELEMENTOS.get(nombre);

    if (canonico) {
      salida += `<${canonico}${atributosLimpios(interior)}${soloCierra ? '/>' : '>'}`;
      continue;
    }

    // No permitido. Los peligrosos se llevan su contenido; el resto se va solo
    // y deja pasar lo que tenga adentro, que puede ser dibujo legítimo.
    const conContenido = TRAGAR.has(nombre) || nombre.includes(':');
    if (conContenido && !soloCierra) {
      const cierre = new RegExp(`</\\s*${nombre.replace(/[.:*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i');
      const resto = svg.slice(i);
      const m = cierre.exec(resto);
      i = m ? i + m.index + m[0].length : svg.length;
    }
  }

  return salida;
}

/** Extrae `viewBox` y contenido del `<svg>` raíz. */
function partir(svg: string): IconoSVG | null {
  const apertura = svg.match(/<svg\b([^>]*)>/i);
  if (!apertura) return null;
  const cierre = svg.lastIndexOf('</svg');
  if (cierre < 0) return null;

  const attrs = apertura[1] ?? '';
  const vb = attrs.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  // Sin viewBox hay que fabricarlo con width/height, si no `<use>` escala mal.
  const w = numeroDe(attrs.match(/\bwidth\s*=\s*["']?([\d.]+)/i)?.[1]);
  const h = numeroDe(attrs.match(/\bheight\s*=\s*["']?([\d.]+)/i)?.[1]);

  const cuerpo = svg.slice((apertura.index ?? 0) + apertura[0].length, cierre).trim();
  if (!cuerpo) return null;

  return {
    viewBox: vb ?? (w && h ? `0 0 ${w} ${h}` : '0 0 24 24'),
    cuerpo,
    monocromo: false,
  };
}

/** Lee y cachea un icono del disco. `null` si no está o no se pudo interpretar. */
export async function leerIcono(rel: string | null | undefined): Promise<IconoSVG | null> {
  if (!rel) return null;
  if (cache.has(rel)) return cache.get(rel) ?? null;

  let resultado: IconoSVG | null = null;
  // `rutaDeArchivo` y no `rutaSegura`: la segunda no ve los enlaces simbólicos.
  const abs = extension(rel) === 'svg' ? await rutaDeArchivo(rel) : null;
  // Sólo SVG: un PNG no se incrusta, se sirve por URL. Ver `Pincel`.
  if (abs) {
    try {
      // Techo de tamaño: un "SVG" de 40 MB en el directorio no debe poder
      // volcarse dentro del HTML de una página.
      const bruto = await readFile(abs, 'utf8');
      if (bruto.length <= 256_000) {
        resultado = partir(higienizar(bruto));
      }
    } catch {
      // Falta el archivo o no se puede leer: se usa el de repuesto. Que un
      // icono no esté no puede dejar al operador sin mapa.
      resultado = null;
    }
  }

  cache.set(rel, resultado);
  return resultado;
}

// ── Iconos de repuesto ──────────────────────────────────────────────────────
// Line art monocromo en una grilla de 24. Usan `currentColor`, así que se tiñen
// solos según el tema y el estado.

const REPUESTO: Record<string, string> = {
  router: `<circle cx="12" cy="12" r="8"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>`,
  ap: `<path d="M12 15.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="currentColor" stroke="none"/><path d="M8.2 9.7a5 5 0 0 0 0 7.1M15.8 9.7a5 5 0 0 1 0 7.1"/><path d="M5.4 6.9a9 9 0 0 0 0 12.7M18.6 6.9a9 9 0 0 1 0 12.7"/>`,
  switch: `<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11.5h3.5M7 14h2M14 10.5l2.5 2.5L14 15.5"/>`,
  bridge: `<path d="M3 16c0-5 4-8 9-8s9 3 9 8"/><path d="M3 16h18M7.5 16v-3.6M12 16V9.6M16.5 16v-3.6"/>`,
  server: `<rect x="4" y="3.5" width="16" height="7" rx="1.5"/><rect x="4" y="13.5" width="16" height="7" rx="1.5"/><path d="M7.5 7h.01M7.5 17h.01"/>`,
  cliente: `<rect x="3" y="5" width="18" height="11" rx="1.5"/><path d="M8 20h8M12 16v4"/>`,
  globo: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.4 3.5 8.5S14.3 18.1 12 20.5c-2.3-2.4-3.5-5.4-3.5-8.5S9.7 5.9 12 3.5Z"/>`,
  antena: `<path d="M12 21V9"/><path d="m7 9 5-6 5 6"/><path d="M8 21h8"/>`,
  submapa: `<path d="m3 6.5 6-2.5 6 2.5 6-2.5v13l-6 2.5-6-2.5-6 2.5v-13Z"/><path d="M9 4v13M15 6.5v13"/>`,
  red: `<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M12 7.2v4.3M10.6 12.6 6.4 16.2M13.4 12.6l4.2 3.6"/>`,
  generico: `<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6"/>`,
};

/**
 * Elige un icono de repuesto.
 *
 * La pista más confiable es el NOMBRE DEL ARCHIVO que The Dude tenía asignado
 * (`router.svg`, `ap.svg`, `client.svg`…): es una clasificación que alguien
 * hizo a mano equipo por equipo. El nombre del nodo es la segunda opción, y
 * acierta bastante porque en el ISP se nombra por función
 * (`Vega_P_Aurora_AC2`, `CPE_Bahia_0031`, `SW_DC_01`).
 */
export function claveRepuesto(pista: string | null | undefined): keyof typeof REPUESTO {
  const t = (pista ?? '').toLowerCase();
  // El orden importa: lo más específico primero. Los nombres de archivo reales
  // del ISP son de catálogo (`nanomder.png`, `rb2011.png`, `crs305.png`),
  // así que los modelos concretos mandan sobre las palabras genéricas.
  if (/nanobridge|bridge|brdg/.test(t)) return 'bridge';
  if (/airfiber|dish|panel|basestation|anten|torre|tower|mast|repetidor/.test(t)) return 'antena';
  if (/nano|rocket|\bap\b|_ac\d|access|wifi|wlan|wireless|sxt|basebox|sector|loco/.test(t))
    return 'ap';
  if (/crs\d|css\d|switch|\bsw[_-]?\d|\bsw[_-]/.test(t)) return 'switch';
  if (/ccr\d|\brb\d|hex|hap|rout|\brt[_-]|\bbr[_-]|mikro|gateway|\bgw\b|olt/.test(t))
    return 'router';
  if (/server|\bsrv\b|srv[_-]|nas|\bvm\b|host\b|\bdns\b/.test(t)) return 'server';
  if (/client|cpe|\bpc\b|prt[_-]|user/.test(t)) return 'cliente';
  if (/globe|internet|\bwan\b|isp|upstream/.test(t)) return 'globo';
  if (/submap|submapa|\bmapa?\b/.test(t)) return 'submapa';
  if (/\bnet\b|network|\blan\b|subnet|\bred\b/.test(t)) return 'red';
  return 'generico';
}

/**
 * Junta el nombre del archivo con el del nodo en una sola pista.
 *
 * Van los dos porque se complementan: el archivo dice la categoría que eligió
 * el operador de The Dude y el nombre dice la función real. Si un elemento no
 * tiene icono asignado (los submapas, por ejemplo), queda sólo el nombre.
 */
export function pistaDe(rel: string | null | undefined, nombre: string | null | undefined): string {
  return [rel ? basename(rel) : '', nombre ?? ''].filter(Boolean).join(' ');
}

export function iconoRepuesto(pista: string | null | undefined): IconoSVG {
  const clave = claveRepuesto(pista);
  return {
    viewBox: '0 0 24 24',
    cuerpo: `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${REPUESTO[clave]}</g>`,
    monocromo: true,
  };
}

/** URL pública de un icono rasterizado. Los espacios de «panel 5m.jpg» y demás
 *  hay que escaparlos o la URL sale rota. */
export function urlDeIcono(rel: string): string {
  const limpio = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return '/iconos/' + limpio.split('/').map(encodeURIComponent).join('/');
}

/**
 * Con qué se pinta un nodo.
 *
 * `f-` para el SVG que salió del disco y `r-` para el de repuesto. Dos nodos
 * con el mismo icono comparten clave, que es lo que permite emitir el
 * `<symbol>` una sola vez.
 */
export async function pincelDeIcono(rel: string | null, nombre: string | null): Promise<Pincel> {
  const ext = extension(rel);

  // Rasterizado y conocido: va por URL aunque el archivo todavía no esté en
  // disco — el endpoint responde con el repuesto y el mapa no queda con huecos.
  //
  // `Object.hasOwn` y no `TIPOS_IMAGEN[ext]` a secas: `TIPOS_IMAGEN['constructor']`
  // devuelve la función heredada del prototipo, que es truthy. La guarda no
  // guardaba. Ver la nota en el endpoint `/iconos/[...ruta]`.
  if (rel && ext && ext !== 'svg' && ext !== 'svgz' && Object.hasOwn(TIPOS_IMAGEN, ext)) {
    return { tipo: 'imagen', url: urlDeIcono(rel) };
  }

  if (rel && (await leerIcono(rel))) {
    return { tipo: 'simbolo', clave: `f-${basename(rel).replace(/[^a-zA-Z0-9]+/g, '-')}` };
  }
  return { tipo: 'simbolo', clave: `r-${claveRepuesto(pistaDe(rel, nombre))}` };
}

export interface JuegoDeIconos {
  /** Un `<symbol>` por icono vectorial distinto. */
  simbolos: Map<string, IconoSVG>;
  /** Con qué se pinta cada nodo. */
  porNodo: Map<number, Pincel>;
}

/**
 * Resuelve de una sola pasada los iconos de todos los nodos de un mapa.
 *
 * Devuelve el juego deduplicado y la asignación por nodo, que es lo que el
 * visor necesita para emitir `<symbol>` una vez y `<use>` muchas.
 */
export async function juegoDeIconos(
  nodos: readonly { id: number; icono: string | null; pista: string | null }[],
): Promise<JuegoDeIconos> {
  const simbolos = new Map<string, IconoSVG>();
  const porNodo = new Map<number, Pincel>();

  for (const n of nodos) {
    const pincel = await pincelDeIcono(n.icono, n.pista);
    if (pincel.tipo === 'simbolo' && !simbolos.has(pincel.clave)) {
      simbolos.set(
        pincel.clave,
        (await leerIcono(n.icono)) ?? iconoRepuesto(pistaDe(n.icono, n.pista)),
      );
    }
    porNodo.set(n.id, pincel);
  }

  return { simbolos, porNodo };
}

function numeroDe(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Sólo para los tests: la caché es global al proceso. */
export function limpiarCacheIconos(): void {
  cache.clear();
}
