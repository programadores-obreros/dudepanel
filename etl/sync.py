"""Sincronizador: The Dude (SQLite, sólo lectura) → PostgreSQL.

    dude.db  ──ro──►  transformar  ──transacción única──►  postgres

Corre en ciclo. Cada vuelta es todo o nada: o queda el snapshot nuevo entero, o
queda intacto el anterior. **Nunca un estado mezclado.** Un panel que muestra
mitad de la red de hace un minuto y mitad de hace una hora miente sin avisar, y
eso es peor que un panel apagado.

Las tres reglas que no se negocian:

  1. 🔴 SÓLO LECTURA sobre SQLite. Del otro lado está el monitoreo de un ISP.
  2. 🔴 CERO CREDENCIALES en PostgreSQL. No se enmascaran: no se leen.
     `dudeobj.SECRETO` las filtra en el decodificador, antes de que existan
     como valor en memoria. `test_sync.py` lo verifica.
  3. Fallar cerrado. Ante cualquier duda sobre la calidad del origen, se aborta
     la corrida y se deja el snapshot anterior, que es viejo pero verdadero.

El contrato del formato está en `docs/FORMATO-DUDE.md`; el del destino, en
`schema.sql`. Donde este archivo se aparta de FORMATO-DUDE.md es porque se
midió lo contrario: los desvíos están anotados en `dudeobj.py`.
"""
from __future__ import annotations

import hashlib
import logging
import os
import signal
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import psycopg

import dudeobj

log = logging.getLogger("sync")

# ─────────────────────────────────────────────────────────────────────────────
# Configuración
# ─────────────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get("DATABASE_URL", "")
DUDE_DB = os.environ.get("DUDE_DB", "/origen/dude.db")
DUDE_FILES = os.environ.get("DUDE_FILES", "")

#: Dónde se deja la copia de trabajo de cada corrida. Tiene que ser un
#: directorio ESCRIBIBLE por el usuario del contenedor y con lugar para el
#: tamaño de `dude.db` más su journal (hoy 43 + 6 MB; el techo es 2 GiB).
#:
#: 🔴 No usar `/tmp`: es un tmpfs de 64 MB, o sea RAM, y la base lo pasa el mes
#:    que viene. Va un volumen de Docker — ver `compose.prod.yml`.
SNAPSHOT = os.environ.get("DUDE_SNAPSHOT", "/trabajo/dude.db")
SYNC_INTERVAL = float(os.environ.get("SYNC_INTERVAL", "30"))
SCHEMA_FILE = os.environ.get("SCHEMA_FILE", str(Path(__file__).with_name("schema.sql")))

#: Cuánto retrocede el ETL al replicar caídas. Una caída en curso sigue
#: creciendo su `duration` después de haberla leído, así que releer las últimas
#: 24 h y hacer UPSERT es la forma barata de no dejarla congelada.
OUTAGES_RETROCESO_S = int(os.environ.get("OUTAGES_RETROCESO_S", 24 * 3600))

#: Tope de filas de historia por corrida. La primera vez hay ~1,58 millones de
#: mediciones esperando: traerlas de un saque sería una transacción larguísima
#: contra la base de producción. Con tope, el ETL se pone al día en varias
#: vueltas y el panel queda usable desde la primera.
CHART_MAX_FILAS = int(os.environ.get("CHART_MAX_FILAS", "250000"))

#: Guarda anti-desastre. Si el origen devuelve de golpe menos de esta fracción
#: de los dispositivos de la última corrida buena, se aborta. Es la diferencia
#: entre "la red se cayó entera" y "leí la base a mitad de escritura": lo
#: primero no borra 800 equipos del inventario, lo segundo sí. 0 lo desactiva.
GUARDA_CAIDA = float(os.environ.get("GUARDA_CAIDA", "0.5"))

BUCKETS = {
    "raw": "chart_values_raw",
    "10min": "chart_values_10min",
    "2hour": "chart_values_2hour",
    "1day": "chart_values_1day",
}

#: typeID de una notificación → etiqueta. Sólo los valores efectivamente vistos
#: en la base del ISP. Los que no estén acá salen en NULL: una etiqueta
#: inventada es peor que un hueco, porque el hueco se nota.
NOTIFICACION = {1: "email", 3: "popup", 4: "flash", 5: "beep", 10: "log"}

#: Tipos de archivo (`type` de un objeto 0x05). El 11 es un directorio y no
#: tiene contenido que servir.
ARCHIVO_DIRECTORIO = 11


class Aborta(RuntimeError):
    """El origen no está en condiciones de ser replicado. No se escribe nada."""


# ─────────────────────────────────────────────────────────────────────────────
# El snapshot: todo lo que se vuelca de una vez
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(slots=True)
class Snapshot:
    """Las tablas del núcleo, ya transformadas y listas para insertar.

    Se arma entero en memoria ANTES de tocar PostgreSQL. Son ~6.000 filas: cabe
    de sobra, y a cambio la transacción de escritura dura milisegundos en vez
    de todo lo que tarde en leerse la base de The Dude.
    """

    objs_total: int = 0
    user_version: int = 0
    files: list[tuple] = field(default_factory=list)
    device_types: list[tuple] = field(default_factory=list)
    probes: list[tuple] = field(default_factory=list)
    link_types: list[tuple] = field(default_factory=list)
    snmp_profiles: list[tuple] = field(default_factory=list)
    notifications: list[tuple] = field(default_factory=list)
    devices: list[tuple] = field(default_factory=list)
    device_parents: list[tuple] = field(default_factory=list)
    services: list[tuple] = field(default_factory=list)
    links: list[tuple] = field(default_factory=list)
    maps: list[tuple] = field(default_factory=list)
    map_elements: list[tuple] = field(default_factory=list)
    chart_sources: list[tuple] = field(default_factory=list)

    def huella(self) -> str:
        """Hash del contenido. Si no cambió, no hace falta reescribir nada.

        The Dude confirma a disco cada 10 s (`dbCommitInterval`), así que el
        mtime del archivo se mueve siempre — pero el inventario de la red no.
        Comparar contenido en vez de mtime evita ~12.000 tuplas muertas por
        minuto en tablas que nadie modificó.
        """
        h = hashlib.blake2b(digest_size=16)
        for nombre in (
            "files", "device_types", "probes", "link_types", "snmp_profiles",
            "notifications", "devices", "device_parents", "services", "links",
            "maps", "map_elements", "chart_sources",
        ):
            h.update(nombre.encode())
            for fila in getattr(self, nombre):
                h.update(repr(fila).encode("utf-8", "replace"))
        return h.hexdigest()


# ─────────────────────────────────────────────────────────────────────────────
# Extracción y transformación
# ─────────────────────────────────────────────────────────────────────────────

def _estado(status: int | None) -> tuple[int | None, str | None]:
    if status is None:
        return None, None
    return status, dudeobj.ESTADO.get(status)


def _ruta_relativa(nombre_completo: str | None) -> str | None:
    """`images\\ap.svg` → `images/ap.svg`, relativo a `data/files/`."""
    if not nombre_completo:
        return None
    return nombre_completo.replace("\\", "/").lstrip("/")


def extraer(ruta: str) -> Snapshot:
    """Lee la base de The Dude y devuelve el snapshot ya transformado.

    Lanza `Aborta` si el origen no pasa los controles mínimos. Nada de lo que
    devuelve esta función contiene credenciales: `dudeobj.valor()` no las lee.
    """
    uv = dudeobj.user_version(ruta)
    if uv != 1:
        # No es una advertencia: con user_version en 0 The Dude cree que la base
        # está vacía. Si estamos leyendo eso, estamos leyendo una base rota o a
        # medio reconstruir, y replicarla borraría el panel entero.
        raise Aborta(f"user_version del origen es {uv}, tiene que ser 1")

    objs = list(dudeobj.leer_objetos(ruta))
    if not objs:
        raise Aborta("el origen devolvió 0 objetos")

    por_id = {o.id: o for o in objs}
    de = lambda t: [o for o in objs if o.sys_type == t]  # noqa: E731

    s = Snapshot(objs_total=len(objs), user_version=uv)

    # ── Catálogos ────────────────────────────────────────────────────────────
    archivos = de(0x05)
    ids_archivo = {o.id for o in archivos}
    for o in archivos:
        s.files.append((
            o.id,
            o.nombre or o.txt("fileName") or str(o.id),
            o.txt("fileName"),
            None if o.num("type") == ARCHIVO_DIRECTORIO
            else _ruta_relativa(o.txt("fullName")),
        ))

    ids_tipo_dispositivo = {o.id for o in de(0x0E)}
    for o in de(0x0E):
        s.device_types.append((
            o.id, o.nombre or str(o.id), o.txt("url"),
            _fk(o.num("imageID"), ids_archivo), o.num("imageScale"),
        ))

    ids_sonda = {o.id for o in de(0x0D)}
    for o in de(0x0D):
        s.probes.append((
            o.id, o.nombre or str(o.id), o.num("defaultPort"), o.txt("dnsName"),
            o.txt("functionAvailable"), o.txt("functionError"),
            o.txt("functionValue"), o.txt("functionUnit"),
        ))

    ids_tipo_enlace = {o.id for o in de(0x22)}
    for o in de(0x22):
        s.link_types.append((
            o.id, o.nombre or str(o.id), o.num("snmpType"), o.num("style"),
            o.num("thickness"), o.num("snmpSpeed"),
        ))

    ids_perfil = {o.id for o in de(0x3A)}
    for o in de(0x3A):
        # 🔴 `community`, `v3AuthPassword` y `v3CryptPassword` NO se tocan.
        s.snmp_profiles.append((
            o.id, o.nombre or str(o.id), o.num("version"), o.num("port"),
            o.num("tryCount"), o.num("tryTimeout"),
        ))

    for o in de(0x18):
        tipo = o.num("typeID")
        s.notifications.append((
            o.id, o.nombre or str(o.id), tipo, NOTIFICACION.get(tipo),
            o.bool_("enabled"), o.txt("mailSubject"),
        ))

    # ── Servicios primero: los dispositivos necesitan su agregado ────────────
    dispositivos = de(0x0F)
    ids_dispositivo = {o.id for o in dispositivos}

    servicios = de(0x11)
    por_dispositivo: dict[int, list] = {}
    for o in servicios:
        did = _fk(o.num("deviceID"), ids_dispositivo)
        estado, etiqueta = _estado(o.num("status"))
        habilitado = o.bool_("enabled")
        s.services.append((
            o.id, did, _fk(o.num("probeID"), ids_sonda), estado, etiqueta,
            habilitado, o.bool_("acked"), o.num("probesDown"),
            o.num("probeInterval"), o.num("probeTimeout"), o.num("probePort"),
            o.num("timeLastUp"), o.num("timeLastDown"),
            o.num("timeSinceChanged"),
        ))
        if did is not None:
            por_dispositivo.setdefault(did, []).append((estado, habilitado))

    # ── Dispositivos ─────────────────────────────────────────────────────────
    estado_dispositivo: dict[int, int | None] = {}
    for o in dispositivos:
        estado, total, arriba, abajo = _agregar_estado(por_dispositivo.get(o.id, []))
        estado_dispositivo[o.id] = estado
        nombres = o.cadenas("dnsNames")
        s.devices.append((
            o.id, o.nombre or str(o.id), o.ips("addresses"),
            ", ".join(nombres) or None, o.macs(),
            _fk(o.num("typeID"), ids_tipo_dispositivo),
            _fk(o.num("snmpProfileID"), ids_perfil),
            o.bool_("routerOS"), o.bool_("probeEnabled"), o.num("probeInterval"),
            o.num("probeTimeout"), o.num("probeDownCount"), o.bool_("dudeServer"),
            estado, dudeobj.ESTADO.get(estado) if estado is not None else None,
            total, arriba, abajo,
        ))
        for padre in o.lista_ids("parentIDs"):
            if padre in ids_dispositivo:
                s.device_parents.append((o.id, padre))

    if GUARDA_CAIDA and not s.devices:
        raise Aborta("el origen devolvió 0 dispositivos")

    # ── Enlaces ──────────────────────────────────────────────────────────────
    enlaces = de(0x1F)
    ids_enlace = {o.id for o in enlaces}
    for o in enlaces:
        s.links.append((
            o.id, o.nombre, _fk(o.num("typeID"), ids_tipo_enlace),
            _fk(o.num("masterDevice"), ids_dispositivo),
            o.num("masterInterface"), o.bool_("history"),
        ))

    # ── Mapas y elementos ────────────────────────────────────────────────────
    # 🔴 Acá está el JOIN que no es obvio: el `sys-type` de un elemento ES el
    #    `elementsID` de su mapa. En el origen no hay ninguna columna que diga
    #    "pertenezco al mapa X" — la pertenencia está codificada en el tipo.
    mapas = de(0x0A)
    ids_mapa = {o.id for o in mapas}
    elementos_de: dict[int, int] = {}
    for m in mapas:
        eid = m.num("elementsID")
        if eid is not None:
            elementos_de[eid] = m.id

    elementos = [o for o in objs if o.sys_type in elementos_de]
    ids_elemento = {o.id for o in elementos}

    por_mapa: dict[int, list[int | None]] = {m.id: [] for m in mapas}
    total_por_mapa: dict[int, int] = {m.id: 0 for m in mapas}

    for o in elementos:
        mid = elementos_de[o.sys_type]
        total_por_mapa[mid] += 1
        clase = _clase_elemento(o)
        destino = o.num("itemID")
        did = destino if clase == "device" and destino in ids_dispositivo else None
        smid = destino if clase == "submap" and destino in ids_mapa else None
        lid = _fk(o.num("linkID"), ids_enlace) if clase == "link" else None
        s.map_elements.append((
            o.id, mid, clase, o.num("itemX"), o.num("itemY"), o.num("itemShape"),
            _fk(o.num("itemImage"), ids_archivo),
            # La escala del icono, en por ciento. The Dude la guarda POR
            # ELEMENTO: el mismo router puede ir al 100 en un mapa y al 10 en
            # otro. Sin esto, una foto de 680×310 se dibuja a 22 píxeles y se ve
            # como un icono genérico — el trabajo de quien cargó las fotos de
            # cada equipo se pierde entero.
            o.num("itemImageScale"),
            o.nombre,
            did, smid, lid,
            _fk(o.num("linkFrom"), ids_elemento),
            _fk(o.num("linkTo"), ids_elemento),
            o.num("linkWidth"),
        ))
        if did is not None:
            por_mapa[mid].append(estado_dispositivo.get(did))

    for m in mapas:
        estados = por_mapa[m.id]
        s.maps.append((
            m.id, m.nombre or str(m.id), m.num("elementsID"),
            m.color("backgroundColor"), m.color("upColor"),
            m.color("downCompleteColor"), m.color("downPartialColor"),
            m.color("unknownColor"), m.color("ackedColor"),
            len(estados),
            sum(1 for e in estados if e == 1),
            sum(1 for e in estados if e == 3),
            # Los degradados van en su propia cuenta, no sumados a los caídos.
            # The Dude los separa —la plantilla [NetMap.DevicesPartiallyDownCount]
            # es un campo distinto de [NetMap.DevicesDownCount]— y si acá se
            # mezclaran, el rótulo del submapa diría un número que el original
            # no dice.
            sum(1 for e in estados if e == 2),
            total_por_mapa[m.id],
        ))

    # ── Fuentes de los gráficos ──────────────────────────────────────────────
    # El running_probe no sabe de qué equipo es (`functionDevice` viene vacío en
    # 1.082 de 1.083). Se resuelve desde quien lo consume.
    equipo_de_fuente: dict[int, tuple] = {}
    for o in servicios:
        src = o.num("dataSourceID")
        if src is not None:
            equipo_de_fuente[src] = (_fk(o.num("deviceID"), ids_dispositivo), o.id, None)
    for o in enlaces:
        maestro = _fk(o.num("masterDevice"), ids_dispositivo)
        for campo in ("rxDataSourceID", "txDataSourceID"):
            src = o.num(campo)
            if src is not None:
                equipo_de_fuente.setdefault(src, (maestro, None, o.id))

    for o in de(0x29):
        did, sid, lid = equipo_de_fuente.get(o.id, (None, None, None))
        s.chart_sources.append((
            o.id, o.nombre or str(o.id), did, sid, lid, o.txt("unit"),
            o.bool_("enabled"),
        ))

    return s


def _fk(valor: int | None, validos: set[int]) -> int | None:
    """Referencia sólo si el destino existe.

    The Dude no borra en cascada: quedan enlaces apuntando a tipos borrados,
    dispositivos con un perfil SNMP que ya no está, elementos que referencian
    elementos difuntos. Con una clave foránea de verdad del otro lado, dejar
    pasar esos ids reventaría la corrida entera por basura vieja e inofensiva.
    """
    return valor if valor in validos else None


def _clase_elemento(o: dudeobj.Objeto) -> str:
    """Clasifica un elemento de mapa. Ver la nota de `dudeobj.ELEMENTO`.

    Son DOS campos: `type` = 1 es enlace, y sólo con `type` = 0 manda
    `itemType`. Mirar únicamente `itemType` —que es lo que dice el documento de
    formato— mezcla 1.170 enlaces con 884 dispositivos y llama "enlace" a 100
    rótulos de texto que no enlazan nada.
    """
    if o.num("type") == dudeobj.ELEMENTO_ENLACE:
        return "link"
    return dudeobj.ELEMENTO.get(o.num("itemType"), "static")


def _agregar_estado(servicios: list[tuple]) -> tuple[int | None, int, int, int]:
    """Estado de un dispositivo a partir de sus servicios.

    Se cuentan sólo los servicios HABILITADOS: uno deshabilitado es uno que
    alguien apagó a propósito, y pintar un equipo de rojo por una sonda que
    nadie quiere no informa, molesta — y con el tiempo hace que se ignore el
    rojo, que es la peor falla posible en un tablero.

        sin servicios habilitados          → NULL   (no se sabe, y se dice)
        todos arriba                       → 1
        alguno caído y alguno no           → 2      (degradado)
        alguno degradado, ninguno caído    → 2      (degradado)
        todos caídos                       → 3
        sólo desconocidos                  → 0

    🔴 Corregido el 31/07/2026. Acá `partial` (2) y `down` (3) se sumaban en la
       misma variable, así que un equipo cuyo ÚNICO servicio estaba degradado
       terminaba en 3 — pintado de rojo como si estuviera caído del todo.
       Medido sobre la base real: le pasaba a **15 dispositivos**.

       No es cosmético. The Dude define un color propio para el estado parcial
       (`mapDownPartialColor`) precisamente porque, para quien está de guardia,
       «anda con un servicio degradado» y «no responde» exigen reacciones
       distintas. Colapsarlos pierde información y, peor, **alarma de más**:
       un tablero que grita rojo por una degradación enseña a ignorar el rojo,
       que es la peor falla que puede tener un tablero.
    """
    activos = [estado for estado, habilitado in servicios if habilitado]
    if not activos:
        return None, 0, 0, 0
    arriba = sum(1 for e in activos if e == 1)
    degradados = sum(1 for e in activos if e == 2)
    caidos = sum(1 for e in activos if e == 3)

    if caidos and (arriba or degradados):
        estado = 2          # mezcla: algo anda, algo no
    elif caidos:
        estado = 3          # todos caídos, y sólo entonces
    elif degradados:
        estado = 2          # nada caído del todo, pero hay degradación
    elif arriba:
        estado = 1
    else:
        estado = 0

    # `services_down` cuenta sólo los CAÍDOS de verdad. Un servicio degradado no
    # está caído, y sumarlo acá haría que la ficha diga «1 de 1 caído» sobre un
    # equipo que el propio panel pinta de naranja: dos afirmaciones que se
    # contradicen en la misma pantalla.
    return estado, len(activos), arriba, caidos


# ─────────────────────────────────────────────────────────────────────────────
# Carga del núcleo
# ─────────────────────────────────────────────────────────────────────────────

#: Hijos primero. Las claves foráneas obligan.
ORDEN_BORRADO = [
    "map_elements", "device_parents", "chart_sources", "services",
    "links", "maps", "devices", "device_types", "probes", "link_types",
    "snmp_profiles", "notifications", "files",
]

INSERTS = {
    "files": "INSERT INTO files (id,name,file_name,rel_path) VALUES (%s,%s,%s,%s)",
    "device_types": "INSERT INTO device_types (id,name,url,image_id,image_scale)"
                    " VALUES (%s,%s,%s,%s,%s)",
    "probes": "INSERT INTO probes (id,name,default_port,dns_name,function_available,"
              "function_error,function_value,unit) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
    "link_types": "INSERT INTO link_types (id,name,snmp_type,style,thickness,snmp_speed)"
                  " VALUES (%s,%s,%s,%s,%s,%s)",
    "snmp_profiles": "INSERT INTO snmp_profiles (id,name,version,port,try_count,try_timeout)"
                     " VALUES (%s,%s,%s,%s,%s,%s)",
    "notifications": "INSERT INTO notifications (id,name,type_id,type_label,enabled,subject)"
                     " VALUES (%s,%s,%s,%s,%s,%s)",
    # Los `::inet[]` y `::text[]` no son adorno: psycopg manda una lista de
    # cadenas como text[], y de text[] a inet[] Postgres no convierte solo.
    "devices": "INSERT INTO devices (id,name,addresses,dns_names,macs,type_id,"
               "snmp_profile_id,router_os,probe_enabled,probe_interval,probe_timeout,"
               "probe_down_count,dude_server,status,status_label,services_total,"
               "services_up,services_down) VALUES "
               "(%s,%s,%s::inet[],%s,%s::text[],%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    "device_parents": "INSERT INTO device_parents (device_id,parent_id) VALUES (%s,%s)",
    "services": "INSERT INTO services (id,device_id,probe_id,status,status_label,enabled,"
                "acked,probes_down,probe_interval,probe_timeout,probe_port,time_last_up,"
                "time_last_down,time_since_changed) VALUES "
                "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    "links": "INSERT INTO links (id,name,type_id,master_device_id,master_interface,history)"
             " VALUES (%s,%s,%s,%s,%s,%s)",
    "maps": "INSERT INTO maps (id,name,elements_id,background_color,up_color,down_color,"
            "partial_color,unknown_color,acked_color,devices_total,devices_up,"
            "devices_down,devices_partial,elements_total) VALUES "
            "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    "map_elements": "INSERT INTO map_elements (id,map_id,kind,x,y,shape,image_id,image_scale,"
                    "label,device_id,submap_id,link_id,link_from,link_to,link_width) VALUES "
                    "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
    "chart_sources": "INSERT INTO chart_sources (id,name,device_id,service_id,link_id,"
                     "unit,enabled) VALUES (%s,%s,%s,%s,%s,%s,%s)",
}

#: Padres primero, que es el orden de borrado al revés. Se deriva en vez de
#: escribirse a mano justamente para que no puedan desincronizarse: una lista
#: copiada y editada a medias produce un fallo de clave foránea intermitente,
#: que aparece sólo cuando esa tabla tiene filas.
ORDEN_INSERCION = list(reversed(ORDEN_BORRADO))


def cargar_nucleo(cur: psycopg.Cursor, s: Snapshot) -> None:
    """Reemplaza el snapshot completo. Va dentro de la transacción del llamador.

    DELETE y no TRUNCATE: TRUNCATE toma un lock exclusivo que frena hasta a los
    lectores, y el panel se quedaría tildado en cada vuelta. Con DELETE, quien
    esté leyendo sigue viendo el snapshot anterior entero hasta el COMMIT.
    """
    for tabla in ORDEN_BORRADO:
        cur.execute(f"DELETE FROM {tabla}")
    for tabla in ORDEN_INSERCION:
        filas = getattr(s, tabla)
        if filas:
            cur.executemany(INSERTS[tabla], filas)


# ─────────────────────────────────────────────────────────────────────────────
# Historia — incremental
# ─────────────────────────────────────────────────────────────────────────────
#
# 1,5 millones de filas no se recargan cada 30 segundos. Las dos tablas de
# historia se replican por marca de agua, y las dos claves empaquetadas del
# origen son justo lo que hace eso barato: como el tiempo va en la clave
# primaria, "traeme lo nuevo" es un recorrido de rango sobre el índice y no un
# scan completo.
#
#     outages.timeAndServiceID  =  (time     << 32) | serviceID
#     chart_values.sourceIDandTime = (sourceID << 32) | epoch
#
# Ojo con el orden invertido entre las dos: no es un error de tipeo, los
# nombres lo dicen y las mediciones lo confirman. La consecuencia práctica es
# que en `outages` la marca de agua es global y en `chart_values` hay que
# llevar una por fuente.

def _con_signo(n: int) -> int:
    """u64 → el entero con signo que SQLite realmente guarda y compara.

    Los ids de fuente pasan de 2^31, así que `sourceID << 32` desborda a
    negativo. Comparar contra el valor sin signo no devolvería ninguna fila.
    Dentro de una misma fuente el orden se conserva igual: los 32 bits altos
    quedan fijos y sólo se mueven los bajos.
    """
    return n - (1 << 64) if n >= (1 << 63) else n


def _fecha(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, timezone.utc)


def _real(v) -> float | None:
    """La columna `value` de SQLite no tiene tipo declarado: viene float, int o
    None según la fila. NULL se conserva como NULL — es "no hubo medición", que
    no es lo mismo que un cero."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def sincronizar_outages(cur: psycopg.Cursor, origen: sqlite3.Connection) -> int:
    cur.execute("SELECT extract(epoch FROM max(started_at))::bigint FROM outages")
    (marca,) = cur.fetchone()
    desde = max(0, marca - OUTAGES_RETROCESO_S) if marca else 0

    filas = origen.execute(
        "SELECT serviceID, deviceID, mapID, time, duration FROM outages"
        " WHERE timeAndServiceID >= ?",
        (_con_signo(desde << 32),),
    ).fetchall()
    if not filas:
        return 0

    datos = [
        (sid, did, mid, _fecha(t), _fecha(t + (dur or 0)), dur)
        for sid, did, mid, t, dur in filas
    ]
    cur.execute(
        "CREATE TEMP TABLE tmp_outages"
        " (service_id bigint, device_id bigint, map_id bigint,"
        "  started_at timestamptz, ended_at timestamptz, duration_s bigint)"
        " ON COMMIT DROP"
    )
    with cur.copy("COPY tmp_outages FROM STDIN (FORMAT BINARY)") as cp:
        cp.set_types(["int8", "int8", "int8", "timestamptz", "timestamptz", "int8"])
        for fila in datos:
            cp.write_row(fila)
    # Una caída en curso vuelve con la duración más grande: hay que pisarla.
    cur.execute(
        "INSERT INTO outages (service_id, device_id, map_id, started_at,"
        "                     ended_at, duration_s)"
        " SELECT DISTINCT ON (service_id, started_at) service_id, device_id,"
        "        map_id, started_at, ended_at, duration_s"
        "   FROM tmp_outages ORDER BY service_id, started_at, duration_s DESC"
        " ON CONFLICT (service_id, started_at) DO UPDATE"
        "    SET ended_at = EXCLUDED.ended_at,"
        "        duration_s = EXCLUDED.duration_s,"
        "        device_id = EXCLUDED.device_id,"
        "        map_id = EXCLUDED.map_id"
        "  WHERE outages.duration_s IS DISTINCT FROM EXCLUDED.duration_s"
    )
    # rowcount y no len(datos): la ventana de 24 h relee caídas que ya estaban
    # y que no cambiaron. Informar "122 caídas nuevas" cada 30 segundos cuando
    # no entró ninguna es ruido que después nadie mira.
    return cur.rowcount


def sincronizar_chart_values(
    cur: psycopg.Cursor, origen: sqlite3.Connection, fuentes: list[int]
) -> int:
    """Replica las mediciones nuevas, fuente por fuente y bucket por bucket.

    Son ~4.300 consultas por vuelta, y suena a mucho hasta que se ve que cada
    una es un salto directo al índice: en régimen devuelven cero o dos filas.
    La alternativa —un `WHERE ts > x` sobre la tabla entera— no puede usar el
    índice, porque el tiempo va en los bits BAJOS de la clave.
    """
    cur.execute(
        "SELECT source_id, bucket, extract(epoch FROM max(ts))::bigint"
        "  FROM chart_values GROUP BY source_id, bucket"
    )
    marca = {(src, b): t for src, b, t in cur.fetchall()}

    pendientes: list[tuple] = []
    tope_alcanzado = False
    for bucket, tabla in BUCKETS.items():
        if tope_alcanzado:
            break
        for src in fuentes:
            ultimo = marca.get((src, bucket))
            desde = (src << 32) | ((ultimo + 1) if ultimo is not None else 0)
            hasta = (src << 32) | 0xFFFFFFFF
            for clave, valor in origen.execute(
                f"SELECT sourceIDandTime, value FROM {tabla}"
                " WHERE sourceIDandTime BETWEEN ? AND ? ORDER BY sourceIDandTime",
                (_con_signo(desde), _con_signo(hasta)),
            ):
                epoch = clave & 0xFFFFFFFF  # el signo no toca los 32 bits bajos
                pendientes.append((src, bucket, _fecha(epoch), _real(valor)))
            if len(pendientes) >= CHART_MAX_FILAS:
                # Se corta en el borde de una fuente: cada fuente lleva su
                # propia marca de agua, así que las que faltan simplemente
                # entran en la vuelta siguiente. Nada queda a medias.
                tope_alcanzado = True
                break

    if not pendientes:
        return 0

    cur.execute(
        "CREATE TEMP TABLE tmp_chart"
        " (source_id bigint, bucket text, ts timestamptz, value double precision)"
        " ON COMMIT DROP"
    )
    with cur.copy("COPY tmp_chart FROM STDIN (FORMAT BINARY)") as cp:
        cp.set_types(["int8", "text", "timestamptz", "float8"])
        for fila in pendientes:
            cp.write_row(fila)
    cur.execute(
        "INSERT INTO chart_values (source_id, bucket, ts, value)"
        " SELECT DISTINCT ON (source_id, bucket, ts) source_id, bucket, ts, value"
        "   FROM tmp_chart ORDER BY source_id, bucket, ts"
        " ON CONFLICT DO NOTHING"
    )
    insertadas = cur.rowcount
    if tope_alcanzado:
        log.info("historia: tope de %d filas alcanzado, sigue en la próxima vuelta",
                 CHART_MAX_FILAS)
    return insertadas


# ─────────────────────────────────────────────────────────────────────────────
# Una corrida
# ─────────────────────────────────────────────────────────────────────────────

def _huella_anterior(cur: psycopg.Cursor) -> tuple[str | None, int | None]:
    cur.execute(
        "SELECT snapshot_hash, devices FROM sync_runs"
        " WHERE ok ORDER BY started_at DESC LIMIT 1"
    )
    fila = cur.fetchone()
    return fila if fila else (None, None)


def corrida(con: psycopg.Connection, ruta: str) -> None:
    """Una sincronización completa. Registra en `sync_runs` pase lo que pase.

    La fila de `sync_runs` se abre y se cierra FUERA de la transacción de datos
    a propósito: si el volcado falla y se revierte, el registro del fracaso
    tiene que sobrevivir. Un fallo que además borra su propio rastro deja al
    panel mostrando datos viejos sin ninguna manera de notarlo.
    """
    inicio = time.monotonic()
    with con.cursor() as cur:
        cur.execute("INSERT INTO sync_runs (started_at) VALUES (now()) RETURNING id")
        (run_id,) = cur.fetchone()

    error = None
    datos: dict = {}
    copia = None
    try:
        st = os.stat(ruta)
        datos["source_mtime"] = datetime.fromtimestamp(st.st_mtime, timezone.utc)
        datos["source_size"] = st.st_size

        # 🔴 Se lee una COPIA, nunca el archivo vivo. The Dude toma un lock
        #    EXCLUSIVE al arrancar y no lo suelta jamás: contra el original,
        #    todo lector recibe `database is locked` para siempre. El porqué
        #    completo, con la medición, está en `dudeobj.instantanea`.
        copia = dudeobj.instantanea(ruta, SNAPSHOT)

        s = extraer(copia)
        datos.update(
            user_version=s.user_version, objs_total=s.objs_total,
            devices=len(s.devices), services=len(s.services),
            links=len(s.links), maps=len(s.maps),
            map_elements=len(s.map_elements),
        )
        huella = s.huella()
        datos["snapshot_hash"] = huella

        with con.cursor() as cur:
            anterior, dispositivos_antes = _huella_anterior(cur)

        if GUARDA_CAIDA and dispositivos_antes:
            minimo = dispositivos_antes * GUARDA_CAIDA
            if len(s.devices) < minimo:
                raise Aborta(
                    f"el origen devolvió {len(s.devices)} dispositivos y la última "
                    f"corrida buena tenía {dispositivos_antes}: se aborta antes de "
                    f"borrar el inventario (GUARDA_CAIDA={GUARDA_CAIDA})"
                )

        reusa = anterior == huella
        datos["snapshot_reused"] = reusa

        # 🔴 Todo lo que sigue es una sola transacción. O entra entero, o el
        #    panel sigue viendo el snapshot anterior. No hay tercer estado.
        with con.transaction(), con.cursor() as cur:
            if reusa:
                log.debug("snapshot sin cambios (%s), no se reescribe", huella[:12])
            else:
                cargar_nucleo(cur, s)
            origen = dudeobj.abrir(copia)
            try:
                datos["outages_upserted"] = sincronizar_outages(cur, origen)
                datos["chart_values_inserted"] = sincronizar_chart_values(
                    cur, origen, [f[0] for f in s.chart_sources]
                )
            finally:
                origen.close()
    except Exception as e:  # noqa: BLE001 — se registra y se sigue en la próxima
        error = f"{type(e).__name__}: {e}"
        log.error("corrida %d fallida: %s", run_id, error)
    finally:
        # Siempre, también si la corrida reventó: esa copia tiene las
        # credenciales de todos los equipos. No se deja tirada entre vueltas.
        if copia:
            dudeobj.descartar(copia)

    datos["duration_ms"] = int((time.monotonic() - inicio) * 1000)
    columnas = ", ".join(f"{k} = %({k})s" for k in datos)
    with con.cursor() as cur:
        cur.execute(
            f"UPDATE sync_runs SET finished_at = now(), ok = %(ok)s,"
            f" error = %(error)s{', ' + columnas if columnas else ''}"
            f" WHERE id = %(id)s",
            {**datos, "ok": error is None, "error": error, "id": run_id},
        )

    if error is None:
        log.info(
            "corrida %d ok en %d ms — %d dispositivos, %d servicios, %d enlaces, "
            "%d mapas, %d elementos%s | historia: +%s caídas, +%s mediciones",
            run_id, datos["duration_ms"], datos["devices"], datos["services"],
            datos["links"], datos["maps"], datos["map_elements"],
            " (sin cambios)" if datos.get("snapshot_reused") else "",
            datos.get("outages_upserted", 0), datos.get("chart_values_inserted", 0),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Arranque
# ─────────────────────────────────────────────────────────────────────────────

def aplicar_esquema(con: psycopg.Connection, archivo: str) -> None:
    """`schema.sql` es idempotente (IF NOT EXISTS / OR REPLACE) — se corre siempre.

    Así el ETL no depende de que alguien se haya acordado de inicializar la base
    a mano. Ojo: idempotente NO es migratorio. Si un día cambia una columna de
    una tabla que ya existe, hace falta un ALTER; esto no lo va a hacer solo.
    """
    ruta = Path(archivo)
    if not ruta.exists():
        log.warning("no encuentro %s, asumo que el esquema ya está aplicado", ruta)
        return
    # Sin `con.transaction()` alrededor: el archivo trae su propio BEGIN/COMMIT
    # y anidarlos daría un WARNING por transacción ya abierta en cada arranque.
    con.execute(ruta.read_text(encoding="utf-8"))


def revisar_iconos(s_files: list[tuple], directorio: str) -> None:
    """Avisa si los iconos que la base indexa no están en el disco.

    El blob de un archivo viene en 0 bytes: la base es sólo el índice y los
    bytes viven en `data/files/`. Si el montaje apunta mal, el panel se dibuja
    entero pero sin un solo icono, y el síntoma no señala la causa.
    """
    base = Path(directorio)
    if not directorio or not base.is_dir():
        log.warning("DUDE_FILES=%r no es un directorio: no verifico los iconos",
                    directorio)
        return
    faltan = sum(
        1 for _, _, _, rel in s_files if rel and not (base / rel).exists()
    )
    total = sum(1 for f in s_files if f[3])
    if faltan:
        log.warning("%d de %d archivos indexados no están en %s", faltan, total, base)
    else:
        log.info("%d archivos indexados, todos presentes en %s", total, base)


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
        stream=sys.stdout,
    )
    if not DATABASE_URL:
        log.error("falta DATABASE_URL")
        return 2
    if not Path(DUDE_DB).exists():
        log.error("no existe %s — ¿está montado el volumen de origen?", DUDE_DB)
        return 2

    parar = False

    def _parar(*_):
        nonlocal parar
        parar = True
        log.info("señal recibida, termino la vuelta y salgo")

    signal.signal(signal.SIGTERM, _parar)
    signal.signal(signal.SIGINT, _parar)

    # autocommit: la transacción de datos se abre explícita con
    # `con.transaction()`. Así las filas de sync_runs se confirman al toque y
    # sobreviven a un rollback del volcado.
    try:
        with psycopg.connect(DATABASE_URL, autocommit=True) as con:
            aplicar_esquema(con, SCHEMA_FILE)
            log.info("sincronizando %s cada %g s", DUDE_DB, SYNC_INTERVAL)
            primera = True
            while not parar:
                corrida(con, DUDE_DB)
                if primera and DUDE_FILES:
                    with con.cursor() as cur:
                        cur.execute("SELECT id, name, file_name, rel_path FROM files")
                        revisar_iconos(cur.fetchall(), DUDE_FILES)
                    primera = False
                for _ in range(int(SYNC_INTERVAL * 10)):
                    if parar:
                        break
                    time.sleep(0.1)
    except psycopg.Error as e:
        # Un fallo del ORIGEN lo absorbe `corrida()` y lo deja anotado. Acá
        # sólo llega un fallo del DESTINO —Postgres se reinició, se cortó la
        # red— y con la conexión rota no hay a dónde anotar nada. Se sale con
        # código distinto de cero y lo levanta `restart: unless-stopped`, que
        # abre una conexión nueva. Reintentar sobre la conexión muerta sería
        # un ciclo infinito silencioso.
        log.error("se perdió la conexión con PostgreSQL: %s", e)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
