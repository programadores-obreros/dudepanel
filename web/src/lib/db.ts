import pg from 'pg';
import { entero, texto } from './entorno';

const { Pool, types } = pg;

// ── Parsers ─────────────────────────────────────────────────────────────────
// node-pg devuelve `bigint` (int8) como string para no perder precisión sobre
// 2^53. Acá todos los bigint son ids de objetos de The Dude (14.925 en total),
// contadores y duraciones en segundos: ninguno se acerca al límite. Devolverlos
// como string obligaría a un Number() en cada uso y rompería silenciosamente
// cualquier comparación numérica o `count > 0`.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// numeric: sólo aparece en promedios y porcentajes calculados.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | undefined;

/**
 * Pool único por proceso.
 *
 * Perezoso a propósito: `astro build` importa los módulos de página para
 * analizarlos y no queremos que el build abra sockets a una base que quizá no
 * existe en la máquina que compila.
 */
export function obtenerPool(): pg.Pool {
  if (pool) return pool;

  const url = texto('DATABASE_URL');
  if (!url) {
    throw new Error(
      'Falta DATABASE_URL. Ejemplo: postgres://dude:dude@localhost:5432/dudepanel',
    );
  }

  pool = new Pool({
    connectionString: url,
    // El panel hace muchas consultas cortas. 10 alcanza y sobra para el
    // caudal esperado, y deja espacio de conexiones para el ETL, que escribe.
    max: entero('PGPOOL_MAX', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Si una consulta tarda más de esto, algo está mal: mejor fallar y mostrar
    // el error que dejar al operador mirando un spinner a las 3 de la mañana.
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: 'dudepanel-web',
  });

  // Un error en una conexión ociosa (la base se reinició, la red se cortó) es
  // un evento 'error' del pool. Sin este listener, Node tumba el proceso.
  pool.on('error', (err) => {
    console.error('[db] error en conexión ociosa:', err.message);
  });

  return pool;
}

/** Consulta tipada. Devuelve sólo las filas, que es lo único que usamos. */
export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await obtenerPool().query<T>(sql, params as unknown[]);
  return res.rows;
}

/** Primera fila o `undefined`. */
export async function consultarUna<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | undefined> {
  const filas = await consultar<T>(sql, params);
  return filas[0];
}

/** Cierra el pool. Sólo para los tests y el apagado ordenado. */
export async function cerrarPool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
