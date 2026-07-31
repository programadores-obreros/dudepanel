import type { MiddlewareHandler } from 'astro';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/**
 * Compresión de las respuestas.
 *
 * El adaptador de Node no comprime nada por su cuenta. Para un mapa de 401
 * elementos eso son ~246 kB de SVG en texto plano, y el destinatario típico es
 * un celular en 4G a las tres de la mañana. El SVG es repetitivo hasta el
 * absurdo —los mismos atributos 400 veces— así que comprime como diez a uno.
 *
 * Se comprime en el proceso y no en un proxy adelante porque el despliegue de
 * el ISP es un contenedor solo: no hay nginx que dé por hecho.
 */

/** Debajo de esto el encabezado de compresión pesa más que lo que ahorra. */
const MINIMO = 1024;

const COMPRIMIBLES =
  /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i;

export const onRequest: MiddlewareHandler = async (ctx, next) => {
  const res = await next();

  const aceptado = negociar(ctx.request.headers.get('accept-encoding'));
  if (!aceptado) return res;

  // Ya viene codificado (lo hizo otro), o no hay cuerpo que comprimir.
  if (res.headers.has('content-encoding') || !res.body) return res;
  if (res.status === 204 || res.status === 304) return res;
  if (!COMPRIMIBLES.test(res.headers.get('content-type') ?? '')) return res;

  // Se acumula el cuerpo. Se pierde el envío en flujo, pero estas páginas ya se
  // arman enteras en el servidor antes de emitir: no hay nada que transmitir de
  // a pedazos, y con el cuerpo completo se puede mandar Content-Length.
  const crudo = Buffer.from(await res.arrayBuffer());
  if (crudo.byteLength < MINIMO) {
    return new Response(crudo, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const cuerpo =
    aceptado === 'br'
      ? brotliCompressSync(crudo, {
          params: {
            // Calidad 5: comprime casi como 11 y tarda una fracción. Con
            // páginas que se piden cada 30 s, el tiempo de CPU importa.
            [constants.BROTLI_PARAM_QUALITY]: 5,
            [constants.BROTLI_PARAM_SIZE_HINT]: crudo.byteLength,
          },
        })
      : gzipSync(crudo, { level: 6 });

  const headers = new Headers(res.headers);
  headers.set('content-encoding', aceptado);
  headers.set('content-length', String(cuerpo.byteLength));
  // Sin esto, una caché intermedia podría servirle la versión comprimida a un
  // cliente que no la pidió.
  headers.append('vary', 'accept-encoding');

  return new Response(cuerpo, { status: res.status, statusText: res.statusText, headers });
};

/** Brotli si el cliente lo acepta; si no, gzip; si no, nada. */
function negociar(cabecera: string | null): 'br' | 'gzip' | null {
  if (!cabecera) return null;
  const c = cabecera.toLowerCase();
  if (c.includes('br')) return 'br';
  if (c.includes('gzip')) return 'gzip';
  return null;
}
