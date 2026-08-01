"""Importador de la historia que The Dude escribió en texto, no en la base.

    ¿POR QUÉ EXISTE ESTO?

    La tabla `outages` de The Dude arranca el 2026-06-12. Ese día la base chocó
    contra el techo de 2 GiB de wine32 y la rearmaron desde cero: la historia
    anterior se perdió. Pero la regla de notificación «log to syslog» venía
    escribiendo cada subida y cada bajada a archivos de texto en `files/`, y
    esos archivos SOBREVIVIERON. Son 44 archivos, 141.678 líneas, y llegan
    hasta 2020.

    O sea: la historia no se perdió, cambió de formato. Este módulo la trae de
    vuelta a una tabla consultable.

    🔴 LO QUE ESTA HISTORIA **NO** ES: seis años continuos.

        2020:   2.928 líneas
        2021:     936
        2022:       0   ← el año entero
        2023:       0   ← el año entero
        2024:   2.584
        2025:  29.331
        2026: 105.899

    Dos años enteros sin un solo registro. Cualquier cosa que se muestre encima
    de estos datos tiene que decirlo: «historia desde 2020» con 2022 y 2023 en
    blanco es una afirmación falsa. Para eso están la vista `v_syslog_cobertura`
    —que emite una fila por MES, con `hueco = true` en los vacíos— y la columna
    `syslog_outages.spans_gap`, que marca las caídas cuyo intervalo cruza uno de
    esos vacíos y que por lo tanto NO se pueden creer.

    ⚠️ OJO CON EL NOMBRE DEL ARCHIVO. `etl/syslog.py` tapa el módulo `syslog` de
       la biblioteca estándar para todo lo que se ejecute con `etl/` en el
       `sys.path`. Hoy no lo importa nadie —ni `logging`, ni `psycopg`— y el
       nombre lo pidió el pedido original. Si algún día aparece un
       `AttributeError` raro sobre `syslog.LOG_DAEMON`, la causa es ésta.

    ─────────────────────────────────────────────────────────────────────────
    CÓMO SE USA

        python syslog.py importar --dir /origen/files --tz America/Argentina/Buenos_Aires
        python syslog.py reporte
        python syslog.py resolver          # después de renombrar equipos
        python syslog.py zona              # ¿la zona horaria elegida es la buena?

    El detalle de cada decisión está en `docs/HISTORIA-SYSLOG.md`.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("syslog")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

#: Dónde viven los 44 archivos. En el servidor es el `files/` de The Dude, el
#: mismo directorio que el ETL ya monta para los iconos.
SYSLOG_DIR = os.environ.get("SYSLOG_DIR", os.environ.get("DUDE_FILES", ""))

#: 🔴 El formato NO trae zona horaria: `2025.11.23-14:53:39` y nada más. Es la
#:    hora local del reloj del servidor que escribió la línea. Se elige acá y se
#:    GUARDA en `syslog_files.tz`, para que dentro de un año se sepa con qué
#:    supuesto se cargó cada archivo.
#:
#:    El default es la zona del ISP. Argentina no mueve el reloj desde 2009, así
#:    que en todo el rango 2020-2026 no hay ni una hora ambigua ni una
#:    inexistente: la conversión es un desplazamiento fijo de -03. Eso es lo que
#:    hace que este supuesto sea barato de corregir después (ver `reinterpretar`).
SYSLOG_TZ = os.environ.get("SYSLOG_TZ", "America/Argentina/Buenos_Aires")

SCHEMA_FILE = os.environ.get("SCHEMA_FILE", str(Path(__file__).with_name("schema.sql")))

#: Cuántas líneas que no entendemos se guardan como muestra por archivo. Se
#: guardan FORMAS distintas, no las primeras N: con 141.678 líneas, las primeras
#: veinte suelen ser la misma cosa repetida y no enseñan nada.
MUESTRAS_MAX = 20

#: Un tramo sin NINGÚN evento de este largo o más se considera un hueco de
#: cobertura. Con ~64 eventos por día de promedio, un día entero en blanco ya es
#: una anomalía; los huecos reales de esta base son de dos años.
HUECO_MIN_DIAS = int(os.environ.get("SYSLOG_HUECO_MIN_DIAS", "1"))


# ═════════════════════════════════════════════════════════════════════════════
# El formato
# ═════════════════════════════════════════════════════════════════════════════
#
# Toda línea, sea del tipo que sea, empieza con el mismo sobre:
#
#     2025.11.23-14:53:39 <IP-DEL-SERVIDOR>: <lo que sea>
#
# Y adentro hay DOS fuentes mezcladas, porque alguien apuntó también un MikroTik
# al mismo destino. Medido sobre los 44 archivos:
#
#     141.678  líneas totales
#      69.525  Service ... is now down
#      69.511  Service ... is now up      ← 14 down de más: caídas sin cerrar
#       2.642  syslog de un MikroTik (VPN, IPsec, autenticaciones)
#
# Las 2.642 NO se tiran. Que 438 de ellas digan «failed to authenticate» es
# información operativa que hoy no mira nadie, y guardarlas cuesta 2.642 filas.

SOBRE = re.compile(
    r"^(?P<fecha>\d{4}\.\d{2}\.\d{2}-\d{2}:\d{2}:\d{2})"
    r"\s+<(?P<host>[^>]*)>:\s?(?P<resto>.*)$"
)

# `Service ping on Peniel_E_Lasalle2AF is now down (timeout)`
#
# La sonda va con `.+?` no ambicioso para que corte en el PRIMER « on ». Eso es
# deliberado: en el histórico la sonda es siempre `ping` (única en 139.036
# líneas), pero los nombres de equipo sí traen preposiciones —«Panel Ombu_Bruck
# en 5.8»— y si la sonda fuera ambiciosa se comería medio nombre.
#
# El motivo entre paréntesis es OPCIONAL y hay más de uno:
#     (timeout)         69.446   el equipo no contesta
#     (local problem)       79   el problema es del SERVIDOR de monitoreo
# La diferencia importa: una caída «local problem» no dice nada del equipo.
SERVICIO = re.compile(
    r"^Service\s+(?P<sonda>.+?)\s+on\s+(?P<equipo>.+?)"
    r"\s+is\s+now\s+(?P<estado>[A-Za-z][A-Za-z ]*?)"
    r"(?:\s*\((?P<motivo>[^)]*)\))?$"
)

# `pptp,ppp,info ponte: jfilippo-fs: terminating... - failed to authenticate`
#
# MikroTik antepone su lista de tópicos separada por comas y terminada en la
# severidad. Se exige AL MENOS UNA COMA a propósito: sin eso, cualquier frase en
# minúscula pasaría por lista de tópicos y clasificaríamos mal por parecido.
TOPICOS = re.compile(
    r"^(?P<topicos>[a-z][a-z0-9_-]*(?:,[a-z0-9_!-]+)+)\s+(?P<mensaje>.*)$"
)

#: Redacción defensiva de todo lo que se guarda VERBATIM (mensajes del MikroTik
#: y muestras de líneas no entendidas). El resto del proyecto tiene una regla
#: dura —«ninguna tabla guarda credenciales»— y estas dos columnas son las
#: únicas de todo el esquema que guardan texto libre de una fuente externa. Un
#: equipo que loguee `community=public` no puede meter eso en la base.
SECRETO = re.compile(
    r"(?i)\b(pass(?:word|wd)?|pwd|community|secret|token|api[_-]?key)\b"
    r"\s*[:=]?\s*\S+"
)


def redactar(texto: str) -> str:
    return SECRETO.sub(lambda m: f"{m.group(1)}=***", texto)


def _forma(texto: str) -> str:
    """Firma gruesa de una línea, para juntar muestras que son «la misma».

    Se aplastan los números y las direcciones. `TCP connection from 1.2.3.4` y
    `TCP connection from 5.6.7.8` dan la misma forma y ocupan una sola muestra.
    """
    return re.sub(r"\d+", "#", texto)[:200]


@dataclass(slots=True)
class Evento:
    """Una transición de un servicio. Es la materia prima de las caídas."""

    momento: datetime          # naive: la hora local que escribió el servidor
    equipo: str
    sonda: str
    estado: str                # 'down' · 'up' · lo que venga, en minúscula
    motivo: str | None
    host: str | None
    archivo: str
    linea: int
    #: Cuántas veces apareció ANTES esta misma línea (misma hora, equipo, sonda
    #: y estado) dentro del mismo archivo. Ver `Archivo.eventos` y la clave
    #: única de `syslog_events`.
    ordinal: int = 0
    #: Desempate para ordenar. Dentro de un archivo es el número de línea; al
    #: releer de la base es el orden global que devuelve el SELECT.
    orden: int = 0


@dataclass(slots=True)
class Otra:
    """Una línea con sobre válido que NO es un evento de servicio."""

    momento: datetime
    host: str | None
    clase: str                 # 'mikrotik' · 'desconocida'
    topicos: str | None
    mensaje: str
    archivo: str
    linea: int


@dataclass
class Archivo:
    nombre: str
    ruta: str
    sha256: str
    bytes: int
    lineas: int = 0
    vacias: int = 0
    ignoradas: int = 0
    duplicadas: int = 0
    muestras: list[str] = field(default_factory=list)
    eventos: list[Evento] = field(default_factory=list)
    otras: list[Otra] = field(default_factory=list)

    @property
    def primero(self) -> datetime | None:
        todos = [e.momento for e in self.eventos] + [o.momento for o in self.otras]
        return min(todos) if todos else None

    @property
    def ultimo(self) -> datetime | None:
        todos = [e.momento for e in self.eventos] + [o.momento for o in self.otras]
        return max(todos) if todos else None


def parsear_linea(texto: str, archivo: str = "", nro: int = 0) -> Evento | Otra | None:
    """Una línea → un `Evento`, una `Otra`, o `None` si ni el sobre entendimos.

    Nunca levanta. Con 141.678 líneas de seis años y dos fuentes mezcladas, una
    excepción a mitad de camino dejaría media importación adentro y la otra
    mitad afuera, y el operador no tendría forma de saber dónde cortó.
    """
    texto = texto.strip("\r\n").lstrip("﻿")
    sobre = SOBRE.match(texto.strip())
    if not sobre:
        return None
    try:
        momento = datetime.strptime(sobre["fecha"], "%Y.%m.%d-%H:%M:%S")
    except ValueError:
        # Fecha con la forma correcta pero imposible (mes 13, 31 de febrero).
        # Se cuenta como no entendida en vez de reventar la corrida.
        return None

    host = sobre["host"] or None
    resto = sobre["resto"].strip()

    srv = SERVICIO.match(resto)
    if srv:
        estado = " ".join(srv["estado"].lower().split())
        motivo = srv["motivo"].strip() if srv["motivo"] is not None else None
        return Evento(
            momento=momento,
            equipo=srv["equipo"].strip(),
            sonda=srv["sonda"].strip(),
            estado=estado,
            motivo=motivo or None,
            host=host,
            archivo=archivo,
            linea=nro,
            orden=nro,
        )

    if not resto:
        return None

    mk = TOPICOS.match(resto)
    return Otra(
        momento=momento,
        host=host,
        clase="mikrotik" if mk else "desconocida",
        topicos=mk["topicos"] if mk else None,
        mensaje=redactar(mk["mensaje"] if mk else resto)[:1000],
        archivo=archivo,
        linea=nro,
    )


def parsear_archivo(ruta: str | Path, *, muestras_max: int = MUESTRAS_MAX) -> Archivo:
    """Lee un archivo entero y devuelve todo lo que encontró, contado.

    Decodifica con `errors="replace"`: The Dude corre sobre Windows y no hay
    garantía de que la codificación sea UTF-8. Una línea con un byte raro pierde
    ese byte, pero el resto del archivo entra igual — que es infinitamente mejor
    que abortar seis años de historia por un acento.
    """
    ruta = Path(ruta)
    crudo = ruta.read_bytes()
    a = Archivo(
        nombre=ruta.name,
        ruta=str(ruta),
        sha256=hashlib.sha256(crudo).hexdigest(),
        bytes=len(crudo),
    )
    formas: set[str] = set()
    #: Clave natural → cuántas veces ya salió. Sin esto, dos líneas idénticas
    #: legítimas (dos equipos que se llaman igual cayendo en el mismo segundo:
    #: hay 80 nombres repetidos en el inventario) colapsarían en una sola al
    #: chocar contra la clave única. Con el ordinal, la segunda entra como
    #: ordinal 1 y no se pierde, y reimportar el mismo archivo vuelve a dar los
    #: mismos ordinales — que es lo que mantiene la idempotencia.
    vistos: Counter = Counter()

    for nro, linea in enumerate(crudo.decode("utf-8", errors="replace").splitlines(), 1):
        a.lineas += 1
        if not linea.strip():
            a.vacias += 1
            continue
        r = parsear_linea(linea, a.nombre, nro)
        if r is None:
            a.ignoradas += 1
            f = _forma(linea.strip())
            if f not in formas and len(a.muestras) < muestras_max:
                formas.add(f)
                a.muestras.append(redactar(linea.strip())[:300])
        elif isinstance(r, Evento):
            clave = (r.momento, r.equipo, r.sonda, r.estado)
            r.ordinal = vistos[clave]
            if r.ordinal:
                a.duplicadas += 1
            vistos[clave] += 1
            a.eventos.append(r)
        else:
            a.otras.append(r)
    return a


# ═════════════════════════════════════════════════════════════════════════════
# Reconstrucción de caídas
# ═════════════════════════════════════════════════════════════════════════════
#
# Un `down` seguido de un `up` del mismo equipo y la misma sonda es una caída.
# Eso es lo fácil. Lo que decide si esto sirve o no son los casos feos, y acá
# están todos resueltos de la misma manera: **nunca inventar un instante que el
# texto no dice, y nunca tirar una línea en silencio.**
#
#   down → up            'closed'    la caída completa. Es el 99 % .
#   down → (nada)        'open'      quedó abierta: o sigue caído, o el `up` se
#                                    perdió. `ended_at` y `duration_s` en NULL,
#                                    que es lo honesto: no sabemos cuánto duró.
#   (nada) → up          'no_start'  recuperó sin que hubiéramos visto la caída.
#                                    `started_at` en NULL. Se guarda igual,
#                                    porque descartarlo sería exactamente el
#                                    «desaparece en silencio» que no queremos.
#   down → down → up     'closed'    UNA caída, la que empieza en el PRIMER
#                                    down, con `down_events = 2`.
#
# Sobre el doble `down`: The Dude notifica transiciones, así que dos `down`
# seguidos significan que el `up` del medio se perdió. Se puede leer de dos
# maneras y las dos son defendibles — una caída larga, o dos cortas con un
# intervalo desconocido en el medio. Se elige la primera porque la segunda
# obliga a inventar la hora del `up` que falta. Para no perder la otra lectura,
# se guarda `last_down_at`: el consumidor que quiera la versión optimista tiene
# el intervalo [last_down_at, ended_at] a mano, y `down_events > 1` le avisa de
# que la elección existe.
#
# Sobre los `up` sin `down`: ⚠️ pueden llegar en manada. Cuando The Dude
# arranca, todos los servicios pasan de «unknown» a «up» y eso dispara la
# notificación. Doscientos `no_start` dentro del mismo minuto no son doscientas
# caídas: son un arranque del servidor. Como no hay forma de distinguirlos desde
# el texto, se guardan igual pero SIN duración, así no pueden contaminar ningún
# cálculo de disponibilidad — un NULL no se suma.


@dataclass(slots=True)
class Caida:
    equipo: str
    sonda: str
    inicio: datetime | None
    fin: datetime | None
    duracion_s: int | None
    cierre: str                # 'closed' · 'open' · 'no_start'
    downs: int
    ultimo_down: datetime | None
    motivo_down: str | None
    motivo_up: str | None
    cruza_hueco: bool = False


def huecos(eventos, min_dias: int = HUECO_MIN_DIAS) -> list[tuple[datetime, datetime]]:
    """Tramos en que el corpus ENTERO no tiene ni una línea.

    No es un detalle: 2022 y 2023 están completamente vacíos. Un `down` de
    diciembre de 2021 emparejado con el `up` de enero de 2024 produciría una
    caída de dos años que nunca existió — lo que se cortó fue el registro, no el
    enlace. Las caídas que cruzan uno de estos tramos quedan marcadas con
    `spans_gap` y no hay que creerles la duración.
    """
    if min_dias <= 0:
        return []
    momentos = sorted({e.momento for e in eventos})
    minimo = timedelta(days=min_dias)
    return [
        (a, b)
        for a, b in zip(momentos, momentos[1:])
        if b - a >= minimo
    ]


def _cruza(inicio, fin, tramos) -> bool:
    if inicio is None or fin is None:
        return False
    return any(a < fin and inicio < b for a, b in tramos)


def reconstruir(eventos, min_dias: int = HUECO_MIN_DIAS) -> list[Caida]:
    """Todos los eventos → todas las caídas. Función pura, sin base de datos.

    Agrupa por (equipo, sonda) y NO por archivo: una caída que empieza al final
    de un archivo y termina al principio del siguiente es una sola caída, y ésa
    es justamente la razón de reconstruir desde la tabla de eventos y no desde
    el flujo de cada archivo.

    El desempate para dos eventos en el mismo segundo es `orden`, que dentro de
    un archivo es el número de línea. El syslog se escribe agregando al final,
    así que el orden de las líneas ES el orden real de los hechos — es la señal
    más fuerte que hay cuando el reloj sólo tiene resolución de un segundo.
    """
    tramos = huecos(eventos, min_dias)
    por_servicio: dict[tuple[str, str], list[Evento]] = defaultdict(list)
    for e in eventos:
        por_servicio[(e.equipo, e.sonda)].append(e)

    caidas: list[Caida] = []
    for (equipo, sonda), lista in por_servicio.items():
        lista.sort(key=lambda e: (e.momento, e.orden))
        abierta: Evento | None = None
        ultimo_down: datetime | None = None
        downs = 0

        for e in lista:
            if e.estado == "down":
                if abierta is None:
                    abierta, downs, ultimo_down = e, 1, e.momento
                else:
                    downs += 1
                    ultimo_down = e.momento
            elif e.estado == "up":
                if abierta is None:
                    caidas.append(Caida(
                        equipo=equipo, sonda=sonda, inicio=None, fin=e.momento,
                        duracion_s=None, cierre="no_start", downs=0,
                        ultimo_down=None, motivo_down=None, motivo_up=e.motivo,
                    ))
                    continue
                # La duración NUNCA puede salir negativa, y no por una guarda:
                # la lista está ordenada por hora, así que `e.momento` es
                # siempre >= el del `down` que abrió. Vale decirlo porque el
                # reloj de un Windows 7 sin NTP confiable SÍ salta para atrás
                # cada tanto en seis años — y lo que produce ese salto no es un
                # número negativo, es que el `up` aparece ANTES que el `down` y
                # sale como un 'no_start' suelto más una caída 'open'. Feo,
                # pero visible, y sin un solo número inventado.
                caidas.append(Caida(
                    equipo=equipo, sonda=sonda,
                    inicio=abierta.momento, fin=e.momento,
                    duracion_s=int((e.momento - abierta.momento).total_seconds()),
                    cierre="closed", downs=downs, ultimo_down=ultimo_down,
                    motivo_down=abierta.motivo, motivo_up=e.motivo,
                ))
                abierta, downs, ultimo_down = None, 0, None
            # Cualquier otro estado ('unknown', 'partially down'…) se guardó como
            # evento y se cuenta en el reporte, pero no abre ni cierra nada: no
            # sabríamos si el servicio está andando o no.

        if abierta is not None:
            caidas.append(Caida(
                equipo=equipo, sonda=sonda, inicio=abierta.momento, fin=None,
                duracion_s=None, cierre="open", downs=downs,
                ultimo_down=ultimo_down, motivo_down=abierta.motivo, motivo_up=None,
            ))

    for c in caidas:
        c.cruza_hueco = _cruza(c.inicio, c.fin, tramos)
    caidas.sort(key=lambda c: (c.inicio or c.fin, c.equipo, c.sonda))
    return caidas


# ═════════════════════════════════════════════════════════════════════════════
# Base de datos
# ═════════════════════════════════════════════════════════════════════════════

def aplicar_esquema(con, archivo: str = SCHEMA_FILE) -> None:
    """El mismo `schema.sql` del ETL: es idempotente y trae ya las tablas de acá."""
    ruta = Path(archivo)
    if not ruta.exists():
        log.warning("no encuentro %s, asumo que el esquema ya está aplicado", ruta)
        return
    con.execute(ruta.read_text(encoding="utf-8"))


def validar_zona(con, tz: str) -> None:
    fila = con.execute(
        "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = %s)", (tz,)
    ).fetchone()
    if not fila[0]:
        raise SystemExit(
            f"la zona horaria {tz!r} no existe en PostgreSQL. "
            "Mirá `SELECT name FROM pg_timezone_names`."
        )


TMP_EVENTOS = (
    "CREATE TEMP TABLE tmp_syslog_events ("
    " occurred_local timestamp, device_name text, probe_name text, state text,"
    " reason text, source_host text, source_file text, source_line integer,"
    " ordinal smallint) ON COMMIT DROP"
)
TIPOS_EVENTOS = ["timestamp", "text", "text", "text", "text", "text", "text",
                 "int4", "int2"]

TMP_OTRAS = (
    "CREATE TEMP TABLE tmp_syslog_other ("
    " occurred_local timestamp, source_host text, kind text, topics text,"
    " message text, source_file text, source_line integer) ON COMMIT DROP"
)
TIPOS_OTRAS = ["timestamp", "text", "text", "text", "text", "text", "int4"]

TMP_CAIDAS = (
    "CREATE TEMP TABLE tmp_syslog_outages ("
    " device_name text, probe_name text, started_at timestamptz,"
    " ended_at timestamptz, duration_s bigint, closure text, down_events integer,"
    " last_down_at timestamptz, down_reason text, up_reason text,"
    " spans_gap boolean) ON COMMIT DROP"
)
TIPOS_CAIDAS = ["text", "text", "timestamptz", "timestamptz", "int8", "text",
                "int4", "timestamptz", "text", "text", "bool"]


def importar_archivo(con, a: Archivo, tz: str, forzar: bool = False) -> str:
    """Carga UN archivo. Devuelve 'saltado' o 'cargado'.

    Cada archivo va en su propia transacción: si el número 30 revienta, los 29
    anteriores quedan adentro y se reintenta sólo ese. Con 44 archivos y seis
    años de datos, un todo-o-nada obliga a repetir cuarenta minutos por una
    línea rota.
    """
    fila = con.execute(
        "SELECT sha256, tz FROM syslog_files WHERE name = %s", (a.nombre,)
    ).fetchone()
    if fila and fila == (a.sha256, tz) and not forzar:
        log.info("%-28s sin cambios, salteado", a.nombre)
        return "saltado"

    with con.transaction(), con.cursor() as cur:
        # 🔴 Borrar primero lo que este archivo había dejado. Es lo que hace que
        #    volver a correr con OTRA zona horaria, o sobre un archivo que
        #    creció, no deje mezcla: las filas viejas de este archivo se van y
        #    entran las nuevas. La clave única de `syslog_events` se encarga
        #    después de que una línea repetida en DOS archivos —el solape típico
        #    de una rotación— entre una sola vez.
        cur.execute("DELETE FROM syslog_events WHERE source_file = %s", (a.nombre,))
        cur.execute("DELETE FROM syslog_other  WHERE source_file = %s", (a.nombre,))

        insertados = 0
        if a.eventos:
            cur.execute(TMP_EVENTOS)
            with cur.copy("COPY tmp_syslog_events FROM STDIN (FORMAT BINARY)") as cp:
                cp.set_types(TIPOS_EVENTOS)
                for e in a.eventos:
                    cp.write_row((e.momento, e.equipo, e.sonda, e.estado, e.motivo,
                                  e.host, e.archivo, e.linea, e.ordinal))
            cur.execute(
                "INSERT INTO syslog_events (occurred_at, occurred_local, device_name,"
                "  probe_name, state, reason, source_host, source_file, source_line,"
                "  ordinal)"
                " SELECT t.occurred_local AT TIME ZONE %s, t.occurred_local,"
                "        t.device_name, t.probe_name, t.state, t.reason,"
                "        t.source_host, t.source_file, t.source_line, t.ordinal"
                "   FROM tmp_syslog_events t"
                " ON CONFLICT DO NOTHING",
                (tz,),
            )
            insertados = cur.rowcount

        if a.otras:
            cur.execute(TMP_OTRAS)
            with cur.copy("COPY tmp_syslog_other FROM STDIN (FORMAT BINARY)") as cp:
                cp.set_types(TIPOS_OTRAS)
                for o in a.otras:
                    cp.write_row((o.momento, o.host, o.clase, o.topicos, o.mensaje,
                                  o.archivo, o.linea))
            cur.execute(
                "INSERT INTO syslog_other (occurred_at, occurred_local, source_host,"
                "  kind, topics, message, source_file, source_line)"
                " SELECT t.occurred_local AT TIME ZONE %s, t.occurred_local,"
                "        t.source_host, t.kind, t.topics, t.message, t.source_file,"
                "        t.source_line"
                "   FROM tmp_syslog_other t"
                " ON CONFLICT DO NOTHING",
                (tz,),
            )

        cur.execute(
            "INSERT INTO syslog_files (name, path, sha256, bytes, tz, lines,"
            "  service_lines, other_lines, ignored_lines, blank_lines,"
            "  duplicate_lines, ignored_samples, first_event, last_event, imported_at)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::text[],"
            "         %s::timestamp AT TIME ZONE %s, %s::timestamp AT TIME ZONE %s, now())"
            " ON CONFLICT (name) DO UPDATE SET"
            "   path = EXCLUDED.path, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,"
            "   tz = EXCLUDED.tz, lines = EXCLUDED.lines,"
            "   service_lines = EXCLUDED.service_lines,"
            "   other_lines = EXCLUDED.other_lines,"
            "   ignored_lines = EXCLUDED.ignored_lines,"
            "   blank_lines = EXCLUDED.blank_lines,"
            "   duplicate_lines = EXCLUDED.duplicate_lines,"
            "   ignored_samples = EXCLUDED.ignored_samples,"
            "   first_event = EXCLUDED.first_event, last_event = EXCLUDED.last_event,"
            "   imported_at = now()",
            (a.nombre, a.ruta, a.sha256, a.bytes, tz, a.lineas, len(a.eventos),
             len(a.otras), a.ignoradas, a.vacias, a.duplicadas, a.muestras,
             a.primero, tz, a.ultimo, tz),
        )

    log.info("%-28s %6d líneas · %6d eventos (+%d nuevos) · %5d otras · %4d "
             "ignoradas · %3d repetidas",
             a.nombre, a.lineas, len(a.eventos), insertados, len(a.otras),
             a.ignoradas, a.duplicadas)
    return "cargado"


def leer_eventos(con) -> list[Evento]:
    """Todos los eventos de la base, en el orden real de los hechos.

    El desempate cuando dos líneas comparten el segundo: primero el archivo cuyo
    primer evento es más viejo, después el número de línea. Ordenar por el
    NOMBRE del archivo sería adivinar — nada garantiza que `syslog.10.txt` sea
    posterior a `syslog.9.txt`.
    """
    filas = con.execute(
        "SELECT e.occurred_at, e.device_name, e.probe_name, e.state, e.reason"
        "  FROM syslog_events e"
        "  LEFT JOIN syslog_files f ON f.name = e.source_file"
        " ORDER BY e.occurred_at, f.first_event NULLS FIRST, e.source_file,"
        "          e.source_line, e.ordinal"
    ).fetchall()
    return [
        Evento(momento=ts, equipo=dev, sonda=probe, estado=st, motivo=rz,
               host=None, archivo="", linea=0, orden=n)
        for n, (ts, dev, probe, st, rz) in enumerate(filas)
    ]


def reconstruir_en_bd(con, min_dias: int = HUECO_MIN_DIAS) -> dict:
    """Vacía `syslog_outages` y la vuelve a derivar de `syslog_events`.

    🔴 Acá está la idempotencia de verdad. La tabla de caídas no se «actualiza»:
       es una FUNCIÓN PURA de la tabla de eventos, y se recalcula entera. Correr
       el importador dos veces, o veinte, da exactamente el mismo contenido —
       porque los eventos se deduplican por su clave natural y las caídas se
       tiran y se rehacen.

       El precio es que los `id` de `syslog_outages` no son estables entre
       reconstrucciones. Nadie los referencia (no hay clave foránea hacia acá) y
       a cambio se gana que mejorar el algoritmo sea `reconstruir` y listo, sin
       migración.
    """
    eventos = leer_eventos(con)
    caidas = reconstruir(eventos, min_dias)
    tramos = huecos(eventos, min_dias)

    with con.transaction(), con.cursor() as cur:
        cur.execute("DELETE FROM syslog_outages")
        if caidas:
            cur.execute(TMP_CAIDAS)
            with cur.copy("COPY tmp_syslog_outages FROM STDIN (FORMAT BINARY)") as cp:
                cp.set_types(TIPOS_CAIDAS)
                for c in caidas:
                    cp.write_row((c.equipo, c.sonda, c.inicio, c.fin, c.duracion_s,
                                  c.cierre, c.downs, c.ultimo_down, c.motivo_down,
                                  c.motivo_up, c.cruza_hueco))
            cur.execute(
                "INSERT INTO syslog_outages (device_name, probe_name, started_at,"
                "  ended_at, duration_s, closure, down_events, last_down_at,"
                "  down_reason, up_reason, spans_gap)"
                " SELECT device_name, probe_name, started_at, ended_at, duration_s,"
                "        closure, down_events, last_down_at, down_reason, up_reason,"
                "        spans_gap FROM tmp_syslog_outages"
                " ON CONFLICT DO NOTHING"
            )
            escritas = cur.rowcount
        else:
            escritas = 0

    if escritas != len(caidas):
        # No debería pasar: dos caídas del mismo servicio con el mismo par
        # (inicio, fin) exigiría dos eventos idénticos, y ésos ya se
        # deduplicaron. Si pasa, hay que mirarlo, no taparlo.
        log.warning("se reconstruyeron %d caídas y entraron %d: %d colisionaron "
                    "contra la clave única", len(caidas), escritas,
                    len(caidas) - escritas)

    resumen = Counter(c.cierre for c in caidas)
    return {
        "eventos": len(eventos),
        "caidas": len(caidas),
        "escritas": escritas,
        "closed": resumen["closed"],
        "open": resumen["open"],
        "no_start": resumen["no_start"],
        "cruzan_hueco": sum(1 for c in caidas if c.cruza_hueco),
        "downs_repetidos": sum(1 for c in caidas if c.downs > 1),
        "reloj_al_reves": sum(
            1 for c in caidas if c.cierre == "closed" and c.duracion_s is None
        ),
        "huecos": tramos,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Nombre → id
# ─────────────────────────────────────────────────────────────────────────────
#
# 🔴 El texto trae NOMBRES; el panel necesita IDS. Y los nombres no son una
#    clave: medido contra la base real,
#
#      452  nombres distintos aparecen en los logs
#      338  existen hoy en `devices.name`          (75 %)
#      114  NO existen                             (25 %)
#
#    Los 114 son equipos renombrados o dados de baja: `AirFiber Nicole_E_Ponte`,
#    `Peniel_E_Ponte 24GHZ ex 10 Ghz`, `Cambium_Panel_1001`, y hasta direcciones
#    IP usadas como nombre de equipo.
#    **Se guardan igual, con `device_id` en NULL.** Tirar un cuarto del
#    histórico porque a alguien le cambiaron el nombre sería perder justo lo que
#    este trabajo viene a rescatar.
#
#    Y NO se emparejan por parecido. Uno de los nombres es literalmente
#    `Peniel_E_Ponte 24GHZ ex 10 Ghz`: el «ex» es la historia de renombres
#    metida adentro del nombre. Un `similarity()` contra eso devolvería
#    coincidencias plausibles y falsas, y una caída atribuida al equipo
#    equivocado es peor que una caída sin atribuir — la primera miente, la
#    segunda se nota.
#
#    Del lado del inventario tampoco hay unicidad: de los 798 nombres distintos
#    de `devices`, 80 los comparten más de un equipo (167 servicios `ping`).
#    Para esos el nombre NO alcanza, y quedan en 'ambiguous'.
#
#    Por eso la resolución tiene cuatro resultados y no dos, y se guarda cuál
#    fue en `match_kind`:
#
#      'service'    el par (equipo, sonda) da EXACTAMENTE un servicio → los dos ids
#      'device'     el nombre da un equipo, pero sin esa sonda → sólo device_id
#      'ambiguous'  el nombre lo comparten varios equipos → ningún id
#      'unknown'    el nombre no está en el inventario → ningún id
#
#    Es un UPDATE aparte y re-ejecutable a propósito: los equipos se renombran,
#    y un nombre que hoy no resuelve puede resolver mañana sin volver a leer los
#    44 archivos.

RESOLVER_SQL = [
    # Punto de partida: todo sin resolver. Necesario para que `resolver` sea
    # re-ejecutable — si un equipo se borra de The Dude, su caída tiene que
    # VOLVER a 'unknown', no quedarse con el id viejo apuntando a la nada.
    ("reset",
     "UPDATE syslog_outages"
     "   SET device_id = NULL, service_id = NULL, match_kind = 'unknown'"),

    # 1 · par (nombre de equipo, nombre de sonda) → un único servicio.
    ("service",
     "UPDATE syslog_outages o"
     "   SET device_id = m.device_id, service_id = m.service_id,"
     "       match_kind = 'service'"
     "  FROM (SELECT d.name AS dn, p.name AS pn, min(s.device_id) AS device_id,"
     "               min(s.id) AS service_id"
     "          FROM services s"
     "          JOIN devices d ON d.id = s.device_id"
     "          JOIN probes  p ON p.id = s.probe_id"
     "         GROUP BY d.name, p.name HAVING count(*) = 1) m"
     " WHERE o.device_name = m.dn AND o.probe_name = m.pn"),

    # 2 · el nombre da un equipo solo, pero ese equipo no tiene esa sonda.
    #     Se resuelve el equipo y se deja el servicio en NULL: saber A QUIÉN se
    #     le cayó algo ya es la mitad del dato.
    ("device",
     "UPDATE syslog_outages o"
     "   SET device_id = m.id, match_kind = 'device'"
     "  FROM (SELECT min(d.id) AS id, d.name"
     "          FROM devices d GROUP BY d.name HAVING count(*) = 1) m"
     " WHERE o.match_kind = 'unknown' AND o.device_name = m.name"),

    # 3 · el nombre existe pero lo comparten varios equipos.
    ("ambiguous",
     "UPDATE syslog_outages o"
     "   SET match_kind = 'ambiguous'"
     " WHERE o.match_kind = 'unknown'"
     "   AND EXISTS (SELECT 1 FROM devices d WHERE d.name = o.device_name)"),
]


def resolver(con) -> dict:
    with con.transaction(), con.cursor() as cur:
        for _, sql in RESOLVER_SQL:
            cur.execute(sql)
        cur.execute(
            "SELECT match_kind, count(*), count(DISTINCT device_name)"
            "  FROM syslog_outages GROUP BY match_kind"
        )
        por_clase = {k: (n, d) for k, n, d in cur.fetchall()}
        cur.execute(
            "SELECT count(DISTINCT device_name) FROM syslog_outages"
        )
        (nombres,) = cur.fetchone()
    return {"nombres": nombres, "por_clase": por_clase}


def nombres_sin_resolver(con, limite: int = 200) -> list[tuple[str, int]]:
    return con.execute(
        "SELECT device_name, count(*) FROM syslog_outages"
        " WHERE match_kind = 'unknown' GROUP BY device_name"
        " ORDER BY 2 DESC, 1 LIMIT %s", (limite,)
    ).fetchall()


# ─────────────────────────────────────────────────────────────────────────────
# ¿Elegimos bien la zona horaria?
# ─────────────────────────────────────────────────────────────────────────────

def verificar_zona(con, tolerancia_s: int = 120, horas=range(-12, 13)) -> list[tuple]:
    """Convierte la incógnita del reloj en una medición.

    Del 2026-06-12 al 2026-07-27 las dos fuentes se solapan: `outages` viene de
    The Dude con epoch unix —o sea UTC de verdad, sin ambigüedad— y el syslog
    viene de este importador con la zona que le dijimos. Si la zona es la
    correcta, las mismas caídas caen a la misma hora.

    Se prueba desplazando el syslog hora por hora y se cuenta cuántas caídas
    encuentran pareja. El desplazamiento ganador tiene que ser 0. Si gana +3, la
    zona está mal por tres horas — que es exactamente el error que ya apareció
    en la VM nueva, que venía en UTC.
    """
    salida = []
    for h in horas:
        (n,) = con.execute(
            "SELECT count(*) FROM syslog_outages s"
            " WHERE s.service_id IS NOT NULL AND s.closure = 'closed'"
            "   AND EXISTS (SELECT 1 FROM outages o"
            "                WHERE o.service_id = s.service_id"
            "                  AND abs(extract(epoch FROM"
            "                      (o.started_at - (s.started_at"
            "                       + make_interval(hours => %s))))) <= %s)",
            (h, tolerancia_s),
        ).fetchone()
        salida.append((h, n))
    return salida


# ═════════════════════════════════════════════════════════════════════════════
# Línea de comandos
# ═════════════════════════════════════════════════════════════════════════════

def buscar_archivos(directorio: str, patron: str) -> list[Path]:
    base = Path(directorio)
    if not base.is_dir():
        raise SystemExit(f"{directorio!r} no es un directorio")
    return sorted(p for p in base.glob(patron) if p.is_file())


def importar(con, rutas, tz: str = SYSLOG_TZ, forzar: bool = False,
             min_dias: int = HUECO_MIN_DIAS) -> dict:
    """Pasada completa: parsear, cargar, reconstruir y resolver."""
    validar_zona(con, tz)
    total = Counter(cargado=0, saltado=0)
    for ruta in rutas:
        a = parsear_archivo(ruta)
        estado = importar_archivo(con, a, tz, forzar)
        total[estado] += 1
        total["lineas"] += a.lineas
        total["eventos"] += len(a.eventos)
        total["otras"] += len(a.otras)
        total["ignoradas"] += a.ignoradas
        total["vacias"] += a.vacias
        total["duplicadas"] += a.duplicadas
    recon = reconstruir_en_bd(con, min_dias)
    res = resolver(con)
    return {"archivos": dict(total), "reconstruccion": recon, "resolucion": res}


def _imprimir_reporte(con) -> None:
    p = print
    fila = con.execute(
        "SELECT count(*), coalesce(sum(lines),0), coalesce(sum(service_lines),0),"
        "       coalesce(sum(other_lines),0), coalesce(sum(ignored_lines),0),"
        "       coalesce(sum(duplicate_lines),0), min(first_event), max(last_event)"
        "  FROM syslog_files"
    ).fetchone()
    p(f"\narchivos importados : {fila[0]}")
    p(f"líneas              : {fila[1]}")
    p(f"  de servicio       : {fila[2]}")
    p(f"  otras (MikroTik)  : {fila[3]}")
    p(f"  no entendidas     : {fila[4]}")
    p(f"  repetidas exactas : {fila[5]}")
    p(f"rango               : {fila[6]} → {fila[7]}")

    p("\nestados vistos")
    for st, n in con.execute(
        "SELECT state, count(*) FROM syslog_events GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        p(f"  {st:<20} {n:>8}")

    p("\nmotivos de caída")
    for rz, n in con.execute(
        "SELECT coalesce(reason,'(sin motivo)'), count(*) FROM syslog_events"
        " WHERE state = 'down' GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
    ).fetchall():
        p(f"  {rz:<20} {n:>8}")

    p("\ncaídas reconstruidas")
    for cl, n, dur in con.execute(
        "SELECT closure, count(*), coalesce(sum(duration_s),0) FROM syslog_outages"
        " GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        p(f"  {cl:<20} {n:>8}   {dur:>12} s acumulados")
    (cruzan,) = con.execute(
        "SELECT count(*) FROM syslog_outages WHERE spans_gap"
    ).fetchone()
    p(f"  {'cruzan un hueco':<20} {cruzan:>8}   ← NO creerles la duración")

    p("\nresolución nombre → id")
    for mk, n, d in con.execute(
        "SELECT match_kind, count(*), count(DISTINCT device_name)"
        "  FROM syslog_outages GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        p(f"  {mk:<20} {n:>8} caídas   {d:>5} nombres")

    p("\ncobertura por año (los huecos son reales, no un error)")
    for anio, n in con.execute(
        "SELECT extract(year FROM occurred_at)::int, count(*)"
        "  FROM syslog_events GROUP BY 1 ORDER BY 1"
    ).fetchall():
        p(f"  {anio}  {n:>8}")
    faltan = con.execute(
        "SELECT mes FROM v_syslog_cobertura WHERE hueco ORDER BY mes"
    ).fetchall()
    if faltan:
        p(f"  meses SIN un solo evento: {len(faltan)}"
          f"  ({faltan[0][0]:%Y-%m} … {faltan[-1][0]:%Y-%m})")

    p("\nlo que NO es un evento de servicio")
    for tp, n in con.execute(
        "SELECT coalesce(topics,'(sin tópicos)'), count(*) FROM syslog_other"
        " GROUP BY 1 ORDER BY 2 DESC LIMIT 15"
    ).fetchall():
        p(f"  {tp:<32} {n:>6}")
    (autenticacion,) = con.execute(
        "SELECT count(*) FROM syslog_other WHERE message ILIKE '%%failed to authenticate%%'"
    ).fetchone()
    p(f"  → de ésas, «failed to authenticate»: {autenticacion}")

    muestras = con.execute(
        "SELECT name, ignored_lines, ignored_samples FROM syslog_files"
        " WHERE ignored_lines > 0 ORDER BY ignored_lines DESC LIMIT 5"
    ).fetchall()
    if muestras:
        p("\nlíneas que el parser no entendió (muestra por forma)")
        for nombre, n, ms in muestras:
            p(f"  {nombre} — {n} líneas")
            for m in ms[:5]:
                p(f"      {m}")
    p("")


def main(argv=None) -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
        stream=sys.stdout,
    )
    ap = argparse.ArgumentParser(
        prog="syslog", description="Importa la historia de caídas del syslog de The Dude"
    )
    ap.add_argument("--url", default=DATABASE_URL, help="DATABASE_URL de PostgreSQL")
    sub = ap.add_subparsers(dest="cmd", required=True)

    imp = sub.add_parser("importar", help="parsear archivos y cargarlos")
    imp.add_argument("rutas", nargs="*", help="archivos sueltos (o usá --dir)")
    imp.add_argument("--dir", default=SYSLOG_DIR)
    imp.add_argument("--glob", default="*.txt",
                     help="patrón dentro de --dir (default *.txt)")
    imp.add_argument("--tz", default=SYSLOG_TZ)
    imp.add_argument("--forzar", action="store_true",
                     help="releer también los archivos cuyo sha256 no cambió")
    imp.add_argument("--hueco-dias", type=int, default=HUECO_MIN_DIAS)

    rec = sub.add_parser("reconstruir", help="rehacer las caídas desde los eventos")
    rec.add_argument("--hueco-dias", type=int, default=HUECO_MIN_DIAS)

    sub.add_parser("resolver", help="volver a resolver nombre → id")
    sub.add_parser("reporte", help="qué hay cargado")

    zon = sub.add_parser("zona", help="¿la zona horaria elegida es la correcta?")
    zon.add_argument("--tolerancia", type=int, default=120)

    rei = sub.add_parser("reinterpretar", help="cambiar la zona horaria sin releer")
    rei.add_argument("--tz", required=True)

    args = ap.parse_args(argv)
    if not args.url:
        log.error("falta DATABASE_URL (o --url)")
        return 2

    import psycopg  # noqa: PLC0415 — así el módulo se puede importar sin psycopg

    with psycopg.connect(args.url, autocommit=True) as con:
        aplicar_esquema(con)

        if args.cmd == "importar":
            rutas = [Path(r) for r in args.rutas]
            if not rutas:
                if not args.dir:
                    log.error("pasá archivos, o --dir, o definí SYSLOG_DIR")
                    return 2
                rutas = buscar_archivos(args.dir, args.glob)
            if not rutas:
                log.error("ningún archivo coincide con %s en %s", args.glob, args.dir)
                return 2
            log.info("%d archivos, zona horaria %s", len(rutas), args.tz)
            r = importar(con, rutas, args.tz, args.forzar, args.hueco_dias)
            log.info("reconstrucción: %s", {k: v for k, v in
                                            r["reconstruccion"].items() if k != "huecos"})
            for a, b in r["reconstruccion"]["huecos"]:
                if (b - a).days >= 15:
                    log.warning("hueco de cobertura: %s → %s (%d días)",
                                a, b, (b - a).days)
            _imprimir_reporte(con)

        elif args.cmd == "reconstruir":
            log.info("%s", {k: v for k, v in
                            reconstruir_en_bd(con, args.hueco_dias).items()
                            if k != "huecos"})
            resolver(con)
            _imprimir_reporte(con)

        elif args.cmd == "resolver":
            log.info("%s", resolver(con))
            print("\nnombres que no resuelven (los 40 con más caídas)")
            for nombre, n in nombres_sin_resolver(con, 40):
                print(f"  {n:>6}  {nombre}")

        elif args.cmd == "reporte":
            _imprimir_reporte(con)

        elif args.cmd == "zona":
            print("\ndesplazamiento  caídas que coinciden con `outages`")
            mejor = None
            for h, n in verificar_zona(con, args.tolerancia):
                if mejor is None or n > mejor[1]:
                    mejor = (h, n)
                print(f"  {h:+3d} h        {n:>8}")
            if mejor:
                print(f"\nmejor desplazamiento: {mejor[0]:+d} h con {mejor[1]} "
                      f"coincidencias — si no es 0, la zona horaria está mal.")

        elif args.cmd == "reinterpretar":
            validar_zona(con, args.tz)
            with con.transaction():
                for tabla in ("syslog_events", "syslog_other"):
                    con.execute(
                        f"UPDATE {tabla} SET occurred_at ="
                        f" occurred_local AT TIME ZONE %s", (args.tz,)
                    )
                con.execute("UPDATE syslog_files SET tz = %s", (args.tz,))
            log.info("reinterpretado con %s, reconstruyo", args.tz)
            reconstruir_en_bd(con)
            resolver(con)
            _imprimir_reporte(con)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
