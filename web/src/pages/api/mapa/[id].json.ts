import type { APIRoute } from 'astro';
import { estadosDelMapa, saludSync, ultimaSincronizacion } from '@/lib/consultas';

/**
 * Sólo los estados de los elementos de un mapa.
 *
 * El visor ya tiene la geometría dibujada; refrescarla entera tiraría el zoom y
 * el encuadre que el operador acomodó. Acá viaja lo único que cambia: un par
 * `id → estado` por nodo. Para el mapa más grande son 401 pares — unos 4 kB.
 */
export const GET: APIRoute = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return json({ error: 'Id de mapa inválido' }, 400);
  }

  try {
    const [estados, sync] = await Promise.all([estadosDelMapa(id), ultimaSincronizacion()]);
    return json({
      ts: new Date().toISOString(),
      salud: saludSync(sync),
      sync: sync && { salud: saludSync(sync), edad_s: sync.edad_s, ok: sync.ok },
      // Array de tuplas y no objeto: pesa la mitad y el cliente lo recorre igual.
      estados: estados.map((e) => [e.id, e.s]),
    });
  } catch (e) {
    console.error('[api/mapa]', e);
    return json({ error: 'No se pudo consultar la base' }, 503);
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
