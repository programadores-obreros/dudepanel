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
export interface Veredicto {
  ajeno: boolean;
  /** Con qué señal se decidió. Va al 403 y al log: un rechazo tiene que
      poder explicarse sin adivinar. */
  senal: string;
  detalle: string;
}

/**
 * 🔴 SE PREGUNTA POR `Sec-Fetch-Site` PRIMERO, Y NO POR `Origin`.
 *
 *    La primera versión de esto comparaba `Origin` contra el host reenviado y
 *    RECHAZÓ AL NAVEGADOR DE VERDAD en producción, con el mensaje «este
 *    formulario no se envió desde el panel». Andaba con `curl -H Origin:…`
 *    —lo probé así— y fallaba con un navegador. O sea: probé el caso que yo
 *    fabricaba, no el que ocurre.
 *
 *    El error de fondo: **`Origin` no está garantizado en un POST de
 *    formulario de navegación de nivel superior.** Varios navegadores lo
 *    omiten cuando el destino es el MISMO origen, justamente porque no aporta
 *    nada — y mi código leía esa ausencia como «no vino del panel».
 *
 *    `Sec-Fetch-Site` sí existe para esto y lo mandan todos los navegadores
 *    actuales, en TODOS los pedidos, sin excepción de método ni de origen. El
 *    navegador lo calcula solo y una página no lo puede falsificar: es
 *    exactamente la señal que hace falta.
 *
 *      same-origin → salió de este mismo sitio          ✅
 *      none        → lo escribió la persona / un favorito ✅
 *      same-site   → otro subdominio                     ❌
 *      cross-site  → otro sitio                          ❌
 *
 *    Y quedan `Origin` y `Referer` como respaldo para un navegador viejo que
 *    no mande `Sec-Fetch-Site`. Si no llega ninguna de las tres, se rechaza:
 *    ahí ya no es un navegador, y las rutas de API con JSON no pasan por acá.
 */
export function comprobarOrigen(request: Request): Veredicto {
  const ok = (senal: string, detalle = ''): Veredicto => ({ ajeno: false, senal, detalle });
  const no = (senal: string, detalle = ''): Veredicto => ({ ajeno: true, senal, detalle });

  if (SEGUROS.has(request.method)) return ok('metodo-seguro', request.method);

  const tipo = (request.headers.get('content-type') ?? '').toLowerCase();
  const esFormulario = tipo === '' || DE_FORMULARIO.some((t) => tipo.includes(t));
  // Un `content-type` que no es de formulario obliga al navegador a pedir
  // permiso por CORS antes de mandar nada, y sin cabeceras de CORS ese permiso
  // no llega. La protección la da el navegador; duplicarla acá rompería a los
  // clientes legítimos de la API.
  if (!esFormulario) return ok('no-es-formulario', tipo);

  const sfs = request.headers.get('sec-fetch-site');
  if (sfs) {
    return sfs === 'same-origin' || sfs === 'none'
      ? ok('sec-fetch-site', sfs)
      : no('sec-fetch-site', sfs);
  }

  const esperado =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  // El esquema NO se compara: adentro del contenedor siempre es http porque
  // Caddy termina el TLS, y exigir que coincida vuelve a romper todo.
  const mismoHost = (v: string | null) => {
    if (!v) return null;
    try {
      return new URL(v).host === esperado;
    } catch {
      return false;
    }
  };

  const porOrigen = mismoHost(request.headers.get('origin'));
  if (porOrigen !== null) {
    return porOrigen
      ? ok('origin', `${request.headers.get('origin')} = ${esperado}`)
      : no('origin', `${request.headers.get('origin')} ≠ ${esperado}`);
  }

  const porReferer = mismoHost(request.headers.get('referer'));
  if (porReferer !== null) {
    return porReferer
      ? ok('referer', esperado)
      : no('referer', `${request.headers.get('referer')} ≠ ${esperado}`);
  }

  return no('sin-señal', 'no llegó Sec-Fetch-Site, ni Origin, ni Referer');
}

/** Compatibilidad con los tests y el resto del código. */
export function origenAjeno(request: Request): boolean {
  return comprobarOrigen(request).ajeno;
}

export const onRequest: MiddlewareHandler = async (ctx, next) => {
  if (!revisado) {
    revisado = true;
    void avisarSiFaltaFiles();
  }

  const v = comprobarOrigen(ctx.request);
  if (v.ajeno) {
    // 🔴 Un rechazo que no dice POR QUÉ es imposible de diagnosticar desde
    //    afuera. Éste ya rechazó a un navegador legítimo una vez y hubo que
    //    adivinar; ahora la respuesta trae la señal y el valor exactos, y lo
    //    mismo va al log del contenedor.
    //
    //    No expone nada: la señal es una palabra del protocolo y el valor es
    //    el propio nombre del sitio. Quien ve esto ya se autenticó.
    console.warn('[origen] rechazado', ctx.request.method, ctx.url.pathname, v.senal, v.detalle);
    const cuerpo =
      'Este formulario no se envió desde el panel, así que se rechazó.\n\n' +
      `Señal: ${v.senal}\n` +
      `Detalle: ${v.detalle}\n\n` +
      'Si llegaste acá desde el panel y ves esto, copiá estas dos líneas: es un ' +
      'error de configuración y con eso se arregla.';
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
