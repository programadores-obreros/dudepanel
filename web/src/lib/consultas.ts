import { consultar, consultarUna } from './db';
import { entero } from './entorno';
import { aEstado, type Estado } from './estado';
import {
  CONTEO_VACIO,
  DIAS_RECIENTE,
  DIAS_RESIDUO,
  type Antiguedad,
  type ConteoAntiguedad,
} from './antiguedad';
import type { ConteoSubmapa } from './plantillas';

/**
 * Toda la SQL del panel vive acá.
 *
 * Motivo: las páginas de Astro son plantillas y no deberían saber de columnas.
 * Y además así se puede probar la capa de datos con vitest contra una base de
 * verdad, sin renderizar nada.
 *
 * 🔴 Ni una sola consulta escribe. El panel es de sólo lectura por diseño: la
 *    fuente de verdad es The Dude y el ETL, y una escritura accidental desde
 *    acá contaminaría el histórico que estamos rescatando.
 */

// ── Sincronización ──────────────────────────────────────────────────────────

export interface Sincronizacion {
  id: number;
  iniciada: string;
  terminada: string | null;
  ok: boolean | null;
  error: string | null;
  edad_s: number;
  duracion_ms: number | null;
  objs_total: number | null;
  user_version: number | null;
  /**
   * El ETL corrió bien y no reescribió nada porque `dude.db` no cambió.
   *
   * 🔴 Eso es ÉXITO, no falta de datos: la red se miró y estaba igual. Tratarlo
   * como "no sincronizó" alarmaría de gusto, que es el error opuesto pero
   * igual de dañino que tapar una caída.
   */
  snapshot_reused: boolean;
}

export type SaludSync = 'fresca' | 'demorada' | 'vieja' | 'fallida' | 'sin-datos';

/** Segundos a partir de los cuales la sincronización se considera demorada. */
export const UMBRAL_DEMORADA = entero('SYNC_UMBRAL_DEMORADA', 180);
/** Segundos a partir de los cuales hay que avisar fuerte: no hay datos frescos. */
export const UMBRAL_VIEJA = entero('SYNC_UMBRAL_VIEJA', 600);

export async function ultimaSincronizacion(): Promise<Sincronizacion | null> {
  const fila = await consultarUna<Sincronizacion>(`
    SELECT id,
           started_at  AS iniciada,
           finished_at AS terminada,
           ok, error,
           EXTRACT(EPOCH FROM now() - COALESCE(finished_at, started_at))::int AS edad_s,
           duration_ms AS duracion_ms,
           objs_total, user_version, snapshot_reused
    FROM sync_runs
    ORDER BY started_at DESC
    LIMIT 1
  `);
  return fila ?? null;
}

/**
 * Un tablero que no distingue "todo bien" de "hace seis horas que no sé nada"
 * es peor que no tener tablero. Esta función es la que hace esa distinción.
 */
export function saludSync(s: Sincronizacion | null): SaludSync {
  if (!s) return 'sin-datos';
  if (s.ok === false) return 'fallida';
  if (s.edad_s > UMBRAL_VIEJA) return 'vieja';
  if (s.edad_s > UMBRAL_DEMORADA) return 'demorada';
  return 'fresca';
}

// ── Desde cuándo está así un equipo ─────────────────────────────────────────

/**
 * 🔴 `devices` NO tiene `status_changed_at`. Sólo lo tienen los servicios.
 *
 *    Así que la antigüedad de un equipo hay que derivarla, y la regla no es
 *    obvia. La que se usa acá, y por qué:
 *
 *      COALESCE(max(cambio) FILTER (status = 3), max(cambio))
 *
 *    · Si el equipo tiene algún servicio CAÍDO, manda **el último en caer**.
 *      Es el que completó la caída: un equipo con `ping` caído desde 2022 y
 *      `winbox` caído desde hoy está caído entero desde hoy, no desde 2022.
 *      Y en el caso inverso —los dos caídos desde 2022— los dos coinciden.
 *
 *    · Si no hay ninguno caído, manda el último cambio de cualquier servicio:
 *      es «lo último que pasó en este equipo».
 *
 *    · Sin servicios, `NULL`. No se inventa una fecha. 32 de los 885 equipos
 *      de la base real están así, y el panel lo dice con esas palabras.
 *
 *    Es una definición, no una verdad revelada: está acá arriba en vez de
 *    enterrada en cinco consultas justamente para que se pueda discutir en un
 *    solo lugar.
 */
const SQL_ESTADO_DESDE = `
  COALESCE(
    max(s.status_changed_at) FILTER (WHERE s.status = 3),
    max(s.status_changed_at)
  )`;

/** El `LEFT JOIN LATERAL` que le cuelga `estado_desde` a `devices d`. */
const JOIN_ESTADO_DESDE = `
  LEFT JOIN LATERAL (
    SELECT ${SQL_ESTADO_DESDE} AS estado_desde
    FROM services s WHERE s.device_id = d.id
  ) sc ON true`;

/**
 * Cómo se clasifica una fecha en SQL, con los mismos cortes que `antiguedad.ts`.
 *
 * Los umbrales viajan como parámetros y no van escritos en la consulta: son
 * configurables por entorno y tener el número en dos lugares es tener dos
 * verdades. `$r` = días de «reciente», `$v` = días de «residuo».
 */
function sqlAntiguedad(col: string, r: string, v: string): string {
  return `CASE
     WHEN ${col} IS NULL THEN 'sin-fecha'
     WHEN ${col} > now() - make_interval(days => ${r}) THEN 'reciente'
     WHEN ${col} > now() - make_interval(days => ${v}) THEN 'arrastre'
     ELSE 'residuo'
   END`;
}

function aConteo(filas: { antiguedad: string; n: number }[]): ConteoAntiguedad {
  const c = { ...CONTEO_VACIO };
  for (const f of filas) {
    if (f.antiguedad === 'reciente') c.reciente = f.n;
    else if (f.antiguedad === 'arrastre') c.arrastre = f.n;
    else if (f.antiguedad === 'residuo') c.residuo = f.n;
    else c.sinFecha = f.n;
  }
  return c;
}

// ── Resumen de la red ───────────────────────────────────────────────────────

export interface Conteo {
  total: number;
  arriba: number;
  parcial: number;
  caidos: number;
  desconocidos: number;
}

export interface ResumenRed {
  equipos: Conteo;
  servicios: Conteo;
  mapas: number;
  enlaces: number;
  caidas_abiertas: number;
  caidas_24h: number;
  /**
   * Los equipos CAÍDOS, repartidos por hace cuánto que lo están.
   *
   * 🔴 Es el número que cambia la lectura del tablero. «267 caídos» y «146
   *    caídos + 121 residuos de más de un año» describen la misma red y llevan
   *    a decisiones distintas. Ver `antiguedad.ts`.
   */
  caidos_por_antiguedad: ConteoAntiguedad;
  /** Los que están en «sin datos», que es donde vive el residuo más viejo. */
  desconocidos_por_antiguedad: ConteoAntiguedad;
}

export async function resumenRed(): Promise<ResumenRed> {
  // Una sola ida a la base: el tablero se refresca cada 30 s y no tiene sentido
  // pagar seis viajes de red para seis contadores.
  const fila = await consultarUna<Record<string, number>>(`
    SELECT
      (SELECT count(*) FROM devices)                            AS eq_total,
      (SELECT count(*) FROM devices WHERE status = 1)           AS eq_arriba,
      (SELECT count(*) FROM devices WHERE status = 2)           AS eq_parcial,
      (SELECT count(*) FROM devices WHERE status = 3)           AS eq_caidos,
      (SELECT count(*) FROM devices WHERE status = 0
                                       OR status IS NULL)       AS eq_desc,
      (SELECT count(*) FROM services)                           AS sv_total,
      (SELECT count(*) FROM services WHERE status = 1)          AS sv_arriba,
      (SELECT count(*) FROM services WHERE status = 2)          AS sv_parcial,
      (SELECT count(*) FROM services WHERE status = 3)          AS sv_caidos,
      (SELECT count(*) FROM services WHERE status = 0
                                       OR status IS NULL)       AS sv_desc,
      (SELECT count(*) FROM maps)                               AS mapas,
      (SELECT count(*) FROM links)                              AS enlaces,
      (SELECT count(*) FROM outages WHERE ended_at IS NULL)     AS abiertas,
      (SELECT count(*) FROM outages
        WHERE started_at > now() - interval '24 hours')         AS ult24
  `);

  // El reparto por antigüedad va en su propia consulta y no pegado a la de
  // arriba: necesita el LATERAL contra `services` y meterlo entre catorce
  // subconsultas escalares haría ilegible la única consulta que se lee seguido.
  const porEdad = await consultar<{ status: number; antiguedad: string; n: number }>(
    `SELECT COALESCE(d.status, 0)::int AS status,
            ${sqlAntiguedad('sc.estado_desde', '$1::int', '$2::int')} AS antiguedad,
            count(*)::int AS n
     FROM devices d
     ${JOIN_ESTADO_DESDE}
     WHERE COALESCE(d.status, 0) IN (0, 3)
     GROUP BY 1, 2`,
    [DIAS_RECIENTE, DIAS_RESIDUO],
  );

  const f = fila ?? {};
  return {
    caidos_por_antiguedad: aConteo(porEdad.filter((p) => p.status === 3)),
    desconocidos_por_antiguedad: aConteo(porEdad.filter((p) => p.status === 0)),
    equipos: {
      total: f.eq_total ?? 0,
      arriba: f.eq_arriba ?? 0,
      parcial: f.eq_parcial ?? 0,
      caidos: f.eq_caidos ?? 0,
      desconocidos: f.eq_desc ?? 0,
    },
    servicios: {
      total: f.sv_total ?? 0,
      arriba: f.sv_arriba ?? 0,
      parcial: f.sv_parcial ?? 0,
      caidos: f.sv_caidos ?? 0,
      desconocidos: f.sv_desc ?? 0,
    },
    mapas: f.mapas ?? 0,
    enlaces: f.enlaces ?? 0,
    caidas_abiertas: f.abiertas ?? 0,
    caidas_24h: f.ult24 ?? 0,
  };
}

// ── Caídas ──────────────────────────────────────────────────────────────────

export interface Caida {
  id: number;
  device_id: number | null;
  equipo: string | null;
  sonda: string | null;
  inicio: string | null;
  fin: string | null;
  duracion_s: number | null;
  abierta: boolean;
}

const SQL_CAIDAS = `
  SELECT o.id, o.device_id,
         d.name  AS equipo,
         p.name  AS sonda,
         o.started_at AS inicio,
         o.ended_at   AS fin,
         COALESCE(o.duration_s,
                  EXTRACT(EPOCH FROM now() - o.started_at)::bigint) AS duracion_s,
         (o.ended_at IS NULL) AS abierta
  FROM outages o
  LEFT JOIN devices  d ON d.id = o.device_id
  LEFT JOIN services s ON s.id = o.service_id
  LEFT JOIN probes   p ON p.id = s.probe_id
`;

/** Las caídas que importan ahora: primero las abiertas, después las recientes. */
export async function caidasRecientes(limite = 12): Promise<Caida[]> {
  return consultar<Caida>(
    `${SQL_CAIDAS}
     ORDER BY (o.ended_at IS NULL) DESC, o.started_at DESC
     LIMIT $1`,
    [limite],
  );
}

export async function caidasDe(deviceId: number, limite = 25): Promise<Caida[]> {
  return consultar<Caida>(
    `${SQL_CAIDAS}
     WHERE o.device_id = $1
     ORDER BY o.started_at DESC
     LIMIT $2`,
    [deviceId, limite],
  );
}

// ── Mapas ───────────────────────────────────────────────────────────────────

export interface ResumenMapa {
  id: number;
  nombre: string;
  elementos: number;
  equipos: number;
  arriba: number;
  parcial: number;
  caidos: number;
  desconocidos: number;
  submapas: number;
}

/**
 * Los contadores se calculan en vivo y no se leen de `maps.devices_*`.
 *
 * Esas columnas las materializa el ETL, y si una corrida falla a mitad quedan
 * describiendo una red que ya no existe. Con 40 mapas y ~2.300 elementos el
 * recuento en vivo cuesta milisegundos, y prefiero pagarlos antes que mostrar
 * "todo verde" porque el ETL no llegó a actualizar un entero.
 */
export async function listarMapas(): Promise<ResumenMapa[]> {
  return consultar<ResumenMapa>(`
    SELECT m.id,
           m.name AS nombre,
           count(e.id)::int                                        AS elementos,
           count(*) FILTER (WHERE e.device_id IS NOT NULL)::int     AS equipos,
           count(*) FILTER (WHERE d.status = 1)::int                AS arriba,
           count(*) FILTER (WHERE d.status = 2)::int                AS parcial,
           count(*) FILTER (WHERE d.status = 3)::int                AS caidos,
           count(*) FILTER (WHERE e.device_id IS NOT NULL
                              AND COALESCE(d.status, 0) = 0)::int   AS desconocidos,
           count(*) FILTER (WHERE e.kind = 'submap')::int           AS submapas
    FROM maps m
    LEFT JOIN map_elements e ON e.map_id = m.id
    LEFT JOIN devices      d ON d.id = e.device_id
    GROUP BY m.id, m.name
    ORDER BY caidos DESC, parcial DESC, m.name ASC
  `);
}

export interface Mapa {
  id: number;
  nombre: string;
}

export async function obtenerMapa(id: number): Promise<Mapa | null> {
  const m = await consultarUna<Mapa>('SELECT id, name AS nombre FROM maps WHERE id = $1', [id]);
  return m ?? null;
}

export interface ElementoMapa {
  element_id: number;
  /** `static` es un rótulo de texto libre: sin icono, sin estado, sin destino. */
  kind: 'device' | 'network' | 'submap' | 'link' | 'static';
  x: number | null;
  y: number | null;
  shape: number | null;
  label: string | null;
  icon: string | null;
  link_from: number | null;
  link_to: number | null;
  link_width: number | null;
  /** Id del enlace del origen. Es la clave para buscarle el tráfico. */
  link_id: number | null;
  name: string | null;
  status: number | null;
  device_id: number | null;
  submap_id: number | null;
  direcciones: string[] | null;
  /**
   * 🔴 El icono del TIPO de equipo, que es el segundo escalón de la cadena.
   *
   *    The Dude resuelve el dibujo en dos pasos: el icono del ELEMENTO y, si
   *    no tiene, el del TIPO. Nosotros hacíamos sólo el primero, y **123
   *    elementos salían con una cajita gris teniendo su imagen a un JOIN de
   *    distancia**: el archivo existe y el panel ya lo sirve con HTTP 200.
   */
  icon_tipo: string | null;
  /**
   * Y su escala, que NO es la del elemento. `device_types.image_scale` es 60
   * para «Algun dispositivo» —122 de esos 123 equipos—; usar la del elemento
   * con la imagen del tipo la dibujaría al tamaño equivocado.
   */
  image_scale_tipo: number | null;
  /** Nombre del tipo. Sirve de pista para elegir el pictograma de repuesto. */
  tipo_nombre: string | null;
  /** Para deducir el fabricante. Ver `lib/oui`: cubre 557 equipos. */
  macs: string[] | null;
  /** ¿Alguien acomodó este nodo a mano? Ver `map_element_positions`. */
  movido?: boolean;
  /** Para `[Device.ServicesDown]`. Nulo si el elemento no es un equipo. */
  services_down: number | null;
  /**
   * Escala del icono, en porcentaje sobre el tamaño natural del archivo.
   *
   * Puede venir nula: el que dimensiona lo trata como 100. Ver `ladoDeIcono`.
   */
  image_scale: number | null;
  /** Desde cuándo el equipo está en su estado. Ver `SQL_ESTADO_DESDE`. */
  estado_desde: string | null;
}

/**
 * Todo el mapa en una consulta, tal como promete `v_map_canvas`.
 *
 * Las direcciones se piden como `text[]` y no como el `inet[]` crudo: el driver
 * las entrega ya listas para mostrar y sin depender de cómo parsee `inet[]`
 * la versión de node-pg que esté instalada.
 *
 * `services_down` sale de un JOIN acá y no de la vista a propósito: la vista es
 * contrato del ETL y esto lo necesita sólo el visor, para resolver la plantilla
 * `[Device.ServicesDown]` de 761 rótulos. Cuesta un hash join sobre las 401
 * filas del mapa más grande — nada.
 */
export async function lienzoMapa(mapId: number): Promise<ElementoMapa[]> {
  return consultar<ElementoMapa>(
    `SELECT c.element_id, c.kind, c.x, c.y, c.shape, c.label, c.icon,
            c.link_from, c.link_to, c.link_width, me.link_id,
            c.name, c.status, c.device_id, c.submap_id,
            ARRAY(SELECT host(a) FROM unnest(c.addresses) a) AS direcciones,
            d.services_down,
            me.image_scale,
            c.movido,
            c.icon_tipo, c.image_scale_tipo, c.tipo_nombre,
            ARRAY(SELECT unnest(c.macs)) AS macs,
            sc.estado_desde
     FROM v_map_canvas c
     JOIN map_elements me ON me.id = c.element_id
     LEFT JOIN devices d ON d.id = c.device_id
     ${JOIN_ESTADO_DESDE}
     WHERE c.map_id = $1
     ORDER BY (c.kind = 'link') DESC, c.element_id`,
    [mapId],
  );
}

// ── Tráfico de los enlaces ──────────────────────────────────────────────────

export interface TraficoEnlace {
  link_id: number;
  /** Bits por segundo del último dato de entrada, y cuándo se midió. */
  entrada_bits: number | null;
  entrada_ts: string | null;
  salida_bits: number | null;
  salida_ts: string | null;
}

/**
 * La última medición de tráfico de cada enlace de un mapa.
 *
 * 🔴 Esto existe porque `[Interface.InBitRate]` estuvo apagado por una medición
 *    vencida. La historia completa está en `plantillas.ts`; acá va lo técnico.
 *
 * ── Por qué un LATERAL por balde y no un `DISTINCT ON` ──────────────────────
 *
 * `chart_values` tiene 1.584.013 filas y su única clave es
 * `(source_id, bucket, ts)`. Un `DISTINCT ON (source_id) … ORDER BY ts DESC`
 * no puede usar ese índice —`bucket` está en el medio— y termina barriendo las
 * ~500.000 filas de las fuentes con enlace en CADA dibujo de mapa. Pidiendo el
 * último de cada balde por separado, cada búsqueda es un `LIMIT 1` sobre el
 * índice. Medido sobre `VLANS`: **0,58 ms**.
 *
 * ── Y por qué se prefiere el balde más fino a igual antigüedad ──────────────
 *
 * `raw` es la medición; `1day` es un promedio de veinticuatro horas. Los dos
 * están en bit/s y los dos son ciertos, pero mostrar el promedio diario como
 * «el tráfico del enlace» achata los picos, que es justo lo que se mira. Se
 * ordena por fecha y se desempata por finura.
 */
export async function traficoDeMapa(mapId: number): Promise<Map<number, TraficoEnlace>> {
  const filas = await consultar<TraficoEnlace>(
    `WITH fuentes AS (
       SELECT cs.id, cs.link_id,
              CASE WHEN cs.name LIKE '% rx' THEN 'rx'
                   WHEN cs.name LIKE '% tx' THEN 'tx' END AS sentido
       FROM chart_sources cs
       WHERE cs.unit = 'bit/s'
         AND cs.link_id IN (SELECT DISTINCT link_id FROM map_elements
                            WHERE map_id = $1 AND link_id IS NOT NULL)
     ),
     ult AS (
       SELECT f.link_id, f.sentido, u.ts, u.value
       FROM fuentes f
       CROSS JOIN LATERAL (
         SELECT x.ts, x.value
         FROM (VALUES ('raw', 1), ('10min', 2), ('2hour', 3), ('1day', 4)) AS b(bucket, pref)
         CROSS JOIN LATERAL (
           SELECT c.ts, c.value FROM chart_values c
           WHERE c.source_id = f.id AND c.bucket = b.bucket AND c.value IS NOT NULL
           ORDER BY c.ts DESC LIMIT 1
         ) x
         ORDER BY x.ts DESC, b.pref LIMIT 1
       ) u
       WHERE f.sentido IS NOT NULL
     )
     SELECT link_id,
            max(value) FILTER (WHERE sentido = 'rx') AS entrada_bits,
            max(ts)    FILTER (WHERE sentido = 'rx') AS entrada_ts,
            max(value) FILTER (WHERE sentido = 'tx') AS salida_bits,
            max(ts)    FILTER (WHERE sentido = 'tx') AS salida_ts
     FROM ult
     GROUP BY link_id`,
    [mapId],
  );
  return new Map(filas.map((f) => [f.link_id, f]));
}

/** Estado y recuentos de un submapa dibujado dentro de otro mapa. */
export interface ResumenSubmapa extends ConteoSubmapa {
  estado: Estado;
}

/**
 * Estado y recuentos de los submapas que aparecen dentro de un mapa.
 *
 * Todo en vivo, nada de `maps.devices_*`. No es una preferencia estética: en la
 * base real esas columnas están **mal**. Medido el 31/07/2026 sobre `MGomez`,
 * el ETL escribió `devices_down = 23` cuando hay 11 caídos y 12 parciales — los
 * suma. El rótulo `[NetMap.DevicesCount] / [...PartiallyDownCount] /
 * [...DownCount]` de 145 elementos diría «48 / 0 / 23», que es otra cosa que la
 * que muestra The Dude. Recontar cuesta milisegundos.
 *
 * `total` sí coincide clavado con `maps.devices_total` en los 40 mapas, lo que
 * confirma de paso que The Dude no cuenta en cascada: los equipos de un
 * sub-submapa no entran.
 */
export async function resumenSubmapas(mapId: number): Promise<Map<number, ResumenSubmapa>> {
  const filas = await consultar<{
    submap_id: number;
    total: number;
    arriba: number;
    parciales: number;
    caidos: number;
  }>(
    `SELECT e.submap_id,
            count(*) FILTER (WHERE se.device_id IS NOT NULL)::int AS total,
            count(*) FILTER (WHERE d.status = 1)::int             AS arriba,
            count(*) FILTER (WHERE d.status = 2)::int             AS parciales,
            count(*) FILTER (WHERE d.status = 3)::int             AS caidos
     FROM map_elements e
     JOIN map_elements se ON se.map_id = e.submap_id
     LEFT JOIN devices  d ON d.id = se.device_id
     WHERE e.map_id = $1 AND e.submap_id IS NOT NULL
     GROUP BY e.submap_id`,
    [mapId],
  );

  return new Map(
    filas.map((f) => [
      f.submap_id,
      {
        total: f.total,
        arriba: f.arriba,
        parciales: f.parciales,
        caidos: f.caidos,
        // El peor manda, igual que en cualquier agregado de este panel.
        estado: aEstado(f.caidos > 0 ? 3 : f.parciales > 0 ? 2 : f.arriba > 0 ? 1 : 0),
      },
    ]),
  );
}

/** Sólo el estado consolidado de cada submapa; lo que necesita el refresco. */
export async function estadoSubmapas(mapId: number): Promise<Map<number, Estado>> {
  const resumen = await resumenSubmapas(mapId);
  return new Map([...resumen].map(([id, r]) => [id, r.estado]));
}

/** Carga liviana para el refresco: sólo id de elemento y estado. */
export async function estadosDelMapa(mapId: number): Promise<{ id: number; s: Estado }[]> {
  const directos = await consultar<{ id: number; s: number | null }>(
    `SELECT e.id, d.status AS s
     FROM map_elements e
     LEFT JOIN devices d ON d.id = e.device_id
     WHERE e.map_id = $1 AND e.device_id IS NOT NULL`,
    [mapId],
  );

  const porSubmapa = await estadoSubmapas(mapId);
  const elementosSubmapa = await consultar<{ id: number; submap_id: number }>(
    `SELECT id, submap_id FROM map_elements
     WHERE map_id = $1 AND submap_id IS NOT NULL`,
    [mapId],
  );

  return [
    ...directos.map((d) => ({ id: d.id, s: aEstado(d.s) })),
    ...elementosSubmapa.map((e) => ({ id: e.id, s: porSubmapa.get(e.submap_id) ?? 0 })),
  ];
}

export interface DestinoEnlace {
  id: number;
  nombre: string;
  enlaces: number;
}

export interface EnlacesFuera {
  /** Enlaces con alguna punta en otro mapa. */
  otroMapa: number;
  /** Enlaces con alguna punta que apunta a un objeto que ya no existe. */
  rotos: number;
  /** A qué mapas se puede ir para ver el otro extremo, y cuántos llevan a cada uno. */
  destinos: DestinoEnlace[];
}

/**
 * Por qué un mapa tiene más enlaces que líneas.
 *
 * Un enlace se dibuja sólo si sus dos puntas son elementos de ESTE mapa. En la
 * base real eso no siempre pasa, y por dos motivos que hay que separar porque
 * significan cosas distintas:
 *
 *  · **La punta está en otro mapa.** Pasa mucho: `Segmentos` es un mapa de resumen
 *    y 147 de sus enlaces terminan en elementos dibujados en `Aurora`. No falta
 *    nada, está en otro lado — y eso se puede convertir en un enlace de
 *    navegación en vez de un agujero.
 *  · **La punta no existe.** Referencia colgada del propio The Dude: 78 en toda
 *    la base. No hay nada que hacer salvo decirlo.
 *
 * El recuento se hace en SQL porque `v_map_canvas` sólo trae los elementos de
 * un mapa: desde ahí es imposible saber si una punta está en otro lienzo o no
 * está en ninguno.
 */
export async function enlacesFueraDelMapa(mapId: number): Promise<EnlacesFuera> {
  const resumen = await consultarUna<{ otro_mapa: number; rotos: number }>(
    `WITH r AS (
       SELECT l.id, a.map_id AS ma, b.map_id AS mb,
              (a.id IS NULL OR b.id IS NULL) AS roto
       FROM map_elements l
       LEFT JOIN map_elements a ON a.id = l.link_from
       LEFT JOIN map_elements b ON b.id = l.link_to
       WHERE l.map_id = $1 AND l.kind = 'link'
     )
     SELECT
       count(*) FILTER (WHERE NOT roto AND (ma <> $1 OR mb <> $1))::int AS otro_mapa,
       count(*) FILTER (WHERE roto)::int                                AS rotos
     FROM r`,
    [mapId],
  );

  const destinos = await consultar<DestinoEnlace>(
    `WITH r AS (
       SELECT l.id, a.map_id AS ma, b.map_id AS mb
       FROM map_elements l
       LEFT JOIN map_elements a ON a.id = l.link_from
       LEFT JOIN map_elements b ON b.id = l.link_to
       WHERE l.map_id = $1 AND l.kind = 'link'
     ),
     puntas AS (
       SELECT id, ma AS mapa FROM r WHERE ma IS NOT NULL AND ma <> $1
       UNION ALL
       SELECT id, mb        FROM r WHERE mb IS NOT NULL AND mb <> $1
     )
     SELECT m.id, m.name AS nombre, count(DISTINCT p.id)::int AS enlaces
     FROM puntas p
     JOIN maps m ON m.id = p.mapa
     GROUP BY m.id, m.name
     ORDER BY enlaces DESC, m.name
     LIMIT 6`,
    [mapId],
  );

  return {
    otroMapa: resumen?.otro_mapa ?? 0,
    rotos: resumen?.rotos ?? 0,
    destinos,
  };
}

/** En qué mapas aparece un equipo. Para poder ir del detalle a la topología. */
export async function mapasDeDispositivo(
  deviceId: number,
): Promise<{ id: number; nombre: string }[]> {
  return consultar(
    `SELECT DISTINCT m.id, m.name AS nombre
     FROM map_elements e
     JOIN maps m ON m.id = e.map_id
     WHERE e.device_id = $1
     ORDER BY m.name`,
    [deviceId],
  );
}

// ── Dispositivos ────────────────────────────────────────────────────────────

export interface FilaDispositivo {
  id: number;
  nombre: string;
  tipo: string | null;
  tipo_id: number | null;
  status: number | null;
  status_label: string | null;
  direcciones: string[];
  services_total: number;
  services_up: number;
  services_down: number;
  router_os: boolean | null;
  /** Desde cuándo está en este estado. Ver `SQL_ESTADO_DESDE`. */
  estado_desde: string | null;
}

export type ColumnaOrden = 'nombre' | 'estado' | 'tipo' | 'servicios' | 'ip' | 'antiguedad';

/**
 * Lista blanca de ordenamientos.
 *
 * El nombre de columna no se puede parametrizar en SQL: va concatenado. Por eso
 * NUNCA sale de la entrada del usuario — se mapea contra estas claves fijas.
 */
const ORDEN: Record<ColumnaOrden, string> = {
  // Urgencia, no valor numérico: caído (3) primero, arriba (1) último.
  estado: 'CASE COALESCE(d.status,0) WHEN 3 THEN 0 WHEN 2 THEN 1 WHEN 0 THEN 2 ELSE 3 END',
  nombre: 'lower(d.name)',
  tipo: 'lower(coalesce(dt.name, \'\'))',
  servicios: 'd.services_down',
  ip: 'coalesce(d.addresses[1], \'0.0.0.0\'::inet)',
  antiguedad: 'sc.estado_desde',
};

/**
 * Columnas donde «ascendente» en la pantalla es DESC en la base.
 *
 * La columna muestra una DURACIÓN («hace 3 h») y guarda un INSTANTE. Ordenar la
 * duración de menor a mayor es ordenar el instante de mayor a menor. Sin esta
 * inversión, pedir «los más recientes primero» devolvía los de 2022.
 */
const ORDEN_INVERTIDO = new Set<ColumnaOrden>(['antiguedad']);

/**
 * Dónde se ponen los nulos.
 *
 * `sc.estado_desde` es nulo en los 32 equipos sin ningún servicio. Sin
 * `NULLS LAST` PostgreSQL los pone primero en DESC, o sea que «ordenar por lo
 * más reciente» arrancaba con treinta y dos filas que dicen «—».
 */
const NULOS_AL_FINAL = new Set<ColumnaOrden>(['antiguedad']);

export interface FiltrosDispositivos {
  estado?: Estado | null;
  tipoId?: number | null;
  texto?: string | null;
  /** Filtro por hace cuánto que el equipo está como está. Ver `antiguedad.ts`. */
  antiguedad?: Antiguedad | null;
  orden?: ColumnaOrden;
  desc?: boolean;
  pagina?: number;
  porPagina?: number;
}

export interface PaginaDispositivos {
  filas: FilaDispositivo[];
  total: number;
  pagina: number;
  porPagina: number;
  paginas: number;
}

export async function listarDispositivos(f: FiltrosDispositivos = {}): Promise<PaginaDispositivos> {
  // `Object.hasOwn` y no `ORDEN[clave]` a secas: `ORDEN['constructor']` y
  // `ORDEN['toString']` devuelven lo heredado del prototipo, que es truthy. La
  // guarda dejaba pasar la clave y después `ORDEN[orden]` se concatenaba en la
  // SQL. No era explotable —lo que se concatena es el valor heredado, no la
  // cadena del atacante, y `Function.prototype.toString` no es SQL válida, así
  // que la consulta rompe— pero una lista blanca que aprueba lo que no está en
  // la lista no es una lista blanca.
  const pedido = f.orden ?? 'estado';
  const orden: ColumnaOrden = Object.hasOwn(ORDEN, pedido) ? pedido : 'estado';
  const ascendente = ORDEN_INVERTIDO.has(orden) ? !!f.desc : !f.desc;
  const dir = ascendente ? 'ASC' : 'DESC';
  const nulos = NULOS_AL_FINAL.has(orden) ? ' NULLS LAST' : '';
  const porPagina = Math.min(Math.max(f.porPagina ?? 50, 10), 200);
  const pagina = Math.max(f.pagina ?? 1, 1);

  const where = `
    WHERE ($1::smallint IS NULL OR COALESCE(d.status, 0) = $1)
      AND ($2::bigint   IS NULL OR d.type_id = $2)
      AND ($3::text     IS NULL OR d.name ILIKE '%' || $3 || '%'
           OR EXISTS (SELECT 1 FROM unnest(d.addresses) a
                      WHERE host(a) LIKE $3 || '%'))
      AND ($4::text     IS NULL
           OR ${sqlAntiguedad('sc.estado_desde', '$5::int', '$6::int')} = $4)
  `;
  const params = [
    f.estado ?? null,
    f.tipoId ?? null,
    f.texto?.trim() || null,
    f.antiguedad ?? null,
    DIAS_RECIENTE,
    DIAS_RESIDUO,
  ];

  const totalFila = await consultarUna<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM devices d
     LEFT JOIN device_types dt ON dt.id = d.type_id
     ${JOIN_ESTADO_DESDE}
     ${where}`,
    params,
  );
  const total = totalFila?.n ?? 0;
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaReal = Math.min(pagina, paginas);

  const filas = await consultar<FilaDispositivo>(
    `SELECT d.id,
            d.name AS nombre,
            dt.name AS tipo,
            d.type_id AS tipo_id,
            d.status, d.status_label,
            ARRAY(SELECT host(a) FROM unnest(d.addresses) a) AS direcciones,
            d.services_total, d.services_up, d.services_down,
            d.router_os,
            sc.estado_desde
     FROM devices d
     LEFT JOIN device_types dt ON dt.id = d.type_id
     ${JOIN_ESTADO_DESDE}
     ${where}
     ORDER BY ${ORDEN[orden]} ${dir}${nulos}, lower(d.name) ASC
     LIMIT $7 OFFSET $8`,
    [...params, porPagina, (paginaReal - 1) * porPagina],
  );

  return { filas, total, pagina: paginaReal, porPagina, paginas };
}

export async function tiposDeDispositivo(): Promise<{ id: number; nombre: string; n: number }[]> {
  return consultar(
    `SELECT dt.id, dt.name AS nombre, count(d.id)::int AS n
     FROM device_types dt
     LEFT JOIN devices d ON d.type_id = dt.id
     GROUP BY dt.id, dt.name
     HAVING count(d.id) > 0
     ORDER BY dt.name`,
  );
}

// ── Detalle de un dispositivo ───────────────────────────────────────────────

export interface Dispositivo extends FilaDispositivo {
  dns_names: string | null;
  macs: string[];
  perfil_snmp: string | null;
  snmp_version: number | null;
  probe_enabled: boolean | null;
  probe_interval: number | null;
  probe_timeout: number | null;
  probe_down_count: number | null;
  dude_server: boolean | null;
}

export async function obtenerDispositivo(id: number): Promise<Dispositivo | null> {
  const d = await consultarUna<Dispositivo>(
    `SELECT d.id, d.name AS nombre,
            dt.name AS tipo, d.type_id AS tipo_id,
            d.status, d.status_label,
            ARRAY(SELECT host(a) FROM unnest(d.addresses) a) AS direcciones,
            d.dns_names, d.macs,
            sp.name AS perfil_snmp, sp.version AS snmp_version,
            d.router_os, d.probe_enabled, d.probe_interval,
            d.probe_timeout, d.probe_down_count, d.dude_server,
            d.services_total, d.services_up, d.services_down,
            sc.estado_desde
     FROM devices d
     LEFT JOIN device_types  dt ON dt.id = d.type_id
     LEFT JOIN snmp_profiles sp ON sp.id = d.snmp_profile_id
     ${JOIN_ESTADO_DESDE}
     WHERE d.id = $1`,
    [id],
  );
  return d ?? null;
}

/**
 * ¿La topología está cargada en esta instalación?
 *
 * 🔴 `device_parents` está VACÍA en la base real, y el ETL es fiel: The Dude no
 *    tiene `parentIDs` en ninguno de sus 885 equipos. El problema es de
 *    lectura, no de datos: la ficha decía «No cuelga de ningún equipo. Es raíz
 *    de la topología», que es una AFIRMACIÓN sobre la red. Y es falsa: lo
 *    cierto es «este dato no está cargado en ninguna parte».
 *
 *    Distinguirlas necesita saber si la tabla tiene algo para ALGUIEN. Con la
 *    tabla vacía, la sección lo dice; con la tabla poblada, un equipo sin
 *    padres sí es una raíz.
 */
export async function hayTopologia(): Promise<boolean> {
  const f = await consultarUna<{ hay: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM device_parents) AS hay',
  );
  return f?.hay ?? false;
}

/**
 * 🔴 Los nombres de The Dude mienten y acá se corrigen.
 *
 * `timeLastUp` y `timeLastDown` NO son fechas: son **duraciones en segundos**
 * (medido: `timeLastDown` coincide exacto con lo que duró la última caída en
 * 251 de 311 servicios). Mostrarlos como instante pone «1970» en pantalla.
 *
 * El que sí es un instante es `timeSinceChanged`, a pesar del nombre. El
 * esquema ya lo expone convertido en `status_changed_at`, que es lo que se usa.
 */
export interface Servicio {
  id: number;
  sonda: string | null;
  unidad: string | null;
  status: number | null;
  status_label: string | null;
  enabled: boolean | null;
  acked: boolean | null;
  probes_down: number | null;
  probe_port: number | null;
  probe_interval: number | null;
  /** Instante del último cambio de estado. */
  cambio_en: string | null;
  /** Cuánto estuvo arriba, en segundos. */
  duro_arriba_s: number | null;
  /** Cuánto duró la última caída, en segundos. */
  duro_caido_s: number | null;
}

export async function serviciosDe(deviceId: number): Promise<Servicio[]> {
  return consultar<Servicio>(
    `SELECT s.id, p.name AS sonda, p.unit AS unidad,
            s.status, s.status_label, s.enabled, s.acked,
            s.probes_down, s.probe_port, s.probe_interval,
            s.status_changed_at AS cambio_en,
            s.time_last_up      AS duro_arriba_s,
            s.time_last_down    AS duro_caido_s
     FROM services s
     LEFT JOIN probes p ON p.id = s.probe_id
     WHERE s.device_id = $1
     ORDER BY CASE COALESCE(s.status,0)
                WHEN 3 THEN 0 WHEN 2 THEN 1 WHEN 0 THEN 2 ELSE 3 END,
              lower(coalesce(p.name, ''))`,
    [deviceId],
  );
}

export interface Vecino {
  id: number;
  nombre: string | null;
  status: number | null;
  /** Profundidad en la cadena: 1 es el padre directo. */
  nivel: number;
}

/**
 * La cadena de dependencia hacia arriba.
 *
 * Recursiva porque lo que el operador necesita saber a las 3 AM no es "de quién
 * cuelga" sino "cuál de los de arriba es el que se cayó de verdad": si el
 * troncal está caído, los veinte clientes de abajo son ruido.
 *
 * `depth < 12` corta ciclos — `device_parents` no tiene FK ni garantía de
 * aciclicidad, y una topología mal cargada colgaría la consulta.
 */
export async function cadenaDePadres(deviceId: number): Promise<Vecino[]> {
  return consultar<Vecino>(
    `WITH RECURSIVE arriba(id, nivel) AS (
       SELECT p.parent_id, 1 FROM device_parents p WHERE p.device_id = $1
       UNION
       SELECT p.parent_id, a.nivel + 1
       FROM device_parents p JOIN arriba a ON p.device_id = a.id
       WHERE a.nivel < 12
     )
     SELECT a.id, d.name AS nombre, d.status, min(a.nivel)::int AS nivel
     FROM arriba a
     LEFT JOIN devices d ON d.id = a.id
     GROUP BY a.id, d.name, d.status
     ORDER BY nivel, lower(coalesce(d.name, ''))`,
    [deviceId],
  );
}

/** Quiénes cuelgan directamente de este equipo. */
export async function hijosDe(deviceId: number): Promise<Vecino[]> {
  return consultar<Vecino>(
    `SELECT d.id, d.name AS nombre, d.status, 1 AS nivel
     FROM device_parents p
     JOIN devices d ON d.id = p.device_id
     WHERE p.parent_id = $1
     ORDER BY CASE COALESCE(d.status,0)
                WHEN 3 THEN 0 WHEN 2 THEN 1 WHEN 0 THEN 2 ELSE 3 END,
              lower(d.name)`,
    [deviceId],
  );
}

// ── La tarjeta de un nodo ───────────────────────────────────────────────────

export interface InterfazConTrafico {
  /** Nombre de la interfaz, ya sin el « @ equipo rx» que le pone The Dude. */
  interfaz: string;
  entrada_bits: number | null;
  salida_bits: number | null;
  /** Instante de la muestra más nueva de las dos. */
  ts: string | null;
}

/**
 * Tráfico por interfaz de un equipo, para la tarjeta emergente.
 *
 * Mismo truco de índice que `traficoDeMapa` —un `LIMIT 1` por balde en vez de
 * un `DISTINCT ON` que barre la tabla— y por el mismo motivo.
 *
 * El nombre de la interfaz sale de recortarle a `chart_sources.name` el sufijo
 * ` @ <equipo> rx|tx` que arma The Dude. No es un parseo frágil: el sufijo lo
 * escribe siempre el mismo código del origen, y si un día no coincide, lo que
 * pasa es que se muestra el nombre entero — feo, no falso.
 */
export async function traficoDeDispositivo(
  deviceId: number,
  limite = 6,
): Promise<InterfazConTrafico[]> {
  return consultar<InterfazConTrafico>(
    `WITH fuentes AS (
       SELECT cs.id,
              regexp_replace(cs.name, '\\s+@\\s+.*\\s+(rx|tx)$', '') AS interfaz,
              CASE WHEN cs.name LIKE '% rx' THEN 'rx'
                   WHEN cs.name LIKE '% tx' THEN 'tx' END AS sentido
       FROM chart_sources cs
       WHERE cs.device_id = $1 AND cs.unit = 'bit/s'
     ),
     ult AS (
       SELECT f.interfaz, f.sentido, u.ts, u.value
       FROM fuentes f
       CROSS JOIN LATERAL (
         SELECT x.ts, x.value
         FROM (VALUES ('raw', 1), ('10min', 2), ('2hour', 3), ('1day', 4)) AS b(bucket, pref)
         CROSS JOIN LATERAL (
           SELECT c.ts, c.value FROM chart_values c
           WHERE c.source_id = f.id AND c.bucket = b.bucket AND c.value IS NOT NULL
           ORDER BY c.ts DESC LIMIT 1
         ) x
         ORDER BY x.ts DESC, b.pref LIMIT 1
       ) u
       WHERE f.sentido IS NOT NULL
     )
     SELECT interfaz,
            max(value) FILTER (WHERE sentido = 'rx') AS entrada_bits,
            max(value) FILTER (WHERE sentido = 'tx') AS salida_bits,
            max(ts) AS ts
     FROM ult
     GROUP BY interfaz
     ORDER BY GREATEST(COALESCE(max(value) FILTER (WHERE sentido = 'rx'), 0),
                       COALESCE(max(value) FILTER (WHERE sentido = 'tx'), 0)) DESC,
              interfaz
     LIMIT $2`,
    [deviceId, limite],
  );
}

export interface FichaNodo {
  equipo: Dispositivo;
  servicios: Servicio[];
  mapas: { id: number; nombre: string }[];
  interfaces: InterfazConTrafico[];
  /** Caídas cerradas del histórico. Sólo las últimas; el resto vive en la ficha. */
  caidas: Caida[];
  /** `false` si `device_parents` está vacía en toda la base. Ver `hayTopologia`. */
  topologiaCargada: boolean;
  padres: Vecino[];
}

/**
 * Todo lo que muestra la tarjeta emergente de un nodo, en un viaje.
 *
 * 🔴 Una función y no seis llamadas desde la ruta: así el barrido antifuga de
 *    `consultas.test.ts` cubre la tarjeta entera con una sola entrada, en vez
 *    de depender de que alguien se acuerde de agregar cada consulta nueva.
 *
 * El límite de servicios y de caídas es bajo a propósito: la tarjeta es una
 * respuesta rápida, no la ficha. Cuando hay más, dice cuántos hay y linkea.
 */
export async function fichaNodo(deviceId: number): Promise<FichaNodo | null> {
  const equipo = await obtenerDispositivo(deviceId);
  if (!equipo) return null;

  const [servicios, mapas, interfaces, caidas, topologiaCargada, padres] = await Promise.all([
    serviciosDe(deviceId),
    mapasDeDispositivo(deviceId),
    traficoDeDispositivo(deviceId),
    caidasDe(deviceId, 3),
    hayTopologia(),
    cadenaDePadres(deviceId),
  ]);

  return { equipo, servicios, mapas, interfaces, caidas, topologiaCargada, padres };
}

// ── Búsqueda ────────────────────────────────────────────────────────────────

export interface Resultado {
  kind: 'device' | 'map';
  id: number;
  nombre: string;
  status: number | null;
  detalle: string | null;
}

/**
 * Un solo campo para nombre e IP.
 *
 * El operador que mira un ticket no sabe si tiene el nombre o la dirección: le
 * damos una caja y que el buscador se arregle. El prefijo de IP se prioriza
 * porque escribir el prefijo de una subred y que aparezcan primero sus equipos es
 * exactamente lo que se espera.
 */
export async function buscar(q: string, limite = 20): Promise<Resultado[]> {
  const texto = q.trim();
  if (texto.length < 2) return [];

  return consultar<Resultado>(
    `SELECT kind, id, name AS nombre, status, detail AS detalle
     FROM v_search
     WHERE name ILIKE '%' || $1 || '%'
        OR detail ILIKE '%' || $1 || '%'
     ORDER BY
       (detail LIKE $1 || '%')      DESC,  -- coincidencia de IP por prefijo
       (name ILIKE $1 || '%')       DESC,  -- el nombre empieza igual
       (kind = 'device')            DESC,  -- equipos antes que mapas
       length(name) ASC,
       lower(name) ASC
     LIMIT $2`,
    [texto, limite],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Posiciones puestas a mano
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Guarda dónde quedó cada nodo. Devuelve cuántas filas quedaron escritas.
 *
 * 🔴 Un solo `INSERT ... ON CONFLICT` con arrays, no N sentencias en un bucle.
 *    Arrastrar una selección de treinta nodos serían treinta idas y vueltas a
 *    Postgres; así es una. Y es **atómico**: o entra todo o no entra nada, que
 *    es lo que hace falta para no dejar la mitad de una selección movida.
 *
 *    `unnest` de tres arrays en paralelo es la forma de mandar un lote sin
 *    construir SQL a mano — nada de concatenar valores en la cadena.
 */
export async function guardarPosiciones(
  movimientos: { id: number; x: number; y: number }[],
  usuario: string,
): Promise<number> {
  if (movimientos.length === 0) return 0;

  const filas = await consultar<{ element_id: string }>(
    `INSERT INTO map_element_positions (element_id, x, y, moved_by, moved_at)
     SELECT t.element_id, t.x, t.y, $4::text, now()
       FROM unnest($1::bigint[], $2::int[], $3::int[]) AS t(element_id, x, y)
     ON CONFLICT (element_id) DO UPDATE
       SET x = EXCLUDED.x, y = EXCLUDED.y,
           moved_by = EXCLUDED.moved_by, moved_at = EXCLUDED.moved_at
     RETURNING element_id`,
    [movimientos.map((m) => m.id), movimientos.map((m) => m.x), movimientos.map((m) => m.y), usuario],
  );
  return filas.length;
}

/** Vuelve a las coordenadas de The Dude: un mapa entero o unos nodos sueltos. */
export async function restablecerPosiciones(
  q: { mapa: number | null; ids: number[] },
): Promise<number> {
  if (q.ids.length > 0) {
    const filas = await consultar<{ element_id: string }>(
      'DELETE FROM map_element_positions WHERE element_id = ANY($1::bigint[]) RETURNING element_id',
      [q.ids],
    );
    return filas.length;
  }
  const filas = await consultar<{ element_id: string }>(
    `DELETE FROM map_element_positions p
      USING map_elements e
      WHERE e.id = p.element_id AND e.map_id = $1
      RETURNING p.element_id`,
    [q.mapa],
  );
  return filas.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Accesos por protocolo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo que hace falta para ofrecer Winbox / web / SSH sobre un equipo.
 *
 * La resolución vive en `lib/accesos.ts`; acá sólo se juntan los datos. La
 * separación importa: la regla de «no publicar credenciales» es lógica pura y
 * así se puede probar sin base.
 */
export async function datosDeAcceso(deviceId: number): Promise<{
  direcciones: string[];
  routerOs: boolean | null;
  urlTipo: string | null;
  nombreTipo: string | null;
  servicios: { sonda: string | null; puerto: number | null; puertoSonda: number | null; habilitado: boolean | null }[];
} | null> {
  const d = await consultarUna<{
    direcciones: string[];
    router_os: boolean | null;
    url_tipo: string | null;
    nombre_tipo: string | null;
  }>(
    `SELECT ARRAY(SELECT host(a) FROM unnest(d.addresses) a) AS direcciones,
            d.router_os, dt.url AS url_tipo, dt.name AS nombre_tipo
       FROM devices d
       LEFT JOIN device_types dt ON dt.id = d.type_id
      WHERE d.id = $1`,
    [deviceId],
  );
  if (!d) return null;

  const servicios = await consultar<{
    sonda: string | null; puerto: number | null; puerto_sonda: number | null; habilitado: boolean | null;
  }>(
    `SELECT p.name AS sonda, s.probe_port AS puerto,
            p.default_port AS puerto_sonda, s.enabled AS habilitado
       FROM services s LEFT JOIN probes p ON p.id = s.probe_id
      WHERE s.device_id = $1`,
    [deviceId],
  );

  return {
    direcciones: d.direcciones ?? [],
    routerOs: d.router_os,
    urlTipo: d.url_tipo,
    nombreTipo: d.nombre_tipo,
    servicios: servicios.map((s) => ({
      sonda: s.sonda, puerto: s.puerto, puertoSonda: s.puerto_sonda, habilitado: s.habilitado,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Historia medida
// ─────────────────────────────────────────────────────────────────────────────

export interface SerieHistoria {
  fuente_id: number;
  nombre: string;
  unidad: string | null;
  /** [epoch en segundos, valor]. Ordenada por tiempo. */
  puntos: [number, number][];
  /** De qué cajón del origen salió. Se muestra: el detalle no es lo mismo. */
  bucket: string;
}

/**
 * Qué cajón de `chart_values` usar según el rango.
 *
 * 🔴 Hay que elegir UNO. Las cuatro resoluciones conviven en la misma tabla y
 *    promediarlas juntas mezcla una medición cruda con el promedio de un día:
 *    sale un número que no es ninguna de las dos cosas.
 *
 * 🔴 Y HAY QUE CONTAR LAS QUE TIENEN VALOR, NO LAS FILAS.
 *
 *    Contando filas, `10min` y `2hour` parecen los mejores: 1.083 fuentes cada
 *    uno contra 439 de `raw`. Es una trampa. **Están casi vacíos**: The Dude
 *    crea la fila del promedio y deja `value` en NULL hasta tener con qué
 *    llenarla. Medido sobre la base real el 31/07/2026:
 *
 *      | cajón | filas   | con valor | %       |
 *      |-------|--------:|----------:|--------:|
 *      | raw   | 935.530 |   933.351 | **99,8**|
 *      | 2hour | 269.290 |   113.089 |    42,0 |
 *      | 10min | 215.796 |    86.441 |    40,1 |
 *      | y en bit/s, `10min` llega al **1,7 %**           |
 *
 *    Fuentes que sirven de verdad, por cajón y unidad:
 *
 *      | unidad     | raw     | 2hour | 10min | 1day |
 *      |------------|--------:|------:|------:|-----:|
 *      | s (ping)   | **428** |   397 |   300 |  428 |
 *      | bit/s      |      10 |     6 |     6 |   10 |
 *
 *    Así que `raw` gana en las dos cosas a la vez: mejor resolución **y** más
 *    cobertura. Cubre 43 días de latencia y 38 de tráfico, de sobra para todo
 *    lo que ofrece la interfaz salvo los rangos muy largos.
 *
 *    Elegí lo contrario hace un rato, por leer «1.083 fuentes» sin preguntar
 *    cuántas tenían un número adentro. Contar filas y contar datos no es lo
 *    mismo, y en una tabla de series temporales casi nunca lo es.
 */
function cajonPara(horas: number): { bucket: string; segundos: number } {
  // `raw` mientras la ventana entre en su cobertura medida (43 días).
  if (horas <= 24 * 30) return { bucket: 'raw', segundos: 60 };
  return { bucket: '1day', segundos: 86400 };
}

/**
 * Las series de un equipo para el rango pedido.
 *
 * La base tiene **1.668.471 mediciones** en 1.083 fuentes: 734 en segundos
 * (latencia de ping) y 348 en bit/s (tráfico). Traerlas crudas para un rango
 * largo son decenas de miles de puntos por serie para dibujar un gráfico de
 * 600 píxeles de ancho — se manda cien veces más de lo que se puede ver.
 *
 * Por eso se agrega en Postgres con `date_bin`, que es exactamente para esto y
 * está desde la 14. El tamaño del cajón sale del rango, para que el gráfico
 * tenga siempre del orden de 200 puntos: legible en el teléfono y en una
 * pantalla de NOC, y sin castigar a la base.
 */
export async function historiaDe(
  deviceId: number,
  horas = 24,
): Promise<SerieHistoria[]> {
  const h = Math.min(Math.max(Math.round(horas), 1), 24 * 90);
  const { bucket, segundos: paso } = cajonPara(h);
  // Nunca más fino que el propio cajón: pedirle 60 s a datos de 2 horas no
  // agrega detalle, sólo multiplica las filas por 120 y deja huecos.
  const segundos = Math.max(paso, Math.round((h * 3600) / 200 / paso) * paso);

  const filas = await consultar<{
    fuente_id: string; nombre: string; unidad: string | null; t: string; v: string;
  }>(
    `WITH fuentes AS (
       SELECT cs.id, cs.name, cs.unit
         FROM chart_sources cs
        WHERE cs.device_id = $1
           OR cs.service_id IN (SELECT id FROM services WHERE device_id = $1)
     )
     SELECT f.id AS fuente_id, f.name AS nombre, f.unit AS unidad,
            extract(epoch FROM date_bin(
              make_interval(secs => $3::int), cv.ts, timestamptz 'epoch'))::bigint AS t,
            avg(cv.value) AS v
       FROM fuentes f JOIN chart_values cv ON cv.source_id = f.id
      WHERE cv.bucket = $4
        -- 🔴 Sin esto el promedio de un cajón sin datos da NULL y la serie
        --    sale llena de agujeros que parecen cortes de servicio.
        AND cv.value IS NOT NULL
        AND cv.ts >= now() - make_interval(hours => $2::int)
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 4`,
    [deviceId, h, segundos, bucket],
  );

  const porFuente = new Map<number, SerieHistoria>();
  for (const f of filas) {
    const id = Number(f.fuente_id);
    let s = porFuente.get(id);
    if (!s) {
      s = { fuente_id: id, nombre: f.nombre, unidad: f.unidad, puntos: [], bucket };
      porFuente.set(id, s);
    }
    s.puntos.push([Number(f.t), Number(f.v)]);
  }
  // Las series con un solo punto no dibujan una línea: no se ofrecen.
  return [...porFuente.values()].filter((s) => s.puntos.length > 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Caídas — la vista del operador
// ─────────────────────────────────────────────────────────────────────────────

export interface FiltrosCaidas {
  /** Horas hacia atrás. */
  horas?: number;
  /** Sólo las que duraron al menos esto, en segundos. */
  minimo_s?: number;
  /** Texto contra el nombre del equipo. */
  q?: string;
  pagina?: number;
  porPagina?: number;
}

export interface PaginaCaidas {
  caidas: Caida[];
  total: number;
  pagina: number;
  paginas: number;
  /** Para el encabezado: cuántas y cuánto tiempo, en el rango filtrado. */
  equipos_afectados: number;
  tiempo_total_s: number;
}

/**
 * El historial de caídas, filtrable y paginado.
 *
 * 🔴 Esto existe porque la base tiene **12.146 caídas registradas** y el panel
 *    no tenía ninguna página donde verlas: sólo las últimas doce en el tablero
 *    y las de un equipo en su ficha. Un historial que no se puede recorrer es
 *    un historial que no existe para quien está de guardia.
 *
 * El filtro por duración mínima es el que hace usable la lista. Sin él, las
 * caídas de treinta segundos —que son ruido de sondeo, no incidentes— entierran
 * a las de dos horas, que son las que hay que mirar.
 */
export async function historialCaidas(f: FiltrosCaidas = {}): Promise<PaginaCaidas> {
  const horas = Math.min(Math.max(Math.round(f.horas ?? 24 * 7), 1), 24 * 365);
  const minimo = Math.max(Math.round(f.minimo_s ?? 0), 0);
  const q = (f.q ?? '').trim();
  const porPagina = Math.min(Math.max(Math.round(f.porPagina ?? 50), 10), 200);
  const pagina = Math.max(Math.round(f.pagina ?? 1), 1);

  const donde = `
    WHERE o.started_at >= now() - make_interval(hours => $1::int)
      AND COALESCE(o.duration_s, EXTRACT(epoch FROM now() - o.started_at)) >= $2
      AND ($3 = '' OR d.name ILIKE '%' || $3 || '%')`;

  const [resumen] = await consultar<{ total: string; equipos: string; tiempo: string }>(
    `SELECT count(*) AS total,
            count(DISTINCT o.device_id) AS equipos,
            COALESCE(sum(COALESCE(o.duration_s, EXTRACT(epoch FROM now() - o.started_at))), 0) AS tiempo
       FROM outages o LEFT JOIN devices d ON d.id = o.device_id
       ${donde}`,
    [horas, minimo, q],
  );

  const total = Number(resumen?.total ?? 0);
  const paginas = Math.max(Math.ceil(total / porPagina), 1);
  const desde = (Math.min(pagina, paginas) - 1) * porPagina;

  const caidas = await consultar<Caida>(
    `SELECT o.id, o.device_id, d.name AS equipo, p.name AS sonda,
            o.started_at AS inicio, o.ended_at AS fin,
            COALESCE(o.duration_s, EXTRACT(epoch FROM now() - o.started_at))::bigint AS duracion_s,
            (o.ended_at IS NULL) AS abierta
       FROM outages o
       LEFT JOIN devices d  ON d.id = o.device_id
       LEFT JOIN services s ON s.id = o.service_id
       LEFT JOIN probes p   ON p.id = s.probe_id
       ${donde}
       -- Las abiertas primero: son las que todavía se pueden atender. Después
       -- por duración, que es el orden en que importan las que ya terminaron.
       ORDER BY (o.ended_at IS NULL) DESC,
                COALESCE(o.duration_s, EXTRACT(epoch FROM now() - o.started_at)) DESC,
                o.started_at DESC
       LIMIT $4 OFFSET $5`,
    [horas, minimo, q, porPagina, desde],
  );

  return {
    caidas,
    total,
    pagina: Math.min(pagina, paginas),
    paginas,
    equipos_afectados: Number(resumen?.equipos ?? 0),
    tiempo_total_s: Math.round(Number(resumen?.tiempo ?? 0)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Disponibilidad — el reporte facturable
//
// Acá está SÓLO la SQL. Toda la aritmética (porcentaje, MTBF, MTTR), la
// clasificación de cobertura y el armado del CSV viven en `lib/disponibilidad.ts`,
// donde se prueban sin base de datos. La regla es una sola: esta capa extrae
// contadores crudos y no interpreta nada.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El primer instante del que hay registro. `null` si la base está vacía.
 *
 * 🔴 Se MIDE, no se escribe a mano. Hoy da `2026-06-12 14:54:07`, que es cuando
 *    se rearmó la base de The Dude tras chocar contra el techo de 2 GB, pero
 *    clavar esa fecha en el código sería garantizar que el reporte mienta la
 *    próxima vez que la base se rehaga —y ya pasó una vez, en junio de 2026.
 *
 * Se usa `min(started_at)` de `outages` y no la primera corrida del ETL:
 * `sync_runs` se trunca al reinstalar el panel y hoy tiene una sola fila, del
 * 01/08/2026. Tomar eso como horizonte tiraría siete semanas de historia real.
 */
export async function horizonteDatos(): Promise<Date | null> {
  const fila = await consultarUna<{ desde: Date | null }>(
    'SELECT min(started_at) AS desde FROM outages',
  );
  return fila?.desde ?? null;
}

/**
 * Contadores por equipo dentro de una ventana. Una fila por equipo, TODOS los
 * equipos —incluidos los que no se monitorean— porque su ausencia también es
 * información y la página tiene que poder decir «de estos 168 no sé nada».
 *
 * 🔴 `range_agg` y no `sum(duration_s)`. Ese es el corazón de la consulta.
 *
 *    Un equipo con tres servicios puede tener tres caídas simultáneas: sumar
 *    duraciones cuenta el mismo minuto tres veces y llega a dar más de 100 % de
 *    indisponibilidad. `range_agg` fusiona los intervalos que se pisan y
 *    `unnest` los devuelve ya unidos, así que `count(*)` es el número de
 *    EPISODIOS reales del equipo y la suma es tiempo de reloj.
 *
 *    Medido el 01/08/2026 sobre la ventana completa: 11.908 filas de `outages`
 *    colapsan a 11.905 episodios —3 solapamientos, entre los 6 equipos que
 *    tienen más de un servicio—. Es el 0,03 %: demasiado poco para notarlo
 *    mirando, más que suficiente para que un cliente encuentre la diferencia.
 *    Se devuelven las dos cifras (`eventos` y `caidas_servicio`) porque no son
 *    lo mismo y el reporte tiene que poder mostrar las dos.
 *
 * 🔴 Las caídas RECONOCIDAS (`services.acked`, 495 de 859) cuentan igual.
 *
 *    No es un olvido, es la única opción defendible: `acked` es el estado de
 *    HOY del servicio, y `outages` no tiene columna de reconocimiento. Filtrar
 *    por ahí borraría siete semanas de historia según lo que alguien haya
 *    tildado esta mañana, y además «el operador vio la alarma» no es «el enlace
 *    estaba andando» — el cliente estuvo sin servicio igual. Lo que sí se
 *    devuelve es `reconocidos`, para que la columna exista y se pueda auditar.
 *
 * El recorte a la ventana se hace en la SQL —`GREATEST`/`LEAST`— y no después:
 * una caída de junio que sigue en julio tiene que aportarle a julio sólo su
 * parte de julio. Las abiertas (`ended_at IS NULL`) se cierran contra `now()`.
 */
export interface CrudoDisponibilidad {
  device_id: number;
  equipo: string;
  mapa_id: number | null;
  mapa: string | null;
  /** Servicios habilitados HOY. Cero significa «no se monitorea». */
  servicios: number;
  /** De esos, cuántos están reconocidos (silenciados) hoy. */
  reconocidos: number;
  /** Desde cuándo hay constancia de monitoreo. Ver `clasificarCobertura`. */
  visto_desde: Date | null;
  /** Episodios del EQUIPO: intervalos ya unidos. */
  eventos: number;
  /** Filas de `outages`, sin unir. Difiere de `eventos` cuando hubo solapamiento. */
  caidas_servicio: number;
  /** Cuántas de esas siguen abiertas. */
  abiertas: number;
  /** Segundos caídos, ya recortados a la ventana y sin contar dos veces. */
  caido_s: number;
  primera: Date | null;
  ultima: Date | null;
}

export interface FiltrosDisponibilidad {
  desde: Date;
  hasta: Date;
  /** Texto contra el nombre del equipo. */
  q?: string;
  /** Un solo mapa, o `null` para todos. */
  mapa?: number | null;
}

export async function crudoDisponibilidad(
  f: FiltrosDisponibilidad,
): Promise<CrudoDisponibilidad[]> {
  const q = (f.q ?? '').trim();
  const mapa = Number.isFinite(f.mapa) && f.mapa != null ? Math.trunc(f.mapa) : null;

  return consultar<CrudoDisponibilidad>(
    `WITH v AS (SELECT $1::timestamptz AS ini, $2::timestamptz AS fin),
     -- Un equipo puede estar dibujado en varios mapas. Medido el 01/08/2026:
     -- hoy ninguno lo está (884 equipos repartidos en 36 mapas, cero
     -- repetidos). Igual se elige UNO y de forma determinística, para que la
     -- suma por mapa cierre contra el total general en vez de contar de más.
     mapa_de AS (
       SELECT DISTINCT ON (me.device_id) me.device_id, me.map_id, m.name AS mapa
         FROM map_elements me JOIN maps m ON m.id = me.map_id
        WHERE me.kind = 'device' AND me.device_id IS NOT NULL
        ORDER BY me.device_id, me.map_id),
     serv AS (
       SELECT device_id,
              count(*) FILTER (WHERE enabled) AS habilitados,
              count(*) FILTER (WHERE enabled AND acked) AS reconocidos,
              -- status_changed_at es el ÚNICO instante real de esta tabla:
              -- time_last_up y time_last_down son duraciones en segundos
              -- (medido: el máximo es 4.294.967.284 = 2^32-12, un centinela de
              -- «nunca»). Leerlas como epoch daba equipos vistos en 1890.
              min(status_changed_at) FILTER (WHERE enabled) AS visto_desde
         FROM services GROUP BY device_id),
     rec AS (
       SELECT o.device_id,
              tstzrange(GREATEST(o.started_at, v.ini),
                        LEAST(COALESCE(o.ended_at, now()), v.fin)) AS r,
              (o.ended_at IS NULL) AS abierta
         FROM outages o CROSS JOIN v
        WHERE o.device_id IS NOT NULL
          AND o.started_at < v.fin
          AND COALESCE(o.ended_at, now()) > v.ini),
     uni AS (
       SELECT device_id, range_agg(r) AS mr, count(*) AS filas,
              count(*) FILTER (WHERE abierta) AS abiertas
         FROM rec WHERE NOT isempty(r) GROUP BY device_id),
     epi AS (
       SELECT u.device_id, u.filas, u.abiertas, count(*) AS eventos,
              sum(EXTRACT(epoch FROM (upper(x) - lower(x))))::bigint AS caido_s,
              min(lower(x)) AS primera, max(upper(x)) AS ultima
         FROM uni u, unnest(u.mr) AS x
        GROUP BY u.device_id, u.filas, u.abiertas)
     SELECT d.id AS device_id, d.name AS equipo,
            md.map_id AS mapa_id, md.mapa,
            COALESCE(s.habilitados, 0)::int AS servicios,
            COALESCE(s.reconocidos, 0)::int AS reconocidos,
            s.visto_desde,
            COALESCE(e.eventos, 0)::int   AS eventos,
            COALESCE(e.filas, 0)::int     AS caidas_servicio,
            COALESCE(e.abiertas, 0)::int  AS abiertas,
            COALESCE(e.caido_s, 0)::bigint AS caido_s,
            e.primera, e.ultima
       FROM devices d
       CROSS JOIN v
       LEFT JOIN mapa_de md ON md.device_id = d.id
       LEFT JOIN serv s     ON s.device_id  = d.id
       LEFT JOIN epi e      ON e.device_id  = d.id
      WHERE ($3 = '' OR d.name ILIKE '%' || $3 || '%')
        AND ($4::bigint IS NULL OR md.map_id = $4::bigint)`,
    [f.desde, f.hasta, q, mapa],
  );
}

/**
 * Los mapas que tienen equipos, para el desplegable del filtro.
 *
 * No se reusa `listarMapas()`: ese trae contadores de estado en vivo y una
 * consulta de más por mapa, y acá alcanza con el nombre y cuántos equipos hay.
 */
export async function mapasConEquipos(): Promise<{ id: number; nombre: string; n: number }[]> {
  return consultar<{ id: number; nombre: string; n: number }>(
    `SELECT m.id, m.name AS nombre, count(DISTINCT me.device_id)::int AS n
       FROM maps m
       JOIN map_elements me ON me.map_id = m.id AND me.kind = 'device'
                           AND me.device_id IS NOT NULL
      GROUP BY m.id, m.name
      HAVING count(DISTINCT me.device_id) > 0
      ORDER BY m.name`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  Topología INFERIDA del grafo de enlaces
//
//  🔴 `device_parents` está vacía y no va a llenarse sola: The Dude nunca
//     guardó `parentIDs`. Todo lo de acá abajo reemplaza esa tabla leyendo la
//     topología de donde SÍ está — los enlaces dibujados en los mapas — y
//     arrastra un nivel de confianza en cada respuesta.
//
//  El porqué del algoritmo, y sobre todo los tres métodos que se midieron y NO
//  funcionaron, está en `topologia.ts`. Acá sólo está el acceso a datos.
//
//  El `import` va acá y no arriba a propósito: las declaraciones de import se
//  izan, así que es legal en cualquier punto del módulo, y de este modo todo lo
//  nuevo entra como un bloque al final sin tocar una línea de lo que ya andaba.
// ════════════════════════════════════════════════════════════════════════════

import {
  cadenaAscendente,
  coberturaDe,
  dependenciaDe,
  hijosDirectos,
  inferirTopologia,
  TOPE_CADENA,
  type Arista,
  type Cobertura,
  type Confianza,
  type Dependencia,
  type Motivo,
  type Topologia,
} from './topologia';

/**
 * Cuánto vale el grafo cacheado antes de volver a leerlo.
 *
 * El ETL corre cada 30 s, pero lo que reescribe son estados y mediciones: los
 * enlaces del mapa cambian cuando alguien dibuja algo, o sea casi nunca. Leer y
 * recalcular 1.076 aristas en cada carga de ficha sería pagar por nada.
 *
 * El costo de estar desactualizado es acotado y barato: un enlace nuevo tarda
 * hasta un minuto en verse. El costo de NO cachear lo paga cada visita.
 */
export const TOPOLOGIA_TTL_MS = entero('TOPOLOGIA_TTL_MS', 60_000);

let topoCache: { valor: Topologia; vence: number } | undefined;

/** Tira el cache. Para los tests y para cuando el ETL avise que cambió el mapa. */
export function olvidarTopologia(): void {
  topoCache = undefined;
}

/**
 * El grafo, ya con dirección inferida y cacheado por proceso.
 *
 * Medido en la base real: la vista sale en ~2 ms y la inferencia sobre 792
 * nodos es despreciable. El cache no está por lentitud sino para no repetir el
 * mismo trabajo 885 veces por recorrida de mapa.
 */
export async function topologiaInferida(): Promise<Topologia> {
  const ahora = Date.now();
  if (topoCache && topoCache.vence > ahora) return topoCache.valor;

  const aristas = await consultar<Arista>(
    'SELECT nodo_a, nodo_b, tipo_a, tipo_b FROM v_topologia_aristas',
  );
  const valor = inferirTopologia(aristas);
  topoCache = { valor, vence: ahora + TOPOLOGIA_TTL_MS };
  return valor;
}

/**
 * Un `Vecino` con el sello de cuánto se le puede creer.
 *
 * 🔴 `confianza` y `motivo` NO son opcionales de mostrar. Este vecino no salió
 *    de una tabla: salió de deducir la dirección de un grafo no dirigido.
 *    Pintarlo igual que un dato cargado sería exactamente la mentira que
 *    `hayTopologia()` se puso a evitar, un nivel más arriba.
 */
export interface VecinoInferido extends Vecino {
  confianza: Confianza;
  motivo: Motivo;
}

/** Nombre y estado de un puñado de equipos, en una sola consulta. */
async function datosDe(ids: readonly number[]): Promise<Map<number, Vecino>> {
  if (ids.length === 0) return new Map();
  const filas = await consultar<{ id: number; nombre: string | null; status: number | null }>(
    'SELECT id, name AS nombre, status FROM devices WHERE id = ANY($1::bigint[])',
    [ids],
  );
  return new Map(filas.map((f) => [f.id, { ...f, nivel: 0 }]));
}

/**
 * La cadena de dependencia hacia arriba, inferida.
 *
 * Mismo contrato de salida que `cadenaDePadres` —`nivel` 1 es el padre
 * directo— más `confianza` y `motivo`, así que la ficha puede cambiar de una a
 * la otra sin tocar el resto de la plantilla.
 *
 * Un equipo fuera del grafo devuelve `[]`, igual que uno que es cabecera. Para
 * distinguirlos hay que mirar `dependenciaInferida`: son dos afirmaciones
 * distintas sobre la red y el arreglo vacío las dice igual.
 */
export async function cadenaDePadresInferida(
  deviceId: number,
  tope: number = TOPE_CADENA,
): Promise<VecinoInferido[]> {
  const topo = await topologiaInferida();
  const cadena = cadenaAscendente(topo, deviceId, tope);
  const datos = await datosDe(cadena.map((e) => e.id));

  return cadena.map((e) => ({
    id: e.id,
    nombre: datos.get(e.id)?.nombre ?? null,
    status: datos.get(e.id)?.status ?? null,
    nivel: e.nivel,
    confianza: e.confianza,
    motivo: e.motivo,
  }));
}

/** Los equipos que dependen de éste, según la inferencia. */
export async function hijosInferidos(deviceId: number): Promise<VecinoInferido[]> {
  const topo = await topologiaInferida();
  const ids = hijosDirectos(topo, deviceId);
  const datos = await datosDe(ids);

  return ids.map((id) => {
    const d = dependenciaDe(topo, id);
    return {
      id,
      nombre: datos.get(id)?.nombre ?? null,
      status: datos.get(id)?.status ?? null,
      nivel: 1,
      // El hijo existe en el mapa `hijos` porque se le infirió este padre, así
      // que la confianza está: el `?? 'baja'` es sólo para el compilador.
      confianza: d.confianza ?? 'baja',
      motivo: d.motivo,
    };
  });
}

/** Qué se sabe de la dependencia de un equipo, sin resolver nombres. */
export async function dependenciaInferida(deviceId: number): Promise<Dependencia> {
  return dependenciaDe(await topologiaInferida(), deviceId);
}

/**
 * El primer equipo caído hacia arriba. **Esto es la advertencia de arrastre.**
 *
 * Devuelve `null` cuando no hay ninguno, que puede significar dos cosas muy
 * distintas —«todos los de arriba están bien» y «no sé quiénes son los de
 * arriba»—. Por eso viene `motivo_sin_padre`: la ficha tiene que poder decir
 * «no cuelga de nadie conocido» en vez de dar a entender que revisó y estaba
 * todo bien.
 */
export interface Arrastre {
  /** El ancestro caído más cercano, o `null` si no hay ninguno. */
  culpable: VecinoInferido | null;
  /** Qué impidió encontrarlo, cuando no hay cadena. `null` si sí la había. */
  motivo_sin_padre: Motivo | null;
}

export async function arrastreDe(deviceId: number): Promise<Arrastre> {
  const cadena = await cadenaDePadresInferida(deviceId);
  if (cadena.length === 0) {
    const d = await dependenciaInferida(deviceId);
    return { culpable: null, motivo_sin_padre: d.motivo };
  }
  // 3 es `down`. Un `partial` no explica una caída entera del hijo.
  return { culpable: cadena.find((p) => p.status === 3) ?? null, motivo_sin_padre: null };
}

/**
 * Cuánta red queda explicada y con qué certeza. Para mostrarlo sin exagerar.
 */
export async function coberturaTopologia(): Promise<Cobertura> {
  const [topo, fila] = await Promise.all([
    topologiaInferida(),
    consultarUna<{ n: number }>('SELECT count(*)::int AS n FROM devices'),
  ]);
  return coberturaDe(topo, fila?.n ?? 0);
}

/**
 * Cuántas caídas se explican como consecuencia de otra.
 *
 * Una caída es **arrastre** si en el instante en que empezó había un equipo de
 * su cadena hacia arriba ya caído. Es la pregunta que resuelve la guardia:
 * cuántas de las 11.988 alarmas del histórico eran ruido de otra alarma.
 *
 * 🔴 Esto mide COINCIDENCIA, no causa. Un corte de luz que se lleva puesto un
 *    sitio entero produce exactamente el mismo patrón, y no es que un equipo
 *    tiró abajo al otro. Sirve para priorizar —«mirá primero al de arriba»—,
 *    no para cerrar un incidente.
 *
 * La cadena se calcula en memoria y se baja a la consulta como tres arreglos
 * paralelos; el cruce con `outages` lo hace PostgreSQL, que para eso tiene el
 * índice `outages_device_idx (device_id, started_at DESC)`.
 */
export interface ArrastreHistorico {
  total: number;
  explicadas: number;
  /** De las explicadas, cuántas por el padre DIRECTO y no por un abuelo. */
  por_padre_directo: number;
  /** Equipos distintos con al menos una caída explicada. */
  equipos_explicados: number;
  /** Caídas de equipos a los que no se les pudo inferir ninguna cadena. */
  sin_cadena: number;
  /** Reparto de las explicadas según cuánto se le cree al padre. */
  por_confianza: Record<Confianza, number>;
}

export async function caidasExplicadasPorArrastre(
  horas?: number,
): Promise<ArrastreHistorico> {
  const topo = await topologiaInferida();

  const hijo: number[] = [];
  const ancestro: number[] = [];
  const nivel: number[] = [];
  const conf: string[] = [];

  // 🔴 La confianza de llegar a un ancestro es la del ESLABÓN MÁS DÉBIL del
  //    camino, no la del último paso. Una cadena firme-firme-dudosa no vale
  //    «dudosa» ni «firme»: vale lo que valga el peor tramo, porque basta que
  //    ese tramo esté mal para que el abuelo no sea el abuelo.
  const PESO: Record<Confianza, number> = { alta: 2, media: 1, baja: 0 };

  for (const id of topo.dependencias.keys()) {
    let peor: Confianza = 'alta';
    for (const e of cadenaAscendente(topo, id)) {
      if (PESO[e.confianza] < PESO[peor]) peor = e.confianza;
      hijo.push(id);
      ancestro.push(e.id);
      nivel.push(e.nivel);
      conf.push(peor);
    }
  }

  // `horas` sin valor = todo el histórico. `null` en vez de un número enorme
  // para que el plan no tenga que comparar contra una fecha inventada.
  const ventana = horas === undefined ? null : Math.max(Math.round(horas), 1);

  const fila = await consultarUna<{
    total: number;
    explicadas: number;
    directas: number;
    equipos: number;
    sin_cadena: number;
    alta: number;
    media: number;
    baja: number;
  }>(
    `WITH cadena(hijo, ancestro, nivel, confianza) AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::text[])
     ),
     con_cadena AS (SELECT DISTINCT hijo FROM cadena),
     -- Un LATERAL y no dos subconsultas correlacionadas: la búsqueda del
     -- ancestro caído se hace UNA vez por caída y devuelve nivel y confianza
     -- juntos. Con dos subconsultas el histórico completo tardaba 4,6 s, y el
     -- statement_timeout está en 10 s: a un mal plan de distancia.
     marcadas AS (
       SELECT o.device_id, culpa.nivel AS nivel_culpable, culpa.confianza AS conf_culpable,
              (o.device_id IN (SELECT hijo FROM con_cadena)) AS tiene_cadena
         FROM outages o
         LEFT JOIN LATERAL (
              SELECT c.nivel, c.confianza
                FROM cadena c
                JOIN outages p
                  ON p.device_id = c.ancestro
                 AND p.started_at <= o.started_at
                 -- Una caída abierta sigue vigente: sin el COALESCE el
                 -- ancestro que TODAVÍA está caído no explicaría nada.
                 AND COALESCE(p.ended_at, now()) >= o.started_at
               WHERE c.hijo = o.device_id
               -- El más cercano gana: si el padre y el abuelo están los dos
               -- caídos, lo que hay que ir a mirar es el padre.
               ORDER BY c.nivel
               LIMIT 1
         ) culpa ON true
        WHERE o.device_id IS NOT NULL
          AND ($5::int IS NULL
               OR o.started_at >= now() - make_interval(hours => $5::int))
     )
     SELECT count(*)::int                                                AS total,
            count(*) FILTER (WHERE nivel_culpable IS NOT NULL)::int      AS explicadas,
            count(*) FILTER (WHERE nivel_culpable = 1)::int              AS directas,
            count(DISTINCT device_id)
              FILTER (WHERE nivel_culpable IS NOT NULL)::int             AS equipos,
            count(*) FILTER (WHERE NOT tiene_cadena)::int                AS sin_cadena,
            count(*) FILTER (WHERE conf_culpable = 'alta')::int          AS alta,
            count(*) FILTER (WHERE conf_culpable = 'media')::int         AS media,
            count(*) FILTER (WHERE conf_culpable = 'baja')::int          AS baja
       FROM marcadas`,
    [hijo, ancestro, nivel, conf, ventana],
  );

  return {
    total: fila?.total ?? 0,
    explicadas: fila?.explicadas ?? 0,
    por_padre_directo: fila?.directas ?? 0,
    equipos_explicados: fila?.equipos ?? 0,
    sin_cadena: fila?.sin_cadena ?? 0,
    por_confianza: {
      alta: fila?.alta ?? 0,
      media: fila?.media ?? 0,
      baja: fila?.baja ?? 0,
    },
  };
}
