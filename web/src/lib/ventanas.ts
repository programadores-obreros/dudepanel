/**
 * Las ventanas de tiempo con las que se recorta «qué se cayó recién».
 *
 * 🔴 Están acá y no en cada página porque el mismo recorte se usa en DOS
 *    lugares que la gente compara entre sí: la lista de `/caidas · En curso` y
 *    el resalte del mapa. Si una ofrece «6 h» y la otra «8 h», o si las dos
 *    dicen «24 h» pero una mide 24 × 3600 y la otra el día calendario, nadie
 *    puede cruzar lo que ve en una pantalla con lo que ve en la otra — y el
 *    panel deja de servir justo para lo que se hizo, que es analizar.
 *
 * ── Por qué estos cortes y no otros ─────────────────────────────────────────
 *
 * No son redondos por estética: cada uno responde una pregunta distinta que
 * alguien hace de verdad frente a la pantalla.
 *
 *     1 h    ¿esto está pasando AHORA? ¿salgo corriendo?
 *     6 h    ¿pasó durante mi turno?
 *    24 h    ¿pasó desde ayer? — el corte del parte diario
 *     7 d    ¿es de esta semana? ¿lo vio alguien?
 *    30 d    ¿entra en el mes que se factura?
 *
 * El de 30 días coincide con `DIAS_ACTIVO` de `vida.ts` a propósito: es el
 * mismo umbral con el que el panel decide si un equipo sigue en servicio, así
 * que «caído dentro de los 30 días» y «todavía cuenta como equipo vivo» son la
 * misma frontera vista desde los dos lados.
 */

export interface Ventana {
  /** Lo que viaja en la URL. Corto, legible, y estable: se pega en un chat. */
  clave: string;
  /** Horas hacia atrás. `null` = sin recorte. */
  horas: number | null;
  texto: string;
  /** Qué pregunta contesta. Va en el `title`, para quien dude. */
  ayuda: string;
}

export const VENTANAS: readonly Ventana[] = [
  { clave: '1h', horas: 1, texto: '1 h', ayuda: '¿Está pasando ahora?' },
  { clave: '6h', horas: 6, texto: '6 h', ayuda: '¿Pasó durante este turno?' },
  { clave: '24h', horas: 24, texto: '24 h', ayuda: '¿Pasó desde ayer?' },
  { clave: '7d', horas: 24 * 7, texto: '7 d', ayuda: '¿Es de esta semana?' },
  { clave: '30d', horas: 24 * 30, texto: '30 d', ayuda: '¿Entra en el mes?' },
  { clave: 'todo', horas: null, texto: 'todo', ayuda: 'Sin recorte de tiempo.' },
] as const;

/** La que se usa si nadie eligió: sin recorte. */
export const VENTANA_POR_OMISION = 'todo';

/**
 * Resuelve el parámetro de la URL a una ventana conocida.
 *
 * 🔴 Se pregunta si el parámetro EXISTE, no sólo si lo que se leyó es válido.
 *
 *    Es la misma trampa que tuvo el filtro de duración mínima de `/caidas`
 *    durante meses: `Number(null)` es 0, y si 0 es un valor legítimo de la
 *    lista, la validación da verdadero y el valor por omisión no se alcanza
 *    nunca. Acá las claves son texto y `null` no matchea con nada, así que no
 *    puede pasar — pero se escribe así igual, porque la próxima persona que
 *    agregue una clave `''` o `0` no va a acordarse de esto.
 */
export function resolverVentana(valor: string | null): Ventana {
  const v = valor == null ? undefined : VENTANAS.find((x) => x.clave === valor);
  return v ?? VENTANAS.find((x) => x.clave === VENTANA_POR_OMISION)!;
}

/** ¿Cae `segundos` de antigüedad dentro de esta ventana? */
export function dentro(ventana: Ventana, segundos: number | null | undefined): boolean {
  if (ventana.horas == null) return true;
  // Sin fecha NO entra en ninguna ventana acotada. Es lo prudente: meterlo
  // sería afirmar que cayó recién, que es justo lo que no se sabe.
  if (segundos == null) return false;
  return segundos <= ventana.horas * 3600;
}
