import { readFile } from 'node:fs/promises';
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

/** Directorio `files/` de The Dude, montado junto a la base. */
const RAIZ = resolve(texto('DUDE_FILES_DIR', './datos/files'));

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
 * Deja pasar sólo dibujo.
 *
 * Lista negra corta y agresiva: `<script>`, `<foreignObject>` (puede meter HTML
 * arbitrario), `<use href="http…">` externo, atributos `on*` y URLs
 * `javascript:`. No pretende ser un higienizador general de SVG — pretende que
 * un archivo del directorio de The Dude no pueda ejecutar nada en el panel.
 */
export function higienizar(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(a|animate|set)\b[^>]*\bhref\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '<$1')
    .replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, ' ')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, ' ')
    .replace(/(href|xlink:href)\s*=\s*(["'])\s*(?:javascript|data:text\/html)[^"']*\2/gi, '');
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
  const abs = rutaSegura(rel);
  if (abs && /\.svgz?$/i.test(abs)) {
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
 * (`Vega_P_Ponte_AC2`, `CPE_Alvear_0031`, `SW_DC_01`).
 */
export function claveRepuesto(pista: string | null | undefined): keyof typeof REPUESTO {
  const t = (pista ?? '').toLowerCase();
  if (/rout|\brt[_-]|\bbr[_-]|rb\d|mikro|gateway|\bgw\b/.test(t)) return 'router';
  if (/\bap\b|_ac\d|access|wifi|wlan|wireless|sxt|basebox|sector/.test(t)) return 'ap';
  if (/switch|\bsw[_-]?\d|\bsw[_-]|crs|css/.test(t)) return 'switch';
  if (/bridge|brdg/.test(t)) return 'bridge';
  if (/server|\bsrv\b|srv[_-]|nas|\bvm\b|host\b/.test(t)) return 'server';
  if (/client|cpe|\bpc\b|prt[_-]|user/.test(t)) return 'cliente';
  if (/globe|internet|\bwan\b|isp|upstream/.test(t)) return 'globo';
  if (/anten|torre|tower|mast|repetidor/.test(t)) return 'antena';
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

/**
 * La clave con la que un nodo referencia su `<symbol>`.
 *
 * `f-` para los que salieron del disco y `r-` para los de repuesto. Dos nodos
 * con el mismo icono comparten clave, que es lo que permite emitir el
 * `<symbol>` una sola vez.
 */
export async function claveDeIcono(rel: string | null, nombre: string | null): Promise<string> {
  if (rel && (await leerIcono(rel))) {
    return `f-${basename(rel).replace(/[^a-zA-Z0-9]+/g, '-')}`;
  }
  return `r-${claveRepuesto(pistaDe(rel, nombre))}`;
}

export interface JuegoDeIconos {
  /** Un `<symbol>` por icono distinto. */
  simbolos: Map<string, IconoSVG>;
  /** Qué `<symbol>` usa cada nodo. */
  porNodo: Map<number, string>;
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
  const porNodo = new Map<number, string>();

  for (const n of nodos) {
    const clave = await claveDeIcono(n.icono, n.pista);
    if (!simbolos.has(clave)) {
      simbolos.set(clave, (await leerIcono(n.icono)) ?? iconoRepuesto(pistaDe(n.icono, n.pista)));
    }
    porNodo.set(n.id, clave);
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
