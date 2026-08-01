"""El camino de red hacia un destino, salto por salto, con el dueño de cada uno.

    python camino.py trazar 192.0.2.10
    python camino.py correr            # todos los destinos registrados
    python camino.py reporte

Contesta la pregunta cara de la madrugada: **¿el problema es mío o del
mayorista?**. Un `traceroute` dice por dónde pasa el tráfico; esto además dice
de qué ORGANIZACIÓN es cada salto público, lo guarda con fecha, y avisa cuando
el camino CAMBIÓ respecto de la vez anterior.

Las tablas están en `schema.sql`, en el bloque «EL CAMINO DE RED».


═══════════════════════════════════════════════════════════════════════════════
 🔴 1 · NINGUNA DIRECCIÓN INTERNA SALE DE ESTA MÁQUINA
═══════════════════════════════════════════════════════════════════════════════

Resolver el ASN de un salto es preguntarle a un tercero (Team Cymru) por una
dirección IP. Si esa dirección es de la red del ISP, la pregunta PUBLICA la
topología interna: un `10.x.y.z` de gestión viajando a un servidor DNS ajeno le
cuenta a alguien cómo está armada la red por dentro.

Medido sobre la base real el 01/08/2026: de las 894 direcciones de los 885
equipos, **807 son privadas** (650 en 10/8, 128 en 172.16/12, 17 en CGNAT
100.64/10, 12 en 192.168/16) y sólo 87 son públicas. O sea que el caso normal
—nueve de cada diez— es justamente el que no puede salir.

La defensa está en tres capas, a propósito, porque una sola se rompe cuando
alguien la refactorea sin leer el comentario:

  1. `es_publica()` es el ÚNICO lugar que decide. Devuelve `True` sólo para
     unicast global de verdad.
  2. `nombre_origen()` y `ResolutorASN.resolver()` **levantan `ValueError`** si
     les pasás algo que no sea público. No devuelven `None` en silencio: si el
     llamador se equivocó, hay que enterarse.
  3. La tabla `camino_asn_cache` tiene un `CHECK` que rechaza toda dirección no
     enrutable globalmente. La base es la última barrera y no depende de que
     este archivo esté bien.

`test_camino.py` espía el resolutor DNS y verifica que la lista de nombres
consultados no contenga NI UNA dirección no pública, y que las tres capas
coincidan entre sí y con el `CHECK` de la base.

Y hay un interruptor general: `CAMINO_ASN=0` desactiva toda consulta externa.
El camino se traza igual; los saltos públicos quedan sin ASN y se ven como tal.


═══════════════════════════════════════════════════════════════════════════════
 🔴 2 · POR QUÉ UDP CON `IP_RECVERR`, Y NO ICMP NI RAW
═══════════════════════════════════════════════════════════════════════════════

El contenedor del ETL corre `cap_drop: [ALL]`, `read_only: true` y como usuario
`dude` (uid 10001). Medido el 01/08/2026 dentro de un contenedor con ESE mismo
perfil (`docker run --cap-drop ALL --read-only --user 10001:10001`):

    técnica                      resultado
    ─────────────────────────────────────────────────────────────────────
    socket RAW (ICMP a mano)     ❌ [Errno 1] Operation not permitted
    socket ICMP SOCK_DGRAM       ⚠️  anda… pero sólo por un sysctl del ANFITRIÓN
    UDP + IP_RECVERR             ✅ 8 saltos, del 1 al destino

El «⚠️» es el punto. `SOCK_DGRAM/IPPROTO_ICMP` (el «ping socket») depende de
`net.ipv4.ping_group_range`, que Docker deja abierto de fábrica en `0
2147483647`. Volviendo a medir con ese sysctl endurecido:

    docker run --sysctl net.ipv4.ping_group_range="1 0" …
      ICMP SOCK_DGRAM: ❌ [Errno 13] Permission denied
      UDP + IP_RECVERR: ✅ los mismos 8 saltos, sin tocar nada

O sea: la técnica ICMP funciona hasta que un administrador endurece el
anfitrión, y ahí se rompe **en la máquina de producción y no en la de
desarrollo**. UDP no pide ningún permiso especial ni ningún sysctl: es un
socket de datagramas común.

Cómo funciona: se manda un UDP con el TTL puesto a mano a un puerto alto que
nadie escucha. El router que agota el TTL responde ICMP 11/0 y el destino
responde ICMP 3/3 (puerto inalcanzable). Un proceso sin privilegios NO puede
abrir un socket para leer ICMP… pero Linux le entrega los errores ICMP de SU
propio socket por la cola de errores: `setsockopt(IP_RECVERR)` +
`recvmsg(MSG_ERRQUEUE)`. Ahí viene el tipo, el código y la dirección del router
que se quejó, que es exactamente lo que necesita un traceroute.

⚠️ **Y hay que esperar con `poll()`, no con `sleep()`.** La primera medición dio
   5,1 ms clavados en TODOS los saltos, incluido el primero. No era la red: era
   el `time.sleep(0.005)` del bucle. Con `poll()` el primer salto —el gateway
   del contenedor— da **0,12 ms**, que es lo que tiene que dar. Un RTT
   inventado por el instrumento es peor que no medir.

`tcp-recverr` (SYN a un puerto abierto) está implementado y atraviesa más
cortafuegos, pero no es el default: un SYN a medio abrir queda en la tabla de
conexiones del destino, y UDP a puerto cerrado se cierra solo con el ICMP 3/3.


═══════════════════════════════════════════════════════════════════════════════
 🔴 3 · ESTO NO PUEDE CORRER EN EL CONTENEDOR DEL ETL
═══════════════════════════════════════════════════════════════════════════════

En `compose.prod.yml` el servicio `etl` está en la red `interna`, que es
`internal: true`. Medido: un contenedor en una red interna de Docker no llega a
ningún lado —

    ttl 1 {'senderr': '[Errno 101] Network is unreachable'}

— y tampoco resuelve DNS hacia afuera. Es correcto que sea así: el ETL no tiene
nada que hacer en internet.

`camino.py` necesita lo contrario, así que va como un servicio APARTE con
`networks: [interna, borde]` —igual que hace `web`— o se corre a mano desde un
contenedor con salida. Meterlo en el bucle de `sync.py` sería, además de
imposible por la red, un error de diseño: `sync.py` corre cada 30 s y trazar
cada 30 s es exactamente el abuso que la sección 4 evita.


═══════════════════════════════════════════════════════════════════════════════
 🔴 4 · LÍMITES EXPLÍCITOS — trazar es tráfico normal, barrer no
═══════════════════════════════════════════════════════════════════════════════

    ttl_max                20 saltos    (no 30: la traza real a un destino de
                                        internet cerró en 8)
    sondas por salto        1           (traceroute clásico manda 3)
    corte por silencio      5 mudos seguidos
    pausa entre sondas     50 ms        → tope duro de 20 paquetes/s
    intervalo por destino  300 s        (`correr` saltea lo trazado hace menos)
    destinos por corrida   50
    consultas ASN/corrida  200
    caché de ASN            7 días

Peor caso de UNA traza: 20 paquetes UDP de 32 bytes. Peor caso de una corrida
completa: 50 destinos × 20 = 1.000 paquetes a 20 pps ≈ 50 s. Eso es menos de lo
que The Dude manda en un segundo (1.929 sondeos/s medidos el 31/07/2026).

🔴 Lo que este módulo NO hace, y no es un olvido: no traza a los 885 equipos.
   885 × 20 = 17.700 paquetes ya no se parece a «tráfico normal», y además no
   serviría — el valor está en los pocos destinos que cruzan al mayorista.
   Por eso los destinos son una tabla y se registran a mano.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import logging
import os
import random
import select
import socket
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger("camino")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
SCHEMA_FILE = os.environ.get("SCHEMA_FILE", str(Path(__file__).with_name("schema.sql")))


def _entero(nombre: str, por_defecto: int) -> int:
    try:
        return int(os.environ.get(nombre, por_defecto))
    except ValueError:
        log.warning("%s no es un número, uso %s", nombre, por_defecto)
        return por_defecto


def _flotante(nombre: str, por_defecto: float) -> float:
    try:
        return float(os.environ.get(nombre, por_defecto))
    except ValueError:
        log.warning("%s no es un número, uso %s", nombre, por_defecto)
        return por_defecto


#: Ver la sección 4 del encabezado. Cada uno de estos números tiene un motivo.
TTL_MAX = _entero("CAMINO_TTL_MAX", 20)
SONDAS_POR_SALTO = _entero("CAMINO_SONDAS", 1)
TIMEOUT_S = _flotante("CAMINO_TIMEOUT_S", 2.0)
PAUSA_S = _flotante("CAMINO_PAUSA_S", 0.05)
MUDOS_SEGUIDOS = _entero("CAMINO_MUDOS_SEGUIDOS", 5)
INTERVALO_MIN_S = _entero("CAMINO_INTERVALO_MIN_S", 300)
MAX_DESTINOS = _entero("CAMINO_MAX_DESTINOS", 50)
MAX_CONSULTAS_ASN = _entero("CAMINO_MAX_CONSULTAS_ASN", 200)
ASN_TTL_DIAS = _entero("CAMINO_ASN_TTL_DIAS", 7)
#: Los `error` se recachean en minutos y no en días: un DNS caído no es una
#: respuesta sobre la dirección, es un fallo nuestro.
ASN_TTL_ERROR_MIN = _entero("CAMINO_ASN_TTL_ERROR_MIN", 15)

#: Puerto UDP base. El rango 33434+ es la convención de traceroute desde 1988 y
#: los cortafuegos que lo dejan pasar lo reconocen por eso.
PUERTO_BASE = _entero("CAMINO_PUERTO_BASE", 33434)

#: Interruptor general de consultas externas. `CAMINO_ASN=0` traza igual y deja
#: los saltos públicos sin ASN, marcados como «no consultado».
ASN_HABILITADO = os.environ.get("CAMINO_ASN", "1") not in ("0", "false", "no")

#: Linux: `include/uapi/linux/in.h`. Python no lo exporta en todas las
#: versiones, así que va el número.
IP_RECVERR = 11

#: Tipos ICMP que nos importan.
ICMP_TTL_AGOTADO = 11
ICMP_INALCANZABLE = 3


# ═════════════════════════════════════════════════════════════════════════════
#  La frontera: qué se puede preguntar afuera
# ═════════════════════════════════════════════════════════════════════════════

#: 🔴 ESPEJO EXACTO del `CHECK camino_asn_cache_publica_chk` de `schema.sql`.
#:
#:    Son constantes de RFC, no direcciones de nadie: si mañana el ISP cambia de
#:    numeración, esta lista no se toca. `test_camino.py` compara las dos listas
#:    carácter por carácter para que no se separen.
#:
#:    ¿Por qué una lista y no `ipaddress.is_global`? Porque `is_global` sola NO
#:    alcanza, y está medido: `224.0.0.1` (multicast) devuelve `is_global ==
#:    True`. Una dirección multicast no es un host enrutable y mandarla a Cymru
#:    no tiene sentido. Al revés también sorprende: `100.64.0.1` (CGNAT) tiene
#:    `is_private == False`, así que filtrar por `is_private` dejaría salir
#:    justo las 17 direcciones CGNAT que hay en la base.
#:
#:    O sea: las dos abreviaturas cómodas fallan, cada una por su lado. La lista
#:    explícita se puede leer, auditar y comparar contra el SQL.
NO_PUBLICAS: tuple[ipaddress.IPv4Network, ...] = tuple(
    ipaddress.ip_network(c)
    for c in (
        "0.0.0.0/8",        # «esta red»
        "10.0.0.0/8",       # RFC 1918 — 650 equipos del ISP
        "100.64.0.0/10",    # RFC 6598 CGNAT — 17 equipos
        "127.0.0.0/8",      # loopback
        "169.254.0.0/16",   # RFC 3927 link-local
        "172.16.0.0/12",    # RFC 1918 — 128 equipos
        "192.0.0.0/24",     # RFC 6890 asignaciones de protocolo
        "192.0.2.0/24",     # RFC 5737 documentación
        "192.168.0.0/16",   # RFC 1918 — 12 equipos
        "198.18.0.0/15",    # RFC 2544 pruebas de rendimiento
        "198.51.100.0/24",  # RFC 5737 documentación
        "203.0.113.0/24",   # RFC 5737 documentación
        "224.0.0.0/4",      # multicast
        "240.0.0.0/4",      # reservada (incluye 255.255.255.255)
    )
)


def es_publica(direccion: str | ipaddress.IPv4Address) -> bool:
    """¿Se le puede preguntar a un tercero por esta dirección?

    🔴 ESTA FUNCIÓN ES LA FRONTERA. Es el único lugar del módulo que decide si
       algo sale de la máquina. Todo lo demás la consulta.

    Ante la duda dice `False`: una dirección que no se puede ni parsear, o que
    es IPv6 (la red del ISP es IPv4 y no hay caso medido), no se consulta.
    """
    try:
        ip = ipaddress.ip_address(direccion)
    except ValueError:
        return False
    if not isinstance(ip, ipaddress.IPv4Address):
        return False
    return not any(ip in red for red in NO_PUBLICAS)


def clasificar(direccion: str | None) -> str:
    """`mudo` · `publica` · `interna` · `especial`.

    Para MOSTRAR. La decisión de consultar afuera la toma `es_publica()` y sólo
    ella; acá se separan las no públicas en dos para que la pantalla no mienta.

    `especial` (multicast, reservada, broadcast) no es lo mismo que `interna`:
    interna significa «es un equipo nuestro», y una multicast no es un equipo de
    nadie. Meterlas en la misma bolsa haría que el panel dibuje un salto que no
    existe como si fuera un router del ISP.
    """
    if direccion is None:
        return "mudo"
    if es_publica(direccion):
        return "publica"
    try:
        ip = ipaddress.ip_address(direccion)
    except ValueError:
        return "especial"
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return "especial"
    return "interna"


# ═════════════════════════════════════════════════════════════════════════════
#  Un cliente DNS mínimo, para consultar TXT
# ═════════════════════════════════════════════════════════════════════════════
#
# Sin `dnspython`. `requirements.txt` tiene UNA dependencia y el encabezado de
# ese archivo explica por qué; traer una biblioteca de DNS entera para mandar
# una pregunta TXT y leer una cadena sería el primer paso para dejar de tener
# ese archivo como está. Son ~70 líneas y el formato no cambió desde 1987.


def servidores_dns() -> list[str]:
    """De `CAMINO_DNS` o de `/etc/resolv.conf`.

    En Docker `resolv.conf` apunta al DNS embebido (127.0.0.11), que reenvía
    hacia afuera. Funciona; y si alguien quiere mandar estas consultas por un
    resolutor concreto —para auditarlas, por ejemplo— `CAMINO_DNS` lo permite
    sin tocar el contenedor.
    """
    manual = os.environ.get("CAMINO_DNS", "").strip()
    if manual:
        return [s.strip() for s in manual.split(",") if s.strip()]
    servidores: list[str] = []
    try:
        for linea in Path("/etc/resolv.conf").read_text(encoding="utf-8").splitlines():
            partes = linea.split()
            if len(partes) >= 2 and partes[0] == "nameserver":
                servidores.append(partes[1])
    except OSError as e:
        log.warning("no puedo leer /etc/resolv.conf: %s", e)
    return servidores


def _codificar_nombre(nombre: str) -> bytes:
    salida = bytearray()
    for etiqueta in nombre.rstrip(".").split("."):
        cruda = etiqueta.encode("ascii")
        if not 0 < len(cruda) < 64:
            raise ValueError(f"etiqueta DNS inválida: {etiqueta!r}")
        salida.append(len(cruda))
        salida += cruda
    salida.append(0)
    return bytes(salida)


def _saltar_nombre(datos: bytes, pos: int) -> int:
    """Devuelve la posición DESPUÉS del nombre que empieza en `pos`.

    Los nombres pueden venir comprimidos: dos bytes con los bits altos en 11
    son un puntero a otra parte del mensaje. No hace falta expandirlo —sólo
    saltearlo— porque lo único que queremos leer es el RDATA.
    """
    while pos < len(datos):
        largo = datos[pos]
        if largo == 0:
            return pos + 1
        if largo & 0xC0 == 0xC0:
            return pos + 2          # puntero: ocupa dos bytes y termina el nombre
        pos += 1 + largo
    raise ValueError("nombre DNS truncado")


def consultar_txt(
    nombre: str,
    servidores: list[str] | None = None,
    timeout: float = 3.0,
) -> list[str]:
    """Pregunta TXT y devuelve las cadenas de la respuesta.

    Lista vacía = el servidor contestó que no hay nada (NXDOMAIN o sin
    respuestas). `OSError` = no se pudo preguntar. La diferencia importa: lo
    primero se cachea una semana, lo segundo quince minutos.
    """
    if servidores is None:
        servidores = servidores_dns()
    if not servidores:
        raise OSError("no hay ningún servidor DNS configurado")

    ident = random.randrange(0, 0xFFFF)
    consulta = (
        struct.pack("!HHHHHH", ident, 0x0100, 1, 0, 0, 0)
        + _codificar_nombre(nombre)
        + struct.pack("!HH", 16, 1)          # QTYPE=TXT, QCLASS=IN
    )

    ultimo: Exception | None = None
    for servidor in servidores:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.sendto(consulta, (servidor, 53))
            while True:
                respuesta, _ = s.recvfrom(4096)
                # Un UDP de otro que llegó justo: se descarta y se sigue
                # esperando, no se toma por bueno.
                if len(respuesta) >= 2 and struct.unpack("!H", respuesta[:2])[0] == ident:
                    break
        except OSError as e:
            ultimo = e
            continue
        finally:
            s.close()
        return _parsear_txt(respuesta)

    raise OSError(f"ningún servidor DNS contestó ({ultimo})")


def _parsear_txt(respuesta: bytes) -> list[str]:
    if len(respuesta) < 12:
        raise ValueError("respuesta DNS truncada")
    _, _, qd, an, _, _ = struct.unpack("!HHHHHH", respuesta[:12])
    pos = 12
    for _ in range(qd):
        pos = _saltar_nombre(respuesta, pos) + 4      # + QTYPE y QCLASS

    cadenas: list[str] = []
    for _ in range(an):
        pos = _saltar_nombre(respuesta, pos)
        tipo, _clase, _ttl, largo = struct.unpack_from("!HHIH", respuesta, pos)
        pos += 10
        fin = pos + largo
        if tipo == 16:
            # El RDATA de un TXT son una o más cadenas <largo><bytes>. Cymru
            # manda una sola, pero el formato permite varias y partirlas mal
            # daría un ASN cortado por la mitad.
            trozo = pos
            partes: list[str] = []
            while trozo < fin:
                n = respuesta[trozo]
                partes.append(respuesta[trozo + 1 : trozo + 1 + n].decode("utf-8", "replace"))
                trozo += 1 + n
            cadenas.append("".join(partes))
        pos = fin
    return cadenas


# ═════════════════════════════════════════════════════════════════════════════
#  Team Cymru — de una dirección a una organización
# ═════════════════════════════════════════════════════════════════════════════
#
# Medido el 01/08/2026:
#
#   1.1.1.1.origin.asn.cymru.com  TXT
#     → "13335 | 1.1.1.0/24 | AU | apnic | 2011-08-11"
#   AS13335.asn.cymru.com  TXT
#     → "13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"
#
# Son DOS consultas por salto: la primera da el número, la segunda el nombre.
# Por eso la caché no es un lujo — 12 saltos públicos serían 24 consultas por
# traza, cada vez.
#
# 🔴 Y hay un caso que hay que respetar: de los 4 saltos públicos de la
#    medición, UNO no devolvió nada. Un salto público sin ASN publicado existe;
#    lo correcto es mostrarlo como «sin ASN», no dejarlo en blanco como si no
#    lo hubiéramos mirado, ni inventarle un dueño.

SUFIJO_ORIGEN = "origin.asn.cymru.com"
SUFIJO_ASN = "asn.cymru.com"


def nombre_origen(direccion: str) -> str:
    """`192.88.99.1` → `1.99.88.192.origin.asn.cymru.com`.

    🔴 LEVANTA `ValueError` si la dirección no es pública. Es la segunda capa de
       la garantía: aunque alguien llame de más arriba con una dirección
       interna, acá el nombre no se llega a construir — y si el nombre no
       existe, no hay nada que mandar.
    """
    if not es_publica(direccion):
        raise ValueError(
            f"negado: {direccion} no es una dirección pública y no puede "
            f"consultarse a un servicio externo"
        )
    return ".".join(reversed(str(direccion).split("."))) + "." + SUFIJO_ORIGEN


@dataclass
class DatosASN:
    """Lo que se sabe del dueño de una dirección. Todo puede faltar."""

    asn: int | None = None
    prefijo: str | None = None
    pais: str | None = None
    registro: str | None = None
    asignado: str | None = None
    org: str | None = None
    #: `ok` · `sin_datos` · `error` · `no_consultado`
    resultado: str = "no_consultado"


def _fecha(texto: str) -> str | None:
    """`2011-08-11` → igual; cualquier otra cosa → `None`.

    🔴 `camino_asn_cache.asignado` es una columna `date`, y este texto lo
       escribe un TERCERO. Sin validarlo, el día que Cymru cambie el formato
       —o devuelva un campo corrido— el INSERT explota con
       `invalid input syntax for type date` y se cae la corrida entera por un
       dato decorativo que nadie mira.

       Lo encontró la propia prueba `test_la_cache_evita_la_segunda_consulta`
       con un `"2011"` a medias. Es un dato de adorno: si no se entiende, va
       NULL y listo — lo que NO puede pasar es que tire abajo el trazado.
    """
    texto = (texto or "").strip()
    try:
        datetime.strptime(texto, "%Y-%m-%d")
    except ValueError:
        return None
    return texto


def parsear_origen(txt: str) -> DatosASN:
    """`"13335 | 1.1.1.0/24 | AU | apnic | 2011-08-11"` → DatosASN."""
    campos = [c.strip() for c in txt.split("|")]
    if not campos or not campos[0]:
        return DatosASN(resultado="sin_datos")

    # 🔴 Un prefijo puede tener VARIOS ASN de origen (MOAS). Cymru los devuelve
    #    separados por espacio: "2914 6461 | …". Se toma el menor —no el
    #    primero— para que la huella del camino sea determinista aunque el
    #    orden de la respuesta cambie, y se deja dicho que había más en vez de
    #    tapar el dato.
    numeros = sorted(int(n) for n in campos[0].split() if n.isdigit())
    if not numeros:
        return DatosASN(resultado="sin_datos")

    d = DatosASN(asn=numeros[0], resultado="ok")
    if len(campos) > 1 and campos[1]:
        d.prefijo = campos[1]
    if len(campos) > 2 and campos[2]:
        d.pais = campos[2]
    if len(campos) > 3 and campos[3]:
        d.registro = campos[3]
    if len(campos) > 4:
        d.asignado = _fecha(campos[4])
    if len(numeros) > 1:
        d.org = f"(+{len(numeros) - 1} ASN más anuncian este prefijo)"
    return d


def parsear_nombre_asn(txt: str) -> str | None:
    """`"13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"`.

    El nombre es el ÚLTIMO campo. Se devuelve entero, con la descripción: para
    quien está de guardia «CLOUDFLARENET - Cloudflare, Inc., US» dice mucho más
    que «CLOUDFLARENET».
    """
    campos = [c.strip() for c in txt.split("|")]
    return campos[-1] if len(campos) >= 5 and campos[-1] else None


class ResolutorASN:
    """Dirección pública → organización, con caché en memoria y en Postgres.

    El `consultor` es un parámetro para que los tests puedan espiarlo: la
    garantía de privacidad se verifica mirando EXACTAMENTE qué nombres se
    pidieron, y eso sólo se puede hacer si hay una costura acá.
    """

    def __init__(
        self,
        con=None,
        consultor=consultar_txt,
        habilitado: bool = ASN_HABILITADO,
        max_consultas: int = MAX_CONSULTAS_ASN,
    ) -> None:
        self.con = con
        self.consultor = consultor
        self.habilitado = habilitado
        self.max_consultas = max_consultas
        self.consultas = 0
        self._memoria: dict[str, DatosASN] = {}
        #: Nombres de AS ya resueltos. Un camino suele cruzar varios saltos del
        #: mismo operador, y son la misma pregunta.
        self._nombres: dict[int, str | None] = {}

    # ── la puerta ──────────────────────────────────────────────────────────
    def resolver(self, direccion: str) -> DatosASN:
        """🔴 LEVANTA `ValueError` si la dirección no es pública.

        Tercera capa de la garantía. No devuelve un `DatosASN` vacío en
        silencio: si alguien llegó hasta acá con una dirección interna, eso es
        un error de programación que hay que ver, no algo que se tapa.
        """
        if not es_publica(direccion):
            raise ValueError(
                f"negado: {direccion} no es pública; el llamador tiene que "
                f"filtrar con es_publica() antes de pedir el ASN"
            )
        if not self.habilitado:
            return DatosASN(resultado="no_consultado")

        if direccion in self._memoria:
            return self._memoria[direccion]

        cacheado = self._leer_cache(direccion)
        if cacheado is not None:
            self._memoria[direccion] = cacheado
            return cacheado

        if self.consultas >= self.max_consultas:
            log.warning("tope de %d consultas ASN alcanzado, no consulto %s",
                        self.max_consultas, direccion)
            return DatosASN(resultado="no_consultado")

        datos = self._consultar(direccion)
        self._memoria[direccion] = datos
        self._guardar_cache(direccion, datos)
        return datos

    def _consultar(self, direccion: str) -> DatosASN:
        # `nombre_origen` vuelve a verificar. Redundante a propósito: es la
        # línea que hay que borrar para que se filtre algo, y está a la vista.
        try:
            respuestas = self.consultor(nombre_origen(direccion))
            self.consultas += 1
        except OSError as e:
            log.warning("no pude consultar el ASN de %s: %s", direccion, e)
            return DatosASN(resultado="error")
        except ValueError as e:
            log.error("respuesta DNS ilegible para %s: %s", direccion, e)
            return DatosASN(resultado="error")

        if not respuestas:
            return DatosASN(resultado="sin_datos")

        datos = parsear_origen(respuestas[0])
        if datos.asn is not None:
            nombre = self._nombre_de(datos.asn)
            if nombre:
                # Si `parsear_origen` dejó la nota de MOAS, se conserva detrás
                # del nombre en vez de pisarla.
                datos.org = f"{nombre} {datos.org}".strip() if datos.org else nombre
        return datos

    def _nombre_de(self, asn: int) -> str | None:
        if asn in self._nombres:
            return self._nombres[asn]
        if self.consultas >= self.max_consultas:
            return None
        try:
            respuestas = self.consultor(f"AS{asn}.{SUFIJO_ASN}")
            self.consultas += 1
        except (OSError, ValueError) as e:
            log.warning("no pude resolver el nombre de AS%d: %s", asn, e)
            return None
        nombre = parsear_nombre_asn(respuestas[0]) if respuestas else None
        self._nombres[asn] = nombre
        return nombre

    # ── caché en Postgres ──────────────────────────────────────────────────
    def _leer_cache(self, direccion: str) -> DatosASN | None:
        if self.con is None:
            return None
        fila = self.con.execute(
            "SELECT asn, prefijo::text, pais, registro, asignado::text, org, resultado"
            "  FROM camino_asn_cache WHERE direccion = %s AND expira_at > now()",
            (direccion,),
        ).fetchone()
        if fila is None:
            return None
        return DatosASN(asn=fila[0], prefijo=fila[1], pais=fila[2], registro=fila[3],
                        asignado=fila[4], org=fila[5], resultado=fila[6])

    def _guardar_cache(self, direccion: str, d: DatosASN) -> None:
        if self.con is None or d.resultado == "no_consultado":
            return
        vida = (
            timedelta(minutes=ASN_TTL_ERROR_MIN)
            if d.resultado == "error"
            else timedelta(days=ASN_TTL_DIAS)
        )
        self.con.execute(
            "INSERT INTO camino_asn_cache"
            " (direccion, asn, prefijo, pais, registro, asignado, org,"
            "  resultado, consultado_at, expira_at)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now(), now() + %s)"
            " ON CONFLICT (direccion) DO UPDATE SET"
            "  asn = EXCLUDED.asn, prefijo = EXCLUDED.prefijo, pais = EXCLUDED.pais,"
            "  registro = EXCLUDED.registro, asignado = EXCLUDED.asignado,"
            "  org = EXCLUDED.org, resultado = EXCLUDED.resultado,"
            "  consultado_at = now(), expira_at = EXCLUDED.expira_at",
            (direccion, d.asn, d.prefijo, d.pais, d.registro, d.asignado or None,
             d.org, d.resultado, vida),
        )


# ═════════════════════════════════════════════════════════════════════════════
#  El trazado
# ═════════════════════════════════════════════════════════════════════════════


@dataclass
class Salto:
    """Un TTL. 🔴 Existe SIEMPRE, conteste o no.

    `direccion is None` significa exactamente una cosa: no contestó. No
    significa «no hay salto» ni «no lo miramos».
    """

    ttl: int
    direccion: str | None = None
    rtt_ms: float | None = None
    icmp_tipo: int | None = None
    icmp_codigo: int | None = None
    asn: DatosASN = field(default_factory=DatosASN)

    @property
    def clase(self) -> str:
        return clasificar(self.direccion)

    @property
    def mudo(self) -> bool:
        return self.direccion is None


@dataclass
class Traza:
    destino: str
    destino_ip: str | None
    saltos: list[Salto]
    metodo: str
    ttl_max: int
    sondas_por_salto: int
    duracion_ms: int
    motivo_fin: str
    error: str | None = None

    @property
    def alcanzado(self) -> bool:
        return self.motivo_fin == "destino"

    @property
    def mudos(self) -> int:
        return sum(1 for s in self.saltos if s.mudo)

    @property
    def publicos(self) -> int:
        return sum(1 for s in self.saltos if s.clase == "publica")

    # ── las dos huellas ────────────────────────────────────────────────────
    @property
    def huella_saltos(self) -> str:
        """La secuencia exacta. Ruidosa: un mudo de más la cambia."""
        texto = "|".join(f"{s.ttl}:{s.direccion or '*'}" for s in self.saltos)
        return hashlib.sha256(texto.encode()).hexdigest()

    @property
    def ruta_asn(self) -> str:
        """`interna>AS1234>AS5678` — la secuencia de dueños, sin repetir.

        🔴 Ésta es la señal que importa. Los saltos mudos NO participan: que un
           router deje de contestar es lo más normal del mundo y no significa
           que el tráfico cambió de operador. Y los tramos consecutivos del
           mismo dueño se colapsan en uno, porque que el mayorista agregue un
           router intermedio tampoco es un cambio de camino.
        """
        etapas: list[str] = []
        for s in self.saltos:
            if s.mudo:
                continue
            if s.clase == "publica":
                etapa = f"AS{s.asn.asn}" if s.asn.asn is not None else "publica-sin-asn"
            else:
                etapa = s.clase
            if not etapas or etapas[-1] != etapa:
                etapas.append(etapa)
        return ">".join(etapas)

    @property
    def huella_asn(self) -> str:
        return hashlib.sha256(self.ruta_asn.encode()).hexdigest()


def _leer_error_icmp(s: socket.socket, t0: float, limite: float):
    """Espera en la cola de errores del socket. Devuelve (ip, ms, tipo, código).

    ⚠️ `poll()` y no `sleep()`: ver el encabezado. Con un `sleep(5 ms)` en el
       bucle, TODOS los saltos medían 5,1 ms, incluido el gateway local que
       mide 0,12.
    """
    po = select.poll()
    po.register(s.fileno(), select.POLLERR | select.POLLIN)
    while True:
        resto = limite - time.perf_counter()
        if resto <= 0:
            return None
        if not po.poll(resto * 1000):
            continue
        try:
            _datos, anc, _flags, _addr = s.recvmsg(512, 1024, socket.MSG_ERRQUEUE)
        except OSError:
            continue
        ms = (time.perf_counter() - t0) * 1000
        for nivel, tipo, valor in anc:
            if nivel != socket.IPPROTO_IP or tipo != IP_RECVERR:
                continue
            # struct sock_extended_err: u32 errno, u8 origin, u8 type, u8 code,
            # u8 pad, u32 info, u32 data — 16 bytes; después el sockaddr del
            # router que se quejó.
            _errno, origen, icmp_tipo, icmp_codigo, _pad, _info, _d = struct.unpack_from(
                "IBBBBII", valor, 0
            )
            sa = valor[16:]
            if len(sa) < 8 or struct.unpack_from("H", sa, 0)[0] != socket.AF_INET:
                continue
            #: origin 2 = SO_EE_ORIGIN_ICMP. Un error local (ruta inexistente)
            #: viene con otro origen y NO es un salto de la red.
            if origen != 2:
                continue
            return socket.inet_ntoa(sa[4:8]), ms, icmp_tipo, icmp_codigo


def _sondear(destino_ip: str, ttl: int, puerto: int, metodo: str, timeout: float):
    """Una sonda a un TTL. Devuelve (ip, ms, tipo, código) o `None` si no contestó."""
    familia = socket.SOCK_DGRAM if metodo == "udp-recverr" else socket.SOCK_STREAM
    s = socket.socket(socket.AF_INET, familia)
    try:
        s.setsockopt(socket.IPPROTO_IP, IP_RECVERR, 1)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, ttl)
        s.setblocking(False)
        t0 = time.perf_counter()
        if metodo == "udp-recverr":
            s.sendto(b"\0" * 32, (destino_ip, puerto))
        else:
            s.connect_ex((destino_ip, puerto))
        return _leer_error_icmp(s, t0, t0 + timeout)
    except OSError as e:
        # `Network is unreachable` es el caso de la red `internal: true`. Se
        # propaga: es un problema de despliegue, no un salto mudo.
        raise OSError(f"no pude mandar la sonda ttl={ttl}: {e}") from e
    finally:
        s.close()


def resolver_saltos(saltos: list[Salto], resolutor: ResolutorASN) -> None:
    """Le pone el ASN a los saltos PÚBLICOS. Modifica la lista en el lugar.

    🔴 PRIMERA CAPA de la garantía de privacidad: este bucle ni siquiera le
       OFRECE al resolutor las direcciones que no son públicas. Las otras dos
       capas (`nombre_origen` y `ResolutorASN.resolver`) están más adentro y
       levantan `ValueError` si alguien las saltea.

    Está afuera de `trazar()` para que se pueda probar sin tocar la red: el test
    le pasa una lista de saltos con una dirección de CADA rango no público y
    verifica que el espía no haya registrado ni una consulta.
    """
    for s in saltos:
        if s.clase == "publica":
            s.asn = resolutor.resolver(s.direccion)


def trazar(
    destino: str,
    *,
    ttl_max: int = TTL_MAX,
    sondas: int = SONDAS_POR_SALTO,
    timeout: float = TIMEOUT_S,
    pausa: float = PAUSA_S,
    mudos_seguidos: int = MUDOS_SEGUIDOS,
    metodo: str = "udp-recverr",
    puerto: int = PUERTO_BASE,
    resolutor: ResolutorASN | None = None,
) -> Traza:
    """Traza el camino hasta `destino`. Ver los límites en la sección 4.

    🔴 El resultado tiene una fila por CADA TTL probado, hayan contestado o no.
    """
    t_inicio = time.perf_counter()
    try:
        info = socket.getaddrinfo(destino, None, socket.AF_INET, socket.SOCK_DGRAM)
        destino_ip = info[0][4][0]
    except OSError as e:
        return Traza(destino, None, [], metodo, ttl_max, sondas, 0, "error",
                     error=f"no resuelve: {e}")

    saltos: list[Salto] = []
    motivo = "ttl_max"
    seguidos = 0

    for ttl in range(1, ttl_max + 1):
        mejor = None
        for n in range(sondas):
            if saltos or n:
                time.sleep(pausa)          # el tope de 20 pps del encabezado
            try:
                r = _sondear(destino_ip, ttl, puerto + ttl, metodo, timeout)
            except OSError as e:
                return Traza(destino, destino_ip, saltos, metodo, ttl_max, sondas,
                             int((time.perf_counter() - t_inicio) * 1000), "error",
                             error=str(e))
            # Con varias sondas se queda el RTT MENOR, que es la convención de
            # traceroute: el mínimo se acerca al tiempo de propagación y el
            # promedio se ensucia con el encolamiento de un router ocupado.
            if r is not None and (mejor is None or r[1] < mejor[1]):
                mejor = r

        if mejor is None:
            saltos.append(Salto(ttl=ttl))            # 🔴 el salto mudo EXISTE
            seguidos += 1
            if seguidos >= mudos_seguidos:
                motivo = "mudos"
                break
            continue

        seguidos = 0
        ip, ms, icmp_tipo, icmp_codigo = mejor
        saltos.append(Salto(ttl=ttl, direccion=ip, rtt_ms=round(ms, 3),
                            icmp_tipo=icmp_tipo, icmp_codigo=icmp_codigo))
        # ICMP 3/x = «inalcanzable» y lo manda el DESTINO (3/3 puerto cerrado,
        # que es el éxito de un traceroute UDP; 3/13 filtrado administrativo).
        # 11/0 lo manda un intermedio. La diferencia es la que separa «llegué»
        # de «voy por la mitad».
        if icmp_tipo == ICMP_INALCANZABLE:
            motivo = "destino"
            break

    if resolutor is not None:
        resolver_saltos(saltos, resolutor)

    return Traza(destino, destino_ip, saltos, metodo, ttl_max, sondas,
                 int((time.perf_counter() - t_inicio) * 1000), motivo)


# ═════════════════════════════════════════════════════════════════════════════
#  Persistencia
# ═════════════════════════════════════════════════════════════════════════════


def aplicar_esquema(con, archivo: str = SCHEMA_FILE) -> None:
    """Mismo contrato que en `sync.py`: `schema.sql` es idempotente."""
    ruta = Path(archivo)
    if not ruta.exists():
        log.warning("no encuentro %s, asumo que el esquema ya está aplicado", ruta)
        return
    con.execute(ruta.read_text(encoding="utf-8"))


def guardar(con, t: Traza) -> dict:
    """Escribe la traza y la compara con la anterior del mismo destino.

    Devuelve `{id, cambio_saltos, cambio_asn, previa_id, ruta_asn}`.

    🔴 `cambio_*` queda en NULL —no en `false`— cuando es la primera traza de
       un destino. «No cambió» y «no hay con qué comparar» son afirmaciones
       distintas, y un tablero que las mezcle va a decir «todo estable» el
       primer día, que es cuando menos se sabe.
    """
    # 🔴 Sólo se compara contra una traza COMPARABLE, y sólo si ésta lo es.
    #
    #    Una traza que falló —el nombre no resolvió, no había ruta— tiene cero
    #    saltos y su huella es la del vacío. Comparar contra eso, o desde eso,
    #    produce «🔴 CAMBIÓ DE OPERADOR» cada vez que el DNS tose. Lo vimos en
    #    la primera corrida real: un destino `.example` que no resuelve salió
    #    marcado como cambio de mayorista.
    #
    #    Una alarma que se dispara sola es peor que no tener alarma: en dos
    #    semanas nadie la mira, y el día que el tránsito cambie de verdad el
    #    aviso va a estar ahí, en el medio del ruido, sin que nadie lo lea.
    #
    #    Comparable = terminó de trazar Y al menos un salto contestó.
    comparable = t.motivo_fin != "error" and (len(t.saltos) - t.mudos) > 0

    previa = None
    if comparable:
        previa = con.execute(
            "SELECT id, huella_saltos, huella_asn FROM camino_trazas"
            "  WHERE destino = %s AND motivo_fin <> 'error'"
            "    AND saltos > saltos_mudos"
            "  ORDER BY iniciada_at DESC LIMIT 1",
            (t.destino,),
        ).fetchone()

    previa_id = previa[0] if previa else None
    cambio_saltos = (t.huella_saltos != previa[1]) if previa else None
    cambio_asn = (t.huella_asn != previa[2]) if previa else None

    fila = con.execute(
        "INSERT INTO camino_trazas"
        " (destino, destino_ip, duracion_ms, metodo, ttl_max, sondas_por_salto,"
        "  saltos, saltos_mudos, saltos_publicos, alcanzado, motivo_fin, error,"
        "  huella_saltos, huella_asn, previa_id, cambio_saltos, cambio_asn)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
        " RETURNING id",
        (t.destino, t.destino_ip, t.duracion_ms, t.metodo, t.ttl_max,
         t.sondas_por_salto, len(t.saltos), t.mudos, t.publicos, t.alcanzado,
         t.motivo_fin, t.error, t.huella_saltos, t.huella_asn, previa_id,
         cambio_saltos, cambio_asn),
    ).fetchone()
    traza_id = fila[0]

    for s in t.saltos:
        publico = s.clase == "publica"
        con.execute(
            "INSERT INTO camino_saltos"
            " (traza_id, ttl, direccion, rtt_ms, clase, asn, asn_org,"
            "  asn_prefijo, asn_pais, icmp_tipo, icmp_codigo)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (traza_id, s.ttl, s.direccion, s.rtt_ms, s.clase,
             s.asn.asn if publico else None,
             s.asn.org if publico else None,
             s.asn.prefijo if publico else None,
             s.asn.pais if publico else None,
             s.icmp_tipo, s.icmp_codigo),
        )

    return {"id": traza_id, "previa_id": previa_id, "cambio_saltos": cambio_saltos,
            "cambio_asn": cambio_asn, "ruta_asn": t.ruta_asn}


def registrar_destino(con, destino: str, nota: str | None = None,
                      creado_por: str | None = None) -> int:
    fila = con.execute(
        "INSERT INTO camino_destinos (destino, nota, creado_por) VALUES (%s,%s,%s)"
        " ON CONFLICT (destino) DO UPDATE SET nota = COALESCE(EXCLUDED.nota,"
        " camino_destinos.nota), activo = true RETURNING id",
        (destino, nota, creado_por),
    ).fetchone()
    return fila[0]


def destinos_a_trazar(con, intervalo_s: int = INTERVALO_MIN_S,
                      limite: int = MAX_DESTINOS) -> list[str]:
    """Los destinos activos que no se trazaron hace poco.

    El intervalo lo decide la BASE y no un cron: si alguien corre `correr` tres
    veces seguidas por nerviosismo, las dos últimas no mandan un solo paquete.
    """
    return [f[0] for f in con.execute(
        "SELECT d.destino FROM camino_destinos d"
        "  LEFT JOIN LATERAL (SELECT max(iniciada_at) AS ultima FROM camino_trazas t"
        "                      WHERE t.destino = d.destino) u ON true"
        " WHERE d.activo"
        "   AND (u.ultima IS NULL OR u.ultima < now() - make_interval(secs => %s))"
        " ORDER BY u.ultima NULLS FIRST LIMIT %s",
        (intervalo_s, limite),
    ).fetchall()]


# ═════════════════════════════════════════════════════════════════════════════
#  CLI
# ═════════════════════════════════════════════════════════════════════════════


def _mostrar(t: Traza) -> None:
    print(f"\ncamino hacia {t.destino} ({t.destino_ip or 'no resuelve'})"
          f" · {t.metodo} · {t.duracion_ms} ms · fin: {t.motivo_fin}")
    if t.error:
        print(f"  error: {t.error}")
    for s in t.saltos:
        if s.mudo:
            # 🔴 El mudo se IMPRIME. Saltearlo renumeraría el camino.
            print(f"  {s.ttl:>2}  {'*':<16}  {'—':>9}  no contestó")
            continue
        dueño = {
            "interna": "red interna",
            "especial": "dirección especial",
        }.get(s.clase, "")
        if s.clase == "publica":
            if s.asn.asn is not None:
                dueño = f"AS{s.asn.asn}  {s.asn.org or ''}".strip()
            elif s.asn.resultado == "no_consultado":
                dueño = "público (ASN no consultado)"
            else:
                dueño = "público, sin ASN publicado"
        print(f"  {s.ttl:>2}  {s.direccion:<16}  {s.rtt_ms:>7.2f} ms  {dueño}")
    print(f"\n  ruta: {t.ruta_asn or '(sin saltos que contesten)'}")


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    ap = argparse.ArgumentParser(
        description="Traza el camino de red y dice de quién es cada salto.")
    ap.add_argument("--url", default=DATABASE_URL, help="DATABASE_URL de PostgreSQL")
    ap.add_argument("--sin-base", action="store_true",
                    help="no escribe nada: sólo traza y muestra")
    sub = ap.add_subparsers(dest="cmd", required=True)

    tra = sub.add_parser("trazar", help="traza un destino")
    tra.add_argument("destino")
    tra.add_argument("--ttl-max", type=int, default=TTL_MAX)
    tra.add_argument("--sondas", type=int, default=SONDAS_POR_SALTO)
    tra.add_argument("--timeout", type=float, default=TIMEOUT_S)
    tra.add_argument("--metodo", choices=("udp-recverr", "tcp-recverr"),
                     default="udp-recverr")
    tra.add_argument("--puerto", type=int, default=PUERTO_BASE,
                     help="con tcp-recverr conviene 443, que suele estar abierto")
    tra.add_argument("--registrar", action="store_true",
                     help="además lo agrega a camino_destinos")

    reg = sub.add_parser("destino", help="registra un destino para trazar seguido")
    reg.add_argument("destino")
    reg.add_argument("--nota")
    reg.add_argument("--por", help="quién lo registró")

    cor = sub.add_parser("correr", help="traza todos los destinos que toquen")
    cor.add_argument("--intervalo", type=int, default=INTERVALO_MIN_S)
    cor.add_argument("--limite", type=int, default=MAX_DESTINOS)

    sub.add_parser("reporte", help="qué hay guardado")

    args = ap.parse_args(argv)

    # Sin base: sirve para probar la técnica desde cualquier lado.
    if args.sin_base or (args.cmd == "trazar" and not args.url):
        if args.cmd != "trazar":
            log.error("«%s» necesita base de datos", args.cmd)
            return 2
        _mostrar(trazar(args.destino, ttl_max=args.ttl_max, sondas=args.sondas,
                        timeout=args.timeout, metodo=args.metodo,
                        puerto=args.puerto, resolutor=ResolutorASN()))
        return 0

    if not args.url:
        log.error("falta DATABASE_URL (o --url, o --sin-base)")
        return 2

    import psycopg  # noqa: PLC0415 — así el módulo se importa sin psycopg

    with psycopg.connect(args.url, autocommit=True) as con:
        aplicar_esquema(con)
        resolutor = ResolutorASN(con)

        if args.cmd == "trazar":
            t = trazar(args.destino, ttl_max=args.ttl_max, sondas=args.sondas,
                       timeout=args.timeout, metodo=args.metodo,
                       puerto=args.puerto, resolutor=resolutor)
            _mostrar(t)
            if args.registrar:
                registrar_destino(con, args.destino)
            r = guardar(con, t)
            print(f"\n  guardada como traza {r['id']}"
                  f" · cambio de camino: {_texto_cambio(r['cambio_saltos'])}"
                  f" · cambio de operador: {_texto_cambio(r['cambio_asn'])}")

        elif args.cmd == "destino":
            print(f"destino {registrar_destino(con, args.destino, args.nota, args.por)}")

        elif args.cmd == "correr":
            pendientes = destinos_a_trazar(con, args.intervalo, args.limite)
            if not pendientes:
                log.info("ningún destino para trazar (intervalo mínimo %d s)",
                         args.intervalo)
                return 0
            log.info("%d destinos", len(pendientes))
            for destino in pendientes:
                t = trazar(destino, resolutor=resolutor)
                r = guardar(con, t)
                aviso = " 🔴 CAMBIÓ DE OPERADOR" if r["cambio_asn"] else ""
                log.info("%s → %s (%d saltos, %d mudos)%s", destino,
                         r["ruta_asn"] or "—", len(t.saltos), t.mudos, aviso)
            log.info("%d consultas ASN", resolutor.consultas)

        elif args.cmd == "reporte":
            _reporte(con)

    return 0


def _texto_cambio(v) -> str:
    return "primera traza" if v is None else ("sí" if v else "no")


def _reporte(con) -> None:
    print("\ndestinos y su última traza")
    for d, ip, cuando, saltos, mudos, ruta, cambio in con.execute(
        "SELECT u.destino, host(u.destino_ip), u.iniciada_at, u.saltos,"
        "       u.saltos_mudos, x.ruta_asn, u.cambio_asn"
        "  FROM v_camino_ultimo u JOIN camino_trazas_texto x ON x.id = u.id"
        " ORDER BY u.destino"
    ).fetchall():
        print(f"  {d:<28} {ip or '—':<16} {cuando:%Y-%m-%d %H:%M}"
              f"  {saltos:>2} saltos ({mudos} mudos)"
              f"  {'🔴 CAMBIÓ  ' if cambio else ''}{ruta or ''}")

    n = con.execute("SELECT count(*), count(*) FILTER (WHERE resultado = 'ok')"
                    "  FROM camino_asn_cache").fetchone()
    print(f"\ncaché de ASN: {n[0]} direcciones, {n[1]} con ASN")


if __name__ == "__main__":
    raise SystemExit(main())
