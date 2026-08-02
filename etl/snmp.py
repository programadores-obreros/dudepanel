"""
Cliente SNMP v1/v2c mínimo: `GET` y `WALK`, sin dependencias.

═══════════════════════════════════════════════════════════════════════════════
 Por qué escrito a mano y no con una biblioteca
═══════════════════════════════════════════════════════════════════════════════

Porque hace falta MUY poco: dos tipos de pedido, una docena de tipos de dato y
un codificador BER que entra en 120 líneas. La alternativa —`pysnmp`— arrastra
un árbol de dependencias grande a un contenedor que hoy tiene exactamente una
(`psycopg`), y que corre en la red de gestión de un ISP. Cada paquete nuevo ahí
es superficie de ataque y una actualización más que vigilar.

Es la misma decisión que se tomó con el traceroute, y por el mismo motivo.

═══════════════════════════════════════════════════════════════════════════════
 🔴 SÓLO LECTURA. No existe `SET` en este módulo, y es a propósito.
═══════════════════════════════════════════════════════════════════════════════

Un `SNMP SET` cambia la configuración de un equipo de producción. Este panel no
escribe en ningún equipo, y la forma más confiable de garantizarlo no es una
comprobación: es que el código para hacerlo no esté.

═══════════════════════════════════════════════════════════════════════════════
 🔴 Y la comunidad NO se guarda en la base
═══════════════════════════════════════════════════════════════════════════════

The Dude la tiene adentro de `dude.db` —medido: `public` en los dos perfiles de
esta instalación, el valor de fábrica— pero el ETL no la extrae y esto no la
lee de ahí. Viene de una variable de entorno del despliegue.

Motivo: en SNMP v1/v2c la comunidad ES la contraseña. Que acá valga `public` no
la vuelve inofensiva en el próximo ISP que instale esto, y la ficha del equipo
promete que «el panel no guarda usuarios ni contraseñas». Una promesa impresa en
pantalla no se rompe por comodidad.

Consecuencia honesta: no se soportan comunidades distintas por equipo. En esta
instalación no hace falta —los 885 heredan el perfil del servidor— y el día que
haga falta, es una decisión a tomar de nuevo, no un defecto a arrastrar.
"""

from __future__ import annotations

import socket
import struct
import time

# ── BER ──────────────────────────────────────────────────────────────────────
#
# Los tags que aparecen de verdad. No se implementa ASN.1 entero: se implementa
# lo que SNMP usa, que es un subconjunto chico y estable desde 1990.

TAG_INTEGER = 0x02
TAG_OCTETS = 0x04
TAG_NULL = 0x05
TAG_OID = 0x06
TAG_SEQ = 0x30
TAG_IP = 0x40
TAG_COUNTER32 = 0x41
TAG_GAUGE32 = 0x42
TAG_TIMETICKS = 0x43
TAG_OPAQUE = 0x44
TAG_COUNTER64 = 0x46

PDU_GET = 0xA0
PDU_GETNEXT = 0xA1
PDU_RESPONSE = 0xA2

#: Los tres «no hay tal cosa» de SNMPv2. Llegan como tag sin contenido y hay que
#: distinguirlos de un valor vacío: «este equipo no tiene esa variable» y «esa
#: variable está en blanco» son dos respuestas distintas.
SIN_OBJETO = {0x80: "sin ese objeto", 0x81: "sin esa instancia", 0x82: "fin del MIB"}


class ErrorSNMP(Exception):
    pass


def _largo(n: int) -> bytes:
    """Longitud BER. Corta hasta 127, larga a partir de ahí."""
    if n < 0x80:
        return bytes([n])
    crudo = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(crudo)]) + crudo


def _tlv(tag: int, valor: bytes) -> bytes:
    return bytes([tag]) + _largo(len(valor)) + valor


def _entero(n: int) -> bytes:
    """INTEGER en complemento a dos, con la MENOR cantidad de bytes.

    🔴 El caso que se olvida: un valor cuyo byte más significativo tiene el bit
       alto en 1 necesita un `00` adelante, o el otro lado lo lee como negativo.
       `128` mal codificado es `-128`, y el equipo contesta un error que no
       nombra el problema.
    """
    if n == 0:
        return _tlv(TAG_INTEGER, b"\x00")
    ancho = (n.bit_length() // 8) + 1
    return _tlv(TAG_INTEGER, n.to_bytes(ancho, "big", signed=True))


def codificar_oid(oid: str) -> bytes:
    """`1.3.6.1.2.1.1.3.0` → BER.

    Las dos primeras ramas van juntas en un byte (`40*a + b`); el resto en
    base 128 con el bit alto como continuación.
    """
    partes = [int(p) for p in oid.strip(".").split(".")]
    if len(partes) < 2:
        raise ErrorSNMP(f"OID demasiado corto: {oid}")
    salida = bytearray([40 * partes[0] + partes[1]])
    for p in partes[2:]:
        if p < 0x80:
            salida.append(p)
            continue
        grupo = bytearray()
        while p:
            grupo.insert(0, (p & 0x7F) | 0x80)
            p >>= 7
        grupo[-1] &= 0x7F
        salida += grupo
    return _tlv(TAG_OID, bytes(salida))


def _leer_largo(datos: bytes, i: int) -> tuple[int, int]:
    b = datos[i]
    i += 1
    if b < 0x80:
        return b, i
    n = b & 0x7F
    return int.from_bytes(datos[i:i + n], "big"), i + n


def _decodificar_oid(crudo: bytes) -> str:
    if not crudo:
        return ""
    partes = [crudo[0] // 40, crudo[0] % 40]
    valor = 0
    for b in crudo[1:]:
        valor = (valor << 7) | (b & 0x7F)
        if not b & 0x80:
            partes.append(valor)
            valor = 0
    return ".".join(str(p) for p in partes)


def _decodificar_valor(tag: int, crudo: bytes):
    if tag in SIN_OBJETO:
        return None
    if tag == TAG_NULL:
        return None
    if tag == TAG_OCTETS:
        # Se intenta texto y se cae a hexadecimal. Muchos valores —una MAC, un
        # sysObjectID binario— no son texto, y mostrarlos con caracteres de
        # reemplazo sería basura que parece un dato.
        try:
            t = crudo.decode("utf-8")
            return t if t.isprintable() or not t else ":".join(f"{b:02x}" for b in crudo)
        except UnicodeDecodeError:
            return ":".join(f"{b:02x}" for b in crudo)
    if tag == TAG_OID:
        return _decodificar_oid(crudo)
    if tag == TAG_IP:
        return ".".join(str(b) for b in crudo) if len(crudo) == 4 else crudo.hex()
    if tag in (TAG_INTEGER, TAG_COUNTER32, TAG_GAUGE32, TAG_TIMETICKS, TAG_COUNTER64):
        # Los contadores son SIN signo aunque compartan la codificación con
        # INTEGER. Leer un Counter32 con signo convierte 3.000.000.000 en un
        # número negativo, y eso después se dibuja en un gráfico.
        con_signo = tag == TAG_INTEGER
        return int.from_bytes(crudo, "big", signed=con_signo) if crudo else 0
    return crudo.hex()


def _parsear_respuesta(datos: bytes, id_esperado: int) -> list[tuple[str, object]]:
    i = 0
    if datos[i] != TAG_SEQ:
        raise ErrorSNMP("la respuesta no empieza con SEQUENCE")
    _, i = _leer_largo(datos, i + 1)

    # version
    if datos[i] != TAG_INTEGER:
        raise ErrorSNMP("falta la versión")
    n, i = _leer_largo(datos, i + 1)
    i += n
    # community
    if datos[i] != TAG_OCTETS:
        raise ErrorSNMP("falta la comunidad")
    n, i = _leer_largo(datos, i + 1)
    i += n
    # PDU
    if datos[i] != PDU_RESPONSE:
        raise ErrorSNMP(f"PDU inesperada 0x{datos[i]:02x}")
    _, i = _leer_largo(datos, i + 1)

    def entero():
        nonlocal i
        n, j = _leer_largo(datos, i + 1)
        v = int.from_bytes(datos[j:j + n], "big", signed=True) if n else 0
        i = j + n
        return v

    rid, err, _idx = entero(), entero(), entero()
    # 🔴 Se comprueba el request-id. Sin esto, una respuesta demorada de una
    #    consulta anterior se toma como la de ahora: en un WALK son cientos de
    #    pedidos por el mismo socket y el desfase de a uno produce una tabla
    #    entera corrida, que se ve perfectamente plausible.
    if rid != id_esperado:
        raise ErrorSNMP(f"request-id {rid} no es el esperado {id_esperado}")
    if err:
        raise ErrorSNMP(f"el equipo devolvió error {err}")

    if datos[i] != TAG_SEQ:
        raise ErrorSNMP("faltan los varbinds")
    n, i = _leer_largo(datos, i + 1)
    fin = i + n

    pares: list[tuple[str, object]] = []
    while i < fin:
        if datos[i] != TAG_SEQ:
            break
        n, i = _leer_largo(datos, i + 1)
        sub = i + n
        if datos[i] != TAG_OID:
            break
        n2, j = _leer_largo(datos, i + 1)
        oid = _decodificar_oid(datos[j:j + n2])
        i = j + n2
        tag = datos[i]
        n3, j = _leer_largo(datos, i + 1)
        pares.append((oid, _decodificar_valor(tag, datos[j:j + n3])))
        i = sub
    return pares


def _pedir(
    destino: str, comunidad: str, oids: list[str], pdu: int, version: int,
    puerto: int, timeout: float, rid: int,
) -> list[tuple[str, object]]:
    binds = b"".join(_tlv(TAG_SEQ, codificar_oid(o) + _tlv(TAG_NULL, b"")) for o in oids)
    cuerpo = _entero(rid) + _entero(0) + _entero(0) + _tlv(TAG_SEQ, binds)
    mensaje = _tlv(
        TAG_SEQ,
        _entero(version) + _tlv(TAG_OCTETS, comunidad.encode()) + _tlv(pdu, cuerpo),
    )
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(timeout)
        s.sendto(mensaje, (destino, puerto))
        datos, _ = s.recvfrom(65535)
        return _parsear_respuesta(datos, rid)
    finally:
        s.close()


def _siguiente_id(contador=[0]) -> int:  # noqa: B006 — estado del módulo, a propósito
    contador[0] = (contador[0] + 1) % 0x7FFFFFFF
    return contador[0] or 1


def get(
    destino: str, oids: list[str], *, comunidad: str = "public",
    version: int = 1, puerto: int = 161, timeout: float = 1.5,
) -> dict[str, object]:
    """Un `GET` con varios OID. `version` 0 = v1, 1 = v2c."""
    pares = _pedir(destino, comunidad, oids, PDU_GET, version, puerto, timeout,
                   _siguiente_id())
    return {o: v for o, v in pares}


def walk(
    destino: str, base: str, *, comunidad: str = "public", version: int = 1,
    puerto: int = 161, timeout: float = 1.5, tope: int = 64,
) -> list[tuple[str, object]]:
    """Recorre una rama con `GETNEXT`. Se corta al salir de la rama o al tope.

    🔴 El `tope` no es una precaución teórica. Un WALK sin límite sobre un
       equipo con una tabla de rutas grande son miles de idas y vueltas: la
       página se cuelga y el equipo se lleva una ráfaga que nadie pidió. 64
       alcanza para la tabla de interfaces de cualquier equipo de acceso.
    """
    salida: list[tuple[str, object]] = []
    actual = base
    prefijo = base.strip(".") + "."
    for _ in range(tope):
        pares = _pedir(destino, comunidad, [actual], PDU_GETNEXT, version, puerto,
                       timeout, _siguiente_id())
        if not pares:
            break
        oid, valor = pares[0]
        if not oid.startswith(prefijo):
            break  # se salió de la rama: terminó la tabla
        # 🔴 Si el OID no avanza, el equipo está mal implementado y esto sería
        #    un bucle infinito con paquetes de verdad. Se corta.
        if oid == actual:
            break
        salida.append((oid, valor))
        actual = oid
    return salida


# ── Lo que se le pregunta a un equipo ────────────────────────────────────────

SISTEMA = {
    "1.3.6.1.2.1.1.1.0": "descripcion",
    "1.3.6.1.2.1.1.3.0": "uptime_centisegundos",
    "1.3.6.1.2.1.1.4.0": "contacto",
    "1.3.6.1.2.1.1.5.0": "nombre",
    "1.3.6.1.2.1.1.6.0": "ubicacion",
}

IF_NOMBRE = "1.3.6.1.2.1.2.2.1.2"
IF_OPER = "1.3.6.1.2.1.2.2.1.8"
IF_ADMIN = "1.3.6.1.2.1.2.2.1.7"
IF_VELOCIDAD = "1.3.6.1.2.1.2.2.1.5"
#: 🔴 El OID que convierte una lista de alarmas en una lista de trabajo.
#:
#:    `ifLastChange` es el valor que tenía `sysUpTime` cuando la interfaz entró
#:    en su estado actual. Restándolo del uptime de ahora sale HACE CUÁNTO que
#:    está así — y esa fecha desarma la mitad de los sustos.
#:
#:    Medido sobre la red real: 20 puertos «caídos con tráfico» que parecían una
#:    emergencia. Con la fecha, el más NUEVO llevaba 26 días y el más viejo 423.
#:    Cero incidentes activos. Sin este dato, la lista mandaba a un técnico a
#:    arreglar enlaces dados de baja hace catorce meses.
IF_ULTIMO_CAMBIO = "1.3.6.1.2.1.2.2.1.9"
IF_IN = "1.3.6.1.2.1.2.2.1.10"
IF_OUT = "1.3.6.1.2.1.2.2.1.16"
#: La descripción que escribió una persona. Vale oro: en esta red hay puertos
#: llamados `ether2-L2-OLT8`, que dicen a quién alimentan sin preguntarle a nadie.
IF_ALIAS = "1.3.6.1.2.1.31.1.1.1.18"

OPER = {1: "arriba", 2: "abajo", 3: "prueba", 4: "desconocido", 5: "dormido",
        6: "sin componente", 7: "sin señal"}

#: Debajo de esto, la interfaz nunca llevó nada útil: es un puerto libre, no una
#: falla. Un megabyte es ruido de negociación y descubrimiento, no servicio.
TRAFICO_MINIMO = 1_000_000


def veredicto(oper, admin, bytes_totales) -> tuple[str, str]:
    """Qué hacer con esta interfaz. Devuelve (clave, explicación).

    🔴 Las cuatro respuestas posibles, y sólo UNA pide acción:

       · `ok`        anda
       · `apagado`   alguien la deshabilitó a propósito — nada que arreglar
       · `libre`     habilitada, sin enlace, y NUNCA movió nada: puerto vacante
       · `caido`     habilitada, sin enlace, y SÍ movió tráfico: acá hay algo

       Un panel que sólo mira el estado operativo mete las tres últimas en la
       misma bolsa. Medido en esta red: 180 puertos «abajo», de los cuales 153
       eran simplemente libres. Sin separarlos, la señal se ahoga en el ruido.
    """
    if admin == "abajo":
        return "apagado", "Deshabilitada a propósito. No hay nada que arreglar."
    if oper == "arriba":
        return "ok", ""
    if oper != "abajo":
        return "ok", ""
    if (bytes_totales or 0) < TRAFICO_MINIMO:
        return "libre", "Habilitada pero nunca movió tráfico: es un puerto vacante."
    return "caido", "Movió tráfico y hoy no tiene enlace. Debería andar y no anda."


def interrogar(
    destino: str, *, comunidad: str = "public", version: int = 1,
    puerto: int = 161, timeout: float = 1.5, max_if: int = 48,
) -> dict:
    """Lo que vale la pena saber de un equipo, en una sola llamada.

    Devuelve `{"responde": False, ...}` en vez de levantar cuando el equipo no
    contesta: no contestar SNMP es un RESULTADO —en esta instalación lo hace el
    93,6 % de los equipos, medido sobre los 885— y no un fallo del panel.

    🔴 Un WALK por atributo sería carísimo: siete atributos × una vuelta por
       interfaz son cientos de idas y vueltas por un clic. Acá se hace UN walk
       para descubrir los índices y después un GET por interfaz con los seis
       OID juntos. Para 32 interfaces: 33 viajes en vez de ~250.
    """
    t0 = time.perf_counter()
    comun = {"destino": destino, "version": "v2c" if version == 1 else "v1"}
    def pedir(oids):
        return get(destino, oids, comunidad=comunidad, version=version,
                   puerto=puerto, timeout=timeout)
    try:
        sis = pedir(list(SISTEMA))
    except (socket.timeout, TimeoutError):
        return {**comun, "responde": False,
                "motivo": "No contestó SNMP. Puede no tenerlo habilitado, "
                          "estar filtrado, o usar otra comunidad."}
    except (ErrorSNMP, OSError) as e:
        return {**comun, "responde": False, "motivo": f"{type(e).__name__}: {e}"}

    datos = {SISTEMA[o]: v for o, v in sis.items() if o in SISTEMA}
    cs = datos.get("uptime_centisegundos")
    arriba_cs = cs if isinstance(cs, int) else 0
    datos["uptime_s"] = arriba_cs // 100 if arriba_cs else None

    interfaces = []
    try:
        nombres = walk(destino, IF_NOMBRE, comunidad=comunidad, version=version,
                       puerto=puerto, timeout=timeout, tope=max_if)
        for oid, nombre in nombres:
            idx = oid.rsplit(".", 1)[-1]
            r = pedir([f"{b}.{idx}" for b in
                       (IF_OPER, IF_ADMIN, IF_VELOCIDAD, IF_ULTIMO_CAMBIO,
                        IF_IN, IF_OUT, IF_ALIAS)])
            o = r.get(f"{IF_OPER}.{idx}")
            a = r.get(f"{IF_ADMIN}.{idx}")
            oper = OPER.get(o, str(o)) if o is not None else None
            admin = OPER.get(a, str(a)) if a is not None else None
            trafico = (r.get(f"{IF_IN}.{idx}") or 0) + (r.get(f"{IF_OUT}.{idx}") or 0)
            ult = r.get(f"{IF_ULTIMO_CAMBIO}.{idx}")
            # `ifLastChange` en 0 significa «así desde que arrancó el equipo»,
            # no «cambió recién». Confundirlos daría «caído hace 0 segundos» en
            # un puerto que lleva años abajo: la mentira más peligrosa posible
            # en esta pantalla.
            desde_arranque = ult == 0
            caido_s = (
                arriba_cs // 100 if desde_arranque
                else (arriba_cs - ult) // 100 if isinstance(ult, int) and arriba_cs
                else None
            )
            clave, explica = veredicto(oper, admin, trafico)
            interfaces.append({
                "indice": idx,
                "nombre": nombre,
                "alias": r.get(f"{IF_ALIAS}.{idx}") or None,
                "operativa": oper,
                # 🔴 «Apagada por alguien» y «caída sola» son cosas MUY
                #    distintas y las dos se ven como «abajo». Sin separarlas,
                #    un puerto deshabilitado a propósito figura como falla.
                "administrativa": admin,
                "velocidad_bps": r.get(f"{IF_VELOCIDAD}.{idx}"),
                "trafico_bytes": trafico,
                "cambio_hace_s": caido_s,
                "desde_el_arranque": desde_arranque,
                "veredicto": clave,
                "explica": explica,
                # 🔴 Marca de agrupación: dos puertos con el MISMO
                #    `ifLastChange` cayeron en el mismo instante, y eso es UN
                #    evento, no dos. Medido: tres puertos de un router llamados
                #    `ether1/2/3-L2-OLT8` con el mismo valor exacto. Tres
                #    coincidencias no existen: fue un cable, un equipo o una
                #    persona.
                "evento": ult if isinstance(ult, int) and ult else None,
            })
    except (socket.timeout, TimeoutError, ErrorSNMP, OSError):
        pass

    return {**comun, "responde": True, **datos, "interfaces": interfaces,
            "ms_total": round((time.perf_counter() - t0) * 1000)}
