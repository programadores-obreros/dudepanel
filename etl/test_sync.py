"""Pruebas del ETL contra `muestra.db`, una copia real de la base de el ISP.

No hay fixtures inventados. Cada número que se afirma acá salió de medir la
base de producción, y por eso las pruebas sirven de dos maneras: verifican el
código y **detectan si el origen cambió de forma**. Si mañana una de estas
falla, la pregunta correcta no es "¿qué rompí?" sino "¿qué pasó en la base?".

    pytest -q etl/

La prueba de extremo a extremo necesita un PostgreSQL:

    docker run --rm -d -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgresql://postgres:x@localhost:55432/postgres pytest -q
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

import dudeobj
import sync

MUESTRA = str(Path(__file__).with_name("muestra.db"))

# Los números de la base real al 31/07/2026.
OBJETOS = 14_925
DISPOSITIVOS = 885
SERVICIOS = 859
ENLACES = 1_171
MAPAS = 40
MAPAS_CON_ELEMENTOS = 38
ELEMENTOS = 2_317


pytestmark = pytest.mark.skipif(
    not Path(MUESTRA).exists(), reason="falta etl/muestra.db"
)


@pytest.fixture(scope="session")
def objetos():
    return list(dudeobj.leer_objetos(MUESTRA))


@pytest.fixture(scope="session")
def snapshot():
    return sync.extraer(MUESTRA)


# ─────────────────────────────────────────────────────────────────────────────
# El origen es el que esperamos
# ─────────────────────────────────────────────────────────────────────────────

def test_cantidad_de_objetos(objetos):
    assert len(objetos) == OBJETOS


def test_user_version_es_1():
    """Vive en la cabecera del archivo, no en el esquema, y un `.dump` no la
    copia. Con 0, The Dude cree que la base está vacía y le escribe 152 objetos
    por defecto encima: medido, `objs` cayó de 14.916 a 454."""
    assert dudeobj.user_version(MUESTRA) == 1


def test_abrir_es_solo_lectura():
    con = dudeobj.abrir(MUESTRA)
    try:
        with pytest.raises(sqlite3.OperationalError):
            con.execute("CREATE TABLE cualquiera (x int)")
        with pytest.raises(sqlite3.OperationalError):
            con.execute("DELETE FROM objs WHERE id = -1")
    finally:
        con.close()


# ─────────────────────────────────────────────────────────────────────────────
# 🔴 La prueba que importa: ninguna credencial sale del decodificador
# ─────────────────────────────────────────────────────────────────────────────

#: Los que EXISTEN en la base de el ISP. Se exige que estén: si un día
#: desaparecen, la prueba de abajo dejaría de probar nada sin avisar.
CAMPOS_SECRETOS = (
    "pwd", "user", "community", "v3AuthPassword", "v3CryptPassword",
    "customField1",
)

#: Los que FORMATO-DUDE.md nombra pero esta base no tiene. Igual tienen que
#: quedar cubiertos por la expresión: otra instalación de The Dude puede
#: traerlos, y descubrirlo el día que aparezcan es tarde.
CAMPOS_SECRETOS_AUSENTES = ("password", "snmpCommunity")


def _secretos_reales(objetos) -> set[str]:
    """Los valores en claro que HAY en la base, leídos a propósito acá.

    Esta función es la única del proyecto que los toca, y sólo para poder
    afirmar que no aparecen en ningún lado. Nunca se imprimen: si una prueba
    falla, el mensaje dice cuántos y en qué tabla, no cuál era la clave.

    Se descarta el secreto que ya está escrito en el nombre que le puso el
    operador —el perfil SNMP `v1-public` tiene community `public`— porque ese
    no lo puede filtrar el ETL: viene en `sys-name`, que sí se copia y sí hace
    falta. Es el caso que `schema.sql` ya anticipa cuando dice que el panel
    necesita saber que un equipo usa v1-public sin saber la cadena.
    """
    fuera = set()
    for o in objetos:
        publico = " ".join(
            crudo.rstrip(b"\x00").decode("latin-1", "replace")
            for campo, crudo in o.campos.items()
            if not dudeobj.SECRETO.search(campo)
        )
        for campo, crudo in o.campos.items():
            if not dudeobj.SECRETO.search(campo):
                continue
            texto = crudo.rstrip(b"\x00").decode("latin-1", "replace").strip()
            if len(texto) >= 4 and texto not in publico:
                fuera.add(texto)
    return fuera


def test_hay_credenciales_en_el_origen(objetos):
    """Si esto falla, la prueba de abajo no prueba nada.

    No es una perogrullada: un test que verifica "no hay secretos" pasa igual
    de bien cuando no hay nada que filtrar. Primero hay que demostrar que el
    origen SÍ los tiene."""
    assert len(_secretos_reales(objetos)) >= 5


def test_el_decodificador_no_devuelve_campos_secretos(objetos):
    for o in objetos:
        for campo in o.campos:
            if dudeobj.SECRETO.search(campo):
                assert o.get(campo) is None, f"{campo} salió con valor"


def test_campos_secretos_conocidos_dan_none(objetos):
    vistos = set()
    for o in objetos:
        for campo in CAMPOS_SECRETOS:
            if campo in o.campos:
                vistos.add(campo)
                assert o.get(campo) is None
                assert dudeobj.valor(campo, o.campos[campo]) is None
    assert vistos == set(CAMPOS_SECRETOS), f"no se probaron: {set(CAMPOS_SECRETOS) - vistos}"


def test_la_expresion_cubre_los_campos_que_esta_base_no_tiene():
    for campo in CAMPOS_SECRETOS_AUSENTES:
        assert dudeobj.SECRETO.search(campo), campo
        assert dudeobj.valor(campo, b"loQueSea") is None


def test_ninguna_credencial_llega_al_snapshot(objetos, snapshot):
    """La prueba de verdad: se busca cada clave en claro dentro de TODO lo que
    el ETL está por escribir en PostgreSQL."""
    secretos = _secretos_reales(objetos)
    volcado = repr([
        getattr(snapshot, t) for t in sync.ORDEN_INSERCION
    ])
    filtrados = [s for s in secretos if s in volcado]
    assert not filtrados, f"{len(filtrados)} credenciales llegaron al snapshot"


def test_customfield_es_secreto():
    """🔴 En la base real hay contraseñas escritas a mano en `customField1`,
    con formato `usuario:clave`. El campo es texto libre: la única defensa es
    no leerlo."""
    assert dudeobj.SECRETO.search("customField1")
    assert dudeobj.valor("customField1", b"admin:unaClaveCualquiera") is None


def test_el_esquema_no_tiene_columnas_de_credenciales():
    sql = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
    # Se mira sólo lo que declara columnas; los comentarios hablan del tema a
    # propósito y no deberían hacer fallar la prueba.
    columnas = [
        l.strip().lower() for l in sql.splitlines()
        if l.strip() and not l.strip().startswith("--")
    ]
    for prohibido in ("password", "passwd", "community", " pwd", "secret"):
        assert not [c for c in columnas if c.startswith(prohibido.strip())], prohibido


# ─────────────────────────────────────────────────────────────────────────────
# Decodificación
# ─────────────────────────────────────────────────────────────────────────────

def test_ip_en_big_endian():
    # C0 00 02 0B → 192.0.2.11. Se usa un rango de documentación (RFC 5737) a
    # propósito: un test es un archivo público, y una dirección real de la red
    # de un cliente no tiene por qué vivir en uno.
    assert dudeobj.direcciones(bytes.fromhex("C000020B")) == ["192.0.2.11"]


def test_lista_de_ips():
    v = bytes.fromhex("C000020B") + bytes.fromhex("C6336401")
    assert dudeobj.direcciones(v) == ["192.0.2.11", "198.51.100.1"]


def test_ffffffff_es_null_y_no_un_numero():
    assert dudeobj.entero("loQueSea", b"\xff\xff\xff\xff") is None
    assert dudeobj.entero("loQueSea", b"\xff\xff\xff\xff") != 4294967295
    assert dudeobj.valor("typeID", b"\xff\xff\xff\xff") is None
    assert dudeobj.color(b"\xff\xff\xff\xff") is None


@pytest.mark.parametrize("crudo,esperado", [
    (b"\x50\x00\x00\x00", 80),        # http
    (b"\x16\x00\x00\x00", 22),        # ssh
    (b"\xa1\x00\x00\x00", 161),       # snmp
    (b"\x91\x1f\x00\x00", 8081),      # webServerPort
    (b"\x51\x02\x00\x00", 593),       # el ejemplo de FORMATO-DUDE.md
])
def test_todo_entero_es_little_endian(crudo, esperado):
    """🔴 FORMATO-DUDE.md dice que los puertos son big-endian. No lo son.
    Leídos así, el 80 se convierte en 1.342.177.280."""
    assert dudeobj.entero("defaultPort", crudo) == esperado
    assert dudeobj.entero("port", crudo) == esperado


def test_puertos_reales_de_la_base(objetos):
    puertos = {
        o.nombre: o.num("defaultPort")
        for o in objetos if o.sys_type == 0x0D
    }
    assert puertos["http"] == 80
    assert puertos["ssh"] == 22
    assert puertos["ftp"] == 21
    assert puertos["telnet"] == 23


def test_colores_en_orden_rgb():
    """El rojo tiene que salir rojo. Leído como u32 little-endian sale azul."""
    assert dudeobj.color(bytes.fromhex("FF060600")) == 0xFF0606   # caído: rojo
    assert dudeobj.color(bytes.fromhex("FF800000")) == 0xFF8000   # parcial: naranja
    assert dudeobj.color(bytes.fromhex("1BD01100")) == 0x1BD011   # arriba: verde
    # Los dos verdes se parecen y no distinguen nada; el rojo sí. Leído como
    # u32 little-endian, `ff 06 06 00` daría 0x0606FF, que es azul.
    assert dudeobj.color(bytes.fromhex("FF060600")) != 0x0606FF


def test_cadenas_con_prefijo_de_largo():
    v = b"\x03\x00\x00\x00abc\x02\x00\x00\x00de"
    assert dudeobj.cadenas(v) == ["abc", "de"]
    # Si no cierra exacto, no adivina.
    assert dudeobj.cadenas(b"\x09\x00\x00\x00abc") == []


def test_dnsnames_de_la_base(objetos):
    con_dns = [o for o in objetos if o.sys_type == 0x0F and o.campos.get("dnsNames")]
    assert len(con_dns) == 96
    for o in con_dns:
        for nombre in o.cadenas("dnsNames"):
            assert nombre and "\x00" not in nombre and nombre.isprintable()


def test_macs():
    assert dudeobj.macs(bytes.fromhex("D4CA6D4EE836")) == ["d4:ca:6d:4e:e8:36"]


def test_registro_truncado_no_explota():
    """Un objeto ilegible es un dato menos, no una sincronización caída."""
    assert dudeobj.registros(b"\x04name\x00\x10corto") == []


# ─────────────────────────────────────────────────────────────────────────────
# Mapas: el JOIN que no es obvio
# ─────────────────────────────────────────────────────────────────────────────

def test_join_mapa_elementos(objetos):
    """El `sys-type` de un elemento ES el `elementsID` de su mapa."""
    mapas = [o for o in objetos if o.sys_type == 0x0A]
    assert len(mapas) == MAPAS

    de_mapa = {m.num("elementsID"): m.id for m in mapas}
    assert len(de_mapa) == MAPAS, "dos mapas comparten elementsID"

    elementos = [o for o in objetos if o.sys_type in de_mapa]
    assert len(elementos) == ELEMENTOS
    assert len({de_mapa[o.sys_type] for o in elementos}) == MAPAS_CON_ELEMENTOS

    huerfanos = [o for o in elementos if de_mapa[o.sys_type] is None]
    assert huerfanos == []


def test_elements_id_apunta_a_una_lista(objetos):
    por_id = {o.id: o for o in objetos}
    for m in (o for o in objetos if o.sys_type == 0x0A):
        lista = por_id.get(m.num("elementsID"))
        assert lista is not None and lista.clase == "list"
        assert lista.nombre == m.nombre


def test_clases_de_elemento(objetos, snapshot):
    """🔴 Son DOS campos, no uno. `type` = 1 es enlace; con `type` = 0 manda
    `itemType`. FORMATO-DUDE.md documenta sólo `itemType` y por eso suma los
    1.170 enlaces adentro de los dispositivos."""
    conteo = {}
    for fila in snapshot.map_elements:
        conteo[fila[2]] = conteo.get(fila[2], 0) + 1
    assert conteo == {
        "device": 884, "network": 2, "submap": 161, "static": 100, "link": 1170,
    }
    assert sum(conteo.values()) == ELEMENTOS


def test_cada_clase_apunta_a_donde_debe(objetos, snapshot):
    por_id = {o.id: o for o in objetos}
    for (_id, _map, clase, *_r, did, smid, lid, _lf, _lt, _lw) in snapshot.map_elements:
        if clase == "device":
            assert por_id[did].sys_type == 0x0F
        elif clase == "submap":
            assert por_id[smid].sys_type == 0x0A
        elif clase == "link":
            assert por_id[lid].sys_type == 0x1F
        elif clase == "static":
            assert (did, smid, lid) == (None, None, None)


def test_link_from_to_resueltos(snapshot):
    """Apuntan a OTROS elementos de mapa. 58 de los 1.170 apuntan a elementos
    borrados: se dejan en NULL en vez de rechazar el enlace."""
    ids = {f[0] for f in snapshot.map_elements}
    enlaces = [f for f in snapshot.map_elements if f[2] == "link"]
    resueltos = [f for f in enlaces if f[11] is not None]
    assert len(resueltos) == 1112
    for f in enlaces:
        assert f[11] is None or f[11] in ids
        assert f[12] is None or f[12] in ids


# ─────────────────────────────────────────────────────────────────────────────
# Transformación
# ─────────────────────────────────────────────────────────────────────────────

def test_conteos_del_snapshot(snapshot):
    assert snapshot.objs_total == OBJETOS
    assert len(snapshot.devices) == DISPOSITIVOS
    assert len(snapshot.services) == SERVICIOS
    assert len(snapshot.links) == ENLACES
    assert len(snapshot.maps) == MAPAS
    assert len(snapshot.map_elements) == ELEMENTOS


def test_distribucion_de_estados(snapshot):
    conteo = {}
    for fila in snapshot.services:
        conteo[fila[3]] = conteo.get(fila[3], 0) + 1
    assert conteo == {1: 363, 3: 267, 0: 214, 2: 15}


def test_estado_agregado_de_un_dispositivo():
    assert sync._agregar_estado([]) == (None, 0, 0, 0)
    assert sync._agregar_estado([(1, True), (1, True)]) == (1, 2, 2, 0)
    assert sync._agregar_estado([(3, True), (3, True)]) == (3, 2, 0, 2)
    assert sync._agregar_estado([(1, True), (3, True)]) == (2, 2, 1, 1)
    assert sync._agregar_estado([(0, True)]) == (0, 1, 0, 0)
    # Un servicio deshabilitado no pinta nada de rojo.
    assert sync._agregar_estado([(3, False)]) == (None, 0, 0, 0)
    assert sync._agregar_estado([(1, True), (3, False)]) == (1, 1, 1, 0)


def test_claves_foraneas_sin_colgados(snapshot):
    """The Dude no borra en cascada. Todo id que sobrevive tiene que existir."""
    archivos = {f[0] for f in snapshot.files}
    tipos = {f[0] for f in snapshot.device_types}
    perfiles = {f[0] for f in snapshot.snmp_profiles}
    dispositivos = {f[0] for f in snapshot.devices}
    sondas = {f[0] for f in snapshot.probes}

    for d in snapshot.devices:
        assert d[5] is None or d[5] in tipos
        assert d[6] is None or d[6] in perfiles
    for s in snapshot.services:
        assert s[1] is None or s[1] in dispositivos
        assert s[2] is None or s[2] in sondas
    for e in snapshot.map_elements:
        assert e[6] is None or e[6] in archivos
    for t in snapshot.device_types:
        assert t[3] is None or t[3] in archivos


def test_perfil_snmp_colgado_queda_en_null(snapshot):
    """61 dispositivos apuntan al perfil 306705, que no existe en la base."""
    assert all(d[6] is None for d in snapshot.devices)


def test_topologia_vacia_en_esta_base(snapshot):
    """🔴 `parentIDs` viene en 0 bytes en los 885 dispositivos: en el ISP la
    topología no se cargó nunca. La transformación está escrita y probada; lo
    que no hay es dato. Si esto empieza a fallar, ALGUIEN cargó padres — y es
    una buena noticia, no un bug."""
    assert snapshot.device_parents == []


def test_archivos_sin_contenido_pero_con_ruta(snapshot):
    assert len(snapshot.files) == 335
    rutas = {f[1]: f[3] for f in snapshot.files}
    assert rutas["ap.svg"] == "images/ap.svg"
    assert rutas["images"] is None      # es un directorio
    assert rutas["arial.ttf"] == "arial.ttf"


def test_interfaz_maestra_es_un_indice(snapshot):
    assert all(l[4] is None or isinstance(l[4], int) for l in snapshot.links)


def test_fuentes_de_grafico(snapshot):
    """Las 1.083 fuentes de chart_values son los 1.083 running_probe."""
    assert len(snapshot.chart_sources) == 1_083
    con_equipo = [f for f in snapshot.chart_sources if f[2] is not None]
    assert len(con_equipo) >= 1_000


def test_la_huella_es_estable():
    a = sync.extraer(MUESTRA).huella()
    b = sync.extraer(MUESTRA).huella()
    assert a == b and len(a) == 32


# ─────────────────────────────────────────────────────────────────────────────
# Historia: el empaquetado de las claves
# ─────────────────────────────────────────────────────────────────────────────

def test_outages_clave_empaquetada():
    """`timeAndServiceID = (time << 32) | serviceID`, verificado contra las
    columnas sueltas que la propia tabla trae al lado."""
    con = dudeobj.abrir(MUESTRA)
    try:
        filas = con.execute(
            "SELECT timeAndServiceID, serviceID, time FROM outages"
        ).fetchall()
    finally:
        con.close()
    assert len(filas) == 11_988
    for clave, sid, t in filas:
        sin_signo = clave & 0xFFFFFFFFFFFFFFFF
        assert sin_signo >> 32 == t
        assert sin_signo & 0xFFFFFFFF == sid


def test_chart_values_clave_empaquetada(objetos):
    """`sourceIDandTime = (sourceID << 32) | epoch`. No se dedujo: los 32 bits
    altos dan exactamente los 1.083 running_probe, y los bajos caen clavados en
    la grilla de cada bucket."""
    sondas = {o.id for o in objetos if o.sys_type == 0x29}
    assert len(sondas) == 1_083

    grilla = {"1day": 86_400, "2hour": 7_200, "10min": 600}
    con = dudeobj.abrir(MUESTRA)
    try:
        for bucket, paso in grilla.items():
            filas = con.execute(
                f"SELECT sourceIDandTime FROM {sync.BUCKETS[bucket]}"
            ).fetchall()
            fuentes = set()
            for (clave,) in filas:
                sin_signo = clave & 0xFFFFFFFFFFFFFFFF
                fuentes.add(sin_signo >> 32)
                epoch = sin_signo & 0xFFFFFFFF
                assert epoch % paso == 0, f"{bucket}: {epoch} fuera de grilla"
                assert 1_700_000_000 < epoch < 2_000_000_000
            assert fuentes <= sondas, f"{bucket}: fuentes que no son running_probe"
    finally:
        con.close()


def test_con_signo_ida_y_vuelta():
    """Los ids de fuente pasan de 2^31: la clave desborda a negativo y SQLite
    la compara así. Sin esta conversión, el rango no devuelve ninguna fila."""
    src = 2_159_869_422
    clave = (src << 32) | 1_785_455_469
    con_signo = sync._con_signo(clave)
    assert con_signo < 0
    assert con_signo & 0xFFFFFFFF == 1_785_455_469
    assert (con_signo & 0xFFFFFFFFFFFFFFFF) >> 32 == src


# ─────────────────────────────────────────────────────────────────────────────
# De extremo a extremo, contra un PostgreSQL de verdad
# ─────────────────────────────────────────────────────────────────────────────

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

sin_postgres = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="definí TEST_DATABASE_URL para correr la prueba de extremo a extremo",
)


@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    con = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    # Base limpia: estas pruebas afirman conteos absolutos.
    con.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    sync.aplicar_esquema(con, str(Path(__file__).with_name("schema.sql")))
    yield con
    con.close()


@sin_postgres
def test_corrida_completa(pg):
    sync.corrida(pg, MUESTRA)

    ok, error, *conteos = pg.execute(
        "SELECT ok, error, devices, services, links, maps, map_elements, objs_total"
        "  FROM sync_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert ok, error
    assert conteos == [DISPOSITIVOS, SERVICIOS, ENLACES, MAPAS, ELEMENTOS, OBJETOS]

    reales = {
        t: pg.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        for t in ("devices", "services", "links", "maps", "map_elements",
                  "files", "device_types", "probes", "chart_sources")
    }
    assert reales["devices"] == DISPOSITIVOS
    assert reales["services"] == SERVICIOS
    assert reales["links"] == ENLACES
    assert reales["maps"] == MAPAS
    assert reales["map_elements"] == ELEMENTOS
    assert reales["files"] == 335
    assert reales["chart_sources"] == 1_083


@sin_postgres
def test_join_del_mapa_en_postgres(pg):
    con_elementos = pg.execute(
        "SELECT count(DISTINCT map_id) FROM map_elements"
    ).fetchone()[0]
    assert con_elementos == MAPAS_CON_ELEMENTOS
    huerfanos = pg.execute(
        "SELECT count(*) FROM map_elements e"
        " LEFT JOIN maps m ON m.id = e.map_id WHERE m.id IS NULL"
    ).fetchone()[0]
    assert huerfanos == 0


@sin_postgres
def test_ips_en_postgres(pg):
    n = pg.execute(
        "SELECT count(*) FROM devices WHERE addresses <> '{}'"
    ).fetchone()[0]
    assert n == DISPOSITIVOS
    # inet de verdad: si el ETL hubiera escrito basura, el tipo no la aceptaba.
    n = pg.execute(
        "SELECT count(*) FROM devices WHERE addresses[1] << '10.0.0.0/8'::inet"
    ).fetchone()[0]
    assert n > 0


@sin_postgres
def test_historia_incremental(pg):
    antes = pg.execute("SELECT count(*) FROM chart_values").fetchone()[0]
    caidas = pg.execute("SELECT count(*) FROM outages").fetchone()[0]
    assert antes > 0 and caidas == 11_988

    # Segunda corrida sobre una base que no cambió: nada nuevo, y el snapshot
    # se reusa en vez de reescribirse.
    sync.corrida(pg, MUESTRA)
    reusado, nuevas = pg.execute(
        "SELECT snapshot_reused, chart_values_inserted FROM sync_runs"
        " ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert reusado is True
    assert pg.execute("SELECT count(*) FROM devices").fetchone()[0] == DISPOSITIVOS
    assert pg.execute("SELECT count(*) FROM outages").fetchone()[0] == 11_988


@sin_postgres
def test_ninguna_credencial_en_postgres(pg, objetos):
    """El último control, sobre lo que realmente quedó escrito: se vuelca cada
    tabla a texto y se busca cada clave en claro del origen."""
    secretos = _secretos_reales(objetos)
    tablas = [t for t in sync.ORDEN_INSERCION]
    for tabla in tablas:
        volcado = pg.execute(
            f"SELECT string_agg(t::text, '|') FROM {tabla} t"
        ).fetchone()[0] or ""
        filtrados = [s for s in secretos if s in volcado]
        assert not filtrados, f"{len(filtrados)} credenciales en {tabla}"


@sin_postgres
def test_falla_registrada_en_sync_runs(pg, tmp_path):
    """Un fallo tiene que dejar rastro. Un ETL que se cae sin registrarlo deja
    al panel mostrando datos viejos sin ninguna manera de notarlo."""
    roto = tmp_path / "roto.db"
    roto.write_bytes(b"esto no es una base SQLite")
    sync.corrida(pg, str(roto))
    ok, error = pg.execute(
        "SELECT ok, error FROM sync_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert ok is False
    assert error
    # Y el snapshot bueno sigue en pie.
    assert pg.execute("SELECT count(*) FROM devices").fetchone()[0] == DISPOSITIVOS
