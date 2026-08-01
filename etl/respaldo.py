"""Respaldo de la configuración de los equipos.

═══════════════════════════════════════════════════════════════════════════════
 🔴 ESTE ES EL PRIMER MÓDULO DEL PROYECTO QUE SE CONECTA A LA RED DE PRODUCCIÓN
═══════════════════════════════════════════════════════════════════════════════

Todo lo demás del panel lee una base de datos. Esto habla con los routers. Por
eso arranca APAGADO y no se enciende solo: hace falta poner credenciales a
propósito, en un archivo que no existe hasta que alguien lo crea.

── Por qué existe ─────────────────────────────────────────────────────────────

Para un ISP, la configuración de un router es más valiosa que cualquier
gráfico. El día que se quema una placa, con el `export` de ayer el equipo
vuelve en diez minutos; sin él, se rearma de memoria y se descubre lo que
faltaba durante la semana siguiente.

── 🔴 POR QUÉ NO ES OXIDIZED NI RANCID, Y ESTO SE MIDIÓ ───────────────────────

Lo obvio era copiar a Oxidized: entrar por SSH y correr `/export`. Se midió
contra los 25 RouterOS que estaban ARRIBA en la red real el 01/08/2026,
escaneando sólo puertos TCP —sin intentar ningún login—:

    8728  API de RouterOS ......  16   64 %
    8291  Winbox ...............  12   48 %
    8729  API sobre TLS ........   9   36 %
    22    SSH ..................   5   20 %   ← el que usa Oxidized
    80    web ..................   4

**Un respaldo por SSH llegaría al 20 %.** Y peor: los 5 que tienen el 22 abierto
tienen TAMBIÉN el 8729, así que SSH no suma un solo equipo que la API no
alcance. Habría sido construir la herramienta equivocada y descubrirlo después.

── Y la clasificación que decide el diseño ────────────────────────────────────

Tomando para cada equipo el camino MÁS SEGURO que tiene disponible:

    API sobre TLS (8729) ....  9   36 %   se puede, y sin exponer nada
    sólo 8728 en claro ......  7   28 %   la contraseña viajaría sin cifrar
    sin puerto de admin .....  9   36 %   no hay por dónde entrar

**Sólo un tercio de los routers se puede respaldar hoy sin regalar la
credencial.** Ese número es el hallazgo, no un detalle de implementación: dice
que antes de escribir el respaldo hay trabajo de configuración en los equipos.

Habilitar la API segura en RouterOS es una línea:

    /ip service set api-ssl disabled=no

── Las decisiones, y por qué ──────────────────────────────────────────────────

1. **La credencial NO va a la base ni al repositorio.** Va en un archivo aparte
   que sólo lee este módulo. La base del panel se replica, se respalda y se
   consulta desde la interfaz; una contraseña de router ahí es una contraseña
   de router en cada copia de seguridad de Postgres.

2. **Por omisión NO se conecta a nada.** Sin archivo de credenciales, corre el
   relevamiento de puertos —que no necesita ninguna— y nada más.

3. **El 8728 en claro exige un permiso explícito.** No alcanza con tener la
   credencial: hay que declarar `permitir_api_en_claro = true` sabiendo que la
   contraseña del router cruza la red de gestión sin cifrar. El valor por
   omisión es `false` y el módulo dice a cuántos equipos deja afuera.

4. **Se guarda el texto, no un binario.** El `/export` de RouterOS es texto, y
   eso es lo que permite ver QUÉ cambió entre ayer y hoy. Un `.backup` binario
   sólo permite restaurar, no auditar.

5. **Y no se guarda todo.** El export trae secretos —claves de PPPoE, de
   wireless, comunidades SNMP—. Se filtran antes de escribir. Un respaldo que
   duplica todas las contraseñas del ISP en otra base es un problema nuevo,
   no una solución.
"""
from __future__ import annotations

import hashlib
import os
import re
import socket
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone

# ─────────────────────────────────────────────────────────────────────────────
# Relevamiento: qué se puede alcanzar, sin credencial ninguna
# ─────────────────────────────────────────────────────────────────────────────

#: Puertos de administración de RouterOS, del más seguro al menos.
#:
#: El orden IMPORTA: es el que decide por dónde se intentaría entrar. Primero
#: el que cifra, y el que va en claro sólo si no hay otro y alguien lo permitió.
PUERTOS = (
    (8729, "api-ssl", True),   # API sobre TLS
    (22, "ssh", True),         # SSH
    (8728, "api", False),      # API en claro ← la contraseña viaja desnuda
)


@dataclass(frozen=True)
class Alcance:
    """Por dónde se puede —o no— llegar a un equipo."""

    ip: str
    abiertos: tuple[int, ...]
    #: El mejor camino disponible, o None si no hay ninguno.
    via: str | None
    #: ¿Ese camino cifra la credencial?
    cifrado: bool

    @property
    def se_puede(self) -> bool:
        return self.via is not None


def relevar(ip: str, timeout: float = 2.0) -> Alcance:
    """Qué puertos de administración contesta un equipo.

    🔴 Abre y cierra un TCP. **No manda un solo byte** y no intenta ningún
       login: no hay nada que registrar en el equipo más allá de una conexión
       que se cerró, ni nada que pueda bloquear una cuenta.

       Es la única parte de este módulo que corre sin credenciales, y por eso
       es la que se puede correr siempre: contesta «¿a cuántos de mis routers
       podría llegarles?», que hoy nadie sabe.
    """
    abiertos: list[int] = []
    for puerto, _, _ in PUERTOS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            if s.connect_ex((ip, puerto)) == 0:
                abiertos.append(puerto)
        except OSError:
            pass
        finally:
            s.close()

    for puerto, nombre, cifrado in PUERTOS:
        if puerto in abiertos:
            return Alcance(ip, tuple(abiertos), nombre, cifrado)
    return Alcance(ip, tuple(abiertos), None, False)


# ─────────────────────────────────────────────────────────────────────────────
# Los secretos del export, que NO se guardan
# ─────────────────────────────────────────────────────────────────────────────

#: Lo que hay que tachar del `/export` antes de escribirlo en ningún lado.
#:
#: 🔴 RouterOS tiene `/export hide-sensitive`, que ya oculta la mayoría. Esto
#:    es la SEGUNDA barrera, y existe porque la primera depende de que alguien
#:    se acuerde de pasar el parámetro. Un respaldo que duplica todas las
#:    contraseñas del ISP en otra base no es una solución: es un problema nuevo
#:    con nombre de solución.
#:
#:    Se tacha el VALOR y se deja la clave, para que el diff siga sirviendo:
#:    «acá cambió la contraseña de PPPoE» es información; el valor no hace
#:    falta para saberlo.
SECRETOS = re.compile(
    r"""(?ix)
    \b(
        password | passwd | secret | pre-shared-key | wpa2?-pre-shared-key |
        key | community | authentication-password | encryption-password |
        private-key | passphrase
    )
    \s* = \s*
    ( " [^"]* " | \S+ )
    """,
    re.VERBOSE,
)


def tachar_secretos(export: str) -> tuple[str, int]:
    """Reemplaza los valores sensibles y devuelve cuántos tachó.

    El contador importa: si un día tacha cero en un export de 400 líneas, lo
    más probable no es que el router no tenga secretos — es que cambió el
    formato y esta expresión dejó de reconocerlos. Un cero es una alarma.
    """
    n = 0

    def _reemplazo(m: re.Match[str]) -> str:
        nonlocal n
        n += 1
        return f"{m.group(1)}=«tachado»"

    return SECRETOS.sub(_reemplazo, export), n


# ─────────────────────────────────────────────────────────────────────────────
# Credenciales: fuera de la base, fuera del repositorio
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Credencial:
    usuario: str
    clave: str
    #: ¿Se acepta hablar por el 8728, donde la clave viaja en claro?
    permitir_api_en_claro: bool = False


def cargar_credencial() -> Credencial | None:
    """Lee la credencial del entorno. Devuelve None si no hay, y eso está bien.

    🔴 Sin credencial el módulo NO se conecta a ningún equipo, y ése es el
       estado por omisión. Encender un respaldo que entra a 155 routers tiene
       que ser un acto deliberado de alguien, no lo que pasa si nadie hace nada.

    Va por entorno y no por la base a propósito. La base del panel se replica,
    se respalda y se consulta desde la interfaz web: una contraseña de router
    ahí es una contraseña de router en cada copia de Postgres y a un `SELECT`
    de distancia de cualquier fallo de la aplicación.
    """
    usuario = os.environ.get("RESPALDO_USUARIO", "").strip()
    clave = os.environ.get("RESPALDO_CLAVE", "")
    if not usuario or not clave:
        return None
    return Credencial(
        usuario=usuario,
        clave=clave,
        permitir_api_en_claro=os.environ.get("RESPALDO_PERMITIR_CLARO") == "1",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Cliente de la API de RouterOS
# ─────────────────────────────────────────────────────────────────────────────

class ErrorRouterOS(RuntimeError):
    """El equipo contestó, pero con un error."""


def _largo(n: int) -> bytes:
    """Codifica el largo de una palabra como lo espera la API de RouterOS.

    El protocolo usa un largo de tamaño variable: los valores chicos ocupan un
    byte y los grandes hasta cinco, con los bits altos del primer byte
    marcando cuántos siguen. Está documentado por MikroTik y no es negociable.
    """
    if n < 0x80:
        return bytes([n])
    if n < 0x4000:
        return (n | 0x8000).to_bytes(2, "big")
    if n < 0x200000:
        return (n | 0xC00000).to_bytes(3, "big")
    if n < 0x10000000:
        return (n | 0xE0000000).to_bytes(4, "big")
    return b"\xf0" + n.to_bytes(4, "big")


def _leer_largo(sock: socket.socket) -> int:
    b = sock.recv(1)
    if not b:
        return 0
    c = b[0]
    if c < 0x80:
        return c
    if c < 0xC0:
        return ((c & 0x3F) << 8) + sock.recv(1)[0]
    if c < 0xE0:
        return ((c & 0x1F) << 16) + int.from_bytes(sock.recv(2), "big")
    if c < 0xF0:
        return ((c & 0x0F) << 24) + int.from_bytes(sock.recv(3), "big")
    return int.from_bytes(sock.recv(4), "big")


def _recibir(sock: socket.socket, n: int) -> bytes:
    """`recv` puede devolver menos de lo pedido. Insistir hasta completar.

    No es paranoia: con un export de 40 kB por una red de radioenlaces, los
    cortes a mitad de palabra son lo normal, no la excepción. Un `recv` suelto
    devolvería una configuración truncada que se ve perfectamente válida.
    """
    partes = []
    faltan = n
    while faltan > 0:
        trozo = sock.recv(min(faltan, 65536))
        if not trozo:
            raise ErrorRouterOS("el equipo cortó la conexión a mitad de la respuesta")
        partes.append(trozo)
        faltan -= len(trozo)
    return b"".join(partes)


def _enviar(sock: socket.socket, *palabras: str) -> None:
    for p in palabras:
        b = p.encode("utf-8")
        sock.sendall(_largo(len(b)) + b)
    sock.sendall(b"\x00")


def _respuesta(sock: socket.socket) -> list[str]:
    """Lee hasta el fin de la respuesta (`!done` o `!trap`)."""
    salida: list[str] = []
    while True:
        n = _leer_largo(sock)
        if n == 0:
            if salida and salida[-1] in ("!done", "!trap", "!fatal"):
                return salida
            continue
        salida.append(_recibir(sock, n).decode("utf-8", "replace"))


def exportar(ip: str, cred: Credencial, alcance: Alcance, timeout: float = 25.0) -> str:
    """Trae el `/export` de un RouterOS. Devuelve el texto, ya sin secretos.

    🔴 Se niega a usar el 8728 salvo permiso explícito. Ver `Credencial`:
       por ese puerto la contraseña del router cruza la red de gestión sin
       cifrar, y en esta instalación 7 de 25 equipos sólo tienen ése.
    """
    if not alcance.se_puede:
        raise ErrorRouterOS(f"{ip}: ningún puerto de administración abierto")
    if not alcance.cifrado and not cred.permitir_api_en_claro:
        raise ErrorRouterOS(
            f"{ip}: sólo acepta la API en claro (8728) y no está permitida. "
            "Habilitá api-ssl en el equipo con "
            "`/ip service set api-ssl disabled=no`, o poné "
            "RESPALDO_PERMITIR_CLARO=1 sabiendo que la contraseña viaja sin cifrar."
        )
    if alcance.via == "ssh":
        raise ErrorRouterOS(f"{ip}: por SSH todavía no; ver docs/RESPALDO-CONFIG.md")

    puerto = 8729 if alcance.via == "api-ssl" else 8728
    cruda = socket.create_connection((ip, puerto), timeout=timeout)
    try:
        if puerto == 8729:
            # 🔴 `check_hostname=False` y sin verificar el certificado, y hay
            #    que decir por qué: RouterOS genera un certificado autofirmado
            #    por equipo. Verificarlo contra una autoridad fallaría en los
            #    155 equipos y la única salida sería desactivar TLS entero —
            #    que es peor. Acá el TLS aporta CIFRADO del transporte, no
            #    autenticación del extremo.
            #
            #    O sea: protege de que alguien LEA la contraseña en la red, no
            #    de que alguien se haga pasar por el router. Para cerrar eso
            #    hace falta poner certificados propios en los equipos, que es
            #    trabajo de configuración y está anotado en el documento.
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(cruda)
        else:
            sock = cruda

        _enviar(sock, "/login", f"=name={cred.usuario}", f"=password={cred.clave}")
        r = _respuesta(sock)
        if "!trap" in r or "!fatal" in r:
            # No se incluye la respuesta: puede repetir la credencial.
            raise ErrorRouterOS(f"{ip}: el equipo rechazó el usuario o la clave")

        _enviar(sock, "/export", "=terse=", "=hide-sensitive=")
        partes = [p[5:] for p in _respuesta(sock) if p.startswith("=ret=")]
        texto = "\n".join(partes) if partes else ""
        if not texto.strip():
            raise ErrorRouterOS(f"{ip}: el export vino vacío")

        limpio, tachados = tachar_secretos(texto)
        if tachados == 0 and len(texto.splitlines()) > 40:
            # Ver el comentario de `tachar_secretos`: cero en un export largo
            # es más probable que sea un cambio de formato que un router sin
            # secretos. Se avisa y se guarda igual — perder el respaldo por una
            # sospecha sería peor.
            print(f"[respaldo] {ip}: no se tachó ningún secreto en un export de "
                  f"{len(texto.splitlines())} líneas. ¿Cambió el formato?")
        return limpio
    finally:
        cruda.close()


def huella(texto: str) -> str:
    """SHA-256 del export, para no guardar dos veces lo mismo.

    Un router que no cambió en tres meses no tiene que ocupar noventa copias
    idénticas. Se compara la huella con la última guardada y, si coincide, se
    actualiza sólo la fecha de la última verificación.
    """
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def ahora() -> datetime:
    return datetime.now(timezone.utc)
