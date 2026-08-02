"""
Pruebas del cliente SNMP escrito a mano.

🔴 Estas pruebas NO tocan la red. Se codifica un pedido, se arma a mano la
   respuesta que un equipo devolvería, y se comprueba que el módulo la lea
   igual. Es lo único que se puede probar de forma determinista: contra un
   equipo real, un test así falla el día que alguien reinicia un router.

   Los casos elegidos son los que rompen un codificador BER de verdad: el bit
   de signo, los OID con ramas grandes, los contadores sin signo y las tres
   variantes de «no existe» de SNMPv2.
"""

import pytest

import snmp


# ── BER ──────────────────────────────────────────────────────────────────────

def test_largo_corto_y_largo():
    assert snmp._largo(5) == b"\x05"
    assert snmp._largo(127) == b"\x7f"
    # A partir de 128 cambia el formato: 0x81 dice «un byte de longitud sigue».
    assert snmp._largo(128) == b"\x81\x80"
    assert snmp._largo(300) == b"\x82\x01\x2c"


class TestEntero:
    """🔴 El bit de signo es donde se rompe todo codificador BER casero."""

    def test_el_cero_ocupa_un_byte(self):
        assert snmp._entero(0) == b"\x02\x01\x00"

    def test_positivo_chico(self):
        assert snmp._entero(1) == b"\x02\x01\x01"
        assert snmp._entero(127) == b"\x02\x01\x7f"

    def test_128_necesita_un_cero_adelante_o_se_lee_como_menos_128(self):
        # Sin el 0x00, el byte 0x80 tiene el bit alto en 1 y el otro lado lo
        # interpreta como -128. Es EL error clásico.
        assert snmp._entero(128) == b"\x02\x02\x00\x80"
        assert int.from_bytes(b"\x00\x80", "big", signed=True) == 128

    def test_ida_y_vuelta_en_los_bordes(self):
        for n in (0, 1, 127, 128, 255, 256, 32767, 32768, 65535, 2**31 - 1):
            crudo = snmp._entero(n)
            assert crudo[0] == snmp.TAG_INTEGER
            largo = crudo[1]
            assert int.from_bytes(crudo[2:2 + largo], "big", signed=True) == n


class TestOID:
    def test_las_dos_primeras_ramas_van_juntas(self):
        # 1.3 → 40*1 + 3 = 43 = 0x2b
        assert snmp.codificar_oid("1.3") == b"\x06\x01\x2b"

    def test_sysuptime(self):
        assert snmp.codificar_oid("1.3.6.1.2.1.1.3.0") == bytes(
            [0x06, 0x08, 0x2B, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00]
        )

    def test_una_rama_mayor_a_127_va_en_base_128(self):
        # 128 → 0x81 0x00. Un OID de MikroTik (1.3.6.1.4.1.14988...) los tiene.
        crudo = snmp.codificar_oid("1.3.128")
        assert crudo == b"\x06\x03\x2b\x81\x00"

    def test_ida_y_vuelta(self):
        for oid in ("1.3.6.1.2.1.1.5.0", "1.3.6.1.4.1.14988.1.1.3.10.0",
                    "1.3.6.1.2.1.31.1.1.1.15.2147483647"):
            crudo = snmp.codificar_oid(oid)
            assert snmp._decodificar_oid(crudo[2:]) == oid

    def test_un_oid_de_una_sola_rama_se_rechaza(self):
        with pytest.raises(snmp.ErrorSNMP):
            snmp.codificar_oid("1")


class TestValores:
    def test_un_contador32_grande_no_sale_negativo(self):
        # 🔴 3.000.000.000 leído con signo da negativo. Un Counter32 es SIN
        #    signo aunque comparta la codificación con INTEGER, y ese número
        #    después se dibuja en un gráfico de tráfico.
        crudo = (3_000_000_000).to_bytes(4, "big")
        assert snmp._decodificar_valor(snmp.TAG_COUNTER32, crudo) == 3_000_000_000
        assert snmp._decodificar_valor(snmp.TAG_INTEGER, crudo) < 0

    def test_las_tres_formas_de_no_existir_dan_None(self):
        for tag in (0x80, 0x81, 0x82):
            assert snmp._decodificar_valor(tag, b"") is None

    def test_una_cadena_binaria_sale_en_hexadecimal_y_no_en_basura(self):
        v = snmp._decodificar_valor(snmp.TAG_OCTETS, b"\x00\xff\x10")
        assert v == "00:ff:10"

    def test_una_ip_se_lee_como_ip(self):
        assert snmp._decodificar_valor(snmp.TAG_IP, bytes([10, 0, 0, 1])) == "10.0.0.1"


# ── Respuestas completas ─────────────────────────────────────────────────────

def _respuesta(rid: int, binds: list[tuple[str, int, bytes]], error: int = 0) -> bytes:
    """Arma la respuesta que devolvería un equipo. `binds` = (oid, tag, valor)."""
    vb = b"".join(
        snmp._tlv(snmp.TAG_SEQ, snmp.codificar_oid(o) + snmp._tlv(t, v))
        for o, t, v in binds
    )
    cuerpo = (snmp._entero(rid) + snmp._entero(error) + snmp._entero(0)
              + snmp._tlv(snmp.TAG_SEQ, vb))
    return snmp._tlv(
        snmp.TAG_SEQ,
        snmp._entero(1) + snmp._tlv(snmp.TAG_OCTETS, b"public")
        + snmp._tlv(snmp.PDU_RESPONSE, cuerpo),
    )


def test_se_lee_una_respuesta_de_sistema():
    datos = _respuesta(7, [
        ("1.3.6.1.2.1.1.1.0", snmp.TAG_OCTETS, b"RouterOS RB750"),
        ("1.3.6.1.2.1.1.3.0", snmp.TAG_TIMETICKS, (123456789).to_bytes(4, "big")),
    ])
    pares = dict(snmp._parsear_respuesta(datos, 7))
    assert pares["1.3.6.1.2.1.1.1.0"] == "RouterOS RB750"
    assert pares["1.3.6.1.2.1.1.3.0"] == 123456789


def test_una_respuesta_de_OTRO_pedido_se_rechaza():
    """🔴 Sin comprobar el request-id, un WALK se corre entero.

    Son cientos de pedidos por el mismo socket; una respuesta demorada del
    anterior se tomaría como la de ahora y la tabla saldría desplazada de a una
    fila — perfectamente plausible y completamente falsa.
    """
    datos = _respuesta(99, [("1.3.6.1.2.1.1.5.0", snmp.TAG_OCTETS, b"x")])
    with pytest.raises(snmp.ErrorSNMP, match="request-id"):
        snmp._parsear_respuesta(datos, 7)


def test_un_error_del_equipo_no_se_devuelve_como_dato():
    datos = _respuesta(3, [], error=2)  # noSuchName
    with pytest.raises(snmp.ErrorSNMP, match="error 2"):
        snmp._parsear_respuesta(datos, 3)


def test_no_existe_SET_en_el_modulo():
    """🔴 La garantía de que el panel no escribe en un equipo es que el código
    para hacerlo no está. Si alguien lo agrega, este test lo dice."""
    assert not hasattr(snmp, "set")
    fuente = open(snmp.__file__, encoding="utf-8").read()
    assert "0xA3" not in fuente and "PDU_SET" not in fuente
