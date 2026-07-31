-- ════════════════════════════════════════════════════════════════════════════
--  Esquema de PostgreSQL para el panel de The Dude
--
--  El origen es `objs(id, obj BLOB)` de SQLite: una única tabla de blobs, sin
--  relaciones, sin tipos. Acá se convierte en un modelo relacional de verdad,
--  con claves foráneas, índices y restricciones — lo que permite consultar,
--  buscar y agregar, que en el origen es imposible.
--
--  🔴 NINGUNA TABLA GUARDA CREDENCIALES.
--     The Dude conserva el usuario y la contraseña de cada router de el ISP
--     en forma recuperable, porque tiene que presentarlos al autenticarse. El
--     ETL no los enmascara: NO LOS LEE. Una base que no los contiene no los
--     puede filtrar, ni por un bug, ni por un volcado, ni por un respaldo mal
--     guardado.
--
--  El contrato del formato de origen está en `docs/FORMATO-DUDE.md`.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Sincronización ──────────────────────────────────────────────────────────
-- Cada corrida del ETL queda registrada. Sin esto, el panel no puede distinguir
-- "la red está toda bien" de "hace seis horas que no sincronizo" — que es
-- exactamente la clase de ambigüedad que vuelve inútil a un tablero.

CREATE TABLE IF NOT EXISTS sync_runs (
    id              bigserial PRIMARY KEY,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    ok              boolean,
    error           text,
    source_mtime    timestamptz,          -- mtime de dude.db al leerlo
    source_size     bigint,
    user_version    integer,              -- tiene que ser 1
    objs_total      integer,
    devices         integer,
    services        integer,
    links           integer,
    maps            integer,
    map_elements    integer,
    duration_ms     integer
);

CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);

COMMENT ON TABLE sync_runs IS
  'Una fila por corrida del ETL. El panel muestra la última para que el usuario '
  'sepa CUÁNDO se miró la red, no sólo qué se vio.';
COMMENT ON COLUMN sync_runs.user_version IS
  'PRAGMA user_version del origen. Si no es 1, la base de The Dude está mal: '
  'vive en la cabecera del archivo y un .dump no la copia.';


-- ── Catálogos ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS files (
    id          bigint PRIMARY KEY,       -- objs.id (sys-type 0x05)
    name        text NOT NULL,
    file_name   text,
    -- El contenido NO está en el blob (viene en 0 bytes): vive en data/files/.
    -- Se guarda la ruta relativa para que el servidor web lo sirva del disco.
    rel_path    text
);
COMMENT ON TABLE files IS
  'Iconos SVG, fuentes y demás. El blob de origen sólo trae el índice; los '
  'bytes están en el directorio data/files/ montado junto a dude.db.';

CREATE TABLE IF NOT EXISTS device_types (
    id          bigint PRIMARY KEY,
    name        text NOT NULL,
    url         text,
    image_id    bigint REFERENCES files(id) ON DELETE SET NULL,
    image_scale integer
);

CREATE TABLE IF NOT EXISTS probes (
    id                  bigint PRIMARY KEY,
    name                text NOT NULL,
    default_port        integer,
    dns_name            text,
    function_available  text,   -- expresiones SNMP: cpu_usage_available()
    function_error      text,
    function_value      text,
    unit                text
);

CREATE TABLE IF NOT EXISTS link_types (
    id          bigint PRIMARY KEY,
    name        text NOT NULL,
    snmp_type   integer,
    style       integer,
    thickness   integer,
    snmp_speed  bigint
);

-- 🔴 SIN la community. Se guarda que el perfil existe y cómo se llama, nunca
--    con qué secreto se autentica.
CREATE TABLE IF NOT EXISTS snmp_profiles (
    id          bigint PRIMARY KEY,
    name        text NOT NULL,
    version     integer,          -- 0 = v1, 1 = v2c, 2 = v3
    port        integer,
    try_count   integer,
    try_timeout integer
);
COMMENT ON TABLE snmp_profiles IS
  'Perfiles SNMP SIN la community. El panel necesita saber que un equipo usa '
  'v1-public; no necesita —ni debe— saber la cadena.';

CREATE TABLE IF NOT EXISTS notifications (
    id          bigint PRIMARY KEY,
    name        text NOT NULL,
    type_id     integer,     -- 1 email · 2 syslog · 3 popup · 10 log …
    type_label  text,
    enabled     boolean,
    subject     text
    -- Sin destinatarios ni comandos: son datos de contacto y de ejecución.
);


-- ── Núcleo ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS devices (
    id                bigint PRIMARY KEY,
    name              text NOT NULL,
    addresses         inet[] NOT NULL DEFAULT '{}',
    dns_names         text,
    macs              text[] NOT NULL DEFAULT '{}',
    type_id           bigint REFERENCES device_types(id) ON DELETE SET NULL,
    snmp_profile_id   bigint REFERENCES snmp_profiles(id) ON DELETE SET NULL,
    router_os         boolean,
    probe_enabled     boolean,
    probe_interval    integer,     -- 0 = hereda del servidor
    probe_timeout     integer,
    probe_down_count  integer,
    dude_server       boolean,
    -- Estado agregado, calculado por el ETL a partir de sus servicios.
    -- Se materializa acá porque el mapa lo pide para 885 equipos a la vez y
    -- resolverlo con un JOIN por nodo en cada carga sería absurdo.
    status            smallint,    -- 0 unknown · 1 up · 2 partial · 3 down
    status_label      text,
    services_total    integer NOT NULL DEFAULT 0,
    services_up       integer NOT NULL DEFAULT 0,
    services_down     integer NOT NULL DEFAULT 0
    -- 🔴 SIN user, SIN pwd. Ver el encabezado.
);

-- La topología. Tabla aparte y no un array, porque así se puede recorrer con
-- WITH RECURSIVE y preguntar "de qué depende este equipo".
CREATE TABLE IF NOT EXISTS device_parents (
    device_id   bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    parent_id   bigint NOT NULL,
    PRIMARY KEY (device_id, parent_id)
);

CREATE TABLE IF NOT EXISTS services (
    id                bigint PRIMARY KEY,
    device_id         bigint REFERENCES devices(id) ON DELETE CASCADE,
    probe_id          bigint REFERENCES probes(id) ON DELETE SET NULL,
    status            smallint,
    status_label      text,
    enabled           boolean,
    acked             boolean,
    probes_down       integer,
    probe_interval    integer,
    probe_timeout     integer,
    probe_port        integer,
    time_last_up      bigint,
    time_last_down    bigint,
    time_since_changed bigint
);

CREATE TABLE IF NOT EXISTS links (
    id                bigint PRIMARY KEY,
    name              text,
    type_id           bigint REFERENCES link_types(id) ON DELETE SET NULL,
    master_device_id  bigint REFERENCES devices(id) ON DELETE SET NULL,
    master_interface  text,
    history           boolean
);


-- ── Mapas ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS maps (
    id                bigint PRIMARY KEY,
    name              text NOT NULL,
    elements_id       bigint,      -- 🔴 la clave del JOIN, ver abajo
    background_color  bigint,
    up_color          bigint,
    down_color        bigint,
    partial_color     bigint,
    unknown_color     bigint,
    acked_color       bigint,
    -- agregados, para poder ordenar y mostrar sin recorrer los elementos
    devices_total     integer NOT NULL DEFAULT 0,
    devices_up        integer NOT NULL DEFAULT 0,
    devices_down      integer NOT NULL DEFAULT 0,
    elements_total    integer NOT NULL DEFAULT 0
);
COMMENT ON COLUMN maps.elements_id IS
  'El sys-type de los elementos de este mapa ES este número. Ese es el JOIN, y '
  'no es obvio: en el origen no hay ninguna columna que diga "pertenezco al '
  'mapa X". Verificado sobre los 40 mapas: 38 con elementos, 0 huérfanos.';

CREATE TABLE IF NOT EXISTS map_elements (
    id           bigint PRIMARY KEY,
    map_id       bigint NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    kind         text NOT NULL,   -- device · network · submap · link
    x            integer,
    y            integer,
    shape        integer,
    image_id     bigint REFERENCES files(id) ON DELETE SET NULL,
    label        text,
    -- según kind, uno de estos tiene valor
    device_id    bigint REFERENCES devices(id) ON DELETE CASCADE,
    submap_id    bigint REFERENCES maps(id) ON DELETE CASCADE,
    link_id      bigint REFERENCES links(id) ON DELETE CASCADE,
    link_from    bigint,   -- id de map_elements, resuelto por el ETL
    link_to      bigint,
    link_width   integer,
    CONSTRAINT map_elements_kind_chk
        CHECK (kind IN ('device', 'network', 'submap', 'link'))
);


-- ── Historia ────────────────────────────────────────────────────────────────
-- 🔴 Acá está el valor estratégico: dude.db murió en junio de 2026 al chocar
--    contra 2 GiB (wine32 es de 32 bits y ese techo no se mueve). Replicando la
--    historia acá, la base local se puede podar y el techo deja de ser una
--    cuenta regresiva.

CREATE TABLE IF NOT EXISTS outages (
    id            bigserial PRIMARY KEY,
    service_id    bigint,
    device_id     bigint,
    started_at    timestamptz,
    ended_at      timestamptz,
    duration_s    bigint,
    UNIQUE (service_id, started_at)
);

CREATE TABLE IF NOT EXISTS chart_values (
    source_id   bigint NOT NULL,
    bucket      text   NOT NULL,   -- raw · 10min · 2hour · 1day
    ts          timestamptz NOT NULL,
    value       double precision,
    PRIMARY KEY (source_id, bucket, ts)
);
COMMENT ON TABLE chart_values IS
  'En el origen la clave es sourceIDandTime: un solo entero de 64 bits que '
  'empaqueta el id de la fuente y el tiempo. El ETL lo desempaqueta.';


-- ── Índices ─────────────────────────────────────────────────────────────────
-- Pensados para lo que el panel realmente hace: buscar, filtrar por estado y
-- pintar un mapa completo de una sola consulta.

CREATE INDEX IF NOT EXISTS devices_status_idx      ON devices (status);
CREATE INDEX IF NOT EXISTS devices_type_idx        ON devices (type_id);
CREATE INDEX IF NOT EXISTS devices_addresses_idx   ON devices USING gin (addresses);
CREATE INDEX IF NOT EXISTS services_device_idx     ON services (device_id);
CREATE INDEX IF NOT EXISTS services_status_idx     ON services (status);
CREATE INDEX IF NOT EXISTS map_elements_map_idx    ON map_elements (map_id);
CREATE INDEX IF NOT EXISTS map_elements_device_idx ON map_elements (device_id);
CREATE INDEX IF NOT EXISTS device_parents_parent_idx ON device_parents (parent_id);
CREATE INDEX IF NOT EXISTS outages_device_idx      ON outages (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS chart_values_lookup_idx ON chart_values (source_id, bucket, ts DESC);

-- Búsqueda por texto. `pg_trgm` permite encontrar "Aurora" dentro de
-- "Vega_P_Ponte_AC2" y tolera errores de tipeo — con LIKE '%...%' sobre 885
-- filas alcanzaría, pero no escala ni ordena por relevancia.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS devices_name_trgm_idx ON devices USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS maps_name_trgm_idx    ON maps    USING gin (name gin_trgm_ops);


-- ── Vistas ──────────────────────────────────────────────────────────────────

-- Todo lo que hace falta para dibujar un mapa, en una consulta.
CREATE OR REPLACE VIEW v_map_canvas AS
SELECT
    e.map_id,
    e.id            AS element_id,
    e.kind,
    e.x, e.y, e.shape,
    e.label,
    f.rel_path      AS icon,
    e.link_from, e.link_to, e.link_width,
    COALESCE(d.name, sm.name, l.name)                 AS name,
    COALESCE(d.status, CASE WHEN e.kind = 'submap'
             THEN (CASE WHEN sm.devices_down > 0 THEN 3
                        WHEN sm.devices_up > 0 THEN 1 ELSE 0 END)
             END)                                     AS status,
    d.id            AS device_id,
    sm.id           AS submap_id,
    d.addresses
FROM map_elements e
LEFT JOIN devices d  ON d.id  = e.device_id
LEFT JOIN maps    sm ON sm.id = e.submap_id
LEFT JOIN links   l  ON l.id  = e.link_id
LEFT JOIN files   f  ON f.id  = e.image_id;

-- Buscador unificado: un equipo se encuentra por nombre O por IP.
CREATE OR REPLACE VIEW v_search AS
SELECT 'device' AS kind, d.id, d.name,
       d.status, d.status_label,
       array_to_string(ARRAY(SELECT host(a) FROM unnest(d.addresses) a), ', ') AS detail
FROM devices d
UNION ALL
SELECT 'map', m.id, m.name, NULL, NULL,
       m.devices_total || ' equipos'
FROM maps m;

COMMIT;
