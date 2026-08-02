import type { APIRoute } from 'astro';
import { marcarVida, olvidarVida } from '@/lib/consultas';
import { quien } from '@/lib/roles';

/**
 * El veredicto humano sobre si un equipo sigue en servicio.
 *
 * 🔴 **La segunda escritura del proyecto, y pesa más que la primera.**
 *
 *    `api/posiciones` mueve un dibujo: lo peor que puede pasar es un mapa feo.
 *    Esto ESCONDE UN EQUIPO DEL MAPA Y LE APAGA LAS ALARMAS. Si el juicio está
 *    equivocado, la próxima caída real de ese equipo no la ve nadie, y el
 *    panel va a seguir diciendo que todo está bien.
 *
 *    De ahí las tres condiciones que no se negocian:
 *      · sólo editores — y se comprueba ACÁ, no en la interfaz;
 *      · queda firmado con usuario y fecha;
 *      · una baja EXIGE nota. Dentro de seis meses, «¿por qué está oculto
 *        esto?» tiene que tener respuesta sin preguntarle a nadie, porque para
 *        entonces la persona que lo marcó puede no estar.
 *
 *    Nada de esto toca la base de The Dude: escribe en `device_estado_manual`,
 *    una tabla nuestra que el ETL no borra. El equipo sigue monitoreado en el
 *    origen; lo que cambia es qué mostramos y por qué avisamos.
 */

const NOTA_MAX = 500;
/** Una nota de tres letras no explica nada y da falsa sensación de trazabilidad. */
const NOTA_MIN = 4;

export const POST: APIRoute = async ({ request }) => {
  const q = quien(request);
  if (!q.puedeEditar) {
    // 403 y no 401: identificarse ya se identificó —de eso se ocupó Caddy—;
    // lo que falta es el permiso. El motivo va en el cuerpo para que la
    // interfaz lo pueda decir con palabras.
    return json({ error: 'No podés cambiar el estado de un equipo', motivo: q.motivo }, 403);
  }

  let cuerpo: { device_id?: unknown; estado?: unknown; nota?: unknown };
  try {
    cuerpo = (await request.json()) as typeof cuerpo;
  } catch {
    return json({ error: 'El cuerpo no es JSON' }, 400);
  }

  const deviceId = Number(cuerpo?.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return json({ error: 'Id de equipo inválido' }, 400);
  }

  const estado = cuerpo?.estado;
  // `auto` no es un estado: es sacar el veredicto y devolver el equipo al
  // cálculo. Va acá y no en un DELETE aparte porque desde la interfaz es un
  // botón más de los mismos tres, y partirlo en dos rutas invitaba a que una
  // de las dos se quedara sin la comprobación de permisos.
  if (estado === 'auto') {
    try {
      const habia = await olvidarVida(deviceId);
      return json({ device_id: deviceId, estado: 'auto', habia, por: q.usuario });
    } catch (e) {
      console.error('[api/vida POST auto]', e);
      return json({ error: 'No se pudo quitar la marca' }, 503);
    }
  }

  if (estado !== 'activo' && estado !== 'baja') {
    return json({ error: "`estado` tiene que ser 'activo', 'baja' o 'auto'" }, 400);
  }

  const nota = typeof cuerpo?.nota === 'string' ? cuerpo.nota.trim() : '';
  // 🔴 La nota es obligatoria SÓLO para dar de baja, y la asimetría es a
  //    propósito: marcar «activo» muestra un equipo de más —un error visible,
  //    que molesta y se corrige—, y marcar «baja» lo esconde, que es un error
  //    invisible. El que no se ve es el que necesita quedar explicado.
  if (estado === 'baja' && nota.length < NOTA_MIN) {
    return json(
      {
        error: 'Para dar de baja hace falta una nota que diga por qué',
        motivo:
          'Dar de baja esconde el equipo del mapa y le apaga las alarmas. Dentro de seis meses alguien va a preguntar por qué, y vos podés no estar.',
      },
      400,
    );
  }
  if (nota.length > NOTA_MAX) {
    return json({ error: `La nota no puede pasar de ${NOTA_MAX} caracteres` }, 413);
  }

  try {
    await marcarVida(deviceId, estado, nota || null, q.usuario ?? 'desconocido');
    return json({
      device_id: deviceId,
      estado,
      por: q.usuario,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[api/vida POST]', e);
    return json({ error: 'No se pudo guardar' }, 503);
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
