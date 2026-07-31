import type { ElementoMapa } from './consultas';
import { aEstado, estadoAgregado, type Estado } from './estado';

/**
 * Convierte las filas de `v_map_canvas` en geometría lista para dibujar.
 *
 * Es una función pura y sin dependencias de la base a propósito: es la parte
 * del visor que más fácil se rompe (coordenadas, enlaces colgados, elementos
 * sin posición) y así se puede probar sola.
 */

/** Lado del recuadro de un nodo, en unidades del lienzo original de The Dude. */
export const TAMANIO_NODO = 36;

export interface Nodo {
  id: number;
  /** Centro del nodo. The Dude guarda la esquina superior izquierda. */
  cx: number;
  cy: number;
  kind: 'device' | 'network' | 'submap';
  estado: Estado;
  nombre: string;
  icono: string | null;
  href: string | null;
  direcciones: string[];
  /** `true` si el elemento no traía coordenadas y se lo ubicó en la grilla. */
  reubicado: boolean;
}

export interface Enlace {
  id: number;
  /** Ids de los dos nodos que une; el refresco en vivo los vuelve a mirar. */
  de: number;
  a: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ancho: number;
  nombre: string | null;
  estado: Estado;
}

/**
 * Elemento `static`: recuadro de anotación.
 *
 * 🔴 No son un adorno, y suponerlo costaba caro.
 *
 * En la base real son 100 y no dicen «eth2» a secas: son fichas de varias
 * líneas que describen la configuración de un puerto —
 *
 *     bndn-SW16-Primero
 *     v2703, v2701, v2216, v2214, v2211, v2213, v2218, v3210, v3215
 *     Tagged
 *
 * — y, sobre todo, **los enlaces se conectan a ellas**. En el mapa Segmentos, 212
 * de sus 308 enlaces tienen al menos una punta en un `static`. Tratarlos como
 * texto decorativo y sacarlos del grafo dejaba el mapa con 18 líneas de 107
 * dibujables: la red se veía desconectada.
 *
 * Así que anclan enlaces como cualquier nodo, pero **no son nodos**: no tienen
 * estado, ni icono, ni adónde llevar. Se dibujan como texto.
 */
export interface Rotulo {
  id: number;
  /** Esquina superior izquierda del bloque de texto. */
  x: number;
  y: number;
  /** Punto donde se enganchan los enlaces: el medio del borde izquierdo. */
  ax: number;
  ay: number;
  lineas: string[];
}

/** Alto de una línea de anotación, en unidades del lienzo. */
export const ALTO_LINEA = 12;
/** Más de esto no entra sin tapar el mapa; el texto completo va en el `<title>`. */
const MAX_LINEAS = 4;
const MAX_CARACTERES = 34;

/**
 * Enlaces que existen en el mapa pero no se pudieron dibujar, y por qué.
 *
 * Que falten líneas no es lo grave: lo grave sería no decirlo. Un operador que
 * abre Segmentos, ve 107 líneas donde hay 308 enlaces y no recibe ninguna
 * explicación, concluye que la red está menos conectada de lo que está.
 */
export interface DiagnosticoEnlaces {
  total: number;
  dibujados: number;
  /** Alguna punta vive en OTRO mapa. Se puede ir a verlo. */
  otroMapa: number;
  /** Alguna punta apunta a un objeto que ya no existe. Dato roto del origen. */
  rotos: number;
}

export interface Lienzo {
  nodos: Nodo[];
  enlaces: Enlace[];
  rotulos: Rotulo[];
  /** Caja del contenido, ya con margen. */
  vista: { x: number; y: number; ancho: number; alto: number };
  /** Elementos que venían sin coordenadas y hubo que acomodar. */
  sinPosicion: number;
  /** Cuántos enlaces traía el mapa y cuántos quedaron dibujados. */
  enlacesTotales: number;
}

const MARGEN = 60;
/** Separación de la grilla donde caen los elementos sin coordenadas. */
const PASO_GRILLA = 110;

export function construirLienzo(
  elementos: readonly ElementoMapa[],
  estadoDeSubmapa: ReadonlyMap<number, Estado> = new Map(),
): Lienzo {
  const nodos: Nodo[] = [];
  const porId = new Map<number, Nodo>();

  const conPosicion = elementos.filter((e) => e.kind !== 'link' && e.kind !== 'static');

  // Los elementos sin coordenada se acomodan en una grilla debajo del contenido
  // en vez de descartarse: perder un equipo del mapa porque el ETL no le
  // encontró itemX es exactamente el bug que nadie nota hasta que se cae.
  const yBase = maximo(conPosicion.map((e) => e.y).filter(esNum), 0) + PASO_GRILLA * 1.5;
  const xBase = minimo(conPosicion.map((e) => e.x).filter(esNum), 0);
  let huerfanos = 0;

  for (const e of conPosicion) {
    const tieneXY = esNum(e.x) && esNum(e.y);
    let x: number;
    let y: number;
    if (tieneXY) {
      x = e.x as number;
      y = e.y as number;
    } else {
      x = xBase + (huerfanos % 8) * PASO_GRILLA;
      y = yBase + Math.floor(huerfanos / 8) * PASO_GRILLA;
      huerfanos++;
    }

    const estado =
      e.kind === 'submap' && e.submap_id != null
        ? (estadoDeSubmapa.get(e.submap_id) ?? aEstado(e.status))
        : aEstado(e.status);

    const nodo: Nodo = {
      id: e.element_id,
      cx: x + TAMANIO_NODO / 2,
      cy: y + TAMANIO_NODO / 2,
      kind: e.kind as Nodo['kind'],
      estado,
      nombre: e.label?.trim() || e.name?.trim() || `#${e.element_id}`,
      icono: e.icon,
      href: hrefDe(e),
      direcciones: e.direcciones ?? [],
      reubicado: !tieneXY,
    };
    nodos.push(nodo);
    porId.set(nodo.id, nodo);
  }

  // Rótulos. Van ANTES de los enlaces porque también los anclan.
  const rotulos: Rotulo[] = [];
  for (const e of elementos) {
    if (e.kind !== 'static') continue;
    const lineas = partirTexto(e.label ?? e.name);
    if (!lineas.length || !esNum(e.x) || !esNum(e.y)) continue;
    rotulos.push({
      id: e.element_id,
      x: e.x,
      y: e.y,
      ax: e.x,
      ay: e.y + (lineas.length * ALTO_LINEA) / 2,
      lineas,
    });
  }

  // Puntos a los que un enlace se puede enganchar: nodos Y rótulos.
  // Los rótulos no tienen estado, así que no tiñen el enlace — un enlace a una
  // ficha de VLAN vale lo que valga el equipo del otro extremo.
  const anclas = new Map<number, { x: number; y: number; estado: Estado | null }>();
  for (const n of nodos) anclas.set(n.id, { x: n.cx, y: n.cy, estado: n.estado });
  for (const r of rotulos) anclas.set(r.id, { x: r.ax, y: r.ay, estado: null });

  // Un enlace con un extremo que no está en este mapa se descarta: dibujarlo
  // apuntando a (0,0) deforma el encuadre y confunde más de lo que informa.
  // Pero se CUENTA, y el visor lo declara. Ver `DiagnosticoEnlaces`.
  const enlaces: Enlace[] = [];
  let enlacesTotales = 0;
  for (const e of elementos) {
    if (e.kind !== 'link') continue;
    enlacesTotales++;
    const a = e.link_from != null ? anclas.get(e.link_from) : undefined;
    const b = e.link_to != null ? anclas.get(e.link_to) : undefined;
    if (!a || !b) continue;

    enlaces.push({
      id: e.element_id,
      de: e.link_from as number,
      a: e.link_to as number,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      // `link_width` viene en unidades de The Dude; 0 o nulo significa "el
      // grosor por defecto", no "invisible".
      ancho: Math.min(Math.max(e.link_width || 2, 1), 10),
      nombre: e.name ?? e.label ?? null,
      // Un enlace está tan sano como sus dos puntas; las que no tienen estado
      // (los rótulos) no cuentan, si no todo enlace a una ficha se vería gris.
      estado: estadoAgregado([a.estado, b.estado].filter((s) => s !== null)),
    });
  }

  return {
    nodos,
    enlaces,
    rotulos,
    vista: encuadrar(nodos, rotulos),
    sinPosicion: huerfanos,
    enlacesTotales,
  };
}

/**
 * Parte la etiqueta de un rótulo en líneas dibujables.
 *
 * El origen las guarda con CR LF de Windows (son de 2011) y algunas llegan a
 * 90 caracteres en cuatro renglones. Se recorta para que no tapen el mapa; el
 * texto entero igual viaja en el `<title>` del elemento.
 */
export function partirTexto(bruto: string | null | undefined): string[] {
  if (!bruto) return [];
  return bruto
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LINEAS)
    .map((l) => (l.length > MAX_CARACTERES ? l.slice(0, MAX_CARACTERES - 1) + '…' : l));
}

/** Caja que contiene todo lo dibujable, con margen para iconos y etiquetas. */
function encuadrar(nodos: readonly Nodo[], rotulos: readonly Rotulo[]): Lienzo['vista'] {
  if (nodos.length === 0 && rotulos.length === 0) {
    return { x: 0, y: 0, ancho: 400, alto: 300 };
  }
  // De los rótulos se miden las dos esquinas: el texto crece hacia la derecha y
  // hacia abajo, y una ficha de cuatro renglones en el borde quedaría cortada.
  const ANCHO_CARACTER = 5.6;
  const xs = [
    ...nodos.map((n) => n.cx),
    ...rotulos.flatMap((r) => [
      r.x,
      r.x + Math.max(...r.lineas.map((l) => l.length)) * ANCHO_CARACTER,
    ]),
  ];
  const ys = [
    ...nodos.map((n) => n.cy),
    ...rotulos.flatMap((r) => [r.y, r.y + r.lineas.length * ALTO_LINEA]),
  ];
  const x0 = Math.min(...xs) - MARGEN;
  const y0 = Math.min(...ys) - MARGEN;
  const x1 = Math.max(...xs) + MARGEN;
  const y1 = Math.max(...ys) + MARGEN;
  return {
    x: x0,
    y: y0,
    // Un mapa de un solo nodo daría ancho 0 y el navegador no dibuja nada.
    ancho: Math.max(x1 - x0, 200),
    alto: Math.max(y1 - y0, 150),
  };
}

function hrefDe(e: ElementoMapa): string | null {
  if (e.kind === 'submap' && e.submap_id != null) return `/mapas/${e.submap_id}`;
  if (e.device_id != null) return `/dispositivos/${e.device_id}`;
  return null;
}

function esNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function maximo(xs: readonly number[], porDefecto: number): number {
  return xs.length ? Math.max(...xs) : porDefecto;
}

function minimo(xs: readonly number[], porDefecto: number): number {
  return xs.length ? Math.min(...xs) : porDefecto;
}
