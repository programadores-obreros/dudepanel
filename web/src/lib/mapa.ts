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
 * Elemento `static`: texto suelto sobre el lienzo.
 *
 * En la base real hay 100, y son cosas como «eth2» o «eth4» puestas al lado de
 * un enlace para decir por qué puerto sale. No representan nada monitoreable:
 * no tienen icono, ni estado, ni adónde llevar. Dibujarlos como nodos sería
 * inventar cien equipos que no existen.
 */
export interface Rotulo {
  id: number;
  x: number;
  y: number;
  texto: string;
}

export interface Lienzo {
  nodos: Nodo[];
  enlaces: Enlace[];
  rotulos: Rotulo[];
  /** Caja del contenido, ya con margen. */
  vista: { x: number; y: number; ancho: number; alto: number };
  /** Elementos que venían sin coordenadas y hubo que acomodar. */
  sinPosicion: number;
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

  // Los enlaces se resuelven contra los nodos ya ubicados. Uno cuyo extremo no
  // está en este mapa se descarta: dibujarlo apuntando a (0,0) deforma el
  // encuadre y confunde más de lo que informa.
  const enlaces: Enlace[] = [];
  for (const e of elementos) {
    if (e.kind !== 'link') continue;
    const a = e.link_from != null ? porId.get(e.link_from) : undefined;
    const b = e.link_to != null ? porId.get(e.link_to) : undefined;
    if (!a || !b) continue;

    enlaces.push({
      id: e.element_id,
      de: a.id,
      a: b.id,
      x1: a.cx,
      y1: a.cy,
      x2: b.cx,
      y2: b.cy,
      // `link_width` viene en unidades de The Dude; 0 o nulo significa "el
      // grosor por defecto", no "invisible".
      ancho: Math.min(Math.max(e.link_width || 2, 1), 10),
      nombre: e.name ?? e.label ?? null,
      // Un enlace está tan sano como sus dos puntas.
      estado: estadoAgregado([a.estado, b.estado]),
    });
  }

  // Rótulos: texto y nada más. Se ignoran los que no tienen ni posición ni
  // texto, que no aportarían nada al lienzo.
  const rotulos: Rotulo[] = [];
  for (const e of elementos) {
    if (e.kind !== 'static') continue;
    const texto = (e.label ?? e.name ?? '').trim();
    if (!texto || !esNum(e.x) || !esNum(e.y)) continue;
    rotulos.push({ id: e.element_id, x: e.x, y: e.y, texto });
  }

  return {
    nodos,
    enlaces,
    rotulos,
    vista: encuadrar(nodos, rotulos),
    sinPosicion: huerfanos,
  };
}

/** Caja que contiene todo lo dibujable, con margen para iconos y etiquetas. */
function encuadrar(nodos: readonly Nodo[], rotulos: readonly Rotulo[]): Lienzo['vista'] {
  if (nodos.length === 0 && rotulos.length === 0) {
    return { x: 0, y: 0, ancho: 400, alto: 300 };
  }
  const xs = [...nodos.map((n) => n.cx), ...rotulos.map((r) => r.x)];
  const ys = [...nodos.map((n) => n.cy), ...rotulos.map((r) => r.y)];
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
