import type { APIRoute } from 'astro';
import {
  UMBRAL_DEMORADA,
  UMBRAL_VIEJA,
  caidasRecientes,
  resumenRed,
  saludSync,
  ultimaSincronizacion,
} from '@/lib/consultas';

/**
 * El pulso del panel.
 *
 * Lo consulta el refresco en vivo cada 30 s. Tiene que ser **liviano**: son
 * contadores y una lista corta, no la página entera. Recargar el documento
 * completo es exactamente lo que hace la interfaz de 2011 que estamos
 * reemplazando, y por eso se pierde el desplazamiento, el zoom del mapa y lo
 * que estabas leyendo.
 */
export const GET: APIRoute = async ({ url }) => {
  const conCaidas = url.searchParams.get('caidas') !== '0';

  try {
    const [sync, resumen, caidas] = await Promise.all([
      ultimaSincronizacion(),
      resumenRed(),
      conCaidas ? caidasRecientes(12) : Promise.resolve([]),
    ]);

    return json({
      ts: new Date().toISOString(),
      // El cliente sigue contando la antigüedad entre encuestas: si el servidor
      // deja de responder, la barra tiene que ponerse roja sola.
      umbrales: { demorada: UMBRAL_DEMORADA, vieja: UMBRAL_VIEJA },
      sync: sync && {
        salud: saludSync(sync),
        edad_s: sync.edad_s,
        ok: sync.ok,
        error: sync.error,
        terminada: sync.terminada,
        objs_total: sync.objs_total,
      },
      salud: saludSync(sync),
      resumen,
      caidas: caidas.map((c) => ({
        id: c.id,
        device_id: c.device_id,
        equipo: c.equipo,
        sonda: c.sonda,
        inicio: c.inicio,
        duracion_s: c.duracion_s,
        abierta: c.abierta,
      })),
    });
  } catch (e) {
    console.error('[api/estado]', e);
    // 503 y no 500: es "no puedo responder ahora", y el cliente reintenta
    // espaciando en vez de rendirse.
    return json({ error: 'No se pudo consultar la base', salud: 'sin-datos' }, 503);
  }
};

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
