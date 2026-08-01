import type { APIRoute } from 'astro';
import { crudoDisponibilidad, horizonteDatos } from '@/lib/consultas';
import {
  aOrden,
  construirFilas,
  nombreArchivoCsv,
  ordenar,
  recortarAlHorizonte,
  reporteCsv,
  resolverPeriodo,
} from '@/lib/disponibilidad';

/**
 * El reporte de disponibilidad, en un archivo.
 *
 * 🔴 Esto no es «la tabla, pero descargable». Es el ENTREGABLE: lo que termina
 *    adjunto en un correo a un cliente que reclama, o en una reunión de
 *    gerencia seis meses después. Por eso el archivo lleva su propio encabezado
 *    con el período, la ventana observada, el horizonte de datos y el aviso de
 *    recorte — ver `cabeceraCsv`. Un CSV con porcentajes pelados es un número
 *    sin contexto, y un número sin contexto en una discusión de contrato se
 *    vuelve en contra del que lo mandó.
 *
 * Lleva **todas** las filas, no las 25 de la pantalla: el tope de la página es
 * para poder leerla, no para recortar el reporte. Son 885 y pesa unos 90 kB;
 * el middleware lo comprime al salir.
 *
 * Los parámetros son exactamente los de `/disponibilidad`, así que el enlace de
 * descarga se arma pegando `.csv` a la URL que ya está en pantalla y el archivo
 * corresponde a lo que la persona estaba mirando.
 */
export const GET: APIRoute = async ({ url }) => {
  const p = url.searchParams;
  const ahora = new Date();

  try {
    const horizonte = await horizonteDatos();
    const pedido = resolverPeriodo(
      { periodo: p.get('periodo'), desde: p.get('desde'), hasta: p.get('hasta') },
      ahora,
      horizonte,
    );
    const ventana = recortarAlHorizonte(pedido, horizonte, ahora);

    const q = (p.get('q') ?? '').trim().slice(0, 80);
    const mapaPedido = Number(p.get('mapa'));
    const mapa = Number.isSafeInteger(mapaPedido) && mapaPedido > 0 ? mapaPedido : null;

    // Con la ventana vacía igual se emite el archivo: sale el encabezado
    // explicando que no hay datos en ese período. Un CSV de cero bytes o un
    // error 400 dejan a quien lo pidió sin saber por qué, y el motivo —«la base
    // no tiene nada de antes del 12/06»— es justamente el dato importante.
    const crudas = ventana.vacia
      ? []
      : await crudoDisponibilidad({ desde: ventana.desde, hasta: ventana.hasta, q, mapa });

    const filas = ordenar(construirFilas(crudas, ventana), aOrden(p.get('orden')) ?? 'peor');

    return new Response(reporteCsv(filas, ventana, ahora), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        // `attachment` y no `inline`: el navegador no tiene que intentar
        // mostrarlo. El nombre lleva las dos fechas de la ventana REAL —la
        // recortada— para que dos archivos del mismo mes no se pisen y para
        // que el nombre no prometa un período que el contenido no cubre.
        'content-disposition': `attachment; filename="${nombreArchivoCsv(ventana)}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    console.error('[api/disponibilidad.csv]', e);
    // Texto plano y 503: si esto falla, quien lo pidió está por adjuntarlo a un
    // correo. Que se descargue un archivo con un mensaje de error adentro es
    // peor que no descargar nada.
    return new Response('No se pudo generar el reporte. El detalle quedó en el registro.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};
