import type { APIRoute } from 'astro';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { extension, iconoRepuesto, rutaDeArchivo, TIPOS_IMAGEN } from '@/lib/iconos';

/**
 * Sirve los iconos de The Dude desde `data/files/`.
 *
 * Sólo hace falta para los rasterizados: los SVG se incrustan en la página
 * (ver `iconos.ts`). Pero 47 de los 56 iconos que usan los mapas del ISP
 * son PNG o JPG —`nanomder.png`, `olt-tplink.png`, `rb2011.png`— y un PNG no se
 * puede incrustar sin inflar el HTML: en base64 serían más de 100 kB por página
 * contra 21 peticiones chiquitas que el navegador cachea y reusa entre mapas.
 *
 * 🔴 LISTA BLANCA DE EXTENSIONES, no lista negra.
 *
 *    En ese mismo directorio conviven `certificate.pem`, 123 `.log` y 109
 *    `.txt`. Un endpoint que sirva "lo que le pidan" bajo `files/` publica la
 *    clave privada del servidor de monitoreo. Acá se sirve una imagen o no se
 *    sirve nada.
 */

export const GET: APIRoute = async ({ params, request }) => {
  const rel = params.ruta ?? '';

  const ext = extension(rel);
  // `Object.hasOwn` y no `TIPOS_IMAGEN[ext]`: la lista blanca se atravesaba por
  // el prototipo. `TIPOS_IMAGEN['constructor']` y `['toString']` son truthy, así
  // que `tipo` quedaba definido y el chequeo «¿es una imagen conocida?» pasaba
  // con una extensión que no está en la lista. Acá esa guarda decide si se toca
  // el disco, así que no puede ser una guarda que sólo por casualidad alcanza.
  const tipo = ext && Object.hasOwn(TIPOS_IMAGEN, ext) ? TIPOS_IMAGEN[ext] : undefined;
  if (!tipo) return repuesto(rel);

  // Resuelve enlaces y revalida la contención y la extensión del archivo REAL.
  // Ver el comentario largo de `rutaDeArchivo`: `rutaSegura` sola dejaba servir
  // `/etc/passwd` y `certificate.pem` con un enlace llamado `algo.png`.
  const abs = await rutaDeArchivo(rel);
  if (!abs) return repuesto(rel);

  try {
    const info = await stat(abs);
    if (!info.isFile()) return repuesto(rel);

    // ETag por tamaño y mtime: si alguien cambia un icono en la VM, el
    // navegador se entera. Sin esto habría que elegir entre servir viejo para
    // siempre o no cachear nunca.
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const cuerpo = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(cuerpo, {
      headers: {
        'content-type': tipo,
        'content-length': String(info.size),
        etag,
        // Un día. Las rutas no llevan hash, así que "immutable" sería mentira:
        // el operador que corrige un icono no debería esperar un año.
        'cache-control': 'public, max-age=86400',
        // Aunque la lista blanca ya lo impide, que el navegador tampoco
        // adivine el tipo por el contenido.
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return repuesto(rel);
  }
};

/**
 * Devuelve el icono de repuesto con estado 200, no un 404.
 *
 * Un `<image>` de SVG no tiene forma decente de reaccionar a un 404: deja un
 * hueco. Devolviendo el dibujo genérico, el mapa se ve completo aunque falte el
 * archivo — que es lo que va a pasar mientras el directorio de la VM no esté
 * montado.
 */
function repuesto(pista: string): Response {
  const ico = iconoRepuesto(pista);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ico.viewBox}" ` +
    `fill="none" stroke="#7c8798">${ico.cuerpo}</svg>`;
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Corto: en cuanto se monte el directorio, que aparezca el icono de verdad.
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    },
  });
}
