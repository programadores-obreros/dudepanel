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
    chart_values_inserted integer,
    -- Y cuánto SALIÓ: la poda de `raw`. Ver `podar_raw` en `sync.py`.
    chart_values_podadas  integer
);

-- 🔴 `CREATE TABLE IF NOT EXISTS` NO agrega columnas a una tabla que ya existe.
--
--    Esta base ya está en producción, así que la columna de arriba no aparece
--    sola: hace falta el ALTER. Y hace falta ACÁ, porque el ETL construye su
--    `UPDATE sync_runs` con las claves que trae —una columna que falta no da
--    un aviso, **aborta la corrida entera** y el panel deja de actualizarse.
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS chart_values_podadas integer;


-- ═════════════════════════════════════════════════════════════════════════════
--  🔴 LA MARCA DE AGUA DE LA HISTORIA, FUERA DE LOS DATOS QUE SE PODAN
--
--  El ETL importa `chart_values` de forma incremental: pide a SQLite sólo lo
--  posterior a la última marca. Esa marca salía de `max(ts)` de la propia
--  `chart_values` — y funcionó hasta que se agregó la poda de `raw`.
--
--  El bucle: una fuente MUERTA —un equipo dado de baja— sólo tiene filas
--  viejas. La poda se las lleva TODAS. Sin filas no hay `max(ts)`, así que el
--  ETL concluye «esta fuente es nueva» y reimporta su historia entera desde
--  SQLite. En la vuelta siguiente la poda vuelve a borrarla. Y otra vez.
--
--  Medido en producción antes del arreglo: **borraba 200.000 filas e insertaba
--  202.983 en la MISMA corrida**, cada 45 segundos, para siempre. La tabla no
--  bajaba, el ETL quemaba 18 s por vuelta, y la ficha del equipo agotaba su
--  tiempo de consulta.
--
--  Con la marca en su propia tabla, borrar un dato no borra el hecho de que
--  ese dato existió. Es la distinción que faltaba.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chart_marca (
    source_id bigint      NOT NULL,
    bucket    text        NOT NULL,
    ultimo_ts timestamptz NOT NULL,
    PRIMARY KEY (source_id, bucket)
);

COMMENT ON TABLE chart_marca IS
  'Hasta dónde se importó cada (fuente, cajón). Vive aparte de chart_values '
  'porque esa tabla se poda: sin esto, podar la última fila de una fuente '
  'muerta hace que el ETL reimporte su historia entera en bucle.';

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
-- 🔴 LA VIDA DEL EQUIPO NO SE UNE ACÁ, y el motivo es el orden del archivo.
--
--    Sería natural agregar `dias_sin_senal` y compañía a esta vista: es la que
--    dibuja el mapa y es justo lo que decide si un nodo se dibuja. Pero
--    `v_device_estado` se define al FINAL de schema.sql —depende de
--    `syslog_outages`, que está en la línea 781, después de esto— y Postgres
--    resuelve las referencias al CREAR la vista, no al consultarla. El JOIN
--    acá revienta con «relation v_device_estado does not exist» en cualquier
--    base nueva, y el ETL aplica este archivo entero en cada corrida.
--
--    Reordenar el archivo para arreglarlo sería mover tres bloques con sus
--    transacciones. La unión se hace en la CONSULTA del mapa
--    (`web/src/lib/consultas.ts`, `mapaCanvas`), que cuesta un JOIN por clave
--    primaria sobre 885 filas: nada.
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


-- ── El grafo de enlaces, que es la topología que SÍ existe ──────────────────
--
-- 🔴 `device_parents` está VACÍA: The Dude no guardó `parentIDs` en ninguno de
--    los 885 equipos. Pero la topología está dibujada en los mapas —1.092
--    enlaces con las dos puntas resueltas— y de ahí se puede sacar.
--
-- Esta vista expone ese grafo **sin dirección**, que es todo lo que el dato
-- dice con certeza: «A está conectado con B». Quién es el padre es una
-- INFERENCIA y vive en `web/src/lib/topologia.ts`, donde se puede probar con
-- casos armados a mano y donde cada equipo sale con un nivel de confianza.
--
-- ¿Por qué la dirección no se calcula acá? Porque necesita componentes conexas
-- y un BFS por componente, y en SQL eso es cierre transitivo: 713 nodos en la
-- componente mayor son ~500.000 filas intermedias en CADA carga de ficha, con
-- `statement_timeout` en 10 s. Una vista devuelve el grafo (1.100 filas, dos
-- índices) y el algoritmo corre una vez en memoria y queda cacheado.
--
--
-- ── Los tres tipos de nodo, y por qué hay tres ──
--
-- Un enlace del mapa no siempre une dos equipos. Medido sobre los 1.170
-- elementos `link`:
--
--   device ↔ device   704   el caso limpio
--   device ↔ static   139   el otro extremo es un RÓTULO de texto libre
--   static ↔ static    77   los dos son rótulos
--   device ↔ submap   129   el otro extremo es la CAJA de otro mapa
--   submap ↔ submap    31
--   con una punta rota  78   apunta a un elemento que ya no existe
--
-- Si sólo se toma `device ↔ device` el grafo queda en **37 pedazos sueltos**.
-- Metiendo las cajas de submapa como nodos propios quedan **15**, y el mayor
-- pasa de 131 a 591 equipos. Medido, no supuesto.
--
-- Y tiene sentido físico: la caja «Ponte» está dibujada en 16 mapas distintos,
-- y en cada uno la une un enlace al equipo local que sube a Ponte —los que se
-- llaman `Hospital-e-Ponte`, `Fatsa_E_Ponte`, `AViveroBT`—. La caja ES el
-- sitio. Por eso `tipo = 'sitio'`: atravesarla dice «esto sube a ese lugar»,
-- que es verdad, pero NO dice a qué equipo de ahí. La inferencia baja la
-- confianza cuando el camino cruza una.
--
-- Los rótulos (`static`, 100 en la base, y `network`, 2) son puntos de dibujo:
-- el más grande, «sfp2», tiene 48 enlaces colgando. No representan a ningún
-- objeto, así que van como `'union'` — sirven para no cortar el camino y nada
-- más.
--
--
-- ── Un solo `bigint` para los tres tipos, y por qué se puede ──
--
-- Los ids de The Dude salen todos de la misma `objs.id`, así que son únicos
-- entre tipos de objeto. Verificado en la base real: los cruces
-- devices×maps, devices×map_elements, maps×map_elements y devices×links dan
-- **0 colisiones**. Sin eso haría falta una clave compuesta y todo el
-- algoritmo se ensuciaría.
CREATE OR REPLACE VIEW v_topologia_aristas AS
WITH nodo AS (
    SELECT e.id AS element_id,
           CASE e.kind
               WHEN 'device' THEN e.device_id   -- el equipo
               WHEN 'submap' THEN e.submap_id   -- el mapa de destino
               ELSE e.id                        -- el rótulo, que es él mismo
           END AS nodo_id,
           CASE e.kind
               WHEN 'device' THEN 'equipo'
               WHEN 'submap' THEN 'sitio'
               ELSE 'union'
           END AS tipo
    FROM map_elements e
    WHERE e.kind IN ('device', 'submap', 'static', 'network')
),
cruda AS (
    -- El JOIN descarta solo las puntas colgadas: 78 de los 1.170 enlaces
    -- apuntan a elementos borrados en The Dude. Se pierde el enlace, no la
    -- corrida. Ver el comentario de `map_elements.link_from`.
    SELECT nf.nodo_id AS a, nt.nodo_id AS b, nf.tipo AS ta, nt.tipo AS tb
    FROM map_elements l
    JOIN nodo nf ON nf.element_id = l.link_from
    JOIN nodo nt ON nt.element_id = l.link_to
    WHERE l.kind = 'link'
      AND nf.nodo_id IS NOT NULL
      AND nt.nodo_id IS NOT NULL
      -- Un enlace de un nodo a sí mismo: pasa cuando dos elementos distintos
      -- dibujan el MISMO equipo en dos mapas. No aporta dirección.
      AND nf.nodo_id <> nt.nodo_id
)
-- Normalizado y sin repetir: el grafo es no dirigido, así que (a,b) y (b,a)
-- son la misma arista, y dos mapas pueden dibujar el mismo enlace dos veces.
SELECT DISTINCT
       least(a, b)                       AS nodo_a,
       greatest(a, b)                    AS nodo_b,
       CASE WHEN a < b THEN ta ELSE tb END AS tipo_a,
       CASE WHEN a < b THEN tb ELSE ta END AS tipo_b
FROM cruda;

COMMENT ON VIEW v_topologia_aristas IS
  'El grafo de enlaces, NO DIRIGIDO. Es el reemplazo de device_parents, que en '
  'esta instalación está vacía. La dirección (quién es el padre) NO está acá '
  'porque no está en el dato: se infiere en web/src/lib/topologia.ts y sale '
  'con nivel de confianza. tipo_* es equipo | sitio | union.';

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
--  HISTORIA IMPORTADA DEL SYSLOG DE THE DUDE
--
--  Bloque agregado el 01/08/2026, con su propia transacción: todo lo de arriba
--  ya cerró con el COMMIT anterior y así los dos bloques se pueden editar sin
--  pisarse.
--
--  ── Por qué existe ─────────────────────────────────────────────────────────
--
--  `outages` arranca el 2026-06-12: ese día dude.db chocó contra los 2 GiB y la
--  rearmaron de cero. Pero la regla «log to syslog» venía escribiendo cada
--  subida y bajada a archivos de texto en `files/`, y ésos sobrevivieron:
--  44 archivos, 141.678 líneas, hasta 2020. Este bloque los aterriza.
--
--  ── 🔴 Lo que estas tablas NO son ──────────────────────────────────────────
--
--  Una historia continua. Medido sobre los 44 archivos:
--
--      2020  2.928  ·  2021  936  ·  2022  0  ·  2023  0
--      2024  2.584  ·  2025  29.331  ·  2026  105.899
--
--  Dos años enteros vacíos. Quien muestre esto tiene que mostrar también los
--  huecos: para eso están `v_syslog_cobertura` (una fila por mes, con
--  `hueco = true` donde no hay nada) y `syslog_outages.spans_gap`.
--
--  ── 🔴 Y NO tienen clave foránea a `devices` ni a `services` ───────────────
--
--  `sync.py` hace `DELETE FROM services` + `INSERT` en CADA corrida, cada 30
--  segundos, porque el origen no sabe decir qué cambió. Una FK con CASCADE
--  desde acá vaciaría seis años de historia dos veces por minuto; con RESTRICT
--  reventaría el ETL entero. Es el mismo motivo, y el mismo precio, que ya está
--  documentado en `map_element_positions` más arriba.
--
--  La diferencia con aquel caso es que acá el hueco es MAYOR: los ids de The
--  Dude son estables, pero el nombre de un equipo no es una clave y el 25 % de
--  los nombres del histórico ya no existe en el inventario. Por eso el dato
--  autoritativo de estas tablas es el NOMBRE en texto, y los ids son una
--  resolución de mejor esfuerzo que se puede volver a correr.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Un renglón por archivo importado ────────────────────────────────────────
-- Es la trazabilidad y, de paso, el atajo: si el sha256 no cambió, el archivo
-- ni se abre. Con 44 archivos y 141.678 líneas eso convierte una reimportación
-- en cuestión de milisegundos.

CREATE TABLE IF NOT EXISTS syslog_files (
    name            text PRIMARY KEY,      -- basename; es la identidad
    path            text NOT NULL,
    sha256          text NOT NULL,
    bytes           bigint NOT NULL,
    -- 🔴 La zona horaria con la que se interpretó ESTE archivo. El formato no
    --    la trae —`2025.11.23-14:53:39` y nada más— así que es un supuesto, y
    --    un supuesto que no queda escrito es un supuesto que dentro de un año
    --    nadie puede auditar ni corregir.
    tz              text NOT NULL,
    lines           integer NOT NULL,
    service_lines   integer NOT NULL,      -- `Service ... is now ...`
    other_lines     integer NOT NULL,      -- syslog de un MikroTik, ver abajo
    ignored_lines   integer NOT NULL,      -- ni el sobre se pudo leer
    blank_lines     integer NOT NULL DEFAULT 0,
    duplicate_lines integer NOT NULL DEFAULT 0,
    -- Hasta 20 muestras de las líneas no entendidas, una por FORMA distinta
    -- (los números se aplastan antes de comparar). Las primeras veinte de un
    -- archivo de 30.000 líneas suelen ser la misma cosa repetida.
    ignored_samples text[] NOT NULL DEFAULT '{}',
    first_event     timestamptz,
    last_event      timestamptz,
    imported_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN syslog_files.ignored_samples IS
  'Texto verbatim de una fuente externa: pasa por un redactor que enmascara '
  'password/pwd/community/secret/token antes de guardarse. Es una de las dos '
  'únicas columnas del esquema con texto libre ajeno, y la regla del proyecto '
  'es que ninguna tabla guarde credenciales.';


-- ── Los eventos, tal como los dice el texto ─────────────────────────────────
-- Es la materia prima y la única fuente autoritativa: `syslog_outages` se
-- deriva de acá y se puede tirar y rehacer cuantas veces haga falta.

CREATE TABLE IF NOT EXISTS syslog_events (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL,
    -- La hora local cruda, sin interpretar. Guardarla cuesta 8 bytes y permite
    -- cambiar de zona horaria con un UPDATE (`syslog.py reinterpretar`) en vez
    -- de volver a leer 44 archivos que capaz ya no están.
    occurred_local  timestamp   NOT NULL,
    device_name     text NOT NULL,
    probe_name      text NOT NULL,
    -- Sin CHECK a propósito. En el histórico sólo hay 'down' y 'up', pero The
    -- Dude también sabe decir 'unknown' y 'partially down'. Una restricción acá
    -- convertiría una línea inesperada en una corrida abortada, cuando lo
    -- correcto es guardarla y contarla.
    state           text NOT NULL,
    -- (timeout) 69.446 · (local problem) 79. La diferencia importa: un
    -- 'local problem' es un problema del SERVIDOR de monitoreo y no dice nada
    -- del equipo. Sumarlo a la indisponibilidad del equipo sería mentir.
    reason          text,
    source_host     text,
    source_file     text NOT NULL,
    source_line     integer NOT NULL,
    -- Cuántas veces apareció antes esta MISMA línea en el mismo archivo. Sin
    -- esto, dos equipos que se llaman igual —hay 80 nombres repetidos en el
    -- inventario— cayendo en el mismo segundo producen dos líneas idénticas y
    -- una se perdería contra la clave única.
    ordinal         smallint NOT NULL DEFAULT 0,
    -- 🔴 La clave de la idempotencia. Reimportar el mismo archivo, o un archivo
    --    que creció, o dos archivos que se solapan por una rotación, no puede
    --    duplicar un evento. No incluye `source_file`: justamente para que la
    --    misma línea presente en dos archivos entre UNA vez.
    UNIQUE (occurred_at, device_name, probe_name, state, ordinal)
);

CREATE INDEX IF NOT EXISTS syslog_events_servicio_idx
    ON syslog_events (device_name, probe_name, occurred_at);
CREATE INDEX IF NOT EXISTS syslog_events_ts_idx ON syslog_events (occurred_at);
CREATE INDEX IF NOT EXISTS syslog_events_file_idx ON syslog_events (source_file);


-- ── Lo que llegó al mismo archivo y NO es un evento de servicio ─────────────
-- 2.642 líneas de las 141.678: alguien apuntó un MikroTik al mismo destino de
-- syslog. Se guardan enteras en vez de descartarse porque son información
-- operativa que hoy no mira nadie — 438 de ellas dicen «failed to authenticate».

CREATE TABLE IF NOT EXISTS syslog_other (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL,
    occurred_local  timestamp   NOT NULL,
    source_host     text,
    kind            text NOT NULL,   -- 'mikrotik' | 'desconocida'
    -- La propia clasificación de MikroTik: 'pptp,ppp,info', 'ipsec,info'. Es
    -- mejor taxonomía que cualquiera que inventáramos nosotros por palabras
    -- clave, y viene gratis en la línea.
    topics          text,
    message         text NOT NULL,   -- redactado, ver syslog_files.ignored_samples
    source_file     text NOT NULL,
    source_line     integer NOT NULL,
    CONSTRAINT syslog_other_kind_chk CHECK (kind IN ('mikrotik', 'desconocida')),
    UNIQUE (source_file, source_line)
);
CREATE INDEX IF NOT EXISTS syslog_other_ts_idx ON syslog_other (occurred_at);
CREATE INDEX IF NOT EXISTS syslog_other_topics_idx ON syslog_other (topics);


-- ── Las caídas reconstruidas ────────────────────────────────────────────────
--
-- 🔴 ESTA TABLA ES DERIVADA. Es una función pura de `syslog_events`: el
--    importador la vacía y la vuelve a calcular entera en cada pasada. Por eso
--    correr el importador dos veces no duplica nada, y por eso mejorar el
--    algoritmo de reconstrucción no necesita ninguna migración.
--
--    Consecuencia: los `id` NO son estables entre reconstrucciones. Nadie los
--    referencia. Si alguna vez hace falta anotar una caída a mano, la anotación
--    va en otra tabla y se ata por (device_name, probe_name, started_at).

CREATE TABLE IF NOT EXISTS syslog_outages (
    id            bigserial PRIMARY KEY,
    -- 🔴 EL DATO AUTORITATIVO ES EL NOMBRE, no el id. Ver el encabezado.
    device_name   text NOT NULL,
    probe_name    text NOT NULL,
    started_at    timestamptz,
    ended_at      timestamptz,
    -- NULL cuando no se puede saber: caída sin cerrar, `up` sin `down`, o el
    -- reloj del servidor saltó para atrás entre las dos líneas. Un NULL no se
    -- suma, así que ninguna de esas tres cosas puede contaminar un promedio de
    -- disponibilidad. Un 0 sí lo haría, y en silencio.
    duration_s    bigint,
    closure       text NOT NULL,
    -- Cuántos `down` se plegaron en esta caída. >1 significa que The Dude avisó
    -- de vuelta sin haber avisado del `up` del medio: o el equipo flapeó y se
    -- perdió el `up`, o el registro tuvo un corte.
    down_events   integer NOT NULL DEFAULT 1,
    -- El ÚLTIMO `down` de la serie. Con down_events > 1, la caída pesimista es
    -- [started_at, ended_at] y la optimista [last_down_at, ended_at]. Se guardan
    -- las dos puntas y no se elige por el consumidor.
    last_down_at  timestamptz,
    down_reason   text,
    up_reason     text,
    -- 🔴 La caída cruza un tramo en que el corpus ENTERO no tiene ni una línea
    --    (2022 y 2023 están vacíos). Un `down` de 2021 emparejado con el `up` de
    --    2024 da una caída de dos años que nunca existió: lo que se cortó fue el
    --    registro, no el enlace. No creerle la duración a estas filas.
    spans_gap     boolean NOT NULL DEFAULT false,
    -- Resolución de mejor esfuerzo. SIN CLAVE FORÁNEA — ver el encabezado.
    device_id     bigint,
    service_id    bigint,
    match_kind    text NOT NULL DEFAULT 'unknown',
    rebuilt_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT syslog_outages_closure_chk
        CHECK (closure IN ('closed', 'open', 'no_start')),
    CONSTRAINT syslog_outages_match_chk
        CHECK (match_kind IN ('service', 'device', 'ambiguous', 'unknown')),
    -- Una caída sin ninguna de las dos puntas no es nada.
    CONSTRAINT syslog_outages_bordes_chk
        CHECK (started_at IS NOT NULL OR ended_at IS NOT NULL),
    CONSTRAINT syslog_outages_duracion_chk
        CHECK (duration_s IS NULL OR duration_s >= 0),
    -- `NULLS NOT DISTINCT` (PostgreSQL 15+) no es un detalle: sin eso, una
    -- caída abierta (ended_at NULL) o una sin inicio (started_at NULL) se
    -- podrían insertar mil veces, porque el UNIQUE clásico considera que dos
    -- NULL son distintos. Justo las dos clases que más nos importa no duplicar.
    UNIQUE NULLS NOT DISTINCT (device_name, probe_name, started_at, ended_at)
);

CREATE INDEX IF NOT EXISTS syslog_outages_inicio_idx
    ON syslog_outages (started_at DESC);
CREATE INDEX IF NOT EXISTS syslog_outages_device_idx
    ON syslog_outages (device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS syslog_outages_service_idx
    ON syslog_outages (service_id, started_at DESC);
CREATE INDEX IF NOT EXISTS syslog_outages_nombre_idx
    ON syslog_outages (device_name, started_at DESC);

COMMENT ON COLUMN syslog_outages.closure IS
  'closed: down → up, la caída completa. '
  'open: down sin up posterior en TODO el corpus — o sigue caído, o el up se '
  'perdió; no se inventa un final. '
  'no_start: up sin down previo — recuperó sin que viéramos la caída. '
  '⚠️ Los no_start pueden venir en manada: cuando The Dude arranca, todos los '
  'servicios pasan de unknown a up y eso dispara la notificación. Doscientos '
  'no_start en el mismo minuto son un arranque del servidor, no doscientas '
  'caídas. Por eso nunca tienen duración.';

COMMENT ON COLUMN syslog_outages.match_kind IS
  'Cómo se resolvió el nombre contra el inventario vivo. '
  'service: el par (equipo, sonda) da exactamente un servicio. '
  'device: el nombre da un equipo solo, pero sin esa sonda. '
  'ambiguous: el nombre lo comparten varios equipos — 80 de los 798 nombres de '
  'devices están repetidos, y ahí el nombre no alcanza. '
  'unknown: el nombre no está en el inventario. Son 114 de los 452 nombres del '
  'histórico (25 %): equipos renombrados o dados de baja. Se guardan igual. '
  '🔴 NO hay emparejamiento por parecido, y es a propósito: uno de los nombres '
  'es "Peniel_E_Ponte 24GHZ ex 10 Ghz" — el nombre ya trae adentro su propia '
  'historia de renombres, y un similarity() contra eso devuelve coincidencias '
  'plausibles y falsas. Una caída atribuida al equipo equivocado miente; una '
  'caída sin atribuir se nota.';


-- ── Vistas ──────────────────────────────────────────────────────────────────

-- La cobertura mes a mes, CON los huecos como filas. Un GROUP BY común no
-- devuelve fila para un mes vacío, y así 2022 y 2023 simplemente no aparecerían
-- — que es exactamente cómo se cuenta una historia falsa sin mentir en ningún
-- número. Acá el mes vacío existe y dice `hueco = true`.
CREATE OR REPLACE VIEW v_syslog_cobertura AS
WITH rango AS (
    SELECT date_trunc('month', min(occurred_at)) AS desde,
           date_trunc('month', max(occurred_at)) AS hasta
      FROM syslog_events
), meses AS (
    SELECT generate_series(desde, hasta, interval '1 month') AS mes FROM rango
)
SELECT m.mes,
       count(e.id)                                        AS eventos,
       count(e.id) FILTER (WHERE e.state = 'down')        AS downs,
       count(e.id) FILTER (WHERE e.state = 'up')          AS ups,
       (count(e.id) = 0)                                  AS hueco
  FROM meses m
  LEFT JOIN syslog_events e
         ON e.occurred_at >= m.mes AND e.occurred_at < m.mes + interval '1 month'
 GROUP BY m.mes;

COMMENT ON VIEW v_syslog_cobertura IS
  'Una fila por mes entre el primer y el último evento, incluidos los meses sin '
  'nada. Es el antídoto contra decir "historia desde 2020" cuando 2022 y 2023 '
  'están vacíos.';

-- Las dos historias juntas, con el origen a la vista.
--
-- 🔴 NO SUMAR SIN FILTRAR. Del 2026-06-12 en adelante las dos fuentes cubren el
--    mismo período y la misma caída puede estar dos veces: una registrada por
--    The Dude con su reloj, otra reconstruida desde texto. La columna
--    `solapado` marca las filas de syslog que caen dentro del rango que ya
--    cubre `outages`; para un total sin doble conteo, filtrar
--    `WHERE NOT solapado` y quedarse con la versión 'dude', que es la de mayor
--    confianza: viene con epoch unix, no con una zona horaria supuesta.
CREATE OR REPLACE VIEW v_historia_caidas AS
SELECT 'dude'::text        AS origen,
       o.device_id, o.service_id,
       d.name              AS device_name,
       p.name              AS probe_name,
       o.started_at, o.ended_at, o.duration_s,
       'closed'::text      AS closure,
       'service'::text     AS match_kind,
       false               AS spans_gap,
       false               AS solapado,
       NULL::text          AS down_reason
  FROM outages o
  LEFT JOIN devices  d ON d.id = o.device_id
  LEFT JOIN services s ON s.id = o.service_id
  LEFT JOIN probes   p ON p.id = s.probe_id
UNION ALL
SELECT 'syslog',
       so.device_id, so.service_id, so.device_name, so.probe_name,
       so.started_at, so.ended_at, so.duration_s, so.closure, so.match_kind,
       so.spans_gap,
       COALESCE(so.started_at >= (SELECT min(started_at) FROM outages), false),
       so.down_reason
  FROM syslog_outages so;

COMMENT ON VIEW v_historia_caidas IS
  'Las caídas de las dos fuentes con `origen` a la vista. Una fila "dude" la '
  'registró The Dude con su propio reloj; una "syslog" se reconstruyó de dos '
  'líneas de texto con una zona horaria supuesta, y puede tener started_at o '
  'ended_at en NULL. No tienen la misma confianza y por eso no se mezclan sin '
  'poder distinguirlas. Ojo con `solapado`: ver el comentario en schema.sql.';

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
--  EL CAMINO DE RED HACIA UN DESTINO, CON DUEÑO DE CADA SALTO
--
--  Bloque agregado el 01/08/2026, con su propia transacción — igual que el de
--  syslog: los de arriba ya cerraron con su COMMIT y así los tres se editan sin
--  pisarse.
--
--  ── Qué pregunta contesta ──────────────────────────────────────────────────
--
--  «¿El problema es MÍO o del mayorista?», a las tres de la mañana, sin abrir
--  una terminal. Hoy eso se resuelve con un `traceroute` a mano y media hora de
--  `whois`; acá queda trazado, fechado y con el ASN de cada salto público.
--
--  ── 🔴 Lo que estas tablas SÍ y NO garantizan ──────────────────────────────
--
--  Un salto que no contestó se guarda como una FILA con `direccion IS NULL`, no
--  se omite. Es la diferencia entre «el salto 7 no contesta» —normal: un router
--  con `icmp-errors` limitado, no una falla— y «el camino tiene 6 saltos», que
--  sería mentira. Por eso `camino_saltos` tiene clave primaria (traza_id, ttl):
--  el TTL es la identidad del salto y nunca se renumera.
--
--  `asn`/`asn_org` se copian DENTRO del salto, desnormalizados a propósito. La
--  caché de abajo sirve para no repetir consultas; el histórico necesita otra
--  cosa: saber a quién pertenecía esa dirección EL DÍA que se trazó. Un cambio
--  de dueño de un prefijo es justamente uno de los eventos que hay que ver.
--
--  ── 🔴 SIN CLAVE FORÁNEA A `devices` ───────────────────────────────────────
--
--  Mismo motivo que `map_element_positions` y `syslog_*`: `sync.py` hace
--  `DELETE FROM devices` + `INSERT` en CADA corrida, cada 30 s. Un CASCADE
--  desde acá borraría el histórico de caminos dos veces por minuto; un RESTRICT
--  reventaría el ETL. `camino_destinos.device_id` es una resolución de mejor
--  esfuerzo y se puede volver a correr.
--
--  Adentro de este bloque sí hay CASCADE —`camino_saltos` → `camino_trazas`—
--  porque esas dos tablas son nuestras y nadie las borra cada 30 s.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A dónde se traza ────────────────────────────────────────────────────────
-- Una tabla explícita y no «trazá lo que te pidan» por dos razones. La primera
-- es de operación: un destino registrado tiene nota, dueño y fecha, así que
-- dentro de seis meses se sabe POR QUÉ se está midiendo eso. La segunda es de
-- prudencia: acota el trabajo. Trazar es tráfico normal, pero 885 equipos por
-- 20 saltos son 17.700 paquetes, y eso ya no se parece a «tráfico normal».

CREATE TABLE IF NOT EXISTS camino_destinos (
    id          bigserial PRIMARY KEY,
    -- Tal como lo escribió la persona: una IP o un nombre. Se guarda el texto
    -- original porque si es un nombre, a QUÉ dirección resuelve es un dato que
    -- cambia — y ver que cambió es parte de lo que buscamos.
    destino     text NOT NULL UNIQUE,
    nota        text,
    -- Mejor esfuerzo, SIN FK. Ver el encabezado.
    device_id   bigint,
    activo      boolean NOT NULL DEFAULT true,
    creado_at   timestamptz NOT NULL DEFAULT now(),
    creado_por  text
);

COMMENT ON COLUMN camino_destinos.destino IS
  'El texto tal como se pidió. Si es un nombre DNS, la dirección a la que '
  'resuelve queda en camino_trazas.destino_ip, que puede cambiar entre trazas.';


-- ── Una corrida del trazado ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS camino_trazas (
    id            bigserial PRIMARY KEY,
    destino       text NOT NULL,
    destino_ip    inet,
    iniciada_at   timestamptz NOT NULL DEFAULT now(),
    duracion_ms   integer,
    -- Queda escrito CÓMO se midió. Un RTT de UDP a puerto cerrado y uno de
    -- TCP a puerto abierto no son comparables, y dentro de un año nadie se
    -- acuerda de con cuál se tomó esta fila.
    metodo        text NOT NULL DEFAULT 'udp-recverr',
    ttl_max       smallint NOT NULL,
    sondas_por_salto smallint NOT NULL DEFAULT 1,
    saltos          smallint NOT NULL,
    saltos_mudos    smallint NOT NULL,
    saltos_publicos smallint NOT NULL,
    -- Llegamos o nos quedamos sin TTL. Una traza que NO alcanzó el destino
    -- puede ser perfectamente informativa —dice hasta dónde llega— pero su
    -- último salto no es el destino, y confundir las dos cosas lleva a culpar
    -- al equipo equivocado.
    alcanzado     boolean NOT NULL,
    -- 🔴 POR QUÉ se dejó de trazar. Sin esto, una traza cortada a los 8 saltos
    --    y una de 8 saltos que llegó se ven IGUAL en la tabla, y son cosas
    --    opuestas: la primera no dice nada del destino.
    --      destino  · contestó el destino (ICMP 3/x). La única que «llegó».
    --      ttl_max  · se acabó el presupuesto de saltos
    --      mudos    · N saltos seguidos sin contestar, se cortó por prudencia
    --      error    · no se pudo ni empezar (ver `error`)
    motivo_fin    text NOT NULL DEFAULT 'ttl_max',
    error         text,

    -- ── Las dos huellas, y por qué son dos ──
    --
    -- 🔴 `huella_saltos` es la secuencia EXACTA (ttl → dirección o `*`). Sirve
    --    para reproducir, pero como señal de «cambió el camino» es RUIDOSA: un
    --    solo router que esta vez no contestó —lo más normal del mundo— le
    --    cambia el valor y dispararía una alarma falsa.
    --
    -- ✅ `huella_asn` es la secuencia ORDENADA y SIN REPETIR de organizaciones
    --    atravesadas, del estilo `interna>AS1234>AS5678`. Los saltos mudos no
    --    aportan nada, así que no la mueven. Ésta es la que contesta la
    --    pregunta cara: «¿mi tránsito está saliendo por otro lado que ayer?».
    huella_saltos text NOT NULL,
    huella_asn    text NOT NULL,

    -- Contra qué traza se comparó. NULL en la primera de cada destino: ahí no
    -- hay «cambió», hay «es la primera vez», y son cosas distintas — por eso
    -- `cambio_*` también queda en NULL y no en `false`.
    previa_id     bigint REFERENCES camino_trazas(id) ON DELETE SET NULL,
    cambio_saltos boolean,
    cambio_asn    boolean,

    CONSTRAINT camino_trazas_metodo_chk
        CHECK (metodo IN ('udp-recverr', 'tcp-recverr')),
    CONSTRAINT camino_trazas_motivo_chk
        CHECK (motivo_fin IN ('destino', 'ttl_max', 'mudos', 'error')),
    -- `alcanzado` y `motivo_fin` son la misma verdad dicha dos veces; que no se
    -- puedan contradecir.
    CONSTRAINT camino_trazas_alcanzado_chk
        CHECK (alcanzado = (motivo_fin = 'destino')),
    CONSTRAINT camino_trazas_conteos_chk
        CHECK (saltos >= 0 AND saltos_mudos >= 0 AND saltos_mudos <= saltos)
);

CREATE INDEX IF NOT EXISTS camino_trazas_destino_idx
    ON camino_trazas (destino, iniciada_at DESC);
CREATE INDEX IF NOT EXISTS camino_trazas_cambio_idx
    ON camino_trazas (iniciada_at DESC) WHERE cambio_asn;

COMMENT ON COLUMN camino_trazas.huella_asn IS
  'sha256 de la secuencia de organizaciones atravesadas, sin repetir y sin los '
  'saltos mudos. Es la señal de cambio de camino que NO se ensucia porque un '
  'router dejó de contestar. La legible está en `camino_trazas_texto.ruta_asn`.';


-- ── Los saltos ──────────────────────────────────────────────────────────────
--
-- 🔴 UNA FILA POR TTL, SIEMPRE, incluidos los que no contestaron. Omitirlos
--    renumeraría el camino y convertiría «no sé qué hay en el salto 7» en «no
--    hay salto 7», que es una afirmación que el dato no respalda.

CREATE TABLE IF NOT EXISTS camino_saltos (
    traza_id    bigint   NOT NULL REFERENCES camino_trazas(id) ON DELETE CASCADE,
    ttl         smallint NOT NULL,
    -- NULL = no contestó. Es el único significado de NULL en esta columna.
    direccion   inet,
    rtt_ms      double precision,
    -- interna  · dirección que NO sale de acá (RFC 1918, CGNAT, loopback…)
    -- publica  · unicast global: es la única clase que se consulta afuera
    -- especial · multicast, reservada, broadcast — contestó algo que no es un
    --            host enrutable. No se consulta afuera y no se disfraza de
    --            «interna», porque no lo es.
    -- mudo     · no contestó
    clase       text NOT NULL,
    -- Copia del ASN VIGENTE AL MOMENTO DE TRAZAR. Ver el encabezado del bloque.
    asn         integer,
    asn_org     text,
    asn_prefijo cidr,
    asn_pais    text,
    -- El ICMP crudo. `11/0` es TTL agotado (un salto intermedio) y `3/3` es
    -- puerto inalcanzable (llegamos al destino). Guardarlo permite distinguir
    -- «el destino contestó» de «un intermedio contestó» sin volver a medir, y
    -- también ver un `3/13` — filtrado administrativamente — que es un dato
    -- operativo por sí solo.
    icmp_tipo   smallint,
    icmp_codigo smallint,
    PRIMARY KEY (traza_id, ttl),
    CONSTRAINT camino_saltos_clase_chk
        CHECK (clase IN ('interna', 'publica', 'especial', 'mudo')),
    -- Las dos direcciones de la misma verdad: mudo ⟺ sin dirección.
    CONSTRAINT camino_saltos_mudo_chk
        CHECK ((clase = 'mudo') = (direccion IS NULL)),
    -- 🔴 Un ASN sólo puede existir en un salto público. Si alguna vez aparece
    --    un ASN junto a una dirección interna, eso significa que una dirección
    --    de la red del ISP se mandó a un servicio externo — que es exactamente
    --    lo que este diseño existe para impedir. Que lo rechace la BASE y no
    --    sólo el código: el código se puede reescribir sin leer el comentario.
    CONSTRAINT camino_saltos_asn_solo_publico_chk
        CHECK (clase = 'publica' OR (asn IS NULL AND asn_org IS NULL
                                     AND asn_prefijo IS NULL AND asn_pais IS NULL))
);

CREATE INDEX IF NOT EXISTS camino_saltos_asn_idx ON camino_saltos (asn);
CREATE INDEX IF NOT EXISTS camino_saltos_dir_idx ON camino_saltos (direccion);


-- ── Caché de ASN ────────────────────────────────────────────────────────────
--
-- El ASN de una dirección no cambia todos los días —el prefijo 1.1.1.0/24 está
-- asignado desde 2011— y cada consulta es tráfico saliente hacia un tercero.
-- Sin caché, una traza de 20 saltos con 12 públicos son 24 consultas DNS (12 de
-- origen + 12 de nombre de AS) cada vez que se corre.
--
-- 🔴 EL `CHECK` DE ABAJO ES LA GARANTÍA DE PRIVACIDAD, ESCRITA EN LA BASE.
--
--    Esta tabla contiene, por definición, las direcciones que SE MANDARON a un
--    servicio externo. Si una dirección de la red del ISP puede entrar acá, ya
--    se filtró. La restricción hace que la base rechace la fila: no depende de
--    que el código esté bien, ni de que el próximo que lo toque lea el
--    comentario.
--
--    Los rangos son las constantes de las RFC (1918 privadas, 6598 CGNAT, 5737
--    documentación, 2544 pruebas, 3927 link-local…), no direcciones de nadie.
--    Son EXACTAMENTE los mismos que `camino.es_publica()` en `camino.py`; si
--    las dos listas se separan, `test_camino.py` lo detecta comparándolas.

CREATE TABLE IF NOT EXISTS camino_asn_cache (
    direccion     inet PRIMARY KEY,
    asn           integer,
    prefijo       cidr,
    pais          text,
    registro      text,
    asignado      date,
    org           text,
    -- ok        · el servicio contestó con un ASN
    -- sin_datos · contestó que no sabe. Pasa de verdad: de los 4 saltos
    --             públicos de la medición del 01/08/2026, uno no tenía origen
    --             publicado. Se cachea igual, si no se re-pregunta siempre.
    -- error     · no se pudo consultar (DNS caído, sin salida). NO se cachea
    --             largo: es un fallo nuestro, no una respuesta.
    resultado     text NOT NULL,
    consultado_at timestamptz NOT NULL DEFAULT now(),
    expira_at     timestamptz NOT NULL,

    CONSTRAINT camino_asn_cache_resultado_chk
        CHECK (resultado IN ('ok', 'sin_datos', 'error')),
    CONSTRAINT camino_asn_cache_publica_chk CHECK (
        family(direccion) = 4
        AND NOT (direccion <<= ANY (ARRAY[
            '0.0.0.0/8',        -- «esta red»
            '10.0.0.0/8',       -- RFC 1918
            '100.64.0.0/10',    -- RFC 6598 CGNAT
            '127.0.0.0/8',      -- loopback
            '169.254.0.0/16',   -- RFC 3927 link-local
            '172.16.0.0/12',    -- RFC 1918
            '192.0.0.0/24',     -- RFC 6890 asignaciones de protocolo
            '192.0.2.0/24',     -- RFC 5737 documentación
            '192.168.0.0/16',   -- RFC 1918
            '198.18.0.0/15',    -- RFC 2544 pruebas
            '198.51.100.0/24',  -- RFC 5737 documentación
            '203.0.113.0/24',   -- RFC 5737 documentación
            '224.0.0.0/4',      -- multicast
            '240.0.0.0/4'       -- reservada
        ]::cidr[]))
    )
);

CREATE INDEX IF NOT EXISTS camino_asn_cache_expira_idx ON camino_asn_cache (expira_at);

COMMENT ON TABLE camino_asn_cache IS
  '🔴 Las direcciones que SE CONSULTARON afuera. El CHECK impide que entre una '
  'dirección no enrutable globalmente: es la garantía de privacidad escrita en '
  'la base, no sólo en el código. Ver el comentario en schema.sql.';


-- ── Vistas ──────────────────────────────────────────────────────────────────

-- La huella legible. Las columnas `huella_*` son sha256 —sirven para comparar,
-- no para leer— y sin esto nadie puede mirar una traza y entender qué cambió.
CREATE OR REPLACE VIEW camino_trazas_texto AS
SELECT t.id,
       t.destino,
       -- `AS1234 › AS5678`, sin repetir y sin los mudos. Es la misma secuencia
       -- sobre la que se calculó `huella_asn`, en versión para humanos.
       (SELECT string_agg(x.etiqueta, ' › ')
          FROM (SELECT DISTINCT ON (grupo) grupo,
                       CASE WHEN s.clase = 'publica' AND s.asn IS NOT NULL
                            THEN 'AS' || s.asn
                            WHEN s.clase = 'publica' THEN 'público sin ASN'
                            ELSE s.clase END AS etiqueta
                  FROM (SELECT s2.*,
                               -- Agrupa saltos consecutivos del mismo dueño.
                               row_number() OVER (ORDER BY s2.ttl)
                             - row_number() OVER (
                                 PARTITION BY s2.clase, s2.asn ORDER BY s2.ttl
                               ) AS grupo
                          FROM camino_saltos s2
                         WHERE s2.traza_id = t.id AND s2.clase <> 'mudo') s
                 ORDER BY grupo, s.ttl) x) AS ruta_asn
  FROM camino_trazas t;

-- La última traza de cada destino. `DISTINCT ON` y no una subconsulta con
-- `max(iniciada_at)`: resuelve por el índice (destino, iniciada_at DESC) sin
-- leer el histórico entero, que es lo que la página carga en cada visita.
CREATE OR REPLACE VIEW v_camino_ultimo AS
SELECT DISTINCT ON (t.destino) t.*
  FROM camino_trazas t
 ORDER BY t.destino, t.iniciada_at DESC;

COMMENT ON VIEW v_camino_ultimo IS
  'Una fila por destino: la traza más reciente. Es lo que muestra /camino.';

COMMIT;


-- ════════════════════════════════════════════════════════════════════════════
--  QUÉ EQUIPO ESTÁ VIVO — Y QUÉ ES ARRASTRE DE UN MAPA QUE NADIE ACTUALIZÓ
--
--  Bloque agregado el 02/08/2026, con su propia transacción.
--
--  ── El problema ────────────────────────────────────────────────────────────
--
--  De los 885 equipos de la base, medidos el 02/08/2026, sólo 465 dieron alguna
--  señal de vida en 30 días. Los otros 420 son equipos dados de baja: la red
--  cambió, los mapas no. Y no son un detalle estético — 325 de ellos siguen con
--  el sondeo HABILITADO, así que The Dude les pregunta cada 60 s, cuenta sus
--  caídas y manda avisos por equipos que hace meses que no existen.
--
--  Una alarma que suena por algo que ya no está no es una alarma: es ruido que
--  entrena a la gente a ignorar las alarmas de verdad.
--
--  ── 🔴 La trampa conceptual, que es el corazón de todo esto ────────────────
--
--  LA AUSENCIA DE EVIDENCIA NO ES EVIDENCIA DE BAJA.
--
--  Un equipo que estuvo impecable 30 días y uno desmantelado en 2021 son
--  IGUAL de silenciosos si la pregunta es «¿tuvo caídas?». El primero no tuvo
--  ninguna porque anduvo bien; el segundo, porque no existe.
--
--  Por eso acá NO se busca ausencia. Se busca EVIDENCIA POSITIVA: algo que sólo
--  puede haber ocurrido si el equipo estaba ahí y alguien lo midió.
--
--  ── 🔴 Y no alcanza con que EXISTA la medición: tiene que valer > 0 ────────
--
--  Medido sobre la base real: 744 equipos tienen fila diaria en la ventana de
--  30 días, y sólo 397 tienen algún valor mayor que cero. Los 347 de diferencia
--  son el relleno de casillero vacío — el mismo centinela que hace que el
--  86,5 % de las muestras de latencia valgan exactamente 0.
--
--  Contar filas habría dado 744 «vivos»: casi el DOBLE de la verdad.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── El veredicto humano, que siempre gana ───────────────────────────────────
--
-- 🔴 SIN CLAVE FORÁNEA a `devices`, y no es un olvido.
--
--    El ETL hace `DELETE FROM devices` + `INSERT` en cada corrida, cada 30 s.
--    Una foránea con CASCADE vaciaría esta tabla en la primera vuelta y el
--    trabajo de una persona se perdería sin un solo error en el log. Es la
--    misma razón por la que `map_element_positions` tampoco la tiene.
--
-- ¿Por qué hace falta un override si la clasificación se calcula sola?
--
--    Porque una escuela apagada en receso es indistinguible de un equipo
--    desmantelado, y la máquina no sabe cuál es cuál. Sin esta tabla, la
--    primera escuela que apagan en enero desaparece del mapa y nadie se entera
--    hasta marzo. La máquina propone; la persona decide, y queda firmado.
CREATE TABLE IF NOT EXISTS device_estado_manual (
    device_id  bigint PRIMARY KEY,
    estado     text NOT NULL,
    nota       text,
    por        text NOT NULL,
    at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT device_estado_manual_estado_chk
        CHECK (estado IN ('activo', 'baja'))
);

COMMENT ON TABLE device_estado_manual IS
  'Veredicto humano sobre si un equipo sigue en servicio. Gana SIEMPRE sobre '
  'el cálculo automático, en las dos direcciones: «activo» rescata a un equipo '
  'legítimamente apagado, «baja» confirma uno que la máquina todavía duda. '
  'Sin clave foránea a propósito: el ETL vacía `devices` cada 30 s.';
COMMENT ON COLUMN device_estado_manual.por IS
  'Usuario del basic_auth que lo firmó. No es decorativo: una baja mal puesta '
  'esconde un equipo del mapa, y hay que poder preguntarle a alguien.';


-- ── El cálculo caro, aislado en una vista ───────────────────────────────────
--
-- Recorre `chart_values` entero (cientos de miles de filas) para sacar la
-- última medición útil de cada equipo. No se consulta desde las páginas: el
-- ETL la vuelca en `device_vida` una vez por corrida. Ver ahí por qué.
CREATE OR REPLACE VIEW v_device_senal AS
WITH presente AS (
    -- 🔴 EL PRESENTE ES `source_mtime`, NO `now()`.
    --
    --    `dude.db` es un archivo que alguien copia; el día que esa copia se
    --    atrase 48 h —que ya pasó— medir contra el reloj de pared correría la
    --    ventana de 30 días dos días hacia adelante y empezaría a declarar
    --    «de baja» equipos vivos, sin que nada falle ni avise.
    --
    --    Anclando al mtime del volcado, una copia vieja produce una respuesta
    --    vieja pero CORRECTA. Que es la única clase de error tolerable acá.
    --    Y NO se filtra por `ok`: el mtime es una propiedad del ARCHIVO, no
    --    del éxito de la corrida. Con `WHERE ok` la primerísima corrida de una
    --    base nueva no encuentra ninguna fila —la suya todavía tiene ok NULL—
    --    y cae al reloj de pared, midiendo la ventana contra el momento
    --    equivocado justo cuando nadie está mirando.
    SELECT COALESCE(max(source_mtime), now()) AS ahora
      FROM sync_runs
     WHERE source_mtime IS NOT NULL
),
medicion AS (
    -- Cualquier unidad sirve. Una latencia > 0 prueba que volvió un ping; un
    -- tráfico > 0, que pasaron bits. Las dos cosas sólo ocurren si el equipo
    -- está. No se filtra por unidad porque la evidencia no necesita ser
    -- necesaria, sólo SUFICIENTE.
    SELECT s.device_id, max(v.ts) AS ts
      FROM chart_sources s
      JOIN chart_values v ON v.source_id = s.id
     WHERE s.device_id IS NOT NULL AND v.value > 0
     GROUP BY s.device_id
),
caida_dude AS (
    -- Que un equipo se HAYA CAÍDO también prueba que estaba: para caerse hay
    -- que haber estado arriba, y para que alguien lo registre hay que existir.
    SELECT device_id, max(GREATEST(started_at, COALESCE(ended_at, started_at))) AS ts
      FROM outages
     WHERE device_id IS NOT NULL
     GROUP BY device_id
),
caida_syslog AS (
    SELECT device_id, max(GREATEST(started_at, COALESCE(ended_at, started_at))) AS ts
      FROM syslog_outages
     WHERE device_id IS NOT NULL
     GROUP BY device_id
),
cambio_estado AS (
    -- 🔴 LA CUARTA FUENTE, Y FALTABA. Un servicio que HOY está caído y cuyo
    --    último cambio de estado fue el martes prueba que el martes estaba
    --    ARRIBA: para caerse hay que haber estado en pie.
    --
    --    Sin esto la vista se perdía justo a los equipos más interesantes.
    --    Medido sobre la instalación real el 06/08/2026, al agregarla:
    --
    --      equipos sin ninguna fecha de vida   256  →   30
    --      con la fecha más reciente que antes       117
    --      🔴 con la fecha hacia ATRÁS                 0
    --
    --    Cero retrocesos es el número que importa: la fuente nueva nunca
    --    contradice a las otras tres, sólo agrega. Y los 226 que ganan fecha
    --    no son ruido — entre ellos hay 3 equipos CAÍDOS AHORA que figuraban
    --    como bajas de hace 1.846 días y en realidad son testigos de corte de
    --    energía que parpadean todos los días. Su trabajo es prenderse y
    --    apagarse; el panel no los veía porque no tienen serie de mediciones
    --    y The Dude nunca les registró una caída.
    --
    -- ⚠️ El límite honesto: si The Dude fecha el ALTA de un servicio que nunca
    --    respondió, eso entra acá como si fuera vida. No se pudo descartar del
    --    todo. Se acota solo —un alta vieja queda fuera de la ventana de 30
    --    días— y el caso que sí importa, un alta reciente que no responde, es
    --    algo que igual hay que mirar. Se prefiere ese falso positivo antes
    --    que seguir ocultando caídas reales.
    SELECT s.device_id, max(s.status_changed_at) AS ts
      FROM services s
     WHERE s.device_id IS NOT NULL
       AND s.status_changed_at IS NOT NULL
     GROUP BY s.device_id
)
SELECT d.id                                   AS device_id,
       m.ts                                   AS ultima_medicion,
       cd.ts                                  AS ultima_caida,
       cs.ts                                  AS ultima_syslog,
       -- 🔴 El COALESCE no es paranoia: `status` es NULL en 159 de los 885
       --    equipos, y en SQL `NULL IN (1,2)` vale NULL, no `false`. Sin esto
       --    la columna sale NULL y revienta contra su propio NOT NULL — que
       --    es exactamente cómo se encontró.
       COALESCE(d.status IN (1, 2), false)    AS arriba_ahora,
       p.ahora,
       -- Un equipo que está ARRIBA ahora mismo no necesita más prueba: la
       -- señal es este instante. Para el resto, la más reciente de las tres,
       -- topeada al presente — un `ended_at` en el futuro (una duración basura)
       -- no puede fabricar vida que no ocurrió.
       --
       -- 🔴 Y el caso «ninguna de las tres» se atiende APARTE, antes del LEAST.
       --
       --    `LEAST` en Postgres IGNORA los NULL: `LEAST(NULL, ahora)` no da
       --    NULL, da `ahora`. Sin esta rama, un equipo sin una sola evidencia
       --    de vida —los 386 que jamás dieron señal— saldría con
       --    `ultima_senal = ahora`, o sea clasificado como VIVO HOY. El error
       --    exactamente al revés del que este módulo viene a evitar, y en
       --    silencio: ninguna restricción lo habría atajado.
       CASE WHEN COALESCE(d.status IN (1, 2), false) THEN p.ahora
            WHEN GREATEST(m.ts, cd.ts, cs.ts, ce.ts) IS NULL THEN NULL
            ELSE LEAST(GREATEST(m.ts, cd.ts, cs.ts, ce.ts), p.ahora)
       END                                    AS ultima_senal,
       -- 🔴 AL FINAL, y no donde correspondería por orden de lectura.
       --    `CREATE OR REPLACE VIEW` sólo sabe AGREGAR columnas al final: meter
       --    una en el medio falla con «cannot change name of view column». Un
       --    orden lindo cuesta un DROP CASCADE, y eso se lleva puestas todas
       --    las vistas que dependen de ésta.
       ce.ts                                  AS ultimo_cambio
  FROM devices d
 CROSS JOIN presente p
  LEFT JOIN medicion      m  ON m.device_id  = d.id
  LEFT JOIN caida_dude    cd ON cd.device_id = d.id
  LEFT JOIN caida_syslog  cs ON cs.device_id = d.id
  LEFT JOIN cambio_estado ce ON ce.device_id = d.id;

COMMENT ON VIEW v_device_senal IS
  'Última evidencia POSITIVA de vida por equipo, y de qué fuente salió. '
  'Cara: recorre chart_values entero. El ETL la vuelca en device_vida.';


-- ── La foto, que es lo que leen las páginas ─────────────────────────────────
--
-- 🔴 Una tabla y no una vista materializada, a propósito.
--
--    `REFRESH MATERIALIZED VIEW` sin CONCURRENTLY toma un ACCESS EXCLUSIVE que
--    congelaría el panel cada 30 s; con CONCURRENTLY no puede correr dentro de
--    una transacción, y todo el ETL vive dentro de una. Un DELETE + INSERT
--    entra en la transacción que ya existe, no bloquea a ningún lector, y si
--    la corrida falla no deja una foto a medias.
--
-- Se puede vaciar sin miedo: es 100 % derivada. Lo que NO se puede perder es
-- `device_estado_manual`, que es de una persona.
CREATE TABLE IF NOT EXISTS device_vida (
    device_id        bigint PRIMARY KEY,
    ultima_medicion  timestamptz,
    ultima_caida     timestamptz,
    ultima_syslog    timestamptz,
    ultimo_cambio    timestamptz,
    ultima_senal     timestamptz,
    arriba_ahora     boolean     NOT NULL DEFAULT false,
    ahora            timestamptz NOT NULL,
    calculada_at     timestamptz NOT NULL DEFAULT now()
);

-- 🔴 `CREATE TABLE IF NOT EXISTS` NO agrega columnas a una tabla que ya existe.
--    En una instalación viva la de arriba no corre, así que la columna nueva
--    hay que pedirla aparte. Sin esto el ETL falla con «column ultimo_cambio
--    does not exist» en la primera corrida después de actualizar — y falla en
--    el servidor, no acá.
ALTER TABLE device_vida ADD COLUMN IF NOT EXISTS ultimo_cambio timestamptz;

COMMENT ON TABLE device_vida IS
  'Foto de v_device_senal, rehecha por el ETL en cada corrida. Derivada al '
  '100 %: se puede vaciar sin perder nada.';
COMMENT ON COLUMN device_vida.ahora IS
  'El «presente» contra el que se midió: source_mtime del volcado, NO now(). '
  'Guardarlo permite que la página diga «según un volcado de hace 2 días» en '
  'vez de presentar una respuesta vieja como si fuera de ahora.';


-- ── Lo que consultan las páginas: barata, una fila por equipo ───────────────
--
-- La CLASIFICACIÓN (activo / dudoso / baja) NO se hace acá sino en
-- `web/src/lib/vida.ts`, con umbrales que salen de variables de entorno.
-- Motivo: si los umbrales viven en el SQL, cambiarlos es una migración; y el
-- corte correcto depende del ISP, no del código. Acá se expone el DATO
-- —cuántos días hace— y la política se decide arriba.
CREATE OR REPLACE VIEW v_device_estado AS
SELECT d.id                                        AS device_id,
       d.name,
       d.status,
       d.status_label,
       d.probe_enabled,
       v.ultima_senal,
       v.ultima_medicion,
       v.ultima_caida,
       v.ultima_syslog,
       COALESCE(v.arriba_ahora, false)             AS arriba_ahora,
       v.ahora,
       CASE WHEN v.ultima_senal IS NULL THEN NULL
            ELSE floor(EXTRACT(EPOCH FROM (v.ahora - v.ultima_senal)) / 86400)::int
       END                                         AS dias_sin_senal,
       m.estado                                    AS estado_manual,
       m.nota                                      AS nota_manual,
       m.por                                       AS por_manual,
       m.at                                        AS at_manual,
       v.ultimo_cambio  -- al final: ver la nota en v_device_senal
  FROM devices d
  LEFT JOIN device_vida           v ON v.device_id = d.id
  LEFT JOIN device_estado_manual  m ON m.device_id = d.id;

COMMENT ON VIEW v_device_estado IS
  'Una fila por equipo con su última señal de vida y el veredicto humano si lo '
  'hay. La clasificación en activo/dudoso/baja se hace en web/src/lib/vida.ts, '
  'no acá: los umbrales son política y cambian por ISP.';


-- ═══════════════════════════════════════════════════════════════════════════
--  Las caídas EN CURSO — reconstruidas, porque The Dude no las guarda
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 🔴 `outages` NO TIENE NI UNA SOLA CAÍDA ABIERTA. Nunca. Medido sobre la
--    instalación real el 06/08/2026:
--
--      outages · total                        11.988
--      outages · con `ended_at IS NULL`             0
--      equipos caídos en ese mismo instante       341
--      de esos, presentes en `outages`              0
--
--    No es un defecto del ETL: es cómo funciona The Dude. **Escribe la fila
--    cuando el servicio SE RECUPERA**, con principio y fin de una vez. Mientras
--    el equipo está caído no hay ninguna fila que lo diga.
--
--    Consecuencia, y es grave: `/caidas` mostraba «Sin resolver: 0» con 341
--    equipos abajo. No mentía por un error de cálculo — contaba bien una tabla
--    que estructuralmente no puede tener lo que se le pedía. **El historial es
--    exactamente lo contrario de lo que necesita una guardia: cuenta lo que ya
--    terminó y calla lo que está pasando.**
--
-- ── De dónde sale entonces la fecha ─────────────────────────────────────────
--
-- De `services.status_changed_at`: el instante del último cambio de estado, que
-- para un servicio caído es justo cuándo se cayó. Llega hasta 2012.
--
-- 🔴 OJO CON `services.time_since_changed`: **no es una duración, es un epoch.**
--    El nombre viene del campo de The Dude y engaña. `status_changed_at` es su
--    decodificación —`to_timestamp(time_since_changed)`, exacto— así que son la
--    misma cosa y cruzarlas no valida nada. Se perdió una medición entera
--    creyendo que eran dos fuentes independientes.
--
-- ── Cómo se comprobó que la fecha dice la verdad ────────────────────────────
--
-- Con `outages`, que sale de OTRO objeto de la base. Un servicio que hoy está
-- ARRIBA cambió de estado al recuperarse, así que su `status_changed_at` tiene
-- que coincidir con el `ended_at` de su última caída cerrada. Sobre 273 casos:
--
--      coinciden al segundo                            78
--      status_changed_at POSTERIOR (hubo flaps luego)  194
--      🔴 ANTERIOR — imposible si la columna miente      0
--
-- Cero imposibles es el resultado que importa. Los 194 posteriores son
-- esperables: `outages` no registró los cambios de después.
--
-- Segunda comprobación, contra las mediciones: de 120 equipos caídos con serie,
-- 92 tienen su última medición con valor > 0 dentro de la hora de la fecha de
-- caída. La mediana da 47 min, y eso NO es error: la serie se guarda en cajones
-- de 10 min, 2 h y 1 día, así que para un equipo caído hace semanas el último
-- punto viene de un cajón diario. La resolución del cajón es el piso del
-- desvío, no una discrepancia.
--
-- ── Decisiones de la vista ──────────────────────────────────────────────────
--
--  · El reloj es `source_mtime` —cuándo se leyó `dude.db` por última vez—, no
--    `now()`. Si el ETL se detuvo, las duraciones NO crecen solas: quedan
--    congeladas donde estaba el conocimiento real. Una duración que sigue
--    corriendo sin datos nuevos es una afirmación que nadie verificó.
--
--  · `LEFT JOIN` a los servicios, no `JOIN`. Un equipo caído sin ningún
--    servicio fechable sale igual, con `desde` en NULL. Hoy no hay ninguno
--    —medido: 0 de 341— pero omitirlo en silencio el día que aparezca sería
--    exactamente el error que este proyecto viene corrigiendo en otros lados:
--    una lista recortada que no avisa que está recortada.
--
--  · No clasifica. `dias_sin_senal` y `estado_manual` viajan crudos y el
--    veredicto activo/dudoso/baja lo pone `web/src/lib/vida.ts`, igual que en
--    `v_device_estado`: los umbrales son política, y la política no va en SQL.
CREATE OR REPLACE VIEW v_caida_en_curso AS
WITH presente AS (
  SELECT COALESCE(max(source_mtime), now()) AS ahora
    FROM sync_runs
   WHERE source_mtime IS NOT NULL
),
caidos AS (
  -- Sólo los servicios que están abajo AHORA y tienen fecha de cuándo cayeron.
  SELECT s.device_id,
         min(s.status_changed_at)                        AS desde,
         count(*)                                        AS servicios_caidos
    FROM services s
   WHERE s.device_id IS NOT NULL
     AND COALESCE(s.status NOT IN (1, 2), false)
     AND s.status_changed_at IS NOT NULL
   GROUP BY s.device_id
),
totales AS (
  SELECT device_id, count(*) AS servicios_total
    FROM services
   WHERE device_id IS NOT NULL
   GROUP BY device_id
)
SELECT d.id                                              AS device_id,
       d.name,
       d.addresses,
       d.status,
       d.status_label,
       c.desde,
       p.ahora,
       -- GREATEST contra 0: si el reloj del origen quedó detrás de la fecha de
       -- caída —relojes distintos, o una corrida vieja— una duración negativa
       -- se dibujaría como «hace -3 h», que es peor que no decir nada.
       CASE WHEN c.desde IS NULL THEN NULL
            ELSE GREATEST(EXTRACT(EPOCH FROM (p.ahora - c.desde))::bigint, 0)
       END                                               AS duracion_s,
       COALESCE(c.servicios_caidos, 0)                   AS servicios_caidos,
       COALESCE(t.servicios_total, 0)                    AS servicios_total,
       e.ultima_senal,
       e.dias_sin_senal,
       e.estado_manual,
       e.nota_manual,
       -- Redundante con el WHERE —acá todo está caído— pero se expone igual
       -- porque `sqlEsActivo()` en web/src/lib/vida.ts la lee, y esa función
       -- es el ÚNICO lugar donde vive la regla de qué equipo cuenta. Copiar
       -- la regla acá con un `false` fijo sería crear una segunda versión que
       -- se desincroniza sola el día que alguien cambie la de allá.
       COALESCE(e.arriba_ahora, false)                   AS arriba_ahora
  FROM devices d
  CROSS JOIN presente p
  LEFT JOIN caidos            c ON c.device_id = d.id
  LEFT JOIN totales           t ON t.device_id = d.id
  LEFT JOIN v_device_estado   e ON e.device_id = d.id
 WHERE COALESCE(d.status NOT IN (1, 2), false);

COMMENT ON VIEW v_caida_en_curso IS
  'Una fila por equipo caído AHORA, con desde cuándo. Reconstruida de '
  'services.status_changed_at porque outages sólo guarda caídas ya terminadas: '
  'tiene 0 filas abiertas de 11.988. No clasifica activo/baja — eso es política '
  'y vive en web/src/lib/vida.ts.';

COMMIT;
