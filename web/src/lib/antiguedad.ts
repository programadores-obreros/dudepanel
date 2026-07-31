import { entero } from './entorno';
import { aEstado, type Estado } from './estado';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  Hace cuánto que está así. El eje que The Dude no tiene.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Medido sobre la base real el 31/07/2026, sobre los 267 servicios caídos:
 *
 *        más de un año   121   ← el 45 %
 *        este año         65
 *        este mes         74
 *        esta semana       7
 *
 *        los cinco más viejos: caídos desde 2022-03-19 → 1.595 días
 *        en «sin datos»: 214, el más viejo desde 2012 → 14 años
 *
 *    Esos 121 no son caídas: son equipos dados de baja que nadie sacó del
 *    monitoreo. Llevan años pintando de rojo un mapa donde nadie va a ir a
 *    arreglar nada.
 *
 * Y ahí está el problema de fondo, que es de diseño y no de datos: **un tablero
 * con 121 rojos permanentes enseña a ignorar el rojo.** Cuando se caiga algo de
 * verdad va a estar mezclado con cuatro años de ruido, y va a tardar más en
 * verse justamente porque el tablero entrenó al operador a no mirar.
 *
 * The Dude muestra «caído» y punto. Nosotros tenemos `services.status_changed_at`.
 * **La diferencia entre «caído hace 7 minutos» y «caído hace 1.595 días» es la
 * diferencia entre una alarma y un residuo**, y es lo más valioso que este panel
 * puede aportar sobre el original.
 *
 * ── Por qué NO es un cuarto estado ──────────────────────────────────────────
 *
 * La tentación era agregar «residuo» al lado de caído / parcial / arriba / s/d.
 * Sería un error: un equipo residual **está caído**, y si el panel dice otra
 * cosa que The Dude, el panel miente. La antigüedad es un **eje ortogonal**:
 * califica al estado, no lo reemplaza. Un caído sigue siendo un caído, con su
 * glifo `✕` y su trazo punteado; lo que cambia es cuánta atención pide.
 *
 * Consecuencias prácticas de esa decisión, que atraviesan todo el panel:
 *
 *  · El glifo y el trazo de estado NO cambian nunca por antigüedad.
 *  · La antigüedad se dibuja atenuando (residuo) o realzando (reciente), y
 *    SIEMPRE va acompañada del texto exacto («caído hace 1.595 días»), porque
 *    la opacidad sola no es un canal accesible.
 *  · Un equipo `arriba` no tiene antigüedad: «arriba desde hace cuatro años»
 *    es una buena noticia, no un residuo. Ver `antiguedadDe`.
 */

export type Antiguedad = 'reciente' | 'arrastre' | 'residuo';

/** Hasta acá, lo que pasó es una novedad. Una guardia dura menos que esto. */
export const DIAS_RECIENTE = entero('ANTIGUEDAD_DIAS_RECIENTE', 7);
/**
 * A partir de acá, ya no es una caída: es parte del paisaje.
 *
 * Un año no es arbitrario: es el corte que separa los 121 medidos del resto, y
 * es el plazo a partir del cual «nadie lo arregló» deja de ser un atraso y pasa
 * a ser una decisión que nadie tomó explícitamente.
 */
export const DIAS_RESIDUO = entero('ANTIGUEDAD_DIAS_RESIDUO', 365);

export interface MetaAntiguedad {
  clave: Antiguedad;
  /** Nombre corto, el de la píldora y el del filtro. */
  etiqueta: string;
  /** Qué significa, en una línea. Va en `title` y en la referencia del mapa. */
  explica: string;
  /** Cuánto pide mirar. 0 es lo primero. */
  urgencia: number;
}

/**
 * 🔴 Acá NO hay un `glifo`, y la ausencia es el arreglo.
 *
 *    La primera versión usaba la rampa `● ◐ ○` —lleno, medio, hueco— que se lee
 *    perfecto en escala de grises y es exactamente el canal redundante que este
 *    proyecto exige. Y en pantalla, el del medio salía como **`‹`**: `◐`
 *    (U+25D0) no está en la fuente monoespaciada del sistema, así que el
 *    escalón intermedio de la rampa era un carácter de repuesto que no
 *    significa nada.
 *
 *    Es el mismo patrón de siempre: el dato era correcto, el marcado era
 *    correcto, los tests estaban en verde y sólo se vio mirando la pantalla.
 *
 *    La rampa ahora se dibuja con CSS —`.rampa` en `global.css`: un disco
 *    lleno, uno mitad y un aro— que no depende de ninguna fuente. Los contextos
 *    donde sólo entra texto (un `<option>`, un `aria-label`) usan la PALABRA,
 *    que nunca falta.
 */

const META: Record<Antiguedad, MetaAntiguedad> = {
  reciente: {
    clave: 'reciente',
    etiqueta: 'Reciente',
    explica: `Cambió hace menos de ${DIAS_RECIENTE} días. Esto es lo que hay que mirar.`,
    urgencia: 0,
  },
  arrastre: {
    clave: 'arrastre',
    etiqueta: 'Arrastre',
    explica: `Entre ${DIAS_RECIENTE} días y un año así. Ya no es una novedad, pero alguien lo dejó a medias.`,
    urgencia: 1,
  },
  residuo: {
    clave: 'residuo',
    etiqueta: 'Residuo',
    explica:
      'Más de un año en el mismo estado. Casi seguro es una baja que nadie sacó del monitoreo.',
    urgencia: 2,
  },
};

/** De la más urgente a la más vieja. Ese es el orden en que se muestran. */
export const ANTIGUEDADES: MetaAntiguedad[] = [META.reciente, META.arrastre, META.residuo];

export function metaAntiguedad(a: Antiguedad): MetaAntiguedad {
  return META[a];
}

/** Normaliza lo que venga de una URL o de un `data-`. `null` si no es una. */
export function aAntiguedad(v: unknown): Antiguedad | null {
  return v === 'reciente' || v === 'arrastre' || v === 'residuo' ? v : null;
}

/**
 * Qué antigüedad le corresponde a un estado que cambió en `desde`.
 *
 * 🔴 Devuelve `null` para «arriba» A PROPÓSITO, y también cuando no hay fecha.
 *
 *    · Un equipo `arriba` desde hace cuatro años no es un residuo: es lo mejor
 *      que le puede pasar a un enlace. Teñirlo de «viejo» convertiría una buena
 *      noticia en una advertencia.
 *    · Sin fecha no se inventa una. `null` significa «no sé desde cuándo», y
 *      el panel lo dice con esas palabras en vez de suponer que es reciente
 *      (que tranquilizaría de gusto) o residuo (que alarmaría de gusto).
 */
export function antiguedadDe(
  estado: unknown,
  desde: Date | string | null | undefined,
  ahora: Date = new Date(),
): Antiguedad | null {
  if (aEstado(estado) === 1) return null;
  const s = segundosDesde(desde, ahora);
  if (s == null) return null;
  return porSegundos(s);
}

/** La clasificación pura, sobre una antigüedad ya medida en segundos. */
export function porSegundos(segundos: number): Antiguedad {
  const d = segundos / 86_400;
  if (d < DIAS_RECIENTE) return 'reciente';
  if (d < DIAS_RESIDUO) return 'arrastre';
  return 'residuo';
}

/**
 * Segundos transcurridos desde `desde`, o `null` si no hay fecha usable.
 *
 * Nunca negativo: un reloj del origen adelantado unos segundos —The Dude corre
 * en un Windows de 2011 sin NTP confiable— daría «dentro de 4 s», que en una
 * columna de antigüedades se lee como un error del panel.
 */
export function segundosDesde(
  desde: Date | string | null | undefined,
  ahora: Date = new Date(),
): number | null {
  if (desde == null) return null;
  const d = desde instanceof Date ? desde : new Date(desde);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (ahora.getTime() - t) / 1000);
}

/** Recuento de un conjunto por antigüedad, más los que no tienen fecha. */
export interface ConteoAntiguedad {
  reciente: number;
  arrastre: number;
  residuo: number;
  /** Sin `status_changed_at`: no se sabe desde cuándo. No se reparte. */
  sinFecha: number;
}

export const CONTEO_VACIO: ConteoAntiguedad = {
  reciente: 0,
  arrastre: 0,
  residuo: 0,
  sinFecha: 0,
};

/**
 * Cuántos de estos merecen atención AHORA.
 *
 * Es el número que va grande en el tablero. Deliberadamente excluye el residuo:
 * la promesa del panel es que este número, cuando sube, significa algo.
 */
export function accionables(c: ConteoAntiguedad): number {
  return c.reciente + c.arrastre;
}

export function totalConteo(c: ConteoAntiguedad): number {
  return c.reciente + c.arrastre + c.residuo + c.sinFecha;
}

/** Clase de la píldora de antigüedad, lista para el HTML. */
export function claseAntiguedad(a: Antiguedad): string {
  return `antig antig-${a}`;
}

/**
 * Estado del que un equipo con estas fechas «no volvió».
 *
 * Se usa en el mapa: el atributo viaja como `data-antiguedad` y el CSS decide
 * si atenúa o realza. Que sea una cadena y no un booleano permite agregar un
 * escalón mañana sin tocar el marcado.
 */
export function atributoAntiguedad(
  estado: Estado,
  desde: Date | string | null | undefined,
  ahora?: Date,
): Antiguedad | undefined {
  return antiguedadDe(estado, desde, ahora) ?? undefined;
}
