"""
Sondeo EN VIVO de un equipo, a pedido: ping, traceroute y puertos.

═══════════════════════════════════════════════════════════════════════════════
 🔴 1 · ESTO CONVIERTE AL PANEL EN ACTOR DE LA RED. LEER ANTES DE TOCAR.
═══════════════════════════════════════════════════════════════════════════════

Hasta acá el panel era un espejo: mostraba lo que The Dude había medido. Este
módulo manda paquetes. Es otra categoría de cosa, y trae otra categoría de
riesgo — un botón «ping» sin frenos, detrás de una autenticación básica, es una
herramienta de escaneo para cualquiera que consiga una contraseña.

Los cuatro frenos, y ninguno es opcional:

  1. **Sólo se sondea lo que está en la base.** El destino tiene que ser una
     dirección de `devices.addresses`. No se puede pedir un host arbitrario: el
     panel no se puede usar para escanear ni la red ni internet.

  2. **Sólo puertos de una lista fija.** Los seis que este panel ya sabe abrir
     desde la ficha del equipo. No hay «escaneá el rango 1-65535».

  3. **Límite de sondas por destino y global**, en memoria. Repetir el mismo
     ping veinte veces seguidas no manda veinte pings.

  4. **NUNCA escribe nada en un equipo.** No hay SNMP set, no hay comando, no
     hay sesión. Sólo se pregunta.

Y va en su PROPIO contenedor, no en el ETL: el ETL es el que abre la base con
las credenciales de todos los equipos del ISP, y ése no sale a internet ni por
casualidad.

═══════════════════════════════════════════════════════════════════════════════
 🔴 2 · POR QUÉ HAY DOS TÉCNICAS DE PING Y CUÁL CONTESTÓ SE INFORMA
═══════════════════════════════════════════════════════════════════════════════

Un `ping` de verdad es ICMP Echo, y eso normalmente pide `CAP_NET_RAW`. Acá no
se pide ningún privilegio, así que hay dos caminos y ninguno es perfecto:

  · **ICMP `SOCK_DGRAM`** (el «ping socket» de Linux). Es un ping de verdad y no
    necesita capacidades — pero depende de `net.ipv4.ping_group_range`, un
    sysctl del anfitrión. Docker lo deja abierto de fábrica; un anfitrión
    endurecido no. Por eso el compose lo fija EXPLÍCITAMENTE en vez de confiar
    en el defecto: se midió que confiar en el defecto se rompe en producción y
    no en desarrollo, que es el peor orden posible.

  · **UDP con `IP_RECVERR`** (lo mismo que usa `camino.py`). No pide ningún
    permiso, pero mide distinto: se manda un UDP a un puerto cerrado y se espera
    el ICMP «port unreachable» de vuelta. Eso PRUEBA que el equipo está y da un
    tiempo de ida y vuelta real — pero un equipo que descarta ese UDP en
    silencio, o que limita la tasa de «unreachable» (RouterOS lo hace por
    omisión), va a parecer caído estando vivo.

**Por eso la respuesta dice siempre con qué técnica se midió.** Un «no contestó»
por UDP y un «no contestó» por ICMP no significan lo mismo, y presentarlos igual
sería mentir con un número al lado.

═══════════════════════════════════════════════════════════════════════════════
 🔴 3 · Y EL SONDEO DE PUERTOS NO ES UN PING
═══════════════════════════════════════════════════════════════════════════════

Es la parte que más valor agrega y la que más se malinterpreta. Un equipo que
contesta ping con el Winbox muerto está CAÍDO para quien lo tiene que
administrar, y el monitoreo por ping dice que está perfecto. Ese caso es real y
es el que este sondeo encuentra.

Se usa `connect()` TCP y se cierra enseguida — nada de medio-abierto, que pide
privilegios y además deja conexiones colgadas del otro lado.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg

import camino

log = logging.getLogger("sonda")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
PUERTO_HTTP = int(os.environ.get("SONDA_PUERTO", "8099"))

#: Cuántas sondas manda un ping. Cinco alcanzan para ver pérdida y jitter sin
#: que el botón tarde una eternidad: con 1 s de timeout, el peor caso son 5 s.
SONDAS_PING = int(os.environ.get("SONDA_PING_SONDAS", "5"))
TIMEOUT_PING_S = float(os.environ.get("SONDA_PING_TIMEOUT_S", "1.0"))
TIMEOUT_PUERTO_S = float(os.environ.get("SONDA_PUERTO_TIMEOUT_S", "1.5"))

#: Mínimo entre dos sondeos al MISMO destino. Apretar el botón diez veces no
#: manda diez ráfagas: la segunda y siguientes reciben el resultado guardado.
ENFRIAMIENTO_S = float(os.environ.get("SONDA_ENFRIAMIENTO_S", "10"))
#: Tope global de sondeos por minuto, sumando todos los usuarios y destinos.
POR_MINUTO = int(os.environ.get("SONDA_POR_MINUTO", "60"))

#: 🔴 Lista FIJA. Son exactamente los puertos que la ficha del equipo ya sabe
#:    ofrecer como acceso, más el 161 para saber si el equipo habla SNMP.
#:    No se acepta un puerto arbitrario del pedido: eso sería un escáner.
PUERTOS = [
    (22, "SSH"),
    (22722, "SSH (convención del ISP)"),
    (80, "HTTP"),
    (443, "HTTPS"),
    (8291, "Winbox"),
    (8728, "API RouterOS"),
]

#: Puerto UDP alto y cerrado para el ping por UDP. El mismo criterio que
#: traceroute: se busca el «port unreachable», no que alguien conteste.
PUERTO_UDP_CERRADO = int(os.environ.get("SONDA_PUERTO_UDP", "33500"))


# ── Frenos ───────────────────────────────────────────────────────────────────

class Freno:
    """Enfriamiento por destino y tope global, en memoria.

    En memoria y no en la base a propósito: el freno protege a la RED de este
    proceso, y si el proceso se reinicia el estado anterior ya no aplica —
    tampoco hay sondas en vuelo. Meterlo en Postgres agregaría una escritura por
    clic para proteger algo que ya está protegido.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ultimo: dict[str, float] = {}
        self._minuto: list[float] = []

    def permite(self, destino: str) -> tuple[bool, str]:
        ahora = time.monotonic()
        with self._lock:
            self._minuto = [t for t in self._minuto if ahora - t < 60]
            if len(self._minuto) >= POR_MINUTO:
                return False, f"tope global de {POR_MINUTO} sondeos por minuto"
            previo = self._ultimo.get(destino)
            if previo is not None and ahora - previo < ENFRIAMIENTO_S:
                falta = ENFRIAMIENTO_S - (ahora - previo)
                return False, f"esperá {falta:.0f} s antes de volver a sondear {destino}"
            self._ultimo[destino] = ahora
            self._minuto.append(ahora)
            return True, ""


FRENO = Freno()


def destino_valido(con, destino: str) -> bool:
    """¿Esta dirección pertenece a un equipo de la base?

    🔴 EL FRENO MÁS IMPORTANTE DE LOS CUATRO.

       Sin esto, el panel es un escáner: cualquiera con una contraseña del
       basic_auth podría pedirle que sondee la red de gestión entera, o una
       dirección de internet. Con esto, el conjunto de destinos posibles es
       exactamente el inventario que el ISP ya monitorea.

       Se pregunta a la base en cada pedido y no se cachea: el ETL reescribe
       `devices` cada 30 s, y un equipo dado de baja tiene que dejar de ser un
       destino válido en la vuelta siguiente, no cuando se reinicie el proceso.
    """
    try:
        ip = ipaddress.ip_address(destino)
    except ValueError:
        return False
    fila = con.execute(
        "SELECT 1 FROM devices WHERE %s::inet = ANY(addresses) LIMIT 1", (str(ip),)
    ).fetchone()
    return fila is not None


# ── Ping ─────────────────────────────────────────────────────────────────────

def _ping_icmp(destino: str, timeout: float) -> float | None:
    """Una sonda ICMP Echo por `SOCK_DGRAM`. `None` si no contestó.

    El kernel se encarga del identificador y del checksum en este tipo de
    socket, así que el paquete es un Echo Request mínimo y nada más.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    try:
        s.settimeout(timeout)
        # tipo 8 (echo), código 0, checksum 0 —lo pone el kernel—, id 0, seq 1
        paquete = struct.pack("!BBHHH", 8, 0, 0, 0, 1) + b"dudepanel"
        t0 = time.perf_counter()
        s.sendto(paquete, (destino, 0))
        s.recvfrom(1024)
        return (time.perf_counter() - t0) * 1000
    except (socket.timeout, TimeoutError):
        return None
    finally:
        s.close()


def _icmp_disponible() -> bool:
    """¿Se puede abrir un ping socket? Depende de un sysctl del anfitrión."""
    try:
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP).close()
        return True
    except OSError:
        return False


def ping(destino: str, sondas: int = SONDAS_PING, timeout: float = TIMEOUT_PING_S) -> dict:
    """Ida y vuelta al equipo, con la mejor técnica disponible.

    Devuelve también QUÉ técnica contestó: un «no contestó» por UDP y uno por
    ICMP no significan lo mismo, y el que mira la pantalla necesita saber cuál
    está leyendo.
    """
    icmp = _icmp_disponible()
    tecnica = "icmp" if icmp else "udp-recverr"
    tiempos: list[float | None] = []

    for _ in range(max(1, min(sondas, 10))):
        if icmp:
            tiempos.append(_ping_icmp(destino, timeout))
        else:
            r = camino._sondear(destino, 64, PUERTO_UDP_CERRADO, "udp-recverr", timeout)
            tiempos.append(r[1] if r else None)

    ok = [t for t in tiempos if t is not None]
    return {
        "destino": destino,
        "tecnica": tecnica,
        "explica": _EXPLICA[tecnica],
        "sondas": len(tiempos),
        "respondieron": len(ok),
        # 🔴 La pérdida se informa como fracción de lo MANDADO, no de lo que
        #    volvió. Parece obvio y es donde se cuela el error clásico de
        #    dividir por len(ok) y obtener 0 % de pérdida siempre.
        "perdida_pct": round(100 * (len(tiempos) - len(ok)) / len(tiempos), 1),
        "ms_min": round(min(ok), 2) if ok else None,
        "ms_prom": round(sum(ok) / len(ok), 2) if ok else None,
        "ms_max": round(max(ok), 2) if ok else None,
        # Jitter como diferencia media entre sondas consecutivas, que es lo que
        # se siente en una llamada. El desvío estándar no distingue una serie
        # que oscila de una que se degrada parejo, y son cosas distintas.
        "jitter_ms": round(
            sum(abs(ok[i] - ok[i - 1]) for i in range(1, len(ok))) / (len(ok) - 1), 2
        ) if len(ok) > 1 else None,
        "muestras_ms": [round(t, 2) if t is not None else None for t in tiempos],
    }


_EXPLICA = {
    "icmp": "Ping ICMP de verdad, el mismo que usa The Dude.",
    "udp-recverr": (
        "No se pudo abrir un socket ICMP, así que se midió con UDP a un puerto "
        "cerrado esperando el «port unreachable». Un equipo que descarta ese UDP "
        "en silencio —RouterOS limita la tasa por omisión— va a figurar sin "
        "respuesta estando vivo."
    ),
}


# ── Puertos ──────────────────────────────────────────────────────────────────

def puertos(destino: str, timeout: float = TIMEOUT_PUERTO_S) -> list[dict]:
    """Qué servicios de administración contestan.

    🔴 Lo que este sondeo encuentra y el ping NO puede encontrar: un equipo que
       responde ping con el Winbox muerto. Para el monitoreo está perfecto; para
       quien lo tiene que administrar, está caído.

    `connect()` completo y cierre inmediato. Nada de medio-abierto: pide
    privilegios y deja conexiones a medias del otro lado.
    """
    salida = []
    for puerto, etiqueta in PUERTOS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        t0 = time.perf_counter()
        try:
            s.connect((destino, puerto))
            estado, detalle = "abierto", None
        except (socket.timeout, TimeoutError):
            # Sin respuesta NO es lo mismo que rechazado, y la diferencia
            # importa: «filtrado» apunta a un firewall en el medio, «cerrado» a
            # que el equipo contestó y el servicio no está.
            estado, detalle = "sin respuesta", "nadie contestó: puede ser un firewall"
        except ConnectionRefusedError:
            estado, detalle = "cerrado", "el equipo contestó que no hay nada escuchando"
        except OSError as e:
            estado, detalle = "error", str(e)
        finally:
            s.close()
        salida.append({
            "puerto": puerto,
            "etiqueta": etiqueta,
            "estado": estado,
            "detalle": detalle,
            "ms": round((time.perf_counter() - t0) * 1000, 1) if estado == "abierto" else None,
        })
    return salida


# ── HTTP ─────────────────────────────────────────────────────────────────────

class Manejador(BaseHTTPRequestHandler):
    # El log por omisión de http.server escribe una línea por pedido con la
    # dirección del cliente. Acá el cliente es siempre el contenedor web: no
    # aporta nada y ensucia el journal.
    def log_message(self, formato, *args):  # noqa: D102, N802
        pass

    def _json(self, cuerpo: dict, estado: int = 200) -> None:
        crudo = json.dumps(cuerpo).encode()
        self.send_response(estado)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(crudo)))
        self.end_headers()
        self.wfile.write(crudo)

    def do_POST(self) -> None:  # noqa: N802
        largo = int(self.headers.get("content-length") or 0)
        if largo > 4096:
            return self._json({"error": "pedido demasiado grande"}, 413)
        try:
            pedido = json.loads(self.rfile.read(largo) or b"{}")
        except ValueError:
            return self._json({"error": "el cuerpo no es JSON"}, 400)

        destino = str(pedido.get("destino") or "").strip()
        que = self.path.strip("/")
        if que not in ("ping", "puertos", "traza"):
            return self._json({"error": f"no sé hacer «{que}»"}, 404)

        try:
            with psycopg.connect(DATABASE_URL, autocommit=True) as con:
                if not destino_valido(con, destino):
                    # 🔴 403 y no 404: la dirección puede existir perfectamente
                    #    en la red. Lo que no existe es el permiso de sondearla.
                    return self._json(
                        {"error": f"{destino or '(vacío)'} no es un equipo de la base",
                         "motivo": "El panel sólo sondea direcciones que ya monitorea. "
                                   "No es un escáner."},
                        403,
                    )
        except Exception as e:  # noqa: BLE001
            log.error("no pude validar el destino: %s", e)
            return self._json({"error": "no se pudo validar el destino"}, 503)

        permite, motivo = FRENO.permite(destino)
        if not permite:
            return self._json({"error": motivo}, 429)

        t0 = time.perf_counter()
        try:
            if que == "ping":
                datos = ping(destino)
            elif que == "puertos":
                datos = {"destino": destino, "puertos": puertos(destino)}
            else:
                # Sin resolutor de ASN: el destino es INTERNO por definición
                # —está en la base— y preguntarle a un tercero por una dirección
                # privada es justo lo que `camino` tiene prohibido.
                t = camino.trazar(destino, resolutor=None)
                datos = {
                    "destino": destino,
                    "alcanzado": t.alcanzado,
                    "motivo_fin": t.motivo_fin,
                    "saltos": [
                        # `rtt_ms`, no `ms`: el nombre sale de `camino.Salto` y
                        # se copia tal cual para que un renombre allá rompa acá
                        # en el import y no en silencio en la pantalla.
                        {"ttl": s.ttl, "direccion": s.direccion,
                         "ms": s.rtt_ms, "clase": s.clase}
                        for s in t.saltos
                    ],
                }
        except Exception as e:  # noqa: BLE001
            log.error("sondeo %s a %s falló: %s", que, destino, e)
            return self._json({"error": f"{type(e).__name__}: {e}"}, 503)

        datos["ms_total"] = round((time.perf_counter() - t0) * 1000)
        self._json(datos)


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not DATABASE_URL:
        log.error("falta DATABASE_URL")
        return 2
    log.info("sonda escuchando en :%d — ICMP %s", PUERTO_HTTP,
             "disponible" if _icmp_disponible() else "NO disponible, se usa UDP")
    ThreadingHTTPServer(("0.0.0.0", PUERTO_HTTP), Manejador).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
