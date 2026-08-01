"""Pruebas del respaldo de configuración.

🔴 Este es el único módulo del proyecto que se conecta a la red de producción,
   así que lo que más se prueba acá no es que funcione: es que **se niegue**.

   Ningún test de este archivo abre un socket. Los que verifican la negativa
   no pueden abrirlo por definición —esa es la afirmación— y los del protocolo
   trabajan sobre bytes.
"""
from __future__ import annotations

import pytest

import respaldo


# ─────────────────────────────────────────────────────────────────────────────
# 🔴 Lo primero: cuándo se NIEGA a conectarse
# ─────────────────────────────────────────────────────────────────────────────

CRED = respaldo.Credencial(usuario="respaldo", clave="no-importa")

def _alcance(via, cifrado, *puertos):
    return respaldo.Alcance("192.0.2.10", tuple(puertos), via, cifrado)


def test_sin_credencial_no_hay_respaldo(monkeypatch):
    """El estado por omisión es APAGADO.

    Encender algo que entra a 155 routers tiene que ser un acto deliberado de
    alguien, no lo que pasa si nadie hace nada."""
    monkeypatch.delenv("RESPALDO_USUARIO", raising=False)
    monkeypatch.delenv("RESPALDO_CLAVE", raising=False)
    assert respaldo.cargar_credencial() is None


def test_credencial_incompleta_tampoco_alcanza(monkeypatch):
    monkeypatch.setenv("RESPALDO_USUARIO", "respaldo")
    monkeypatch.delenv("RESPALDO_CLAVE", raising=False)
    assert respaldo.cargar_credencial() is None
    monkeypatch.setenv("RESPALDO_CLAVE", "")
    assert respaldo.cargar_credencial() is None


def test_el_api_en_claro_esta_prohibido_por_defecto(monkeypatch):
    """🔴 El corazón de este módulo.

    Por el 8728 la contraseña del router cruza la red de gestión SIN CIFRAR.
    En esta instalación son 7 de 25 equipos. Que ande igual «porque total es
    la red interna» es exactamente cómo se regalan las credenciales de todos
    los routers de un ISP."""
    monkeypatch.setenv("RESPALDO_USUARIO", "u")
    monkeypatch.setenv("RESPALDO_CLAVE", "c")
    monkeypatch.delenv("RESPALDO_PERMITIR_CLARO", raising=False)
    cred = respaldo.cargar_credencial()
    assert cred is not None
    assert cred.permitir_api_en_claro is False

    with pytest.raises(respaldo.ErrorRouterOS) as e:
        respaldo.exportar("192.0.2.10", cred, _alcance("api", False, 8728))
    # El mensaje tiene que decir CÓMO arreglarlo, no sólo que no se puede.
    assert "api-ssl" in str(e.value)


def test_el_api_en_claro_exige_permiso_explicito():
    cred = respaldo.Credencial("u", "c", permitir_api_en_claro=True)
    # Ya no se niega por la política; falla al conectar, que es otra cosa.
    with pytest.raises(Exception) as e:
        respaldo.exportar("192.0.2.10", cred, _alcance("api", False, 8728), timeout=0.05)
    assert "no está permitida" not in str(e.value)


def test_sin_ningun_puerto_abierto_no_se_intenta():
    with pytest.raises(respaldo.ErrorRouterOS) as e:
        respaldo.exportar("192.0.2.10", CRED, _alcance(None, False))
    assert "ningún puerto" in str(e.value)


def test_ssh_todavia_no_esta(monkeypatch):
    """Se declara que falta en vez de fallar con un error raro más adelante."""
    with pytest.raises(respaldo.ErrorRouterOS) as e:
        respaldo.exportar("192.0.2.10", CRED, _alcance("ssh", True, 22))
    assert "SSH" in str(e.value)


def test_el_orden_de_puertos_prefiere_lo_cifrado():
    """🔴 El orden de `PUERTOS` ES la política de seguridad.

    Si alguien lo reordena y pone el 8728 primero, el módulo empezaría a
    mandar contraseñas en claro a equipos que aceptan TLS — sin que falle
    nada visible."""
    nombres = [n for _, n, _ in respaldo.PUERTOS]
    assert nombres.index("api-ssl") < nombres.index("api")
    # Y el único no cifrado tiene que ser el 8728.
    inseguros = [p for p, _, cif in respaldo.PUERTOS if not cif]
    assert inseguros == [8728]


# ─────────────────────────────────────────────────────────────────────────────
# Tachar secretos
# ─────────────────────────────────────────────────────────────────────────────

EXPORT = """# jul/31/2026 21:04:11 by RouterOS 6.49.7
/interface wireless security-profiles
set [ find default=yes ] supplicant-identity="MikroTik"
add authentication-types=wpa2-psk mode=dynamic-keys name=perfil1 \\
    wpa2-pre-shared-key="unaClaveDeWifiMuyLarga"
/ppp secret
add name=cliente0142 password="clave-del-cliente" service=pppoe
/snmp community
set [ find default=yes ] name=public
add name=monitoreo authentication-password="secretoSNMP" security=private
/ip service
set api-ssl disabled=no
"""


def test_las_claves_no_sobreviven_al_respaldo():
    limpio, n = respaldo.tachar_secretos(EXPORT)
    assert n >= 3
    for secreto in ("unaClaveDeWifiMuyLarga", "clave-del-cliente", "secretoSNMP"):
        assert secreto not in limpio, f"{secreto} quedó en el respaldo"


def test_la_clave_se_tacha_pero_el_campo_queda():
    """El diff tiene que poder decir «acá cambió la contraseña».

    Borrar la línea entera perdería esa señal: se vería como si el campo no
    existiera, que es otra cosa."""
    limpio, _ = respaldo.tachar_secretos(EXPORT)
    assert "password=«tachado»" in limpio
    assert "wpa2-pre-shared-key=«tachado»" in limpio


def test_lo_que_no_es_secreto_no_se_toca():
    limpio, _ = respaldo.tachar_secretos(EXPORT)
    for conservar in ("/ppp secret", "name=cliente0142", "service=pppoe",
                      "RouterOS 6.49.7", "set api-ssl disabled=no"):
        assert conservar in limpio


def test_un_export_sin_secretos_da_cero():
    limpio, n = respaldo.tachar_secretos("/system identity\nset name=RT_Core_01\n")
    assert n == 0
    assert "RT_Core_01" in limpio


# ─────────────────────────────────────────────────────────────────────────────
# El protocolo, sobre bytes
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "n, esperado",
    [
        (0, b"\x00"),
        (5, b"\x05"),
        (0x7F, b"\x7f"),
        (0x80, b"\x80\x80"),        # ya no entra en un byte
        (0x3FFF, b"\xbf\xff"),
        (0x4000, b"\xc0\x40\x00"),
        (0x1FFFFF, b"\xdf\xff\xff"),
    ],
)
def test_largo_de_palabra(n, esperado):
    """El largo variable de la API de RouterOS.

    Los bits altos del primer byte dicen cuántos siguen. Un error acá no da un
    error: da una configuración leída torcida, que se guarda como si fuera
    buena."""
    assert respaldo._largo(n) == esperado


def test_el_largo_no_se_desborda_en_exports_grandes():
    # Un export de un CCR con 400 líneas ronda los 40 kB. Tiene que caer en la
    # rama de 3 bytes, no en la de 1 ni truncarse.
    assert len(respaldo._largo(40_000)) == 3


# ─────────────────────────────────────────────────────────────────────────────
# Huella
# ─────────────────────────────────────────────────────────────────────────────

def test_la_huella_no_cambia_si_la_config_no_cambio():
    a = "/system identity\nset name=RT_Core_01\n"
    assert respaldo.huella(a) == respaldo.huella(a)
    assert respaldo.huella(a) != respaldo.huella(a + "\n/ip service\nset api disabled=yes\n")


# ─────────────────────────────────────────────────────────────────────────────
# Relevamiento
# ─────────────────────────────────────────────────────────────────────────────

def test_relevar_no_inventa_cuando_no_hay_nada():
    """Contra una dirección del rango de documentación, que no existe.

    Devuelve «no se puede» en vez de explotar: un equipo inalcanzable es lo
    NORMAL en una red de radioenlaces, no una excepción."""
    a = respaldo.relevar("192.0.2.1", timeout=0.05)
    assert a.se_puede is False
    assert a.via is None
    assert a.abiertos == ()
