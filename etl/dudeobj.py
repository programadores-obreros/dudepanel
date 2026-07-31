"""Decodificador del formato de objetos de The Dude 4.0beta3.

El contrato completo está en `docs/FORMATO-DUDE.md`. Acá va sólo lo que hace
falta para leer un blob; las decisiones y su porqué están documentadas allá.

Todo lo de este módulo se obtuvo por inspección de la base real de el ISP
(14.925 objetos). MikroTik nunca documentó este formato, y no lo va a hacer:
The Dude 4.0beta3 es de enero de 2011, es la última versión para Windows y está
discontinuado.

**Eso, que suena a problema, es la garantía del proyecto: el formato no puede
cambiar porque el proveedor se fue.**

🔴 SÓLO LECTURA. Este módulo nunca abre la base para escritura. La base viva es
   el monitoreo de producción de un ISP.
"""
from __future__ import annotations

import re
import sqlite3
import struct
import time
from dataclasses import dataclass, field
from typing import Iterator

# ─────────────────────────────────────────────────────────────────────────────
# Constantes del formato
# ─────────────────────────────────────────────────────────────────────────────

#: The Dude usa 0xFFFFFFFF donde otros usarían NULL. NO es 4.294.967.295.
NINGUNO = 0xFFFFFFFF

#: Cabecera de un journal SQLite "caliente" (transacción sin confirmar).
#: Su mera EXISTENCIA no dice nada: en journal_mode=PERSIST el archivo queda
#: para siempre. Sólo la cabecera distingue.
JOURNAL_CALIENTE = bytes.fromhex("d9d505f920a163d7")

#: sys-type < 0x100 es el esquema (igual en toda instalación de The Dude).
#: Los de arriba son instancias: cada mapa y cada log recibe el suyo al crearse.
TIPO = {
    0x03: "config",
    0x04: "tool",
    0x05: "file",
    0x07: "log",
    0x0A: "map",
    0x0D: "probe",
    0x0E: "device_type",
    0x0F: "device",
    0x10: "network",
    0x11: "service",
    0x14: "permission_group",
    0x15: "user",
    0x18: "notification",
    0x1F: "link",
    0x22: "link_type",
    0x29: "running_probe",
    0x2A: "chart",
    0x39: "function",
    0x3A: "snmp_profile",
    0x43: "syslog_rule",
    0x01: "list",
}

#: itemType de un elemento de mapa. Medido, no supuesto:
#: 2.054 dispositivos · 2 redes · 161 submapas · 100 enlaces.
ELEMENTO = {0: "device", 1: "network", 2: "submap", 3: "link"}

#: status de un servicio. Derivado de los cuatro colores que define la
#: configuración del servidor y verificado contra la interfaz web de The Dude.
ESTADO = {0: "unknown", 1: "up", 2: "partial", 3: "down"}

#: 🔴 Campos que NUNCA se leen. The Dude guarda las credenciales de cada router
#: en forma recuperable —tiene que presentarlas al autenticarse, no puede usar
#: hashes— y un panel de sólo lectura no tiene razón para conocerlas.
#: No se enmascaran: no se leen. Una base que no las contiene no las filtra.
SECRETO = re.compile(
    r"(pass|pwd|secret|community|privkey|authkey|wpa|psk|^user$)", re.I
)

#: Campos que SIEMPRE son números aunque sus bytes caigan en rango imprimible.
#: Sin esto el puerto 80 (0x0050) se lee como la letra 'P'.
_NUMERICO = re.compile(
    r"(port|count|interval|timeout|speed|size|scale|zoom|thickness|width|"
    r"height|opacity|refresh|ID$|IDs$|Color$|^itemX$|^itemY$|^time)",
    re.I,
)

#: Estos van en big-endian. El resto de los enteros va en little-endian.
_BIG_ENDIAN = re.compile(r"(port|^time|snmpType)", re.I)


# ─────────────────────────────────────────────────────────────────────────────
# Lectura del blob
# ─────────────────────────────────────────────────────────────────────────────

def registros(blob: bytes) -> list[tuple[str, bytes]]:
    """Devuelve [(nombre, valor_crudo)] del blob, en el orden en que vienen.

    Formato:  u8 largoNombre | nombre | u16be largoValor | valor

    Nunca lanza por un blob truncado: corta y devuelve lo que pudo leer. Un
    objeto ilegible es un dato menos, no una sincronización caída.
    """
    salida: list[tuple[str, bytes]] = []
    i, n = 0, len(blob)
    while i < n:
        largo = blob[i]
        i += 1
        if i + largo > n:
            break
        nombre = blob[i:i + largo].decode("latin-1", "replace")
        i += largo
        if i + 2 > n:
            break
        (lv,) = struct.unpack_from(">H", blob, i)
        i += 2
        if i + lv > n:
            break
        salida.append((nombre, blob[i:i + lv]))
        i += lv
    return salida


def texto(v: bytes) -> str | None:
    """Cadena latin-1 sin el relleno de ceros. None si queda vacía."""
    t = v.rstrip(b"\x00").decode("latin-1", "replace")
    return t or None


def entero(nombre: str, v: bytes) -> int | None:
    """Entero, respetando el endianness que corresponde al campo.

    Devuelve None para 0xFFFFFFFF, que en The Dude significa «ninguno».
    """
    if len(v) not in (1, 2, 4):
        return None
    if len(v) == 4 and v == b"\xff\xff\xff\xff":
        return None
    if len(v) == 1:
        return v[0]
    orden = "big" if _BIG_ENDIAN.search(nombre) else "little"
    n = int.from_bytes(v, orden)
    return None if n == NINGUNO else n


def booleano(v: bytes) -> bool | None:
    return None if len(v) != 1 else v[0] != 0


def direcciones(v: bytes) -> list[str]:
    """IPv4 empaquetadas en big-endian, N por campo. Descarta 0.0.0.0."""
    if not v or len(v) % 4:
        return []
    out = []
    for i in range(0, len(v), 4):
        ip = ".".join(str(b) for b in v[i:i + 4])
        if ip != "0.0.0.0":
            out.append(ip)
    return out


def ids(v: bytes) -> list[int]:
    """Lista de identificadores u32 little-endian. Descarta los «ninguno»."""
    if not v or len(v) % 4:
        return []
    return [
        n for i in range(0, len(v), 4)
        if (n := int.from_bytes(v[i:i + 4], "little")) not in (0, NINGUNO)
    ]


def macs(v: bytes) -> list[str]:
    """Direcciones MAC, 6 bytes cada una."""
    if not v or len(v) % 6:
        return []
    return [
        ":".join(f"{b:02x}" for b in v[i:i + 6])
        for i in range(0, len(v), 6)
    ]


def valor(nombre: str, v: bytes):
    """Interpreta un campo con la heurística correcta según su nombre.

    Devuelve None para los campos secretos: **no se leen**.
    """
    if SECRETO.search(nombre):
        return None
    if len(v) == 0:
        return None
    if re.search(r"address", nombre, re.I) and len(v) % 4 == 0:
        d = direcciones(v)
        return d or None
    if nombre == "macs":
        m = macs(v)
        return m or None
    if len(v) == 1:
        return v[0]
    if _NUMERICO.search(nombre) or not _imprimible(v):
        if len(v) in (2, 4):
            return entero(nombre, v)
        if len(v) % 4 == 0 and nombre.endswith("IDs"):
            return ids(v) or None
    return texto(v)


def _imprimible(v: bytes) -> bool:
    return all(32 <= c < 127 or c in (0, 9, 10, 13) for c in v)


# ─────────────────────────────────────────────────────────────────────────────
# Objeto
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(slots=True)
class Objeto:
    """Un objeto de The Dude, ya decodificado."""

    id: int
    sys_type: int | None
    nombre: str | None
    campos: dict[str, bytes] = field(repr=False, default_factory=dict)

    @property
    def clase(self) -> str:
        """Nombre legible del tipo, o 'instance:N' si es una instancia."""
        if self.sys_type is None:
            return "?"
        return TIPO.get(self.sys_type, f"instance:{self.sys_type}")

    def crudo(self, nombre: str) -> bytes | None:
        return self.campos.get(nombre)

    def get(self, nombre: str, por_defecto=None):
        v = self.campos.get(nombre)
        return por_defecto if v is None else valor(nombre, v)

    def num(self, nombre: str) -> int | None:
        v = self.campos.get(nombre)
        return None if v is None else entero(nombre, v)

    def txt(self, nombre: str) -> str | None:
        v = self.campos.get(nombre)
        return None if v is None else texto(v)

    def bool_(self, nombre: str) -> bool | None:
        v = self.campos.get(nombre)
        return None if v is None else booleano(v)

    def lista_ids(self, nombre: str) -> list[int]:
        v = self.campos.get(nombre)
        return [] if v is None else ids(v)

    def ips(self, nombre: str) -> list[str]:
        v = self.campos.get(nombre)
        return [] if v is None else direcciones(v)


def objeto(oid: int, blob: bytes) -> Objeto:
    campos = dict(registros(blob))
    st = campos.get("sys-type")
    return Objeto(
        id=oid,
        sys_type=int.from_bytes(st, "little") if st and len(st) == 4 else None,
        nombre=texto(campos.get("sys-name", b"")),
        campos=campos,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Acceso a la base — SÓLO LECTURA
# ─────────────────────────────────────────────────────────────────────────────

class BaseOcupada(RuntimeError):
    """La base estuvo bloqueada más allá de los reintentos."""


def abrir(ruta: str, timeout: float = 30.0) -> sqlite3.Connection:
    """Abre `dude.db` en modo estrictamente de sólo lectura.

    `mode=ro` no es cosmético: es la garantía de que un error nuestro no puede
    corromper el monitoreo de producción de un ISP.

    El `timeout` importa porque SQLite 3.6.14 —la versión compilada dentro de
    dude.exe, de 2009— **no tiene WAL**: en modo rollback journal el escritor
    toma bloqueo exclusivo al confirmar y todo lector recibe SQLITE_BUSY.
    """
    con = sqlite3.connect(f"file:{ruta}?mode=ro", uri=True, timeout=timeout)
    con.execute("PRAGMA query_only = ON")
    return con


def leer_objetos(
    ruta: str, intentos: int = 5, espera: float = 2.0
) -> Iterator[Objeto]:
    """Recorre todos los objetos, reintentando si The Dude tiene la base tomada.

    Reintenta con espera creciente. Si agota los intentos lanza `BaseOcupada`
    en vez de devolver una lista corta: **una sincronización parcial silenciosa
    sería peor que ninguna** — dejaría el panel mostrando una red que no existe.
    """
    ultimo: Exception | None = None
    for n in range(intentos):
        try:
            con = abrir(ruta)
            try:
                for oid, blob in con.execute("SELECT id, obj FROM objs"):
                    if blob:
                        yield objeto(oid, bytes(blob))
                return
            finally:
                con.close()
        except sqlite3.OperationalError as e:
            if "locked" not in str(e).lower() and "busy" not in str(e).lower():
                raise
            ultimo = e
            time.sleep(espera * (2 ** n))
    raise BaseOcupada(
        f"la base siguió bloqueada tras {intentos} intentos: {ultimo}"
    ) from ultimo


def user_version(ruta: str) -> int:
    """`PRAGMA user_version` — tiene que ser 1.

    Vive en la CABECERA del archivo, bytes 60-63, no en el esquema. Un `.dump`
    no la copia. Si The Dude abre una base con 0, concluye que está vacía y le
    escribe 152 objetos por defecto encima: medido, `objs` cayó de 14.916 a 454.
    """
    con = abrir(ruta)
    try:
        return con.execute("PRAGMA user_version").fetchone()[0]
    finally:
        con.close()
