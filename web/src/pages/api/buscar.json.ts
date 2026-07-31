import type { APIRoute } from 'astro';
import { buscar } from '@/lib/consultas';

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';

  try {
    const resultados = await buscar(q, 20);
    return json({ q, resultados });
  } catch (e) {
    console.error('[api/buscar]', e);
    return json({ error: 'No se pudo consultar la base' }, 503);
  }
};

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Resultados de monitoreo: cachearlos es mentirle al operador.
      'cache-control': 'no-store',
    },
  });
}
