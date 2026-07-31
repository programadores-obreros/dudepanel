/**
 * Los cuatro estados de The Dude y cómo se muestran.
 *
 * Regla dura del proyecto: **nunca sólo color**. Cada estado tiene además un
 * glifo (`✓ ! ✕ ?`) y un texto. Un tablero que distingue "todo bien" de "se
 * cayó el enlace" únicamente por el tono deja afuera a cerca del 8 % de los
 * varones, y este se mira de noche y apurado.
 */
export type Estado = 0 | 1 | 2 | 3;

export interface MetaEstado {
  valor: Estado;
  /** Sufijo de clase CSS: `pildora-up`, `bg-up`, … */
  clave: 'desconocido' | 'up' | 'parcial' | 'caido';
  /** Etiqueta en rioplatense, la que ve el operador. */
  etiqueta: string;
  /** Forma corta para tablas apretadas y para el mapa. */
  corta: string;
  /** Carácter monoespaciado; no es un emoji, se imprime y se lee en gris. */
  glifo: string;
  /** Orden de urgencia: primero lo que hay que mirar. */
  urgencia: number;
}

const META: Record<Estado, MetaEstado> = {
  3: {
    valor: 3,
    clave: 'caido',
    etiqueta: 'Caído',
    corta: 'Caído',
    glifo: '✕',
    urgencia: 0,
  },
  2: {
    valor: 2,
    clave: 'parcial',
    etiqueta: 'Caída parcial',
    corta: 'Parcial',
    glifo: '!',
    urgencia: 1,
  },
  0: {
    valor: 0,
    clave: 'desconocido',
    etiqueta: 'Sin datos',
    corta: 'S/D',
    glifo: '?',
    urgencia: 2,
  },
  1: {
    valor: 1,
    clave: 'up',
    etiqueta: 'Arriba',
    corta: 'Arriba',
    glifo: '✓',
    urgencia: 3,
  },
};

/** Normaliza cualquier cosa que venga de la base a un estado válido. */
export function aEstado(v: unknown): Estado {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? (n as Estado) : 0;
}

export function metaEstado(v: unknown): MetaEstado {
  return META[aEstado(v)];
}

export const ESTADOS: MetaEstado[] = [META[3], META[2], META[0], META[1]];

/** Clase de la píldora, para usar directo en el HTML. */
export function clasePildora(v: unknown): string {
  return `pildora pildora-${metaEstado(v).clave}`;
}

/**
 * Estado agregado de un conjunto: manda el peor.
 *
 * Se usa para el titular del tablero y para el estado de un mapa. Un "todo
 * bien" que promedia y esconde tres equipos caídos es peor que no mostrar nada.
 */
export function estadoAgregado(estados: readonly unknown[]): Estado {
  let peor: Estado = 1;
  let vistos = 0;
  for (const e of estados) {
    const s = aEstado(e);
    vistos++;
    if (META[s].urgencia < META[peor].urgencia) peor = s;
  }
  return vistos === 0 ? 0 : peor;
}
