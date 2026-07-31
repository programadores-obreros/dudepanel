-- ════════════════════════════════════════════════════════════════════════════
--  Datos de prueba para desarrollar el panel y correr los tests.
--
--  NO son datos de el ISP: son inventados, pero con la forma de los reales.
--  Nombres al estilo `Vega_P_Ponte_AC2`, direcciones en 192.0.2.0/24, tres
--  mapas encadenados por submapas, coordenadas plausibles y una distribución de
--  estados parecida a la medida el 31/07/2026 (1→363 · 3→267 · 0→214 · 2→15).
--
--  Se aplica DESPUÉS de etl/schema.sql:
--
--      psql "$DATABASE_URL" -f ../etl/schema.sql
--      psql "$DATABASE_URL" -f seed-dev.sql
--
--  Es idempotente: limpia todo antes de cargar.
--
--  🔴 No hay ni una columna de credenciales, igual que en el esquema real.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

TRUNCATE chart_values, chart_sources, outages, map_elements, maps, links,
         services, device_parents, devices, notifications, snmp_profiles,
         link_types, probes, device_types, files, sync_runs
  RESTART IDENTITY CASCADE;

-- ── Catálogos ───────────────────────────────────────────────────────────────
-- Las rutas apuntan a `data/files/`, que en desarrollo normalmente no existe.
-- A propósito: así se ejercita el camino de los iconos de repuesto.

INSERT INTO files (id, name, file_name, rel_path) VALUES
  (501, 'router.svg',  'router.svg',  'files/router.svg'),
  (502, 'ap.svg',      'ap.svg',      'files/ap.svg'),
  (503, 'switch.svg',  'switch.svg',  'files/switch.svg'),
  (504, 'client.svg',  'client.svg',  'files/client.svg'),
  (505, 'server.svg',  'server.svg',  'files/server.svg'),
  (506, 'globe.svg',   'globe.svg',   'files/globe.svg'),
  (507, 'device.svg',  'device.svg',  'files/device.svg');

INSERT INTO device_types (id, name, url, image_id, image_scale) VALUES
  (601, 'Router',        NULL, 501, 100),
  (602, 'Access Point',  NULL, 502, 100),
  (603, 'Switch',        NULL, 503, 100),
  (604, 'Cliente',       NULL, 504, 100),
  (605, 'Servidor',      NULL, 505, 100),
  (606, 'Enlace WAN',    NULL, 506, 100),
  (607, 'Genérico',      NULL, 507, 100);

INSERT INTO probes (id, name, default_port, dns_name, function_available, function_error, function_value, unit) VALUES
  (701, 'ping',        NULL, NULL, NULL, NULL, 'ping_avg_rtt()', 'ms'),
  (702, 'dns',           53, NULL, NULL, NULL, NULL, NULL),
  (703, 'http',          80, NULL, NULL, NULL, NULL, NULL),
  (704, 'snmp-cpu',     161, NULL, 'cpu_usage_available()', NULL, 'cpu_usage()', '%'),
  (705, 'winbox',      8291, NULL, NULL, NULL, NULL, NULL),
  (706, 'radius',      1812, NULL, NULL, NULL, NULL, NULL);

INSERT INTO link_types (id, name, snmp_type, style, thickness, snmp_speed) VALUES
  (801, 'Fibra',        6, 0, 3, 1000000000),
  (802, 'Enlace PtP',  71, 0, 2,  300000000),
  (803, 'Ethernet',     6, 0, 2, 1000000000),
  (804, 'Cliente PtMP',71, 1, 1,   50000000);

-- 🔴 Sin community, igual que en producción: el ETL no la lee.
INSERT INTO snmp_profiles (id, name, version, port, try_count, try_timeout) VALUES
  (901, 'v2c-gestion', 1, 161, 3, 2000),
  (902, 'v1-legacy',   0, 161, 2, 3000),
  (903, 'v3-core',     2, 161, 3, 2000);

INSERT INTO notifications (id, name, type_id, type_label, enabled, subject) VALUES
  (951, 'Correo a guardia', 1, 'email',  true,  'The Dude: [Device.Name] está [Device.Status]'),
  (952, 'Registro',        10, 'log',    true,  NULL),
  (953, 'Syslog NOC',       2, 'syslog', false, NULL);

-- ── Dispositivos ────────────────────────────────────────────────────────────
-- La columna `status` se carga a mano y los servicios se derivan de ella más
-- abajo, para que el conjunto sea internamente coherente.

INSERT INTO devices
  (id, name, addresses, dns_names, macs, type_id, snmp_profile_id, router_os,
   probe_enabled, probe_interval, probe_timeout, probe_down_count, dude_server, status)
VALUES
  -- Núcleo
  (100, 'WAN_Fibertel_Principal', '{200.10.5.1}',   'wan1.example.net',  '{}',                     606, NULL, false, true,  60, 3000, 3, false, 1),
  (101, 'BR_Core_01',             '{192.0.2.2}',   'br01.example.net',  '{4C:5E:0C:11:22:01}',    601,  903, true,  true,  30, 2000, 3, false, 1),
  (102, 'RT_Core_A',              '{192.0.2.3}',   'rta.example.net',   '{4C:5E:0C:11:22:02}',    601,  903, true,  true,  30, 2000, 3, false, 1),
  (103, 'RT_Core_B',              '{192.0.2.4}',   'rtb.example.net',   '{4C:5E:0C:11:22:03}',    601,  903, true,  true,  30, 2000, 3, false, 2),
  (104, 'SW_DC_01',               '{192.0.2.20}',  NULL,                '{4C:5E:0C:11:22:10}',    603,  901, false, true,  60, 2000, 3, false, 1),
  (105, 'SRV_Dude_Monitor',       '{192.0.2.30,192.0.2.200}', 'host-de-ejemplo', '{02:00:00:00:00:01}', 605, 901, false, true,  30, 2000, 3, true,  1),
  (106, 'SRV_NAS_Backup',         '{192.0.2.31}',  NULL,                '{}',                     605,  901, false, true, 300, 5000, 5, false, 0),
  (137, 'SRV_Radius',             '{192.0.2.40}',  'radius.example.net','{}',                     605,  901, false, true,  60, 2000, 3, false, 1),
  (138, 'SRV_DNS_01',             '{192.0.2.41}',  'ns1.example.net',   '{}',                     605,  901, false, true,  60, 2000, 3, false, 1),
  (139, 'SRV_DNS_02',             '{192.0.2.42}',  'ns2.example.net',   '{}',                     605,  901, false, true,  60, 2000, 3, false, 2),
  (140, 'UPS_DC_Principal',       '{192.0.2.41}',  NULL,                '{}',                     607,  902, false, true, 120, 4000, 3, false, 1),

  -- Zona Norte · Aurora
  (117, 'RT_Ponte_Torre',         '{192.0.2.8054}', NULL,               '{48:8F:5A:0B:11:FE}',    601,  901, true,  true,  30, 2000, 3, false, 1),
  (130, 'SW_Ponte_01',            '{192.0.2.8040}', NULL,               '{48:8F:5A:0B:11:F0}',    603,  901, false, true,  60, 2000, 3, false, 1),
  (110, 'Vega_P_Ponte_AC2',        '{192.0.2.79}',   NULL,               '{48:8F:5A:0B:11:01}',    602,  901, true,  true,  30, 2000, 3, false, 1),
  (111, 'Vega_P_Ponte_SEC',        '{192.0.2.80}',   NULL,               '{48:8F:5A:0B:11:02}',    602,  901, true,  true,  30, 2000, 3, false, 1),
  (112, 'CPE_Ponte_0142',         '{192.0.2.120}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (113, 'CPE_Ponte_0187',         '{192.0.2.165}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 3),
  (114, 'CPE_Ponte_0203',         '{192.0.2.7903}', NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (115, 'CPE_Ponte_0219',         '{192.0.2.7919}', NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (116, 'CPE_Ponte_0244',         '{192.0.2.7944}', NULL,               '{}',                     604, NULL, true,  false, 60, 3000, 4, false, 0),

  -- Repetidora Cerro (cuelga de Aurora)
  (132, 'RT_Repetidora_Cerro',    '{192.0.2.212}',   NULL,               '{48:8F:5A:0C:30:01}',    601,  901, true,  true,  30, 2000, 3, false, 1),
  (133, 'Vega_P_Cerro_AC1',        '{192.0.2.213}',   NULL,               '{48:8F:5A:0C:30:02}',    602,  901, true,  true,  30, 2000, 3, false, 1),
  (134, 'CPE_Cerro_0011',         '{192.0.2.2121}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (135, 'CPE_Cerro_0025',         '{192.0.2.2135}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 0),

  -- Zona Sur · Alvear — acá está el problema del turno
  (126, 'RT_Alvear_Torre',        '{192.0.2.15754}', NULL,               '{48:8F:5A:0B:22:FE}',    601,  901, true,  true,  30, 2000, 3, false, 1),
  (131, 'SW_Alvear_01',           '{192.0.2.15740}', NULL,               '{48:8F:5A:0B:22:F0}',    603,  901, false, true,  60, 2000, 3, false, 1),
  (120, 'Vega_P_Alvear_AC1',       '{192.0.2.156}',   NULL,               '{48:8F:5A:0B:22:01}',    602,  901, true,  true,  30, 2000, 3, false, 2),
  (121, 'Vega_P_Alvear_AC2',       '{192.0.2.157}',   NULL,               '{48:8F:5A:0B:22:02}',    602,  901, true,  true,  30, 2000, 3, false, 3),
  (122, 'CPE_Alvear_0031',        '{192.0.2.186}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 3),
  (123, 'CPE_Alvear_0058',        '{192.0.2.213}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 3),
  (124, 'CPE_Alvear_0072',        '{192.0.2.227}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (125, 'CPE_Alvear_0099',        '{192.0.2.254}',  NULL,               '{}',                     604, NULL, true,  true,  60, 3000, 4, false, 1),
  (136, 'PRT_Oficina_Central',    '{192.168.2.50}',  NULL,               '{}',                     607, NULL, false, true, 300, 5000, 3, false, 1);

UPDATE devices SET status_label = CASE status
  WHEN 1 THEN 'arriba' WHEN 2 THEN 'caída parcial' WHEN 3 THEN 'caído' ELSE 'sin datos' END;

-- ── Topología ───────────────────────────────────────────────────────────────
-- Con esto el detalle de un CPE caído puede decir "el AP del que colgás también
-- está caído, arreglá ese primero".

INSERT INTO device_parents (device_id, parent_id) VALUES
  (101, 100),
  (102, 101), (103, 101), (106, 101),
  (104, 102), (105, 102), (140, 104),
  (137, 103), (138, 103), (139, 103),
  (117, 102), (126, 103),
  (130, 117), (110, 130), (111, 130),
  (112, 110), (113, 110), (114, 111), (115, 111), (116, 111),
  (132, 117), (133, 132), (134, 133), (135, 133),
  (131, 126), (120, 131), (121, 131),
  (122, 120), (123, 120), (124, 121), (125, 121),
  (136, 131);

-- ── Servicios ───────────────────────────────────────────────────────────────
-- Derivados del estado del equipo para que no se contradigan. Un `ping` en todo
-- lo que se monitorea, `winbox` en los MikroTik, y las sondas puntuales.

INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
SELECT 3000 + d.id, d.id, 701, d.status, d.probe_enabled, false,
       CASE WHEN d.status = 3 THEN 7 WHEN d.status = 2 THEN 2 ELSE 0 END,
       d.probe_interval, d.probe_timeout, NULL,
       -- 🔴 timeLastUp y timeLastDown son DURACIONES en segundos, no fechas:
       --    los nombres de The Dude mienten. El que sí es un instante epoch es
       --    timeSinceChanged. Ver el comentario en `Servicio`.
       CASE WHEN d.status = 1 THEN 86400 * 12 ELSE 3600 * 5 END,
       CASE WHEN d.status IN (2, 3) THEN 10800 ELSE 0 END,
       CASE WHEN d.status = 1 THEN extract(epoch FROM now() - interval '12 days')::bigint
            ELSE extract(epoch FROM now() - interval '3 hours')::bigint END
FROM devices d;

-- Winbox sólo en los RouterOS. En los que están parciales, esta es la que falla.
INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
SELECT 3500 + d.id, d.id, 705,
       CASE WHEN d.status = 2 THEN 3 ELSE d.status END,
       true, false,
       CASE WHEN d.status IN (2, 3) THEN 5 ELSE 0 END,
       60, 3000, 8291,
       3600, CASE WHEN d.status IN (2, 3) THEN 2400 ELSE 0 END,
       extract(epoch FROM now() - interval '40 minutes')::bigint
FROM devices d
WHERE d.router_os;

-- SNMP de CPU en el núcleo y en las torres.
INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
SELECT 4000 + d.id, d.id, 704, CASE WHEN d.status = 3 THEN 3 ELSE 1 END,
       true, false, 0, 300, 4000, 161,
       86400 * 30, 0, extract(epoch FROM now() - interval '30 days')::bigint
FROM devices d
WHERE d.snmp_profile_id IS NOT NULL;

-- DNS y RADIUS, con una reconocida por el operador para ejercitar `acked`.
INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
VALUES
  (4501, 138, 702, 1, true, false, 0, 60, 2000,   53,
        604800, 0,      extract(epoch FROM now() - interval '7 days')::bigint),
  (4502, 139, 702, 3, true, true,  9, 60, 2000,   53,
        172800, 172800, extract(epoch FROM now() - interval '2 days')::bigint),
  (4503, 137, 706, 1, true, false, 0, 60, 2000, 1812,
        259200, 0,      extract(epoch FROM now() - interval '3 days')::bigint),
  (4504, 105, 703, 1, true, false, 0, 60, 2000,   80,
        1209600, 0,     extract(epoch FROM now() - interval '14 days')::bigint);

UPDATE services SET status_label = CASE status
  WHEN 1 THEN 'arriba' WHEN 2 THEN 'caída parcial' WHEN 3 THEN 'caído' ELSE 'sin datos' END;

-- ── Enlaces ─────────────────────────────────────────────────────────────────

-- `master_interface` es el ÍNDICE SNMP de la interfaz, no su nombre: en el
-- origen viene como entero y el esquema lo respeta.
INSERT INTO links (id, name, type_id, master_device_id, master_interface, history) VALUES
  (4001, 'Fibra WAN Fibertel',       801, 101, 1, true),
  (4002, 'Core A ↔ Core B',          801, 102, 9, true),
  (4003, 'PtP Núcleo → Aurora',       802, 102, 3, true),
  (4004, 'PtP Núcleo → Alvear',      802, 103, 3, true),
  (4005, 'PtP Aurora → Cerro',        802, 117, 4, true),
  (4006, 'Sector Aurora AC2',         804, 110, 2, false),
  (4007, 'Sector Alvear AC1',        804, 120, 2, false);

-- ── Mapas ───────────────────────────────────────────────────────────────────
-- 🔴 `elements_id` es la clave del JOIN en el origen: el `sys-type` de un
--    elemento ES este número. Acá no se usa para unir (ya hay `map_id`), pero
--    se carga igual porque el esquema lo modela y el ETL real lo llena.

INSERT INTO maps (id, name, elements_id, background_color,
                  up_color, down_color, partial_color, unknown_color, acked_color) VALUES
  (1001, 'el ISP — Núcleo',    2001, 16777215, 32768, 16711680, 16753920, 8421504, 255),
  (1002, 'Zona Norte — Aurora',   2002, 16777215, 32768, 16711680, 16753920, 8421504, 255),
  (1003, 'Zona Sur — Alvear',    2003, 16777215, 32768, 16711680, 16753920, 8421504, 255),
  (1004, 'Mapa vacío (heredado)',2004, 16777215, 32768, 16711680, 16753920, 8421504, 255);

-- Núcleo. Los dos nodos de submapa llevan a los otros mapas.
INSERT INTO map_elements (id, map_id, kind, x, y, shape, image_id, label, device_id, submap_id) VALUES
  (5001, 1001, 'device', 400,  40, 0, 506, NULL, 100, NULL),
  (5002, 1001, 'device', 400, 150, 0, 501, NULL, 101, NULL),
  (5003, 1001, 'device', 240, 270, 0, 501, NULL, 102, NULL),
  (5004, 1001, 'device', 560, 270, 0, 501, NULL, 103, NULL),
  (5005, 1001, 'device', 130, 390, 0, 503, NULL, 104, NULL),
  (5006, 1001, 'device', 300, 390, 0, 505, NULL, 105, NULL),
  (5007, 1001, 'device', 470, 390, 0, 505, NULL, 137, NULL),
  (5008, 1001, 'device', 620, 390, 0, 505, NULL, 138, NULL),
  (5009, 1001, 'device', 760, 390, 0, 505, NULL, 139, NULL),
  (5012, 1001, 'device', 900, 150, 0, 505, NULL, 106, NULL),
  (5013, 1001, 'device', 130, 500, 0, 507, 'UPS', 140, NULL),
  (5010, 1001, 'submap', 300, 520, 0, NULL, 'Zona Norte', NULL, 1002),
  (5011, 1001, 'submap', 620, 520, 0, NULL, 'Zona Sur',   NULL, 1003);

-- Zona Norte.
INSERT INTO map_elements (id, map_id, kind, x, y, shape, image_id, label, device_id, submap_id) VALUES
  (5101, 1002, 'device', 400,  60, 0, 501, NULL, 117, NULL),
  (5104, 1002, 'device', 400, 180, 0, 503, NULL, 130, NULL),
  (5102, 1002, 'device', 240, 300, 0, 502, NULL, 110, NULL),
  (5103, 1002, 'device', 560, 300, 0, 502, NULL, 111, NULL),
  (5105, 1002, 'device', 100, 440, 0, 504, NULL, 112, NULL),
  (5106, 1002, 'device', 250, 440, 0, 504, NULL, 113, NULL),
  (5107, 1002, 'device', 460, 440, 0, 504, NULL, 114, NULL),
  (5108, 1002, 'device', 610, 440, 0, 504, NULL, 115, NULL),
  (5109, 1002, 'device', 760, 440, 0, 504, NULL, 116, NULL),
  (5110, 1002, 'device', 860, 180, 0, 501, NULL, 132, NULL),
  (5111, 1002, 'device', 860, 300, 0, 502, NULL, 133, NULL),
  (5112, 1002, 'device', 940, 440, 0, 504, NULL, 134, NULL),
  (5113, 1002, 'device',1080, 440, 0, 504, NULL, 135, NULL);

-- Zona Sur. El 5209 va SIN coordenadas a propósito: en la base real hay
-- elementos así y el visor tiene que ubicarlos igual, no perderlos.
INSERT INTO map_elements (id, map_id, kind, x, y, shape, image_id, label, device_id, submap_id) VALUES
  (5201, 1003, 'device', 400,  60, 0, 501, NULL, 126, NULL),
  (5202, 1003, 'device', 400, 180, 0, 503, NULL, 131, NULL),
  (5203, 1003, 'device', 240, 300, 0, 502, NULL, 120, NULL),
  (5204, 1003, 'device', 560, 300, 0, 502, NULL, 121, NULL),
  (5205, 1003, 'device', 120, 440, 0, 504, NULL, 122, NULL),
  (5206, 1003, 'device', 300, 440, 0, 504, NULL, 123, NULL),
  (5207, 1003, 'device', 480, 440, 0, 504, NULL, 124, NULL),
  (5208, 1003, 'device', 660, 440, 0, 504, NULL, 125, NULL),
  (5209, 1003, 'device', NULL, NULL, 0, 507, NULL, 136, NULL);

-- Rótulos `static`: texto libre del original. En la base real hay 100 y son
-- nombres de puerto puestos al lado de un enlace. No son equipos: no tienen
-- estado, ni icono, ni adónde llevar.
INSERT INTO map_elements (id, map_id, kind, x, y, shape, label) VALUES
  (5301, 1001, 'static', 300,  95, NULL, 'ether1'),
  (5302, 1001, 'static', 470, 215, NULL, 'sfp-plus1'),
  (5303, 1001, 'static', 200, 470, NULL, 'wlan1'),
  (5304, 1002, 'static', 420, 120, NULL, 'ether5'),
  (5305, 1002, 'static', 700, 130, NULL, 'wlan2'),
  (5306, 1003, 'static', 420, 120, NULL, 'ether5'),
  -- Sin texto: se descarta en silencio en vez de dibujar un hueco.
  (5307, 1003, 'static', 700, 120, NULL, '   ');

-- Enlaces dibujados. `link_from`/`link_to` son ids de OTROS elementos del mismo
-- mapa, no de dispositivos: eso es lo que resuelve el ETL.
INSERT INTO map_elements (id, map_id, kind, x, y, shape, link_id, link_from, link_to, link_width) VALUES
  (5050, 1001, 'link', NULL, NULL, NULL, 4001, 5001, 5002, 4),
  (5051, 1001, 'link', NULL, NULL, NULL, NULL, 5002, 5003, 3),
  (5052, 1001, 'link', NULL, NULL, NULL, NULL, 5002, 5004, 3),
  (5053, 1001, 'link', NULL, NULL, NULL, 4002, 5003, 5004, 3),
  (5054, 1001, 'link', NULL, NULL, NULL, NULL, 5003, 5005, 2),
  (5055, 1001, 'link', NULL, NULL, NULL, NULL, 5003, 5006, 2),
  (5056, 1001, 'link', NULL, NULL, NULL, NULL, 5004, 5007, 2),
  (5057, 1001, 'link', NULL, NULL, NULL, NULL, 5004, 5008, 2),
  (5058, 1001, 'link', NULL, NULL, NULL, NULL, 5004, 5009, 2),
  (5059, 1001, 'link', NULL, NULL, NULL, 4003, 5003, 5010, 3),
  (5060, 1001, 'link', NULL, NULL, NULL, 4004, 5004, 5011, 3),
  (5061, 1001, 'link', NULL, NULL, NULL, NULL, 5002, 5012, 2),
  (5062, 1001, 'link', NULL, NULL, NULL, NULL, 5005, 5013, 1),
  -- Enlace colgado: apunta a un elemento que no está en este mapa. El visor lo
  -- tiene que descartar sin romper el encuadre.
  (5063, 1001, 'link', NULL, NULL, NULL, NULL, 5003, 5999, 2),

  (5150, 1002, 'link', NULL, NULL, NULL, NULL, 5101, 5104, 3),
  (5151, 1002, 'link', NULL, NULL, NULL, NULL, 5104, 5102, 2),
  (5152, 1002, 'link', NULL, NULL, NULL, NULL, 5104, 5103, 2),
  (5153, 1002, 'link', NULL, NULL, NULL, 4006, 5102, 5105, 1),
  (5154, 1002, 'link', NULL, NULL, NULL, NULL, 5102, 5106, 1),
  (5155, 1002, 'link', NULL, NULL, NULL, NULL, 5103, 5107, 1),
  (5156, 1002, 'link', NULL, NULL, NULL, NULL, 5103, 5108, 1),
  (5157, 1002, 'link', NULL, NULL, NULL, NULL, 5103, 5109, 1),
  (5158, 1002, 'link', NULL, NULL, NULL, 4005, 5101, 5110, 3),
  (5159, 1002, 'link', NULL, NULL, NULL, NULL, 5110, 5111, 2),
  (5160, 1002, 'link', NULL, NULL, NULL, NULL, 5111, 5112, 1),
  (5161, 1002, 'link', NULL, NULL, NULL, NULL, 5111, 5113, 1),

  (5250, 1003, 'link', NULL, NULL, NULL, NULL, 5201, 5202, 3),
  (5251, 1003, 'link', NULL, NULL, NULL, NULL, 5202, 5203, 2),
  (5252, 1003, 'link', NULL, NULL, NULL, NULL, 5202, 5204, 2),
  (5253, 1003, 'link', NULL, NULL, NULL, 4007, 5203, 5205, 1),
  (5254, 1003, 'link', NULL, NULL, NULL, NULL, 5203, 5206, 1),
  (5255, 1003, 'link', NULL, NULL, NULL, NULL, 5204, 5207, 1),
  (5256, 1003, 'link', NULL, NULL, NULL, NULL, 5204, 5208, 1),
  (5257, 1003, 'link', NULL, NULL, NULL, NULL, 5202, 5209, 1);

-- ── Caídas ──────────────────────────────────────────────────────────────────
-- Abiertas para todo lo que está caído ahora, más historia cerrada.

INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)
SELECT 3000 + d.id, d.id, now() - interval '3 hours', NULL, NULL
FROM devices d WHERE d.status = 3;

INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)
SELECT 3500 + d.id, d.id, now() - interval '40 minutes', NULL, NULL
FROM devices d WHERE d.status = 2 AND d.router_os;

-- Historia: cinco caídas cerradas por equipo, espaciadas y de duración variable.
INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)
SELECT 3000 + d.id,
       d.id,
       now() - (n * interval '17 hours') - interval '2 days',
       now() - (n * interval '17 hours') - interval '2 days' + (n * 11 + 4) * interval '1 minute',
       (n * 11 + 4) * 60
FROM devices d
CROSS JOIN generate_series(1, 5) AS n
WHERE d.id % 3 = 0;

-- ── Mediciones ──────────────────────────────────────────────────────────────
-- Sólo lo suficiente para que las tablas no estén vacías; el panel todavía no
-- grafica, pero el esquema lo contempla y el ETL las llena.

INSERT INTO chart_sources (id, name, device_id, service_id, link_id, unit, enabled)
SELECT 3000 + d.id, d.name || ' · ping', d.id, 3000 + d.id, NULL, 'ms', true
FROM devices d
WHERE d.status = 1 AND d.id % 5 = 0;

INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT cs.id, '10min', now() - (n * interval '10 minutes'),
       round((12 + 8 * sin(n / 3.0) + (cs.id % 7))::numeric, 2)
FROM chart_sources cs
CROSS JOIN generate_series(0, 47) AS n;

-- ── Sincronización ──────────────────────────────────────────────────────────
-- La última es reciente y correcta, así que el panel arranca "al día". Para
-- probar el aviso de datos viejos, moverla hacia atrás:
--   UPDATE sync_runs SET finished_at = now() - interval '2 hours'
--   WHERE id = (SELECT max(id) FROM sync_runs);

-- 🔴 `snapshot_reused = true` significa que el ETL corrió BIEN y no reescribió
--    nada porque `dude.db` no había cambiado. Es éxito, no falta de datos.
INSERT INTO sync_runs (started_at, finished_at, ok, error, source_mtime, source_size,
                       user_version, objs_total, devices, services, links, maps,
                       map_elements, duration_ms, snapshot_hash, snapshot_reused,
                       outages_upserted, chart_values_inserted)
SELECT now() - (n * interval '30 seconds') - interval '4 seconds',
       now() - (n * interval '30 seconds'),
       true, NULL, now() - (n * interval '30 seconds') - interval '10 seconds',
       35651584, 1, 14916,
       (SELECT count(*) FROM devices), (SELECT count(*) FROM services),
       (SELECT count(*) FROM links),   (SELECT count(*) FROM maps),
       (SELECT count(*) FROM map_elements),
       3800 + (n * 37) % 900,
       md5('instantanea-' || n), (n % 3 = 1),
       CASE WHEN n % 3 = 1 THEN 0 ELSE 4 END,
       CASE WHEN n % 3 = 1 THEN 0 ELSE 336 END
FROM generate_series(0, 9) AS n;

-- ── Agregados ───────────────────────────────────────────────────────────────
-- Los materializa el ETL. El panel los recalcula en vivo para no depender de
-- ellos, pero se llenan igual: `v_map_canvas` los usa para el estado de un
-- submapa y el seed tiene que ser coherente con el esquema.

UPDATE devices d SET
  services_total = c.total,
  services_up    = c.arriba,
  services_down  = c.caidos
FROM (
  SELECT device_id,
         count(*)::int                            AS total,
         count(*) FILTER (WHERE status = 1)::int   AS arriba,
         count(*) FILTER (WHERE status = 3)::int   AS caidos
  FROM services GROUP BY device_id
) c
WHERE c.device_id = d.id;

UPDATE maps m SET
  devices_total  = c.equipos,
  devices_up     = c.arriba,
  devices_down   = c.caidos,
  elements_total = c.elementos
FROM (
  SELECT e.map_id,
         count(*)::int                                          AS elementos,
         count(*) FILTER (WHERE e.device_id IS NOT NULL)::int    AS equipos,
         count(*) FILTER (WHERE d.status = 1)::int               AS arriba,
         count(*) FILTER (WHERE d.status = 3)::int               AS caidos
  FROM map_elements e
  LEFT JOIN devices d ON d.id = e.device_id
  GROUP BY e.map_id
) c
WHERE c.map_id = m.id;

COMMIT;

-- Resumen de lo cargado, para verificar de un vistazo.
SELECT
  (SELECT count(*) FROM devices)      AS equipos,
  (SELECT count(*) FROM services)     AS servicios,
  (SELECT count(*) FROM maps)         AS mapas,
  (SELECT count(*) FROM map_elements) AS elementos,
  (SELECT count(*) FROM links)        AS enlaces,
  (SELECT count(*) FROM outages)      AS caidas,
  (SELECT count(*) FROM sync_runs)    AS sincronizaciones;
