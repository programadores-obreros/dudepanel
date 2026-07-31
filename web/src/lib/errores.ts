import { texto } from './entorno';

/**
 * Qué se le cuenta al navegador cuando algo falla.
 *
 * 🔴 Antes cada página hacía `error = e.message` y lo pintaba tal cual. Eso
 *    ponía el error crudo de PostgreSQL en pantalla:
 *
 *        /dispositivos/9999999999999999999999
 *        → invalid input syntax for type bigint: "1e+22"
 *
 *    No hay credenciales ahí —se verificó— así que no es divulgación de
 *    secretos. Es divulgación de ESTRUCTURA: nombres de tabla y de columna,
 *    rutas internas, el motor y su versión. En un panel sin autenticación eso
 *    es un regalo, y además no le sirve a nadie: el operador de guardia a las
 *    tres de la mañana no sabe qué hacer con «invalid input syntax for bigint».
 *
 * Al usuario le va un mensaje que dice qué pasó y qué puede hacer. El detalle
 * completo va a `console.error`, que en el contenedor termina en el registro.
 *
 * `MOSTRAR_ERRORES=1` devuelve el detalle a la pantalla. Es para diagnosticar
 * en desarrollo o para una guardia que sepa leerlo: NO se enciende en
 * producción sin pensarlo.
 */
const MOSTRAR = texto('MOSTRAR_ERRORES') === '1';

/** El mismo texto en todas las páginas: si cambia, cambia en un solo lugar. */
export const MENSAJE_GENERICO =
  'No se pudo consultar la base de datos. El detalle quedó en el registro del servidor.';

/**
 * Anota el error completo y devuelve lo que se puede mostrar.
 *
 * `contexto` es lo que después se busca en el registro: poné dónde pasó
 * (`'dispositivos/[id]'`), no qué pasó.
 */
export function reportarError(contexto: string, e: unknown): string {
  console.error(`[${contexto}]`, e);
  if (!MOSTRAR) return MENSAJE_GENERICO;
  return e instanceof Error ? e.message : String(e);
}
