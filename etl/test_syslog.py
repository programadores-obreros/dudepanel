"""Pruebas del importador de syslog.

A diferencia de `test_sync.py`, acá **sí hay fixtures inventados**, y el motivo
es que los 44 archivos de verdad viven en el servidor del ISP y no entran en el
repositorio: son 141.678 líneas con los nombres de todos los equipos de la red.

Lo que NO es inventado son las FORMAS y los NÚMEROS: cada línea de fixture está
copiada de la estructura medida sobre los archivos reales, y los conteos que se
citan en los comentarios (69.525 down, 69.511 up, 2.642 otras, 452 nombres, 338
que resuelven) salieron de medirlos.

🔴 Ninguna dirección ni MAC de la red real acá adentro. Se usa el rango de
   documentación de la RFC 5737 (192.0.2.0/24, 198.51.100.0/24) y el bloque de
   MAC de documentación de la RFC 7042 (00:00:5E:00:53:xx).

    pytest -q etl/test_syslog.py

La parte de extremo a extremo necesita un PostgreSQL 15 o más nuevo
(`UNIQUE NULLS NOT DISTINCT`):

    docker run --rm -d -e POSTGRES_PASSWORD=x -p 55490:5432 postgres:16-alpine
    TEST_DATABASE_URL=postgresql://postgres:x@localhost:55490/postgres pytest -q
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

import pytest

import syslog as sl

ESQUEMA = str(Path(__file__).with_name("schema.sql"))


def ev(momento: str, equipo: str, estado: str, motivo: str | None = None,
       sonda: str = "ping", orden: int = 0) -> sl.Evento:
    """Atajo para armar eventos en las pruebas de reconstrucción."""
    return sl.Evento(
        momento=datetime.strptime(momento, "%Y-%m-%d %H:%M:%S"),
        equipo=equipo, sonda=sonda, estado=estado, motivo=motivo,
        host=None, archivo="fixture", linea=orden, orden=orden,
    )


# ═════════════════════════════════════════════════════════════════════════════
# El formato
# ═════════════════════════════════════════════════════════════════════════════

def test_la_linea_canonica():
    e = sl.parsear_linea(
        "2025.11.23-14:53:39 <192.0.2.10>: Service ping on Sitio_E_Norte2AF"
        " is now down (timeout)"
    )
    assert isinstance(e, sl.Evento)
    assert e.momento == datetime(2025, 11, 23, 14, 53, 39)
    assert (e.sonda, e.equipo, e.estado, e.motivo) == (
        "ping", "Sitio_E_Norte2AF", "down", "timeout")
    assert e.host == "192.0.2.10"


def test_el_up_tambien():
    e = sl.parsear_linea(
        "2025.11.23-14:56:09 <192.0.2.10>: Service ping on Sitio_E_Norte2AF"
        " is now up (ok)"
    )
    assert (e.estado, e.motivo) == ("up", "ok")


def test_los_dos_motivos_de_caida_del_historico():
    """Medido sobre los 44 archivos: (timeout) 69.446 y (local problem) 79.

    No es un detalle de nomenclatura. `local problem` significa que el problema
    lo tuvo el SERVIDOR de monitoreo —se quedó sin ruta, se le cayó la placa— y
    no dice absolutamente nada del equipo. Contarlo como indisponibilidad del
    equipo es atribuirle una falla ajena."""
    a = sl.parsear_linea("2020.01.02-03:04:05 <192.0.2.10>: Service ping on X"
                         " is now down (timeout)")
    b = sl.parsear_linea("2020.01.02-03:04:05 <192.0.2.10>: Service ping on X"
                         " is now down (local problem)")
    assert a.motivo == "timeout"
    assert b.motivo == "local problem"


def test_sin_motivo_entre_parentesis():
    e = sl.parsear_linea("2020.01.02-03:04:05 <192.0.2.10>: Service ping on X is now up")
    assert e.estado == "up" and e.motivo is None


@pytest.mark.parametrize("nombre", [
    "Panel Ombu_Bruck en 5.8",
    "Sitio_E_Ponte 24GHZ ex 10 Ghz",
    "OLT 9 - SWIFT1 ex 192.0.2.221",
    "MK-SW2-NorteBT2",
    "AirFiber Nicole_E_Ponte",
])
def test_nombres_de_equipo_con_espacios_y_guiones(nombre):
    """Los nombres reales traen espacios, guiones, «ex» y hasta direcciones
    adentro. El regex no puede asumir un identificador limpio."""
    e = sl.parsear_linea(
        f"2024.03.04-05:06:07 <192.0.2.10>: Service ping on {nombre} is now down (timeout)"
    )
    assert e.equipo == nombre


def test_un_on_dentro_del_nombre_no_parte_el_equipo():
    """La sonda corta en el PRIMER « on », así que el resto del nombre queda
    entero aunque tenga la palabra adentro."""
    e = sl.parsear_linea(
        "2024.03.04-05:06:07 <192.0.2.10>: Service ping on Router on Stick"
        " is now down (timeout)"
    )
    assert (e.sonda, e.equipo) == ("ping", "Router on Stick")


def test_estados_que_no_son_up_ni_down_no_revientan():
    """En el histórico sólo hay up y down, pero The Dude sabe decir más. Se
    guarda el estado tal cual y no participa del emparejamiento."""
    e = sl.parsear_linea("2024.03.04-05:06:07 <192.0.2.10>: Service ping on X"
                         " is now partially down")
    assert e.estado == "partially down"


def test_la_hora_queda_sin_zona():
    """🔴 El formato no trae zona horaria. El parser NO inventa una: devuelve un
    datetime naive y la interpretación la hace PostgreSQL con la zona que se le
    diga, que queda escrita en `syslog_files.tz`."""
    e = sl.parsear_linea("2024.03.04-05:06:07 <192.0.2.10>: Service ping on X is now up")
    assert e.momento.tzinfo is None


# ── Lo que NO es un evento de servicio ───────────────────────────────────────

MIKROTIK = [
    "2025.06.01-10:00:00 <192.0.2.10>: pptp,ppp,info ponte: usuario-fs: initializing...",
    "2025.06.01-10:00:01 <192.0.2.10>: pptp,ppp,info ponte: usuario-fs: terminating..."
    " - failed to authenticate ourselves to peer",
    "2025.06.01-10:00:02 <192.0.2.10>: ipsec,info ponte: respond new phase 1"
    " (Identity Protection): 192.0.2.1[500]<=>198.51.100.7[500]",
    "2025.06.01-10:00:03 <192.0.2.10>: pptp,info ponte: TCP connection established"
    " from 198.51.100.7",
]


@pytest.mark.parametrize("linea", MIKROTIK)
def test_el_syslog_del_mikrotik_se_clasifica_aparte(linea):
    """2.642 de las 141.678 líneas son de otra fuente: alguien apuntó un
    MikroTik al mismo destino. **No se descartan.** Que 438 digan «failed to
    authenticate» es información operativa que hoy no mira nadie."""
    o = sl.parsear_linea(linea)
    assert isinstance(o, sl.Otra)
    assert o.clase == "mikrotik"
    assert "," in o.topicos            # MikroTik siempre trae tópico + severidad
    assert o.mensaje


def test_los_topicos_son_la_clasificacion_que_ya_viene_en_la_linea():
    o = sl.parsear_linea(MIKROTIK[2])
    assert o.topicos == "ipsec,info"


def test_la_frase_que_importa_sobrevive_a_la_redaccion():
    o = sl.parsear_linea(MIKROTIK[1])
    assert "failed to authenticate" in o.mensaje


def test_una_frase_en_minuscula_no_pasa_por_topicos_de_mikrotik():
    """Se exige al menos una coma justamente para no clasificar por parecido."""
    o = sl.parsear_linea("2025.06.01-10:00:00 <192.0.2.10>: algo raro pasó acá")
    assert o.clase == "desconocida" and o.topicos is None


def test_sin_sobre_no_hay_nada():
    for basura in ("", "   ", "esto no es una línea de syslog",
                   "2025-06-01 10:00:00 mensaje sin el formato de The Dude"):
        assert sl.parsear_linea(basura) is None


def test_fecha_con_forma_valida_pero_imposible():
    """31 de febrero. Se cuenta como no entendida en vez de tumbar la corrida."""
    assert sl.parsear_linea(
        "2025.02.31-10:00:00 <192.0.2.10>: Service ping on X is now up") is None


# ── Redacción ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("crudo,pedazo", [
    ("login failed password=hunter2", "hunter2"),
    ("snmp community: publico-secreto", "publico-secreto"),
    ("auth token = abc123def", "abc123def"),
    ("api_key=zzz", "zzz"),
])
def test_el_texto_libre_ajeno_se_redacta(crudo, pedazo):
    """`syslog_other.message` y `syslog_files.ignored_samples` son las dos únicas
    columnas del esquema con texto libre de una fuente externa. La regla del
    proyecto es que ninguna tabla guarde credenciales, y un equipo que loguee su
    community no puede meterla acá."""
    assert pedazo not in sl.redactar(crudo)
    assert "***" in sl.redactar(crudo)


def test_la_redaccion_no_come_texto_util():
    assert sl.redactar("failed to authenticate ourselves to peer") == \
        "failed to authenticate ourselves to peer"


# ═════════════════════════════════════════════════════════════════════════════
# Un archivo entero
# ═════════════════════════════════════════════════════════════════════════════

def escribir(tmp_path: Path, nombre: str, lineas: list[str]) -> Path:
    p = tmp_path / nombre
    p.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    return p


def test_un_archivo_mezclado_se_cuenta_por_clase(tmp_path):
    p = escribir(tmp_path, "syslog1.txt", [
        "2025.06.01-10:00:00 <192.0.2.10>: Service ping on A is now down (timeout)",
        "2025.06.01-10:05:00 <192.0.2.10>: Service ping on A is now up (ok)",
        *MIKROTIK,
        "",
        "una línea que no entendemos para nada",
        "otra línea que no entendemos para nada",
    ])
    a = sl.parsear_archivo(p)
    assert a.lineas == 9
    assert len(a.eventos) == 2
    assert len(a.otras) == 4
    assert a.vacias == 1
    assert a.ignoradas == 2
    assert a.sha256 and a.bytes == p.stat().st_size


def test_las_muestras_de_lo_ignorado_son_una_por_forma(tmp_path):
    """Con 30.000 líneas rotas iguales, las primeras veinte no enseñan nada. Se
    aplastan los números antes de comparar, así `error 1` y `error 2` son la
    misma forma y ocupan una sola muestra."""
    p = escribir(tmp_path, "s.txt", [f"error numero {n}" for n in range(50)]
                 + ["otra cosa distinta"])
    a = sl.parsear_archivo(p)
    assert a.ignoradas == 51
    assert len(a.muestras) == 2


def test_las_muestras_estan_topeadas(tmp_path):
    p = escribir(tmp_path, "s.txt", [f"forma distinta {chr(65 + n)}" for n in range(40)])
    a = sl.parsear_archivo(p)
    assert a.ignoradas == 40
    assert len(a.muestras) == sl.MUESTRAS_MAX


def test_dos_lineas_identicas_reciben_ordinales_distintos(tmp_path):
    """Hay 80 nombres de equipo repetidos en el inventario. Dos equipos con el
    mismo nombre cayendo en el mismo segundo escriben DOS líneas idénticas, y
    sin el ordinal la clave única se quedaría con una sola."""
    linea = "2025.06.01-10:00:00 <192.0.2.10>: Service ping on A is now down (timeout)"
    a = sl.parsear_archivo(escribir(tmp_path, "s.txt", [linea, linea]))
    assert [e.ordinal for e in a.eventos] == [0, 1]
    assert a.duplicadas == 1


def test_un_byte_invalido_no_se_lleva_puesto_el_archivo(tmp_path):
    p = tmp_path / "s.txt"
    p.write_bytes(
        b"2025.06.01-10:00:00 <192.0.2.10>: Service ping on Sitio\xff_E is now up (ok)\n"
        b"2025.06.01-10:01:00 <192.0.2.10>: Service ping on B is now down (timeout)\n"
    )
    a = sl.parsear_archivo(p)
    assert len(a.eventos) == 2
    assert a.eventos[1].equipo == "B"


# ═════════════════════════════════════════════════════════════════════════════
# Reconstrucción — los casos feos
# ═════════════════════════════════════════════════════════════════════════════

def test_down_mas_up_es_una_caida_con_duracion():
    c, = sl.reconstruir([
        ev("2025-11-23 14:53:39", "A", "down", "timeout", orden=1),
        ev("2025-11-23 14:56:09", "A", "up", "ok", orden=2),
    ])
    assert c.cierre == "closed"
    assert c.duracion_s == 150
    assert (c.motivo_down, c.motivo_up) == ("timeout", "ok")
    assert c.downs == 1


def test_down_sin_up_queda_abierta_y_sin_duracion():
    """No sabemos si sigue caído o si el `up` se perdió. Lo único deshonesto
    sería inventar un final. `duration_s` en NULL no se suma a ningún promedio;
    un 0 sí, y en silencio."""
    c, = sl.reconstruir([ev("2025-11-23 14:53:39", "A", "down", "timeout")])
    assert c.cierre == "open"
    assert c.fin is None and c.duracion_s is None
    assert c.inicio == datetime(2025, 11, 23, 14, 53, 39)


def test_up_sin_down_se_guarda_sin_inicio():
    """Recuperó sin que hubiéramos visto la caída: o el `down` está antes del
    principio del corpus, o cayó en uno de los dos años que faltan. Se guarda
    igual — descartarlo sería el «desaparece en silencio» que no queremos."""
    c, = sl.reconstruir([ev("2025-11-23 14:56:09", "A", "up", "ok")])
    assert c.cierre == "no_start"
    assert c.inicio is None and c.duracion_s is None
    assert c.fin == datetime(2025, 11, 23, 14, 56, 9)


def test_dos_down_seguidos_son_una_sola_caida_desde_el_primero():
    """The Dude notifica transiciones: dos `down` seguidos significan que se
    perdió el `up` del medio. Se elige la lectura pesimista —una caída larga—
    porque la optimista obliga a inventar la hora del `up` que falta. Para no
    perder la otra lectura queda `last_down_at`."""
    c, = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "down", "timeout", orden=1),
        ev("2025-11-23 11:00:00", "A", "down", "timeout", orden=2),
        ev("2025-11-23 12:00:00", "A", "up", "ok", orden=3),
    ])
    assert c.cierre == "closed"
    assert c.inicio == datetime(2025, 11, 23, 10, 0, 0)
    assert c.duracion_s == 7200
    assert c.downs == 2
    # La versión optimista está a mano: [11:00, 12:00] = 3600 s.
    assert c.ultimo_down == datetime(2025, 11, 23, 11, 0, 0)


def test_dos_up_seguidos_dan_dos_registros_sin_inicio():
    caidas = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "up", "ok", orden=1),
        ev("2025-11-23 11:00:00", "A", "up", "ok", orden=2),
    ])
    assert [c.cierre for c in caidas] == ["no_start", "no_start"]


def test_cada_servicio_va_por_su_cuenta():
    """Dos equipos distintos, y el mismo equipo con dos sondas distintas, no se
    mezclan aunque los eventos vengan intercalados."""
    caidas = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "down", orden=1),
        ev("2025-11-23 10:00:01", "B", "down", orden=2),
        ev("2025-11-23 10:00:02", "A", "up", orden=3),
        ev("2025-11-23 10:00:30", "B", "up", orden=4),
        ev("2025-11-23 10:00:00", "A", "down", sonda="ssh", orden=5),
        ev("2025-11-23 10:10:00", "A", "up", sonda="ssh", orden=6),
    ])
    por = {(c.equipo, c.sonda): c.duracion_s for c in caidas}
    assert por == {("A", "ping"): 2, ("B", "ping"): 29, ("A", "ssh"): 600}


def test_una_caida_puede_cruzar_de_un_archivo_a_otro():
    """Ésta es la razón de reconstruir desde la TABLA de eventos y no desde el
    flujo de cada archivo: el `down` está en el archivo que se rota y el `up` en
    el siguiente. Reconstruyendo por archivo darían un 'open' y un 'no_start' en
    vez de la caída que realmente pasó."""
    a = ev("2025-11-23 23:59:00", "A", "down", "timeout", orden=1)
    a.archivo = "syslog1.txt"
    b = ev("2025-11-24 00:01:00", "A", "up", "ok", orden=2)
    b.archivo = "syslog2.txt"
    c, = sl.reconstruir([a, b])
    assert c.cierre == "closed" and c.duracion_s == 120


def test_dos_eventos_en_el_mismo_segundo_se_ordenan_por_linea():
    """El syslog se escribe agregando al final: el orden de las líneas ES el
    orden de los hechos. Con resolución de un segundo, es la señal más fuerte
    que hay."""
    c, = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "up", orden=2),      # llegó SEGUNDO
        ev("2025-11-23 10:00:00", "A", "down", orden=1),    # llegó PRIMERO
    ])
    assert c.cierre == "closed" and c.duracion_s == 0


def test_el_reloj_para_atras_no_inventa_ninguna_duracion():
    """Seis años de un Windows 7 sin NTP confiable: el reloj salta para atrás.

    🔴 Lo primero que uno escribe acá es una guarda contra la duración
       negativa, y es código muerto: como los eventos se ordenan por hora, la
       resta nunca puede dar negativo. Lo que un salto de reloj produce de
       verdad es que el `up` aparezca ANTES que el `down`, y eso sale como un
       'no_start' suelto más una caída 'open'. Feo, pero visible — y las dos
       filas quedan sin duración, así que no contaminan ningún promedio."""
    caidas = sl.reconstruir([
        ev("2025-11-23 12:00:00", "A", "down", orden=1),
        ev("2025-11-23 11:00:00", "A", "up", orden=2),
    ])
    assert sorted(c.cierre for c in caidas) == ["no_start", "open"]
    assert all(c.duracion_s is None for c in caidas)


def test_ninguna_duracion_reconstruida_es_negativa():
    """El invariante, escrito una vez para que no haga falta confiar en él."""
    eventos = [
        ev("2025-11-23 12:00:00", "A", "down", orden=1),
        ev("2025-11-23 11:00:00", "A", "up", orden=2),
        ev("2025-11-23 13:00:00", "A", "up", orden=3),
        ev("2025-11-23 09:00:00", "B", "up", orden=4),
        ev("2025-11-23 10:00:00", "B", "down", orden=5),
        ev("2025-11-23 10:00:00", "B", "up", orden=6),
    ]
    assert all(c.duracion_s is None or c.duracion_s >= 0
               for c in sl.reconstruir(eventos))


def test_un_estado_desconocido_no_abre_ni_cierra_nada():
    caidas = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "partially down", orden=1),
        ev("2025-11-23 10:01:00", "A", "down", orden=2),
        ev("2025-11-23 10:02:00", "A", "up", orden=3),
    ])
    assert len(caidas) == 1
    assert caidas[0].duracion_s == 60


# ── Los huecos de cobertura ──────────────────────────────────────────────────

def test_los_dos_anios_que_faltan_se_detectan_como_hueco():
    """2022 y 2023 no tienen una sola línea en los 44 archivos."""
    eventos = [
        ev("2021-12-31 10:00:00", "A", "up", orden=1),
        ev("2024-01-02 10:00:00", "B", "up", orden=2),
    ]
    tramos = sl.huecos(eventos, min_dias=1)
    assert len(tramos) == 1
    assert (tramos[0][1] - tramos[0][0]).days > 700


def test_una_caida_que_cruza_el_hueco_queda_marcada():
    """🔴 El caso que convierte esto en una mentira si no se marca: un `down` de
    2021 emparejado con el `up` de 2024 da una caída de dos años que nunca
    existió. Lo que se cortó fue el REGISTRO, no el enlace."""
    caidas = sl.reconstruir([
        ev("2021-12-31 10:00:00", "A", "down", "timeout", orden=1),
        ev("2024-01-02 10:00:00", "A", "up", "ok", orden=2),
        ev("2024-01-02 11:00:00", "B", "down", "timeout", orden=3),
        ev("2024-01-02 11:30:00", "B", "up", "ok", orden=4),
    ], min_dias=1)
    por = {c.equipo: c for c in caidas}
    assert por["A"].cruza_hueco is True
    assert por["A"].duracion_s > 63_000_000     # dos años: no creerle
    assert por["B"].cruza_hueco is False


def test_sin_huecos_nadie_queda_marcado():
    caidas = sl.reconstruir([
        ev("2025-11-23 10:00:00", "A", "down", orden=1),
        ev("2025-11-23 10:30:00", "A", "up", orden=2),
    ], min_dias=1)
    assert caidas[0].cruza_hueco is False


def test_el_balance_del_historico_se_reproduce():
    """Medido: 69.525 down y 69.511 up, o sea 14 down de más. Esos 14 tienen que
    salir como caídas 'open', no desaparecer ni cerrarse contra nada."""
    eventos = []
    n = 0
    for i in range(20):
        n += 1
        eventos.append(ev("2025-11-23 10:00:00", f"E{i}", "down", orden=n))
        n += 1
        eventos.append(ev("2025-11-23 10:30:00", f"E{i}", "up", orden=n))
    for i in range(3):                       # tres que no vuelven
        n += 1
        eventos.append(ev("2025-11-23 11:00:00", f"Z{i}", "down", orden=n))
    caidas = sl.reconstruir(eventos)
    assert sum(1 for c in caidas if c.cierre == "closed") == 20
    assert sum(1 for c in caidas if c.cierre == "open") == 3


# ═════════════════════════════════════════════════════════════════════════════
# De extremo a extremo, contra un PostgreSQL de verdad
# ═════════════════════════════════════════════════════════════════════════════

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "")

sin_postgres = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="definí TEST_DATABASE_URL para correr la prueba de extremo a extremo",
)

#: Inventario mínimo, con las tres formas que importan:
#:   - Sitio_Norte      un equipo, un servicio ping   → 'service'
#:   - Sitio_Sur        un equipo, SIN ping           → 'device'
#:   - Sitio_Repetido   DOS equipos con el mismo nombre → 'ambiguous'
#:   - (y lo que no está en la tabla)                → 'unknown'
INVENTARIO = """
INSERT INTO probes (id, name) VALUES (1, 'ping'), (2, 'ssh')
    ON CONFLICT DO NOTHING;
INSERT INTO devices (id, name) VALUES
    (10, 'Sitio_Norte'), (11, 'Sitio_Sur'),
    (12, 'Sitio_Repetido'), (13, 'Sitio_Repetido')
    ON CONFLICT DO NOTHING;
INSERT INTO services (id, device_id, probe_id) VALUES
    (100, 10, 1), (101, 11, 2), (102, 12, 1), (103, 13, 1)
    ON CONFLICT DO NOTHING;
"""

LINEAS = [
    # una caída normal, cerrada
    "2025.06.01-10:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now down (timeout)",
    "2025.06.01-10:05:00 <192.0.2.10>: Service ping on Sitio_Norte is now up (ok)",
    # un problema del servidor de monitoreo, no del equipo
    "2025.06.01-11:00:00 <192.0.2.10>: Service ping on Sitio_Sur is now down (local problem)",
    "2025.06.01-11:00:30 <192.0.2.10>: Service ping on Sitio_Sur is now up (ok)",
    # nombre repetido en el inventario → ambiguo
    "2025.06.01-12:00:00 <192.0.2.10>: Service ping on Sitio_Repetido is now down (timeout)",
    "2025.06.01-12:10:00 <192.0.2.10>: Service ping on Sitio_Repetido is now up (ok)",
    # equipo renombrado o dado de baja → no resuelve, pero se guarda
    "2025.06.01-13:00:00 <192.0.2.10>: Service ping on Sitio_E_Ponte 24GHZ ex 10 Ghz"
    " is now down (timeout)",
    "2025.06.01-13:30:00 <192.0.2.10>: Service ping on Sitio_E_Ponte 24GHZ ex 10 Ghz"
    " is now up (ok)",
    # caída sin cerrar
    "2025.06.01-14:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now down (timeout)",
    # y la otra fuente
    *MIKROTIK,
    "una línea que no entendemos",
]


@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    con = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    con.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    sl.aplicar_esquema(con, ESQUEMA)
    con.execute(INVENTARIO)
    yield con
    con.close()


@pytest.fixture(scope="module")
def archivo(tmp_path_factory):
    p = tmp_path_factory.mktemp("syslog") / "syslog1.txt"
    p.write_text("\n".join(LINEAS) + "\n", encoding="utf-8")
    return p


@sin_postgres
def test_el_esquema_se_puede_aplicar_dos_veces(pg):
    """El ETL corre `schema.sql` entero en CADA arranque. Un `CREATE TABLE` sin
    `IF NOT EXISTS`, o un índice repetido, rompería el contenedor en el segundo
    despliegue y no en el primero — que es la peor forma de romperse."""
    sl.aplicar_esquema(pg, ESQUEMA)
    sl.aplicar_esquema(pg, ESQUEMA)


@sin_postgres
def test_importar_carga_y_clasifica(pg, archivo):
    r = sl.importar(pg, [archivo], tz="America/Argentina/Buenos_Aires")
    assert r["archivos"]["cargado"] == 1

    fila = pg.execute(
        "SELECT lines, service_lines, other_lines, ignored_lines, tz"
        "  FROM syslog_files WHERE name = 'syslog1.txt'"
    ).fetchone()
    assert fila == (14, 9, 4, 1, "America/Argentina/Buenos_Aires")

    assert pg.execute("SELECT count(*) FROM syslog_events").fetchone()[0] == 9
    assert pg.execute("SELECT count(*) FROM syslog_other").fetchone()[0] == 4
    (auth,) = pg.execute(
        "SELECT count(*) FROM syslog_other WHERE message ILIKE '%%failed to authenticate%%'"
    ).fetchone()
    assert auth == 1


@sin_postgres
def test_la_zona_horaria_se_aplica_de_verdad(pg):
    """-03 sin horario de verano en todo el rango: Argentina no mueve el reloj
    desde 2009. 10:00 local del 2025-06-01 son las 13:00 UTC."""
    ts, local = pg.execute(
        "SELECT occurred_at, occurred_local FROM syslog_events"
        " WHERE device_name = 'Sitio_Norte' AND state = 'down'"
        " ORDER BY occurred_at LIMIT 1"
    ).fetchone()
    assert local == datetime(2025, 6, 1, 10, 0, 0)
    assert ts.utcoffset().total_seconds() == 0        # psycopg devuelve UTC
    assert ts.hour == 13


@sin_postgres
def test_las_caidas_reconstruidas(pg):
    filas = dict(pg.execute(
        "SELECT closure, count(*) FROM syslog_outages GROUP BY 1"
    ).fetchall())
    assert filas == {"closed": 4, "open": 1}

    dur, motivo = pg.execute(
        "SELECT duration_s, down_reason FROM syslog_outages"
        " WHERE device_name = 'Sitio_Norte' AND closure = 'closed'"
    ).fetchone()
    assert (dur, motivo) == (300, "timeout")

    # El motivo distingue un problema del equipo de uno del servidor.
    (locales,) = pg.execute(
        "SELECT count(*) FROM syslog_outages WHERE down_reason = 'local problem'"
    ).fetchone()
    assert locales == 1


@sin_postgres
def test_la_resolucion_tiene_cuatro_resultados(pg):
    filas = dict(pg.execute(
        "SELECT match_kind, count(*) FROM syslog_outages GROUP BY 1"
    ).fetchall())
    assert filas == {"service": 2, "device": 1, "ambiguous": 1, "unknown": 1}

    # 'service': los dos ids resueltos.
    assert pg.execute(
        "SELECT device_id, service_id FROM syslog_outages"
        " WHERE device_name = 'Sitio_Norte' AND closure = 'closed'"
    ).fetchone() == (10, 100)

    # 'device': el equipo sí, el servicio no (no tiene sonda ping).
    assert pg.execute(
        "SELECT device_id, service_id FROM syslog_outages"
        " WHERE device_name = 'Sitio_Sur'"
    ).fetchone() == (11, None)

    # 'ambiguous': el nombre lo comparten dos equipos, así que ningún id.
    assert pg.execute(
        "SELECT device_id, service_id FROM syslog_outages"
        " WHERE device_name = 'Sitio_Repetido'"
    ).fetchone() == (None, None)


@sin_postgres
def test_el_25_por_ciento_que_no_resuelve_se_guarda_igual(pg):
    """🔴 Medido sobre los 44 archivos: 114 de 452 nombres ya no existen en el
    inventario. Tirarlos sería perder justo lo que este trabajo viene a
    rescatar."""
    filas = pg.execute(
        "SELECT device_name, started_at, ended_at, duration_s FROM syslog_outages"
        " WHERE match_kind = 'unknown' AND closure = 'closed'"
    ).fetchall()
    assert len(filas) == 1
    assert filas[0][0] == "Sitio_E_Ponte 24GHZ ex 10 Ghz"
    assert filas[0][3] == 1800

    sin = sl.nombres_sin_resolver(pg)
    assert ("Sitio_E_Ponte 24GHZ ex 10 Ghz", 1) in sin


@sin_postgres
def test_no_hay_emparejamiento_por_parecido(pg):
    """`Sitio_E_Ponte 24GHZ ex 10 Ghz` se PARECE a `Sitio_Norte` y a
    `Sitio_Sur`. Ninguna de las dos se le asigna: una caída atribuida al equipo
    equivocado miente, y una sin atribuir se nota."""
    assert pg.execute(
        "SELECT count(*) FROM syslog_outages"
        " WHERE device_name = 'Sitio_E_Ponte 24GHZ ex 10 Ghz'"
        "   AND (device_id IS NOT NULL OR service_id IS NOT NULL)"
    ).fetchone()[0] == 0


# ── Idempotencia ─────────────────────────────────────────────────────────────

@sin_postgres
def test_correrlo_de_nuevo_no_duplica_nada(pg, archivo):
    antes = _conteos(pg)
    r = sl.importar(pg, [archivo], tz="America/Argentina/Buenos_Aires")
    # El sha256 no cambió: ni se abre el archivo.
    assert r["archivos"]["saltado"] == 1
    assert _conteos(pg) == antes

    # Y también con --forzar, que sí relee y reescribe.
    r = sl.importar(pg, [archivo], tz="America/Argentina/Buenos_Aires", forzar=True)
    assert r["archivos"]["cargado"] == 1
    assert _conteos(pg) == antes


@sin_postgres
def test_reconstruir_dos_veces_da_lo_mismo(pg):
    """`syslog_outages` es una función pura de `syslog_events`: se tira y se
    recalcula entera. Es lo que hace que mejorar el algoritmo no necesite
    migración."""
    a = sl.reconstruir_en_bd(pg)
    b = sl.reconstruir_en_bd(pg)
    assert a["caidas"] == b["caidas"] == a["escritas"] == b["escritas"]
    assert _conteos(pg)["syslog_outages"] == a["caidas"]


@sin_postgres
def test_un_archivo_que_crecio_agrega_sin_duplicar(pg, tmp_path):
    """La rotación de un syslog: el archivo vivo se sigue escribiendo. Al
    reimportarlo entran las líneas nuevas y las viejas no se repiten."""
    p = tmp_path / "creciente.txt"
    base = [
        "2025.07.01-10:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now down (timeout)",
        "2025.07.01-10:05:00 <192.0.2.10>: Service ping on Sitio_Norte is now up (ok)",
    ]
    p.write_text("\n".join(base) + "\n", encoding="utf-8")
    sl.importar(pg, [p], tz="America/Argentina/Buenos_Aires")
    n1 = _conteos(pg)["syslog_events"]

    p.write_text("\n".join(base + [
        "2025.07.01-11:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now down (timeout)",
    ]) + "\n", encoding="utf-8")
    sl.importar(pg, [p], tz="America/Argentina/Buenos_Aires")
    assert _conteos(pg)["syslog_events"] == n1 + 1


@sin_postgres
def test_la_misma_linea_en_dos_archivos_entra_una_sola_vez(pg, tmp_path):
    """El solape típico de una rotación. La clave única NO incluye el archivo,
    justamente para esto."""
    linea = ("2025.08.01-10:00:00 <192.0.2.10>: Service ping on Sitio_Norte"
             " is now down (timeout)")
    antes = _conteos(pg)["syslog_events"]
    for nombre in ("solape_a.txt", "solape_b.txt"):
        p = tmp_path / nombre
        p.write_text(linea + "\n", encoding="utf-8")
        sl.importar(pg, [p], tz="America/Argentina/Buenos_Aires")
    assert _conteos(pg)["syslog_events"] == antes + 1


@sin_postgres
def test_resolver_es_re_ejecutable_y_se_desresuelve_solo(pg):
    """Si un equipo se borra de The Dude, su caída tiene que VOLVER a 'unknown'
    y no quedarse con el id viejo apuntando a la nada."""
    antes = dict(pg.execute(
        "SELECT match_kind, count(*) FROM syslog_outages GROUP BY 1").fetchall())
    pg.execute("DELETE FROM services WHERE id = 101")
    pg.execute("DELETE FROM devices WHERE id = 11")
    sl.resolver(pg)
    assert pg.execute(
        "SELECT device_id, match_kind FROM syslog_outages"
        " WHERE device_name = 'Sitio_Sur'"
    ).fetchone() == (None, "unknown")

    pg.execute("INSERT INTO devices (id, name) VALUES (11, 'Sitio_Sur')")
    pg.execute("INSERT INTO services (id, device_id, probe_id) VALUES (101, 11, 2)")
    sl.resolver(pg)
    assert dict(pg.execute(
        "SELECT match_kind, count(*) FROM syslog_outages GROUP BY 1").fetchall()) == antes


# ── 🔴 Lo que el ETL le hace a la base cada 30 segundos ──────────────────────

@sin_postgres
def test_el_borrado_del_etl_no_se_lleva_puesta_la_historia(pg):
    """🔴 LA PRUEBA QUE JUSTIFICA NO PONER CLAVE FORÁNEA.

    `sync.py` hace `DELETE FROM services` + `INSERT` en cada corrida, cada 30
    segundos. Con `REFERENCES services(id) ON DELETE CASCADE`, seis años de
    historia se evaporarían dos veces por minuto. Con `RESTRICT`, reventaría el
    ETL entero. Es el mismo precedente que `map_element_positions`.

    Acá se simula ese borrado y se exige que la historia siga entera."""
    antes = _conteos(pg)["syslog_outages"]
    assert antes > 0
    for tabla in ("services", "devices"):
        pg.execute(f"DELETE FROM {tabla}")
    assert _conteos(pg)["syslog_outages"] == antes
    assert _conteos(pg)["syslog_events"] > 0

    # Y los ids que quedaron apuntando a filas que ya no están no rompen nada:
    # el nombre en texto sigue siendo el dato autoritativo.
    assert pg.execute(
        "SELECT device_name FROM syslog_outages WHERE device_id = 10 LIMIT 1"
    ).fetchone()[0] == "Sitio_Norte"

    pg.execute(INVENTARIO)
    sl.resolver(pg)


@sin_postgres
def test_el_esquema_no_tiene_clave_foranea_hacia_devices_ni_services(pg):
    """No alcanza con que hoy funcione: hay que impedir que alguien la agregue
    de buena fe mañana."""
    fks = pg.execute(
        "SELECT tc.table_name, ccu.table_name"
        "  FROM information_schema.table_constraints tc"
        "  JOIN information_schema.constraint_column_usage ccu"
        "    ON ccu.constraint_name = tc.constraint_name"
        " WHERE tc.constraint_type = 'FOREIGN KEY'"
        "   AND tc.table_name LIKE 'syslog\\_%%'"
    ).fetchall()
    assert fks == []


# ── Las vistas ───────────────────────────────────────────────────────────────

@sin_postgres
def test_la_cobertura_muestra_los_meses_vacios(pg, tmp_path):
    """Un GROUP BY común no devuelve fila para un mes sin datos, y así 2022 y
    2023 no aparecerían: se contaría una historia falsa sin mentir en ningún
    número."""
    p = tmp_path / "viejo.txt"
    p.write_text(
        "2024.12.01-10:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now up (ok)\n",
        encoding="utf-8")
    sl.importar(pg, [p], tz="America/Argentina/Buenos_Aires")

    filas = pg.execute(
        "SELECT mes, eventos, hueco FROM v_syslog_cobertura ORDER BY mes"
    ).fetchall()
    assert filas[0][0].year == 2024 and filas[0][0].month == 12
    huecos = [f for f in filas if f[2]]
    assert len(huecos) >= 4                  # enero a mayo de 2025, vacíos
    assert all(f[1] == 0 for f in huecos)


@sin_postgres
def test_la_vista_unificada_distingue_el_origen(pg):
    """El requisito de fondo: una caída reconstruida desde dos líneas de texto y
    una que The Dude registró con su reloj no tienen la misma confianza, y el
    que consulta tiene que poder distinguirlas."""
    pg.execute(
        "INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)"
        " VALUES (100, 10, '2026-06-20 10:00:00+00', '2026-06-20 10:01:00+00', 60)"
    )
    origenes = dict(pg.execute(
        "SELECT origen, count(*) FROM v_historia_caidas GROUP BY 1").fetchall())
    assert origenes["dude"] == 1
    assert origenes["syslog"] > 0

    # Y marca el solape: todo lo de syslog es anterior a la primera caída que
    # The Dude registró, así que nada se pisa.
    assert pg.execute(
        "SELECT count(*) FROM v_historia_caidas WHERE origen='syslog' AND solapado"
    ).fetchone()[0] == 0

    pg.execute("DELETE FROM outages")


@sin_postgres
def test_la_vista_marca_el_solape_cuando_lo_hay(pg, tmp_path):
    """Del 2026-06-12 en adelante las dos fuentes cubren el mismo período y la
    misma caída puede estar dos veces. Sumar sin filtrar la contaría doble."""
    p = tmp_path / "solapado.txt"
    # La primera línea cierra la caída que quedó abierta en 2025-08-01. Sin
    # ella, el `down` de 2026 se pliega contra aquel `down` viejo —que es
    # exactamente lo que hace la regla de los dos `down` seguidos— y la caída
    # resultante empieza en 2025, no en 2026. Costó un test en rojo descubrirlo,
    # y es la prueba de que la regla se aplica también donde no la esperabas.
    p.write_text(
        "2026.06.19-09:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now up (ok)\n"
        "2026.06.20-10:00:00 <192.0.2.10>: Service ping on Sitio_Norte is now down (timeout)\n"
        "2026.06.20-10:01:00 <192.0.2.10>: Service ping on Sitio_Norte is now up (ok)\n",
        encoding="utf-8")
    sl.importar(pg, [p], tz="America/Argentina/Buenos_Aires")
    pg.execute(
        "INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)"
        " VALUES (100, 10, '2026-06-20 13:00:00+00', '2026-06-20 13:01:00+00', 60)"
    )
    assert pg.execute(
        "SELECT count(*) FROM v_historia_caidas WHERE origen='syslog' AND solapado"
    ).fetchone()[0] == 1
    pg.execute("DELETE FROM outages")


@sin_postgres
def test_la_zona_horaria_se_puede_medir_contra_outages(pg, tmp_path):
    """🔴 La incógnita del reloj se vuelve una medición.

    `outages` viene de The Dude con epoch unix: UTC de verdad, sin ambigüedad.
    Si la zona con la que interpretamos el texto es la correcta, las mismas
    caídas caen a la misma hora, y el desplazamiento ganador es 0."""
    pg.execute("DELETE FROM outages")
    pg.execute(
        "INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s)"
        " VALUES (100, 10, '2026-06-20 13:00:00+00', '2026-06-20 13:01:00+00', 60)"
    )
    sl.resolver(pg)
    resultado = dict(sl.verificar_zona(pg, tolerancia_s=120))
    mejor = max(resultado, key=lambda h: resultado[h])
    assert mejor == 0 and resultado[0] == 1
    assert resultado[3] == 0
    pg.execute("DELETE FROM outages")


@sin_postgres
def test_reinterpretar_corrige_la_zona_sin_releer_los_archivos(pg):
    """Por eso se guarda `occurred_local`: si un día se descubre que el servidor
    estaba en UTC —ya pasó con la VM nueva, que venía tres horas adelantada—, se
    arregla con un UPDATE y no hay que volver a conseguir 44 archivos."""
    antes = pg.execute(
        "SELECT occurred_at FROM syslog_events"
        " WHERE device_name = 'Sitio_Norte' ORDER BY occurred_at LIMIT 1"
    ).fetchone()[0]
    pg.execute("UPDATE syslog_events SET occurred_at = occurred_local AT TIME ZONE 'UTC'")
    despues = pg.execute(
        "SELECT occurred_at FROM syslog_events"
        " WHERE device_name = 'Sitio_Norte' ORDER BY occurred_at LIMIT 1"
    ).fetchone()[0]
    assert (antes - despues).total_seconds() == 3 * 3600
    pg.execute(
        "UPDATE syslog_events SET occurred_at ="
        " occurred_local AT TIME ZONE 'America/Argentina/Buenos_Aires'")
    sl.reconstruir_en_bd(pg)
    sl.resolver(pg)


def _conteos(con) -> dict[str, int]:
    return {
        t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        for t in ("syslog_files", "syslog_events", "syslog_other", "syslog_outages")
    }
