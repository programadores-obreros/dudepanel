import { consultar, consultarUna } from './db';
import { entero } from './entorno';
import { aEstado, type Estado } from './estado';

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

  const f = fila ?? {};
  return {
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
  name: string | null;
  status: number | null;
  device_id: number | null;
  submap_id: number | null;
  direcciones: string[] | null;
}

/**
 * Todo el mapa en una consulta, tal como promete `v_map_canvas`.
 *
 * Las direcciones se piden como `text[]` y no como el `inet[]` crudo: el driver
 * las entrega ya listas para mostrar y sin depender de cómo parsee `inet[]`
 * la versión de node-pg que esté instalada.
 */
export async function lienzoMapa(mapId: number): Promise<ElementoMapa[]> {
  return consultar<ElementoMapa>(
    `SELECT element_id, kind, x, y, shape, label, icon,
            link_from, link_to, link_width,
            name, status, device_id, submap_id,
            ARRAY(SELECT host(a) FROM unnest(addresses) a) AS direcciones
     FROM v_map_canvas
     WHERE map_id = $1
     ORDER BY (kind = 'link') DESC, element_id`,
    [mapId],
  );
}

/**
 * Estado consolidado de los submapas que aparecen dentro de un mapa.
 *
 * `v_map_canvas` lo deriva de `maps.devices_*`, que es material del ETL; acá se
 * recalcula en vivo por la misma razón que en `listarMapas`.
 */
export async function estadoSubmapas(mapId: number): Promise<Map<number, Estado>> {
  const filas = await consultar<{ submap_id: number; status: number }>(
    `SELECT e.submap_id,
            CASE
              WHEN count(*) FILTER (WHERE d.status = 3) > 0 THEN 3
              WHEN count(*) FILTER (WHERE d.status = 2) > 0 THEN 2
              WHEN count(*) FILTER (WHERE d.status = 1) > 0 THEN 1
              ELSE 0
            END AS status
     FROM map_elements e
     JOIN map_elements se ON se.map_id = e.submap_id
     LEFT JOIN devices  d ON d.id = se.device_id
     WHERE e.map_id = $1 AND e.submap_id IS NOT NULL
     GROUP BY e.submap_id`,
    [mapId],
  );
  return new Map(filas.map((f) => [f.submap_id, aEstado(f.status)]));
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
}

export type ColumnaOrden = 'nombre' | 'estado' | 'tipo' | 'servicios' | 'ip';

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
};

export interface FiltrosDispositivos {
  estado?: Estado | null;
  tipoId?: number | null;
  texto?: string | null;
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
  const orden = ORDEN[f.orden ?? 'estado'] ? (f.orden ?? 'estado') : 'estado';
  const dir = f.desc ? 'DESC' : 'ASC';
  const porPagina = Math.min(Math.max(f.porPagina ?? 50, 10), 200);
  const pagina = Math.max(f.pagina ?? 1, 1);

  const where = `
    WHERE ($1::smallint IS NULL OR COALESCE(d.status, 0) = $1)
      AND ($2::bigint   IS NULL OR d.type_id = $2)
      AND ($3::text     IS NULL OR d.name ILIKE '%' || $3 || '%'
           OR EXISTS (SELECT 1 FROM unnest(d.addresses) a
                      WHERE host(a) LIKE $3 || '%'))
  `;
  const params = [f.estado ?? null, f.tipoId ?? null, f.texto?.trim() || null];

  const totalFila = await consultarUna<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM devices d
     LEFT JOIN device_types dt ON dt.id = d.type_id
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
            d.router_os
     FROM devices d
     LEFT JOIN device_types dt ON dt.id = d.type_id
     ${where}
     ORDER BY ${ORDEN[orden]} ${dir}, lower(d.name) ASC
     LIMIT $4 OFFSET $5`,
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
            d.services_total, d.services_up, d.services_down
     FROM devices d
     LEFT JOIN device_types  dt ON dt.id = d.type_id
     LEFT JOIN snmp_profiles sp ON sp.id = d.snmp_profile_id
     WHERE d.id = $1`,
    [id],
  );
  return d ?? null;
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
 * porque escribir "192.0.2" y que aparezcan primero los equipos de esa /16 es
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
