/**
 * Formateo para lectura humana, en español rioplatense.
 *
 * Nada de `Intl.RelativeTimeFormat`: produce "hace 2 horas" cuando lo que el
 * operador necesita a las 3 AM es "2 h 14 min" — la magnitud exacta, corta y
 * alineable en una columna.
 */

const TZ = 'America/Argentina/Buenos_Aires';

/** `1 h 07 min`, `3 d 4 h`, `42 s`. Compacto y siempre con dos magnitudes. */
export function duracion(segundos: number | null | undefined): string {
  if (segundos == null || !Number.isFinite(segundos)) return '—';
  const s = Math.max(0, Math.floor(segundos));

  if (s < 60) return `${s} s`;

  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;

  const hs = Math.floor(min / 60);
  const minResto = min % 60;
  if (hs < 24) return minResto ? `${hs} h ${pad(minResto)} min` : `${hs} h`;

  const dias = Math.floor(hs / 24);
  const hsResto = hs % 24;
  if (dias < 30) return hsResto ? `${dias} d ${hsResto} h` : `${dias} d`;

  const meses = Math.floor(dias / 30);
  return `${meses} mes${meses === 1 ? '' : 'es'}`;
}

/** Cuánto pasó desde `fecha`, ya formateado. */
export function desde(fecha: Date | string | null | undefined, ahora = new Date()): string {
  const d = aFecha(fecha);
  if (!d) return '—';
  return duracion((ahora.getTime() - d.getTime()) / 1000);
}

/**
 * `31/07 02:14`, o `04/01/2025 05:14` si es de otro año.
 *
 * Se arma con `formatToParts` en vez de con el patrón de `Intl`: al pedirle una
 * fecha sin año, `Intl` cambia de plantilla y devuelve `31/7, 02:14` — mes de
 * un dígito y una coma en el medio. En una columna de tabla eso baila.
 */
export function fechaHora(fecha: Date | string | null | undefined, ahora = new Date()): string {
  const p = partes(fecha);
  if (!p) return '—';
  const anio = aFecha(fecha)!.getFullYear() === ahora.getFullYear() ? '' : `/${p.year}`;
  return `${p.day}/${p.month}${anio} ${p.hour}:${p.minute}`;
}

/** Las piezas de la fecha en la zona de Buenos Aires, ya con dos dígitos. */
function partes(fecha: Date | string | null | undefined): Record<string, string> | null {
  const d = aFecha(fecha);
  if (!d) return null;
  const fmt = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  });
  const out: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(d)) out[type] = value;
  // `hourCycle` h23 puede dar "24" a medianoche en algunos entornos.
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** Fecha y hora completas, para `title` y `datetime`. */
export function fechaLarga(fecha: Date | string | null | undefined): string {
  const d = aFecha(fecha);
  if (!d) return '';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'full',
    timeStyle: 'medium',
    timeZone: TZ,
  }).format(d);
}

/** Separador de miles con punto, como corresponde en es-AR. */
export function numero(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('es-AR').format(n);
}

/** Porcentaje entero; `—` si el total es cero, nunca `NaN%`. */
export function porcentaje(parte: number, total: number): string {
  if (!total) return '—';
  return `${Math.round((parte / total) * 100)} %`;
}

/**
 * Las marcas de tiempo de The Dude vienen como segundos Unix en `bigint`.
 * Un `0` ahí significa "nunca", no el 1 de enero de 1970.
 */
export function desdeUnix(seg: number | null | undefined): Date | null {
  if (seg == null || !Number.isFinite(seg) || seg <= 0) return null;
  return new Date(seg * 1000);
}

function aFecha(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
