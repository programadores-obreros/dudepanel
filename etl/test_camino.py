"""Pruebas de `camino.py`.

    pytest -q etl/test_camino.py

La prueba de extremo a extremo necesita un PostgreSQL:

    docker run --rm -d -e POSTGRES_PASSWORD=x -p 55496:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgresql://postgres:x@localhost:55496/postgres pytest -q


🔴 LA PRUEBA QUE JUSTIFICA ESTE ARCHIVO es `TestNadaInternoSale`. Todo lo demás
   verifica que el código haga lo que dice; ésa verifica que NO haga lo que no
   tiene que hacer, que es lo difícil de comprobar mirando el código.

   La técnica es un espía: `ResolutorASN` recibe su consultor DNS por
   parámetro, así que el test le pasa uno que ANOTA cada nombre en vez de
   mandarlo. Después se afirma sobre la lista de nombres. No se verifica que el
   código «filtre bien»: se verifica qué salió.

── Sobre las direcciones de estas pruebas ──────────────────────────────────────

Los rangos de documentación de la RFC 5737 (192.0.2/24, 198.51.100/24,
203.0.113/24) son, para `camino.py`, direcciones NO PÚBLICAS — y con razón: no
tiene sentido preguntarle a un tercero por una dirección que por definición no
es de nadie.

Eso deja un problema para las pruebas: hace falta alguna dirección que el
módulo considere pública, y no puede ser la de un equipo real.

La respuesta es `192.88.99.0/24`: el prefijo anycast de los relays 6to4, que la
**RFC 7526 dio de baja en 2015**. Está en el espacio unicast global —así que el
módulo lo trata como público, igual que el `CHECK` de la base— pero no está
asignado a ningún operador ni ruteado a ninguna parte. Identifica a nadie.
"""
from __future__ import annotations

import ipaddress
import os
import re
import struct
from pathlib import Path

import pytest

import camino

#: Ver el encabezado. La única familia de direcciones "públicas" que este
#: archivo tiene permitido escribir.
PUBLICA = "192.88.99.1"
PUBLICA_2 = "192.88.99.2"

SCHEMA = Path(__file__).with_name("schema.sql")


# ═════════════════════════════════════════════════════════════════════════════
#  El espía
# ═════════════════════════════════════════════════════════════════════════════


class EspiaDNS:
    """Consultor de mentira que anota todo lo que le piden y no manda nada."""

    def __init__(self, respuestas: dict[str, list[str]] | None = None) -> None:
        self.nombres: list[str] = []
        self.respuestas = respuestas or {}

    def __call__(self, nombre, servidores=None, timeout=3.0) -> list[str]:
        self.nombres.append(nombre)
        return self.respuestas.get(nombre, [])


def muestras(red: ipaddress.IPv4Network) -> list[str]:
    """Tres direcciones de una red: la primera, la segunda y la última.

    Las puntas son donde se rompen los `<=` mal escritos.
    """
    primera = int(red.network_address)
    ultima = int(red.broadcast_address)
    return [
        str(ipaddress.IPv4Address(primera)),
        str(ipaddress.IPv4Address(min(primera + 1, ultima))),
        str(ipaddress.IPv4Address(ultima)),
    ]


# ═════════════════════════════════════════════════════════════════════════════
#  🔴 La garantía
# ═════════════════════════════════════════════════════════════════════════════


class TestNadaInternoSale:
    def test_ningun_rango_no_publico_es_publico(self):
        """Las tres direcciones de cada uno de los 14 rangos, una por una."""
        colados = [
            d for red in camino.NO_PUBLICAS for d in muestras(red)
            if camino.es_publica(d)
        ]
        assert colados == []

    def test_las_direcciones_de_los_equipos_del_isp_no_son_publicas(self):
        """Los cuatro rangos donde vive el 90 % del inventario.

        Medido el 01/08/2026 sobre las 894 direcciones de los 885 equipos:
        650 en 10/8, 128 en 172.16/12, 17 en CGNAT 100.64/10, 12 en 192.168/16.
        Son 807 direcciones que NO pueden salir, y estos son sus rangos —no las
        direcciones, que no van al repositorio.
        """
        rangos = ["10.0.0.0/8", "172.16.0.0/12", "100.64.0.0/10", "192.168.0.0/16"]
        for r in rangos:
            red = ipaddress.ip_network(r)
            assert not any(camino.es_publica(d) for d in muestras(red)), r

    def test_el_resolutor_se_niega_y_no_consulta_nada(self):
        espia = EspiaDNS()
        r = camino.ResolutorASN(consultor=espia)

        for red in camino.NO_PUBLICAS:
            for d in muestras(red):
                with pytest.raises(ValueError, match="negado"):
                    r.resolver(d)

        # 42 negativas y CERO consultas. Ésta es la afirmación.
        assert espia.nombres == []

    def test_nombre_origen_no_se_construye_para_lo_interno(self):
        """Segunda capa: si el nombre no llega a existir, no hay qué mandar."""
        for red in camino.NO_PUBLICAS:
            for d in muestras(red):
                with pytest.raises(ValueError, match="negado"):
                    camino.nombre_origen(d)

    def test_un_camino_mezclado_solo_consulta_los_saltos_publicos(self):
        """La prueba de integración de la garantía, sin tocar la red.

        Un camino con una dirección de CADA rango no público más dos públicas:
        tienen que salir exactamente dos consultas de origen.
        """
        saltos = [
            camino.Salto(ttl=i + 1, direccion=muestras(red)[1], rtt_ms=1.0)
            for i, red in enumerate(camino.NO_PUBLICAS)
        ]
        saltos.append(camino.Salto(ttl=len(saltos) + 1))              # uno mudo
        saltos.append(camino.Salto(ttl=len(saltos) + 1, direccion=PUBLICA))
        saltos.append(camino.Salto(ttl=len(saltos) + 1, direccion=PUBLICA_2))

        espia = EspiaDNS()
        camino.resolver_saltos(saltos, camino.ResolutorASN(consultor=espia))

        assert espia.nombres == [
            camino.nombre_origen(PUBLICA),
            camino.nombre_origen(PUBLICA_2),
        ]

    def test_ningun_nombre_consultado_contiene_una_direccion_no_publica(self):
        """Lo mismo, pero mirando el TEXTO de lo que salió.

        Una afirmación sobre la lista esperada se puede satisfacer por
        casualidad; ésta reconstruye la dirección desde el nombre invertido y
        comprueba que sea pública. Es la prueba que sobrevive a un refactor que
        cambie el formato del nombre.
        """
        saltos = [
            camino.Salto(ttl=i + 1, direccion=muestras(red)[1])
            for i, red in enumerate(camino.NO_PUBLICAS)
        ] + [camino.Salto(ttl=99, direccion=PUBLICA)]

        espia = EspiaDNS()
        camino.resolver_saltos(saltos, camino.ResolutorASN(consultor=espia))

        for nombre in espia.nombres:
            etiquetas = nombre.split(".")
            if not nombre.endswith(camino.SUFIJO_ORIGEN):
                continue
            reconstruida = ".".join(reversed(etiquetas[:4]))
            assert camino.es_publica(reconstruida), f"se filtró {reconstruida}"

    def test_el_interruptor_apaga_toda_consulta(self):
        """`CAMINO_ASN=0`: traza igual y no le pregunta nada a nadie."""
        espia = EspiaDNS()
        r = camino.ResolutorASN(consultor=espia, habilitado=False)
        assert r.resolver(PUBLICA).resultado == "no_consultado"
        assert espia.nombres == []

    def test_la_lista_de_python_y_el_CHECK_de_la_base_son_la_misma(self):
        """🔴 Las dos listas se pueden separar sin que nada falle. Salvo esto.

        `camino.NO_PUBLICAS` decide qué sale de la máquina; el `CHECK` de
        `camino_asn_cache` es la última barrera. Si alguien agrega un rango a
        una sola de las dos, la barrera deja de cubrir lo que el código filtra
        —o al revés— y nadie se entera hasta que se filtra algo.
        """
        sql = SCHEMA.read_text(encoding="utf-8")
        bloque = re.search(
            r"camino_asn_cache_publica_chk.*?\]::cidr\[\]", sql, re.S
        )
        assert bloque, "no encontré el CHECK en schema.sql"

        del_sql = sorted(
            ipaddress.ip_network(c) for c in re.findall(r"'([\d./]+)'", bloque.group(0))
        )
        del_py = sorted(camino.NO_PUBLICAS)
        assert del_sql == del_py


# ═════════════════════════════════════════════════════════════════════════════
#  Clasificación
# ═════════════════════════════════════════════════════════════════════════════


class TestClasificar:
    def test_mudo_es_none_y_solo_none(self):
        assert camino.clasificar(None) == "mudo"

    def test_publica(self):
        assert camino.clasificar(PUBLICA) == "publica"

    @pytest.mark.parametrize("d", ["10.0.0.1", "172.16.0.1", "192.168.0.1",
                                   "100.64.0.1", "127.0.0.1", "169.254.0.1"])
    def test_interna(self, d):
        assert camino.clasificar(d) == "interna"

    @pytest.mark.parametrize("d", ["224.0.0.1", "239.255.255.255",
                                   "240.0.0.1", "255.255.255.255", "0.0.0.0"])
    def test_especial_no_se_disfraza_de_interna(self, d):
        """Una multicast no es «un equipo nuestro». Meterlas en la misma bolsa
        haría que el panel dibuje un router del ISP donde no hay ninguno."""
        assert camino.clasificar(d) == "especial"

    def test_multicast_es_la_trampa_de_is_global(self):
        """🔴 El motivo de que `NO_PUBLICAS` sea una lista y no `is_global`.

        Medido: `ipaddress.ip_address('224.0.0.1').is_global` devuelve **True**.
        Un filtro escrito con esa propiedad mandaría direcciones multicast a un
        servicio externo. Y al revés, `100.64.0.1` (CGNAT, 17 equipos del ISP)
        tiene `is_private == False`: filtrar por ahí las dejaría salir. Las dos
        abreviaturas fallan, cada una por su lado.
        """
        assert ipaddress.ip_address("224.0.0.1").is_global is True
        assert camino.es_publica("224.0.0.1") is False

        assert ipaddress.ip_address("100.64.0.1").is_private is False
        assert camino.es_publica("100.64.0.1") is False

    @pytest.mark.parametrize("basura", ["", "no-es-una-ip", "999.1.1.1",
                                        "1.2.3", "::1", "2001:db8::1"])
    def test_ante_la_duda_no_sale(self, basura):
        assert camino.es_publica(basura) is False


# ═════════════════════════════════════════════════════════════════════════════
#  Los saltos mudos
# ═════════════════════════════════════════════════════════════════════════════


class TestSaltosMudos:
    def _traza(self, direcciones: list[str | None]) -> camino.Traza:
        saltos = [camino.Salto(ttl=i + 1, direccion=d, rtt_ms=1.0 if d else None)
                  for i, d in enumerate(direcciones)]
        return camino.Traza("destino.example", "192.88.99.9", saltos,
                            "udp-recverr", 20, 1, 100, "destino")

    def test_el_mudo_ocupa_su_ttl_y_no_se_renumera(self):
        """🔴 Un salto que no contesta es lo NORMAL, no un error.

        Omitirlo convertiría «no sé qué hay en el salto 2» en «no hay salto 2»,
        y el salto 3 pasaría a llamarse 2. Todo el camino se corre un lugar.
        """
        t = self._traza(["10.0.0.1", None, PUBLICA])
        assert [s.ttl for s in t.saltos] == [1, 2, 3]
        assert t.saltos[1].direccion is None
        assert t.saltos[1].clase == "mudo"
        assert t.saltos[2].ttl == 3

    def test_el_mudo_no_tiene_rtt_inventado(self):
        t = self._traza([None])
        assert t.saltos[0].rtt_ms is None
        assert t.saltos[0].icmp_tipo is None

    def test_se_cuentan(self):
        t = self._traza(["10.0.0.1", None, None, PUBLICA])
        assert len(t.saltos) == 4
        assert t.mudos == 2
        assert t.publicos == 1


# ═════════════════════════════════════════════════════════════════════════════
#  Detección de cambio de camino
# ═════════════════════════════════════════════════════════════════════════════


class TestHuellas:
    def _con_asn(self, pares: list[tuple[str | None, int | None]]) -> camino.Traza:
        saltos = []
        for i, (d, asn) in enumerate(pares):
            s = camino.Salto(ttl=i + 1, direccion=d)
            if asn is not None:
                s.asn = camino.DatosASN(asn=asn, resultado="ok")
            saltos.append(s)
        return camino.Traza("d.example", "192.88.99.9", saltos,
                            "udp-recverr", 20, 1, 1, "destino")

    def test_un_salto_mudo_de_mas_NO_cambia_la_huella_de_operador(self):
        """🔴 El motivo de que haya dos huellas.

        Que un router deje de contestar es lo más común del mundo. Si eso
        disparara «el camino cambió», la alarma sería ruido y en dos semanas
        nadie la mira. La huella de operadores ignora los mudos; la de saltos
        no, y por eso sirve para reproducir pero no para alarmar.
        """
        a = self._con_asn([("10.0.0.1", None), (PUBLICA, 64500)])
        b = self._con_asn([("10.0.0.1", None), (None, None), (PUBLICA, 64500)])

        assert a.huella_asn == b.huella_asn        # 🔴 lo importante
        assert a.huella_saltos != b.huella_saltos  # y esto también es correcto

    def test_cambiar_de_operador_SI_cambia_la_huella(self):
        a = self._con_asn([("10.0.0.1", None), (PUBLICA, 64500)])
        b = self._con_asn([("10.0.0.1", None), (PUBLICA, 64501)])
        assert a.huella_asn != b.huella_asn
        assert a.ruta_asn == "interna>AS64500"
        assert b.ruta_asn == "interna>AS64501"

    def test_saltos_seguidos_del_mismo_dueno_se_colapsan(self):
        """Que el mayorista agregue un router intermedio no es cambiar de
        camino: sigue siendo el mismo mayorista."""
        a = self._con_asn([("10.0.0.1", None), (PUBLICA, 64500)])
        b = self._con_asn([("10.0.0.1", None), ("10.0.0.2", None),
                           (PUBLICA, 64500), (PUBLICA_2, 64500)])
        assert a.ruta_asn == b.ruta_asn == "interna>AS64500"
        assert a.huella_asn == b.huella_asn

    def test_publico_sin_asn_no_se_confunde_con_interno(self):
        a = self._con_asn([(PUBLICA, None)])
        assert a.ruta_asn == "publica-sin-asn"

    def test_la_ruta_es_legible(self):
        t = self._con_asn([("10.0.0.1", None), (None, None), (PUBLICA, 64500)])
        assert t.ruta_asn == "interna>AS64500"


# ═════════════════════════════════════════════════════════════════════════════
#  Team Cymru
# ═════════════════════════════════════════════════════════════════════════════


class TestCymru:
    def test_nombre_origen_invierte_los_octetos(self):
        assert camino.nombre_origen("192.88.99.1") == \
            "1.99.88.192." + camino.SUFIJO_ORIGEN

    def test_parsear_origen_con_la_respuesta_medida(self):
        """Formato verificado contra el servicio real el 01/08/2026."""
        d = camino.parsear_origen("13335 | 192.88.99.0/24 | AU | apnic | 2011-08-11")
        assert (d.asn, d.pais, d.registro, d.resultado) == \
            (13335, "AU", "apnic", "ok")
        assert d.prefijo == "192.88.99.0/24"
        assert d.asignado == "2011-08-11"

    def test_parsear_nombre_de_as(self):
        txt = "13335 | US | arin | 2010-07-14 | CLOUDFLARENET - Cloudflare, Inc., US"
        assert camino.parsear_nombre_asn(txt) == \
            "CLOUDFLARENET - Cloudflare, Inc., US"

    def test_varios_asn_en_el_mismo_prefijo(self):
        """MOAS. Se toma el MENOR —no el primero— para que la huella sea
        determinista aunque el servicio devuelva otro orden, y se deja dicho
        que había más en vez de tapar el dato."""
        a = camino.parsear_origen("64501 64500 | 192.88.99.0/24 | AU | apnic | 2011")
        b = camino.parsear_origen("64500 64501 | 192.88.99.0/24 | AU | apnic | 2011")
        assert a.asn == b.asn == 64500
        assert "+1" in (a.org or "")

    @pytest.mark.parametrize("basura", ["2011", "", "ayer", "2011-13-45", "0"])
    def test_una_fecha_ajena_ilegible_no_tira_abajo_la_corrida(self, basura):
        """🔴 Regresión. `asignado` es una columna `date` y el texto lo escribe
        un TERCERO: sin validarlo, el INSERT explota con `invalid input syntax
        for type date` y se cae el trazado entero por un dato de adorno.
        Lo encontró `test_la_cache_evita_la_segunda_consulta` con un "2011"."""
        d = camino.parsear_origen(f"64500 | 192.88.99.0/24 | AU | apnic | {basura}")
        assert d.asignado is None
        assert d.asn == 64500          # el dato que importa sigue estando

    def test_una_fecha_bien_formada_se_conserva(self):
        d = camino.parsear_origen("64500 | 192.88.99.0/24 | AU | apnic | 2011-08-11")
        assert d.asignado == "2011-08-11"

    def test_sin_datos_no_es_un_error(self):
        """🔴 Un salto público sin ASN publicado EXISTE y hay que mostrarlo
        como tal. Medido: de los 4 saltos públicos de la traza del 01/08/2026,
        uno no devolvió origen. No es un fallo ni se le inventa un dueño."""
        espia = EspiaDNS(respuestas={})       # contesta, pero vacío
        r = camino.ResolutorASN(consultor=espia)
        assert r.resolver(PUBLICA).resultado == "sin_datos"

    def test_un_dns_caido_es_error_y_no_sin_datos(self):
        """La diferencia decide cuánto se cachea: 7 días contra 15 minutos."""
        def rota(nombre, servidores=None, timeout=3.0):
            raise OSError("sin salida")
        r = camino.ResolutorASN(consultor=rota)
        assert r.resolver(PUBLICA).resultado == "error"

    def test_el_nombre_del_as_se_pregunta_una_sola_vez(self):
        """Un camino cruza varios saltos del mismo operador y es la misma
        pregunta. Sin esta caché, 12 saltos de un mayorista son 12 consultas
        idénticas."""
        respuestas = {
            camino.nombre_origen(PUBLICA): ["64500 | 192.88.99.0/24 | AU | apnic | 2011"],
            camino.nombre_origen(PUBLICA_2): ["64500 | 192.88.99.0/24 | AU | apnic | 2011"],
            f"AS64500.{camino.SUFIJO_ASN}": ["64500 | AU | apnic | 2011 | EJEMPLO - Nadie"],
        }
        espia = EspiaDNS(respuestas)
        r = camino.ResolutorASN(consultor=espia)
        r.resolver(PUBLICA)
        r.resolver(PUBLICA_2)
        assert espia.nombres.count(f"AS64500.{camino.SUFIJO_ASN}") == 1

    def test_la_misma_direccion_se_pregunta_una_sola_vez(self):
        espia = EspiaDNS()
        r = camino.ResolutorASN(consultor=espia)
        r.resolver(PUBLICA)
        r.resolver(PUBLICA)
        assert espia.nombres.count(camino.nombre_origen(PUBLICA)) == 1

    def test_el_tope_de_consultas_frena(self):
        espia = EspiaDNS()
        r = camino.ResolutorASN(consultor=espia, max_consultas=1)
        r.resolver(PUBLICA)
        r.resolver(PUBLICA_2)
        assert len(espia.nombres) == 1


# ═════════════════════════════════════════════════════════════════════════════
#  El cliente DNS propio
# ═════════════════════════════════════════════════════════════════════════════


class TestDNS:
    def _respuesta_txt(self, nombre: str, texto: str) -> bytes:
        """Arma una respuesta DNS a mano, con puntero de compresión."""
        pregunta = camino._codificar_nombre(nombre) + struct.pack("!HH", 16, 1)
        rdata = bytes([len(texto)]) + texto.encode()
        # 0xC00C = puntero al offset 12, que es donde arranca la pregunta. Es
        # lo que manda un servidor de verdad y hay que saber saltearlo.
        respuesta = (struct.pack("!H", 0xC00C) + struct.pack("!HHIH", 16, 1, 300, len(rdata))
                     + rdata)
        return struct.pack("!HHHHHH", 1, 0x8180, 1, 1, 0, 0) + pregunta + respuesta

    def test_ida_y_vuelta(self):
        texto = "64500 | 192.88.99.0/24 | AU | apnic | 2011-08-11"
        datos = self._respuesta_txt("1.99.88.192." + camino.SUFIJO_ORIGEN, texto)
        assert camino._parsear_txt(datos) == [texto]

    def test_sin_respuestas_da_lista_vacia(self):
        vacia = struct.pack("!HHHHHH", 1, 0x8183, 1, 0, 0, 0) + \
            camino._codificar_nombre("nada.example") + struct.pack("!HH", 16, 1)
        assert camino._parsear_txt(vacia) == []

    def test_una_respuesta_truncada_no_pasa_por_buena(self):
        with pytest.raises(ValueError):
            camino._parsear_txt(b"\x00\x01")

    def test_etiqueta_demasiado_larga(self):
        with pytest.raises(ValueError):
            camino._codificar_nombre("x" * 64 + ".example")


# ═════════════════════════════════════════════════════════════════════════════
#  Extremo a extremo contra PostgreSQL
# ═════════════════════════════════════════════════════════════════════════════

URL = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
conBase = pytest.mark.skipif(not URL, reason="falta TEST_DATABASE_URL")


@pytest.fixture()
def con():
    import psycopg
    with psycopg.connect(URL, autocommit=True) as c:
        camino.aplicar_esquema(c, str(SCHEMA))
        c.execute("TRUNCATE camino_trazas, camino_destinos, camino_asn_cache CASCADE")
        yield c


def _traza(direcciones, asn=None, motivo="destino"):
    saltos = []
    for i, d in enumerate(direcciones):
        s = camino.Salto(ttl=i + 1, direccion=d,
                         rtt_ms=1.5 if d else None,
                         icmp_tipo=11 if d else None,
                         icmp_codigo=0 if d else None)
        if d and camino.es_publica(d) and asn:
            s.asn = camino.DatosASN(asn=asn, org="EJEMPLO - Nadie", resultado="ok")
        saltos.append(s)
    return camino.Traza("d.example", "192.88.99.9", saltos, "udp-recverr",
                        20, 1, 42, motivo)


@conBase
class TestGuardar:
    def test_guarda_los_mudos_como_filas(self, con):
        camino.guardar(con, _traza(["10.0.0.1", None, PUBLICA]))
        filas = con.execute(
            "SELECT ttl, direccion, clase FROM camino_saltos ORDER BY ttl"
        ).fetchall()
        assert [f[0] for f in filas] == [1, 2, 3]
        assert filas[1][1] is None and filas[1][2] == "mudo"

    def test_la_primera_traza_no_dice_que_cambio_nada(self, con):
        """🔴 NULL y no `false`. «No cambió» y «no hay con qué comparar» son
        afirmaciones distintas, y confundirlas hace que el tablero diga «todo
        estable» justo el día que menos se sabe."""
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA]))
        assert r["cambio_saltos"] is None
        assert r["cambio_asn"] is None
        assert r["previa_id"] is None

    def test_dos_trazas_iguales_no_son_un_cambio(self, con):
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        assert r["cambio_saltos"] is False
        assert r["cambio_asn"] is False
        assert r["previa_id"] is not None

    def test_un_mudo_nuevo_cambia_el_camino_pero_no_el_operador(self, con):
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        r = camino.guardar(con, _traza(["10.0.0.1", None, PUBLICA], asn=64500))
        assert r["cambio_saltos"] is True
        assert r["cambio_asn"] is False      # 🔴 la que dispara la alarma

    def test_cambiar_de_mayorista_se_detecta(self, con):
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64501))
        assert r["cambio_asn"] is True

    def test_el_asn_queda_pegado_al_salto_con_su_fecha(self, con):
        """Desnormalizado a propósito: el histórico tiene que poder decir a
        quién pertenecía esa dirección EL DÍA que se trazó."""
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        fila = con.execute(
            "SELECT asn, asn_org FROM camino_saltos WHERE clase = 'publica'"
        ).fetchone()
        assert fila == (64500, "EJEMPLO - Nadie")

    def test_un_salto_interno_no_puede_tener_asn(self, con):
        """🔴 El `CHECK` de la base. Si un salto interno tuviera ASN, eso
        significaría que su dirección se mandó afuera."""
        import psycopg
        camino.guardar(con, _traza(["10.0.0.1"]))
        with pytest.raises(psycopg.errors.CheckViolation):
            con.execute(
                "INSERT INTO camino_saltos (traza_id, ttl, direccion, clase, asn)"
                " SELECT id, 90, '10.0.0.9', 'interna', 64500 FROM camino_trazas LIMIT 1"
            )

    def test_la_cache_rechaza_una_direccion_interna(self, con):
        """La última barrera, la que no depende de que `camino.py` esté bien."""
        import psycopg
        for red in camino.NO_PUBLICAS:
            d = muestras(red)[1]
            with pytest.raises(psycopg.errors.CheckViolation):
                con.execute(
                    "INSERT INTO camino_asn_cache (direccion, resultado, expira_at)"
                    " VALUES (%s, 'ok', now() + interval '1 day')", (d,))

    def test_la_cache_acepta_una_publica(self, con):
        con.execute("INSERT INTO camino_asn_cache (direccion, resultado, expira_at)"
                    " VALUES (%s, 'ok', now() + interval '1 day')", (PUBLICA,))
        assert con.execute("SELECT count(*) FROM camino_asn_cache").fetchone()[0] == 1

    def test_la_cache_evita_la_segunda_consulta(self, con):
        respuestas = {
            camino.nombre_origen(PUBLICA): ["64500 | 192.88.99.0/24 | AU | apnic | 2011"],
            f"AS64500.{camino.SUFIJO_ASN}": ["64500 | AU | apnic | 2011 | EJEMPLO - Nadie"],
        }
        e1 = EspiaDNS(respuestas)
        camino.ResolutorASN(con, consultor=e1).resolver(PUBLICA)
        assert len(e1.nombres) == 2

        # Un resolutor NUEVO, sin caché en memoria: tiene que leer la de la base.
        e2 = EspiaDNS(respuestas)
        d = camino.ResolutorASN(con, consultor=e2).resolver(PUBLICA)
        assert e2.nombres == []
        assert d.asn == 64500 and d.org == "EJEMPLO - Nadie"

    def test_borrar_una_traza_se_lleva_sus_saltos(self, con):
        r = camino.guardar(con, _traza(["10.0.0.1", None, PUBLICA]))
        con.execute("DELETE FROM camino_trazas WHERE id = %s", (r["id"],))
        assert con.execute("SELECT count(*) FROM camino_saltos").fetchone()[0] == 0

    def test_alcanzado_y_motivo_no_se_pueden_contradecir(self, con):
        import psycopg
        with pytest.raises(psycopg.errors.CheckViolation):
            con.execute(
                "INSERT INTO camino_trazas (destino, ttl_max, saltos, saltos_mudos,"
                " saltos_publicos, alcanzado, motivo_fin, huella_saltos, huella_asn)"
                " VALUES ('x', 20, 1, 0, 0, true, 'ttl_max', 'a', 'b')")

    def test_el_intervalo_minimo_frena_la_segunda_corrida(self, con):
        """Lo decide la BASE y no un cron: si alguien corre `correr` tres veces
        seguidas por nerviosismo, las dos últimas no mandan un solo paquete."""
        camino.registrar_destino(con, "d.example")
        assert camino.destinos_a_trazar(con) == ["d.example"]
        camino.guardar(con, _traza(["10.0.0.1"]))
        assert camino.destinos_a_trazar(con) == []
        # Con intervalo 0 sí toca de vuelta.
        assert camino.destinos_a_trazar(con, intervalo_s=0) == ["d.example"]

    def test_un_destino_inactivo_no_se_traza(self, con):
        camino.registrar_destino(con, "d.example")
        con.execute("UPDATE camino_destinos SET activo = false")
        assert camino.destinos_a_trazar(con, intervalo_s=0) == []

    def test_la_ruta_legible_de_la_vista_coincide_con_la_del_python(self, con):
        """La vista `camino_trazas_texto` reimplementa `ruta_asn` en SQL para
        que el panel no tenga que recalcularla. Si las dos se separan, el panel
        muestra una ruta y la huella se calculó sobre otra."""
        t = _traza(["10.0.0.1", None, PUBLICA, PUBLICA_2], asn=64500)
        r = camino.guardar(con, t)
        fila = con.execute("SELECT ruta_asn FROM camino_trazas_texto WHERE id = %s",
                           (r["id"],)).fetchone()
        assert fila[0] == t.ruta_asn.replace(">", " › ")

    def test_v_camino_ultimo_devuelve_la_mas_nueva(self, con):
        camino.guardar(con, _traza(["10.0.0.1"]))
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA]))
        fila = con.execute("SELECT id FROM v_camino_ultimo WHERE destino = 'd.example'"
                           ).fetchone()
        assert fila[0] == r["id"]


@conBase
class TestNoAlarmarDeGusto:
    """🔴 Una traza fallida NO puede parecer un cambio de mayorista.

    Encontrado en la primera corrida real: un destino que no resuelve produce
    cero saltos, y su huella —la del vacío— no coincide con la de la traza
    buena anterior, así que salía marcado «🔴 CAMBIÓ DE OPERADOR».

    Una alarma que se dispara sola es peor que no tener alarma: en dos semanas
    nadie la mira, y el día que el tránsito cambie de verdad el aviso va a
    estar ahí, en el medio del ruido, sin que nadie lo lea.
    """

    def _fallida(self):
        return camino.Traza("d.example", None, [], "udp-recverr", 20, 1, 5,
                            "error", error="no resuelve")

    def test_una_traza_fallida_no_se_compara_con_nada(self, con):
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        r = camino.guardar(con, self._fallida())
        assert r["cambio_asn"] is None
        assert r["cambio_saltos"] is None
        assert r["previa_id"] is None

    def test_despues_de_una_fallida_se_compara_con_la_ultima_BUENA(self, con):
        buena = camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        camino.guardar(con, self._fallida())
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        # Saltea la fallida del medio y compara contra la buena: sin cambios.
        assert r["previa_id"] == buena["id"]
        assert r["cambio_asn"] is False

    def test_una_traza_donde_nadie_contesto_tampoco_se_compara(self, con):
        """Todos los saltos mudos: se midió, pero no se supo nada. Distinto de
        «el camino es igual» y distinto de «el camino cambió»."""
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        r = camino.guardar(con, _traza([None, None, None], motivo="mudos"))
        assert r["cambio_asn"] is None

    def test_un_cambio_de_verdad_despues_de_una_fallida_si_se_ve(self, con):
        """El arreglo no puede tapar la alarma que sí importa."""
        camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64500))
        camino.guardar(con, self._fallida())
        r = camino.guardar(con, _traza(["10.0.0.1", PUBLICA], asn=64501))
        assert r["cambio_asn"] is True
