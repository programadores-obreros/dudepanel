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

#: 🔴 CORREGIDO el 31/07/2026. Un elemento de mapa se clasifica con DOS campos,
#:    no con uno, y FORMATO-DUDE.md documenta mal este punto.
#:
#:    `type` es el discriminador de primer nivel:
#:        type = 1  → es un ENLACE   (usa linkID / linkFrom / linkTo)
#:        type = 0  → es un NODO     (y recién ahí manda `itemType`)
#:
#:    Medida completa sobre los 2.317 elementos, cruzando ambos campos:
#:
#:      type  itemType   n     linkID   itemID apunta a
#:      ───────────────────────────────────────────────────
#:        0       0     884       —     device   (884/884)
#:        0       1       2       —     network  (2/2)
#:        0       2     161       —     map      (161/161)
#:        0       3     100       —     nada  → rótulo de texto libre
#:        1       0   1.170    1.170    nada  → enlace
#:
#:    El doc dice «itemType 0 = dispositivo (2.054), itemType 3 = enlace (100)».
#:    Los 2.054 son 884 dispositivos + 1.170 enlaces sumados por ignorar `type`,
#:    y los «100 enlaces» son en realidad 100 rótulos: ninguno tiene linkID.
#:    Los enlaces de verdad son 1.170 — uno por cada objeto enlace menos uno.
ELEMENTO = {0: "device", 1: "network", 2: "submap", 3: "static"}

#: Un elemento con `type` = 1 es un enlace, sin importar su `itemType`.
ELEMENTO_ENLACE = 1

#: status de un servicio. Derivado de los cuatro colores que define la
#: configuración del servidor y verificado contra la interfaz web de The Dude.
ESTADO = {0: "unknown", 1: "up", 2: "partial", 3: "down"}

#: 🔴 Campos que NUNCA se leen. The Dude guarda las credenciales de cada router
#: en forma recuperable —tiene que presentarlas al autenticarse, no puede usar
#: hashes— y un panel de sólo lectura no tiene razón para conocerlas.
#: No se enmascaran: no se leen. Una base que no las contiene no las filtra.
#:
#: 🔴 `customField` se agregó el 31/07/2026 y NO es paranoia preventiva: en la
#:    base de el ISP seis dispositivos tienen la contraseña del equipo escrita
#:    a mano en `customField1`, en claro y con formato `usuario:clave`. El campo
#:    es texto libre, así que la convención de nombres no protege nada: lo único
#:    que protege es no leerlo.
SECRETO = re.compile(
    r"(pass|pwd|secret|community|privkey|authkey|wpa|psk|customField|^user$)",
    re.I,
)

#: Campos que SIEMPRE son números aunque sus bytes caigan en rango imprimible.
#: Sin esto el puerto 80 (0x0050) se lee como la letra 'P'.
_NUMERICO = re.compile(
    r"(port|count|interval|timeout|speed|size|scale|zoom|thickness|width|"
    r"height|opacity|refresh|ID$|IDs$|Color$|^itemX$|^itemY$|^time)",
    re.I,
)

#: 🔴 CORREGIDO el 31/07/2026. Acá había una regla `(port|^time|snmpType)` que
#:    leía esos campos en big-endian. **Está mal: TODO entero de 4 bytes de este
#:    formato es little-endian.** Sólo son big-endian el `u16` de largo del
#:    encabezado de cada registro y las IPv4, que se decodifican aparte.
#:
#:    Medido sobre la base real, comparando las dos lecturas:
#:
#:      campo                bytes          little-endian   big-endian
#:      ────────────────────────────────────────────────────────────────────
#:      probe 'http'.defaultPort   50 00 00 00        80    1.342.177.280
#:      probe 'ssh'.defaultPort    16 00 00 00        22      369.098.752
#:      snmpProfile.port           a1 00 00 00       161    2.701.131.776
#:      config.webServerPort       91 1f 00 00     8.081    2.434.727.936
#:      config.snmpTrapPort        a2 00 00 00       162    2.717.908.992
#:      linkType 'ethernet'.snmpType 06 00 00 00       6      100.663.296
#:
#:    80, 22, 161, 8081, 162 y el ifType 6 de IANA no son coincidencias.
#:
#:    El error venía del propio FORMATO-DUDE.md, que documenta «puertos en
#:    big-endian, `00 A1` = 161». Los bytes reales son `A1 00 00 00`: alguien
#:    vio el `A1` primero y lo leyó al revés.


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
    """Cadena sin el relleno de ceros. None si queda vacía.

    🔴 Corregido el 31/07/2026. Acá se decodificaba siempre en latin-1, y está
       mal: **The Dude escribe el texto que tipea el usuario en UTF-8.**

       La evidencia es un solo caso en la base real, porque casi no hay acentos
       cargados —una nota que dice `'Está arriba en la torre.'`, bytes `c3 a1`—
       pero es concluyente: leída en latin-1 sale `'EstÃ¡ arriba en la torre.'`.
       El día que alguien escriba «Estación» en el nombre de un equipo, el panel
       mostraría «EstaciÃ³n».

       Se intenta UTF-8 y se cae a latin-1 sólo si no es válido. Ese respaldo no
       es paranoia: los campos que **no** son texto —identificadores, colores,
       coordenadas— tienen bytes altos que no forman UTF-8, y esta función los
       recibe igual cuando el llamador todavía no sabe de qué tipo son. En
       latin-1 cualquier byte es válido, así que nunca lanza y nunca pierde
       datos.
    """
    b = v.rstrip(b"\x00")
    if not b:
        return None
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("latin-1")


def entero(nombre: str, v: bytes) -> int | None:
    """Entero little-endian. Devuelve None para 0xFFFFFFFF («ninguno»).

    `nombre` ya no decide el endianness —ver la nota de arriba: no hay campos
    big-endian— pero sigue en la firma porque toda la API del módulo es
    `(campo, bytes)` y porque, si algún día apareciera una excepción medida,
    este es el único lugar donde tendría que vivir.
    """
    if len(v) not in (1, 2, 4):
        return None
    if len(v) == 1:
        return v[0]
    n = int.from_bytes(v, "little")
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


def cadenas(v: bytes) -> list[str]:
    """Lista de cadenas, cada una precedida por su largo en u32 little-endian.

    Es un tercer encaje de listas que FORMATO-DUDE.md no menciona —hay listas
    de 4 bytes (ids, IPs) y de 6 (MAC), pero las de texto son de largo variable
    y necesitan el prefijo. Se usa al menos en `dnsNames`.

    Si el recorrido no cierra exacto en el final del campo, devuelve [] en vez
    de adivinar: un nombre DNS mal cortado es peor que ninguno.
    """
    salida: list[str] = []
    i = 0
    while i + 4 <= len(v):
        (n,) = struct.unpack_from("<I", v, i)
        i += 4
        if n > len(v) - i:
            return []
        salida.append(v[i:i + n].decode("latin-1", "replace"))
        i += n
    return salida if i == len(v) else []


def color(v: bytes) -> int | None:
    """Color de The Dude → entero 0xRRGGBB, listo para `#%06x`.

    Son 4 bytes en orden R, G, B, 0 (el COLORREF de Windows leído como entero
    little-endian da lo mismo). El cuarto byte es siempre 0 y NO es alfa.

    Medido contra los colores que el propio The Dude usa para pintar el mapa:

        upColor            1b d0 11 00  →  #1bd011   verde
        downCompleteColor  ff 06 06 00  →  #ff0606   rojo
        downPartialColor   ff 80 00 00  →  #ff8000   naranja
        unknownColor       d2 d2 d2 00  →  #d2d2d2   gris

    Leerlo como u32 little-endian daría #0606ff para «caído»: azul. Que el rojo
    salga rojo y el naranja naranja es la prueba de que el orden es R, G, B.
    """
    if v is None or len(v) != 4 or v == b"\xff\xff\xff\xff":
        return None
    return (v[0] << 16) | (v[1] << 8) | v[2]


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
    if nombre == "dnsNames":
        c = cadenas(v)
        return c or None
    if nombre.endswith("Color"):
        return color(v)
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

    def _leer(self, nombre: str) -> bytes | None:
        """Devuelve los bytes de un campo, o None si el campo es secreto.

        🔴 Agregado el 31/07/2026, y corrige una mentira de la documentación.

           El README, `schema.sql` y los propios comentarios afirmaban que
           `SECRETO` protegía el ETL «antes de que los valores existan en
           memoria». **Era falso**: el filtro vivía sólo en `valor()`, que se usa
           desde `get()`, y una auditoría contó **54 llamadas a los accesores en
           `sync.py` y CERO a `get()`**. `o.txt("pwd")` habría devuelto la
           contraseña sin pasar por ningún filtro.

           Lo que de hecho protegía era la lista de campos escrita a mano en
           `extraer()`. Eso funciona —y de hecho funcionó— pero no era lo que
           decía la documentación, y esa diferencia importa: el próximo que
           agregue un campo iba a creer que había una red debajo.

           Ahora la hay. Todos los accesores pasan por acá, así que la afirmación
           pasó a ser cierta en vez de aspiracional.
        """
        if SECRETO.search(nombre):
            return None
        return self.campos.get(nombre)

    def crudo(self, nombre: str) -> bytes | None:
        return self._leer(nombre)

    def get(self, nombre: str, por_defecto=None):
        v = self._leer(nombre)
        return por_defecto if v is None else valor(nombre, v)

    def num(self, nombre: str) -> int | None:
        v = self._leer(nombre)
        return None if v is None else entero(nombre, v)

    def txt(self, nombre: str) -> str | None:
        v = self._leer(nombre)
        return None if v is None else texto(v)

    def bool_(self, nombre: str) -> bool | None:
        v = self._leer(nombre)
        return None if v is None else booleano(v)

    def lista_ids(self, nombre: str) -> list[int]:
        v = self._leer(nombre)
        return [] if v is None else ids(v)

    def ips(self, nombre: str) -> list[str]:
        v = self._leer(nombre)
        return [] if v is None else direcciones(v)

    def macs(self, nombre: str = "macs") -> list[str]:
        v = self.campos.get(nombre)
        return [] if v is None else macs(v)

    def cadenas(self, nombre: str) -> list[str]:
        v = self.campos.get(nombre)
        return [] if v is None else cadenas(v)

    def color(self, nombre: str) -> int | None:
        v = self.campos.get(nombre)
        return None if v is None else color(v)


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

    🔴 Corregido el 31/07/2026. Antes esto EMITÍA mientras leía, con el bucle de
       reintentos por fuera del `yield`. Si el bloqueo llegaba a mitad de la
       lectura —que es EL caso típico, porque The Dude toma el lock exclusivo al
       confirmar cada 10 s— el reintento volvía a emitir desde cero lo ya
       emitido.

       Medido inyectando un `database is locked` en la fila 500:

           objetos leídos 15.425 · únicos 14.925 · DUPLICADOS 500

       Aguas abajo eso terminaba siempre en `UniqueViolation: files_pkey`. El
       snapshot anterior sobrevivía —falla cerrado, eso estaba bien— pero **el
       reintento no podía tener éxito nunca** en el único escenario para el que
       existe, y en `sync_runs.error` quedaba «clave duplicada» en vez de «la
       base estaba bloqueada». Diagnosticar eso a las 3 de la mañana es horrible.

       Ahora se acumula dentro del `try` y se devuelve entero. No cuesta memoria
       extra: quien llama ya hacía `list(...)`.
    """
    ultimo: Exception | None = None
    for n in range(intentos):
        try:
            con = abrir(ruta)
            try:
                leidos = [
                    objeto(oid, bytes(blob))
                    for oid, blob in con.execute("SELECT id, obj FROM objs")
                    if blob
                ]
            finally:
                con.close()
            yield from leidos
            return
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
