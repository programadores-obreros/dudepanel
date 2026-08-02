import type { MiddlewareHandler } from 'astro';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { CABECERAS } from './lib/cabeceras';
import { avisarSiFaltaFiles } from './lib/iconos';

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

/**
 * Revisión de arranque, una sola vez.
 *
 * Va en la primera petición y no arriba del módulo porque `astro build`
 * importa el middleware para analizarlo: quejarse ahí sería ruido en la
 * compilación, donde el directorio de iconos legítimamente no está.
 */
let revisado = false;

/** Métodos que no cambian nada: no necesitan comprobación de origen. */
const SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Los tipos que un `<form>` puede mandar SIN preflight de CORS.
 *
 * Son exactamente esos tres los que hacen falta comprobar: cualquier otro
 * —`application/json`, por ejemplo— obliga al navegador a pedir permiso al
 * servidor antes de mandar nada, y sin cabeceras de CORS ese permiso no llega.
 */
const DE_FORMULARIO = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

/**
 * 🔴 Comprobación de origen propia. Reemplaza la de Astro, que acá no sirve.
 *
 * ── Por qué hace falta la protección ────────────────────────────────────────
 *
 * El panel usa autenticación básica, y el navegador manda esas credenciales en
 * CUALQUIER pedido al sitio — incluido un `<form>` disparado desde otra página.
 * Sin esta comprobación, una web maliciosa podría hacer que el navegador de un
 * editor logueado diera equipos de baja o mandara sondas, sin que se entere.
 *
 * ── Por qué no se usa la de Astro ───────────────────────────────────────────
 *
 * `security.checkOrigin` compara `Origin` contra `Astro.url.origin`. Y detrás
 * de un proxy, `Astro.url` NO es la URL del navegador: el adaptador de Node
 * descarta el `Host` salvo que el dominio esté en una lista blanca compilada
 * dentro del build. Medido parcheando su middleware:
 *
 *     origin     = http://127.0.0.1:4466   ← lo que mandó el navegador
 *     url.origin = http://localhost        ← lo que Astro creyó que era
 *     host       = 127.0.0.1:4466
 *
 * Nunca coinciden, así que TODO formulario devuelve 403 en cualquier despliegue
 * real. Y la lista blanca no sirve acá: la imagen es la misma para cualquier
 * ISP, y meterle un dominio obligaría a recompilar por cliente.
 *
 * 🔴 Lo más peligroso de ese fallo es CUÁNDO aparece: `astro dev` no aplica ese
 *    middleware. Anda perfecto en la máquina de uno y se rompe sólo en
 *    producción. Se descubrió porque un botón nuevo devolvía 403 con un mensaje
 *    que mandaba a buscar un problema de CORS que no existía.
 *
 * ── Qué hace ésta, y por qué sí funciona ────────────────────────────────────
 *
 * Compara el HOST del `Origin` contra el host que reenvía el proxy. No
 * reconstruye ninguna URL, así que no le importa que Caddy termine el TLS y
 * hable HTTP para adentro — que es justo donde se rompía la otra.
 *
 * Y no compara el esquema a propósito: del lado de adentro siempre es `http` y
 * exigir que coincida volvería a fallar por lo mismo. El host alcanza: un
 * atacante que controle el host que llega acá ya está adentro de la red.
 */
export function origenAjeno(request: Request): boolean {
  if (SEGUROS.has(request.method)) return false;

  const tipo = (request.headers.get('content-type') ?? '').toLowerCase();
  const esFormulario = tipo === '' || DE_FORMULARIO.some((t) => tipo.includes(t));
  if (!esFormulario) return false;

  const origen = request.headers.get('origin');
  // Sin `Origin` en un POST de formulario: los navegadores actuales la mandan
  // siempre. Que falte es un cliente que no es un navegador, y para eso están
  // las rutas de API con JSON — que no pasan por acá.
  if (!origen) return true;

  const esperado =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  try {
    return new URL(origen).host !== esperado;
  } catch {
    return true; // un `Origin` que no es una URL no puede ser el nuestro
  }
}

export const onRequest: MiddlewareHandler = async (ctx, next) => {
  if (!revisado) {
    revisado = true;
    void avisarSiFaltaFiles();
  }

  if (origenAjeno(ctx.request)) {
    const cuerpo =
      'Este formulario no se envió desde el panel, así que se rechazó.\n' +
      'Si llegaste acá desde el panel y ves esto, avisá: es un error de configuración del proxy.';
    const h = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    for (const [nombre, valor] of CABECERAS) h.set(nombre, valor);
    return new Response(cuerpo, { status: 403, headers: h });
  }

  const res = await next();

  // 🔴 Las cabeceras de seguridad van PRIMERO y sin condiciones.
  //
  //    Antes de cualquier `return` temprano: si se pusieran más abajo, una
  //    respuesta que no se comprime —un 304, un icono chico, un cliente sin
  //    `accept-encoding`— saldría sin CSP. Una política que protege sólo
  //    algunas respuestas no protege ninguna.
  ponerCabeceras(res.headers);

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

/**
 * Aplica las cabeceras de seguridad sin pisar lo que ya haya puesto la ruta.
 *
 * `set` y no `append`, salvo que la ruta ya la haya definido: el endpoint de
 * iconos, por ejemplo, ya manda su propio `x-content-type-options`.
 */
function ponerCabeceras(h: Headers): void {
  for (const [nombre, valor] of CABECERAS) {
    if (!h.has(nombre)) h.set(nombre, valor);
  }
}

/** Brotli si el cliente lo acepta; si no, gzip; si no, nada. */
function negociar(cabecera: string | null): 'br' | 'gzip' | null {
  if (!cabecera) return null;
  const c = cabecera.toLowerCase();
  if (c.includes('br')) return 'br';
  if (c.includes('gzip')) return 'gzip';
  return null;
}
