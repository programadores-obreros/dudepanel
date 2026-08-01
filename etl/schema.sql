-- ════════════════════════════════════════════════════════════════════════════
--  Esquema de PostgreSQL para el panel de The Dude
--
--  El origen es `objs(id, obj BLOB)` de SQLite: una única tabla de blobs, sin
--  relaciones, sin tipos. Acá se convierte en un modelo relacional de verdad,
--  con claves foráneas, índices y restricciones — lo que permite consultar,
--  buscar y agregar, que en el origen es imposible.
--
--  🔴 NINGUNA TABLA GUARDA CREDENCIALES.
--     The Dude conserva el usuario y la contraseña de cada router del ISP
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
    duration_ms     integer,

    -- Agregado el 31/07/2026. The Dude confirma a disco cada 10 s, así que el
    -- mtime del archivo cambia siempre aunque no haya cambiado ni un objeto.
    -- Este hash es del contenido ya transformado: si coincide con el de la
    -- corrida anterior, el ETL no reescribe el snapshot. Sin esto, 30 s de
    -- intervalo son ~12.000 tuplas muertas por minuto que nadie leyó nunca.
    snapshot_hash   text,
    snapshot_reused boolean NOT NULL DEFAULT false,

    -- La historia es incremental: interesa cuánto entró en ESTA corrida.
    outages_upserted      integer,
    chart_values_inserted integer
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
    -- En el origen `dnsNames` es una lista: cada nombre viene precedido por su
    -- largo en u32 LE. Casi siempre trae uno solo; acá se unen con ', ' para
    -- no cambiar el tipo de la columna, que ya es contrato con el frontend.
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

    -- 🔴 Los nombres de estos tres campos vienen de The Dude y MIENTEN sobre lo
    --    que contienen. Medido el 31/07/2026:
    --
    --      timeLastUp / timeLastDown  →  DURACIONES en segundos, no instantes.
    --        `timeLastDown` coincide exactamente con `outages.duration` de la
    --        última caída registrada en 251 de los 311 servicios que tienen
    --        historial. Los valores típicos son 1, 41, 4009: no son fechas.
    --
    --      timeSinceChanged  →  al revés: SÍ es un instante, epoch unix.
    --        732 de 859 servicios caen en el rango del último mes.
    --
    --    Se conservan los nombres de origen para que se pueda rastrear de dónde
    --    salió cada número, y se agrega abajo la columna que el panel necesita.
    time_last_up      bigint,      -- segundos
    time_last_down    bigint,      -- segundos
    time_since_changed bigint,     -- epoch unix

    status_changed_at timestamptz
        GENERATED ALWAYS AS (to_timestamp(time_since_changed)) STORED
);
COMMENT ON COLUMN services.status_changed_at IS
  'time_since_changed convertido a fecha. Es lo que el panel muestra como '
  '"caído desde"; la columna cruda queda para poder auditar la conversión.';

CREATE TABLE IF NOT EXISTS links (
    id                bigint PRIMARY KEY,
    name              text,
    type_id           bigint REFERENCES link_types(id) ON DELETE SET NULL,
    master_device_id  bigint REFERENCES devices(id) ON DELETE SET NULL,
    -- 🔴 Era `text`, y el cambio es incómodo a propósito. En el origen
    --    `masterInterface` es un u32 en los 1.171 enlaces, sin una sola
    --    excepción: es el ifIndex SNMP (2, 3, 5, 2801…), no el nombre.
    --
    --    O sea: **el nombre de la interfaz no está en el objeto enlace.** Lo
    --    tentador era dejar la columna en `text` y escribir "2801" adentro,
    --    pero eso disfraza el hueco de dato. Un panel que muestra
    --    "Fibra WAN — 2801" se ve roto, que es lo correcto; uno que muestra
    --    "Fibra WAN — ether1" con un nombre inventado, no.
    --
    --    Dónde SÍ está el nombre: en `chart_sources.name`, que llega como
    --    'ether10-Wan-aPenielRS (10) @ PenielBS2 tx' — nombre y ifIndex entre
    --    paréntesis. Ahí se puede resolver, con un JOIN por índice y equipo.
    master_interface  integer,
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
    -- Separado de devices_down porque The Dude lo separa: la plantilla
    -- [NetMap.DevicesPartiallyDownCount] es un campo propio en los rótulos de
    -- 145 elementos de submapa. Sumarlo a los caídos haría que el rótulo diga
    -- una cosa distinta de la que dice el original.
    devices_partial   integer NOT NULL DEFAULT 0,
    elements_total    integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE maps IS
  'Los seis colores son enteros 0xRRGGBB: el frontend los pinta con '
  '"#" + n.toString(16).padStart(6, "0"). En el origen son cuatro bytes en '
  'orden R, G, B, 0 — leerlos como u32 little-endian pinta el rojo de azul.';
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
    -- 🔴 The Dude escala cada icono POR ELEMENTO, de 10 a 100 (por ciento).
    --    Medido en la base real: 150 elementos al 100, 64 al 60, 43 al 10.
    --    Ignorarlo y dibujar todo al mismo tamaño convierte la foto de un
    --    router de 680×310 en una mancha de 22 píxeles — se ve como si fuera
    --    un icono genérico y el trabajo de quien cargó las fotos se pierde.
    image_scale  integer,
    label        text,
    -- según kind, uno de estos tiene valor
    device_id    bigint REFERENCES devices(id) ON DELETE CASCADE,
    submap_id    bigint REFERENCES maps(id) ON DELETE CASCADE,
    link_id      bigint REFERENCES links(id) ON DELETE CASCADE,
    link_from    bigint,   -- id de map_elements, resuelto por el ETL
    link_to      bigint,
    link_width   integer,
    CONSTRAINT map_elements_kind_chk
        CHECK (kind IN ('device', 'network', 'submap', 'link', 'static'))
);
COMMENT ON COLUMN map_elements.kind IS
  '🔴 Se agregó ''static'' el 31/07/2026 al medir que el origen clasifica con '
  'DOS campos, no con uno: type=1 es enlace (1.170) y sólo si type=0 manda '
  'itemType (884 device · 2 network · 161 submap · 100 static). Los 100 '
  '''static'' son rótulos de texto libre —"eth2", "eth4"— sin itemID ni '
  'linkID: no representan a ningún objeto, sólo se dibujan. Ver dudeobj.ELEMENTO.';
COMMENT ON COLUMN map_elements.link_from IS
  'Id de OTRO map_elements. Sin clave foránea a propósito: 58 de los 1.170 '
  'enlaces apuntan a elementos que ya no existen —restos de borrados en The '
  'Dude— y 69 apuntan a elementos de OTRO mapa, que es legítimo. El ETL '
  'resuelve lo que puede y deja NULL lo que no, en vez de rechazar el enlace.';


-- ── Historia ────────────────────────────────────────────────────────────────
-- 🔴 Acá está el valor estratégico: dude.db murió en junio de 2026 al chocar
--    contra 2 GiB (wine32 es de 32 bits y ese techo no se mueve). Replicando la
--    historia acá, la base local se puede podar y el techo deja de ser una
--    cuenta regresiva.

CREATE TABLE IF NOT EXISTS outages (
    id            bigserial PRIMARY KEY,
    service_id    bigint,
    device_id     bigint,
    map_id        bigint,
    started_at    timestamptz,
    ended_at      timestamptz,
    duration_s    bigint,
    UNIQUE (service_id, started_at)
);
COMMENT ON TABLE outages IS
  'Origen: la tabla `outages` de SQLite, que sí es una tabla de verdad y no '
  'un blob. Su clave `timeAndServiceID` es (time << 32) | serviceID — '
  'verificado contra sus propias columnas `time` y `serviceID` en las 11.988 '
  'filas. `ended_at` sale de started_at + duration_s.';
COMMENT ON COLUMN outages.map_id IS
  'El origen guarda en qué mapa se vio la caída. Sin clave foránea: los mapas '
  'se borran y las caídas viejas quedan apuntando a la nada.';

-- Qué es cada `chart_values.source_id`. Sin esta tabla la historia es un
-- montón de números sin etiqueta: el frontend no puede ni titular un gráfico.
-- Las 1.083 fuentes distintas de chart_values son EXACTAMENTE los 1.083
-- objetos running_probe (sys-type 0x29) — coincidencia total, no aproximada.
CREATE TABLE IF NOT EXISTS chart_sources (
    id          bigint PRIMARY KEY,
    name        text NOT NULL,     -- 'ether10-Wan (10) @ PenielBS2 tx'
    device_id   bigint REFERENCES devices(id) ON DELETE SET NULL,
    service_id  bigint REFERENCES services(id) ON DELETE SET NULL,
    link_id     bigint REFERENCES links(id) ON DELETE SET NULL,
    unit        text,              -- 's' · 'bit/s' · '%'
    enabled     boolean
);
COMMENT ON COLUMN chart_sources.device_id IS
  'El objeto running_probe TIENE un campo `functionDevice`, y es una trampa: '
  'está en 0xFFFFFFFF en 1.082 de los 1.083. El equipo se resuelve al revés, '
  'desde quien consume la fuente — services.dataSourceID (734 sondas) y '
  'links.rx/txDataSourceID (348) — que juntos cubren 1.082 de 1.083.';

CREATE TABLE IF NOT EXISTS chart_values (
    source_id   bigint NOT NULL,
    bucket      text   NOT NULL,   -- raw · 10min · 2hour · 1day
    ts          timestamptz NOT NULL,
    value       double precision,
    PRIMARY KEY (source_id, bucket, ts),
    CONSTRAINT chart_values_bucket_chk
        CHECK (bucket IN ('raw', '10min', '2hour', '1day'))
);
COMMENT ON TABLE chart_values IS
  'En el origen la clave es sourceIDandTime: un entero de 64 bits que empaqueta '
  '(sourceID << 32) | epoch_unix. El ETL lo desempaqueta. '
  'El empaquetado NO se dedujo: se comprobó por tres caminos independientes. '
  '(1) La tabla hermana `outages` trae la misma clase de clave —'
  'timeAndServiceID— junto a las columnas sueltas `time` y `serviceID`, y ahí '
  '(time << 32) | serviceID reproduce la clave exacta en las 11.988 filas. '
  '(2) Los 32 bits altos de chart_values dan 1.083 valores distintos y los '
  '1.083 están en objs como running_probe: coincidencia perfecta. '
  '(3) Los 32 bits bajos, leídos como epoch, caen clavados en la grilla de '
  'cada bucket: 1day a las 00:00:00 UTC exactas, 2hour a las horas pares, '
  '10min a los múltiplos de 600 s. Un desempaquetado equivocado no produce '
  'timestamps redondos por casualidad.';
COMMENT ON COLUMN chart_values.value IS
  'Puede ser NULL: el origen guarda huecos explícitos para los períodos en que '
  'la sonda no midió. NULL es "no hay dato", que no es lo mismo que 0.';


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
CREATE INDEX IF NOT EXISTS outages_service_idx     ON outages (service_id, started_at DESC);
CREATE INDEX IF NOT EXISTS chart_sources_device_idx ON chart_sources (device_id);
-- La clave primaria ya sirve para (source_id, bucket, ts), y de paso es lo que
-- el ETL usa para saber hasta dónde replicó cada fuente: `max(ts) GROUP BY
-- (source_id, bucket)` se resuelve por índice, sin tocar 1,5 millones de filas.

-- Búsqueda por texto. `pg_trgm` permite encontrar "Aurora" dentro de
-- "Vega_P_Ponte_AC2" y tolera errores de tipeo — con LIKE '%...%' sobre 885
-- filas alcanzaría, pero no escala ni ordena por relevancia.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS devices_name_trgm_idx ON devices USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS maps_name_trgm_idx    ON maps    USING gin (name gin_trgm_ops);


-- ── Posiciones puestas por la gente ─────────────────────────────────────────
--
-- The Dude trae las coordenadas de cada elemento, pero están apretadas: la
-- mediana entre vecinos es de 128 unidades y **62 nodos quedan a menos de 40**,
-- que con el icono y el rótulo encima se pisan. Acá se guarda dónde los movió
-- un operador, y esa posición gana sobre la del origen.
--
-- 🔴 SIN CLAVE FORÁNEA A `map_elements`, Y NO ES UN OLVIDO.
--
--    El ETL hace `DELETE FROM map_elements` seguido de `INSERT` en CADA corrida
--    —cada 30 segundos— porque el origen no tiene forma de decir qué cambió.
--    Con `REFERENCES ... ON DELETE CASCADE` esta tabla se vaciaría sola dos
--    veces por minuto y el trabajo de acomodar un mapa duraría hasta la
--    próxima vuelta. Con `RESTRICT` sería peor: reventaría el ETL entero.
--
--    El precio es que pueden quedar filas huérfanas si alguien borra un
--    elemento en The Dude. Es barato y no molesta a nadie: la vista las ignora
--    con el JOIN, y se limpian cuando se quiera con el DELETE de abajo.
--
--    Los ids de The Dude son estables entre corridas (son los suyos, no
--    seriales nuestros), así que la posición sobrevive al borrado e inserción.
--    Eso es lo que hace que esto funcione.
CREATE TABLE IF NOT EXISTS map_element_positions (
    element_id  bigint PRIMARY KEY,
    x           integer NOT NULL,
    y           integer NOT NULL,
    moved_by    text    NOT NULL,
    moved_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE map_element_positions IS
  'Posiciones puestas a mano, que ganan sobre las del origen. Sin FK a '
  'map_elements a propósito: el ETL borra e inserta esa tabla entera cada 30 s '
  'y un CASCADE vaciaría esto continuamente. Limpieza de huérfanas: '
  'DELETE FROM map_element_positions p WHERE NOT EXISTS '
  '(SELECT 1 FROM map_elements e WHERE e.id = p.element_id);';

COMMENT ON COLUMN map_element_positions.moved_by IS
  'Usuario autenticado que la movió, tal como lo pasa el proxy inverso en '
  'X-Panel-Usuario. Sirve para auditar quién dejó un mapa como está.';


-- ── Vistas ──────────────────────────────────────────────────────────────────

-- Todo lo que hace falta para dibujar un mapa, en una consulta.
--
-- `x`/`y` son la posición EFECTIVA: la que puso la gente si existe, y si no la
-- del origen. Quien dibuja no tiene que saber de dónde salió. `x_origen` e
-- `y_origen` quedan expuestas para poder ofrecer «volver a la original» y para
-- marcar en la interfaz qué nodos se movieron.
CREATE OR REPLACE VIEW v_map_canvas AS
SELECT
    e.map_id,
    e.id            AS element_id,
    e.kind,
    -- 🔴 `x` e `y` SIGUEN EN SU LUGAR, con el mismo nombre y el mismo tipo.
    --    `CREATE OR REPLACE VIEW` permite cambiar la EXPRESIÓN de una columna
    --    y AGREGAR columnas AL FINAL, pero no insertarlas en el medio ni
    --    reordenarlas: falla con «cannot change name of view column». Como
    --    esta vista ya existe en producción y el esquema se aplica en cada
    --    corrida del ETL, meter las nuevas acá arriba rompería la
    --    sincronización cada 30 segundos. Van al final, después de `addresses`.
    COALESCE(p.x, e.x) AS x,
    COALESCE(p.y, e.y) AS y,
    e.shape,
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
    d.addresses,
    -- ── Agregadas el 31/07/2026, al final por lo de arriba ──
    e.x             AS x_origen,
    e.y             AS y_origen,
    (p.element_id IS NOT NULL) AS movido,
    p.moved_by,
    p.moved_at,

    -- 🔴 EL ICONO DEL TIPO DE EQUIPO, que estaba en la base y nadie pedía.
    --
    --    The Dude resuelve el dibujo de un nodo en dos pasos: primero el
    --    icono del ELEMENTO y, si no tiene, el del TIPO al que pertenece el
    --    equipo. Nosotros hacíamos sólo el primero, así que **123 elementos
    --    se dibujaban con una cajita gris teniendo su imagen a un JOIN de
    --    distancia** — el archivo existe, el panel ya lo sirve con HTTP 200 y
    --    la columna estaba acá desde el primer día.
    --
    --    Va la escala del tipo también: `device_types.image_scale` es 60 para
    --    «Algun dispositivo», que son 122 de esos 123. Usar la escala del
    --    elemento con la imagen del tipo dibujaría al tamaño equivocado.
    ft.rel_path     AS icon_tipo,
    t.image_scale   AS image_scale_tipo,
    t.name          AS tipo_nombre,
    -- Las MAC del equipo, para deducir el fabricante. Ver `web/src/lib/oui.ts`:
    -- da la marca de 557 equipos sin preguntarle nada a la red.
    d.macs          AS macs
FROM map_elements e
LEFT JOIN devices d  ON d.id  = e.device_id
LEFT JOIN maps    sm ON sm.id = e.submap_id
LEFT JOIN links   l  ON l.id  = e.link_id
LEFT JOIN device_types t ON t.id = d.type_id
LEFT JOIN files       ft ON ft.id = t.image_id
LEFT JOIN files   f  ON f.id  = e.image_id
LEFT JOIN map_element_positions p ON p.element_id = e.id;

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
