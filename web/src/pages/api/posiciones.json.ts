import type { APIRoute } from 'astro';
import { guardarPosiciones, restablecerPosiciones } from '@/lib/consultas';
import { quien } from '@/lib/roles';

/**
 * Dónde quedó cada nodo después de que alguien lo acomodó.
 *
 * 🔴 **La única escritura de todo el proyecto.** Todo lo demás —el panel
 *    entero— es de sólo lectura, y la base de The Dude no se toca ni acá:
 *    esto escribe en `map_element_positions`, una tabla nuestra que The Dude
 *    no conoce y que el ETL no borra.
 *
 * Por eso el control de permisos vive acá y no en la interfaz. Ocultarle el
 * botón a `soporte` es cortesía; **rechazarle el POST es la seguridad.** Quien
 * abra las herramientas del navegador va a encontrar esta ruta en dos minutos.
 *
 * Se guarda por lote, no de a un nodo: arrastrar tres equipos son tres
 * `PATCH` sueltos o uno con tres. Uno solo es una transacción, no tres, y no
 * deja el mapa a medio guardar si se corta la red en el segundo.
 */

const LIMITE_LOTE = 500;
const COORD_MAX = 100_000;

type Movimiento = { id: number; x: number; y: number };

export const POST: APIRoute = async ({ request }) => {
  const q = quien(request);
  if (!q.puedeEditar) {
    // 403 y no 401: no es que falte identificarse —Caddy ya lo hizo— es que
    // esa persona no tiene permiso. Y el motivo va en el cuerpo para que la
    // interfaz pueda decirlo con palabras en vez de un error genérico.
    return json(
      { error: 'No podés mover nodos', motivo: q.motivo, usuario: q.usuario },
      403,
    );
  }

  let cuerpo: unknown;
  try {
    cuerpo = await request.json();
  } catch {
    return json({ error: 'El cuerpo no es JSON' }, 400);
  }

  const bruto = (cuerpo as { movimientos?: unknown })?.movimientos;
  if (!Array.isArray(bruto) || bruto.length === 0) {
    return json({ error: 'Falta `movimientos`, y tiene que traer al menos uno' }, 400);
  }
  if (bruto.length > LIMITE_LOTE) {
    return json({ error: `Máximo ${LIMITE_LOTE} movimientos por pedido` }, 413);
  }

  const movimientos: Movimiento[] = [];
  for (const m of bruto) {
    const id = Number((m as Movimiento)?.id);
    const x = Math.round(Number((m as Movimiento)?.x));
    const y = Math.round(Number((m as Movimiento)?.y));
    // Enteros y dentro de un rango sano. El mapa más grande del origen llega a
    // 4.553; el tope de 100.000 deja lugar de sobra para acomodar sin permitir
    // que un nodo se vaya a una coordenada absurda de la que no se vuelve.
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'Id inválido' }, 400);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return json({ error: 'Coordenada inválida' }, 400);
    }
    if (Math.abs(x) > COORD_MAX || Math.abs(y) > COORD_MAX) {
      return json({ error: `Coordenada fuera de rango (±${COORD_MAX})` }, 400);
    }
    movimientos.push({ id, x, y });
  }

  try {
    const n = await guardarPosiciones(movimientos, q.usuario ?? 'desconocido');
    return json({ guardados: n, por: q.usuario, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[api/posiciones POST]', e);
    return json({ error: 'No se pudo guardar' }, 503);
  }
};

/**
 * Volver un mapa —o unos nodos— a como los dejó The Dude.
 *
 * Es la salida de emergencia del arrastrar y soltar: si alguien desordena un
 * mapa, tiene que poder deshacerlo sin pedirle a nadie que entre a la base.
 * Sin esto, «mover» sería una operación de una sola dirección.
 */
export const DELETE: APIRoute = async ({ request }) => {
  const q = quien(request);
  if (!q.puedeEditar) {
    return json({ error: 'No podés restablecer posiciones', motivo: q.motivo }, 403);
  }

  let cuerpo: { mapa?: unknown; ids?: unknown };
  try {
    cuerpo = (await request.json()) as typeof cuerpo;
  } catch {
    return json({ error: 'El cuerpo no es JSON' }, 400);
  }

  const mapa = cuerpo?.mapa != null ? Number(cuerpo.mapa) : null;
  const ids = Array.isArray(cuerpo?.ids) ? cuerpo.ids.map(Number).filter(Number.isInteger) : [];

  if (mapa == null && ids.length === 0) {
    return json({ error: 'Indicá `mapa` o `ids`' }, 400);
  }
  if (mapa != null && (!Number.isInteger(mapa) || mapa <= 0)) {
    return json({ error: 'Id de mapa inválido' }, 400);
  }

  try {
    const n = await restablecerPosiciones({ mapa, ids });
    return json({ restablecidos: n, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[api/posiciones DELETE]', e);
    return json({ error: 'No se pudo restablecer' }, 503);
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
