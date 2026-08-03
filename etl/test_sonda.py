"""
Pruebas del freno del sondeo en vivo.

🔴 Esto no tenía UN SOLO test, y por eso el defecto llegó a producción: el
   enfriamiento era por DESTINO y frenaba «Camino» porque un segundo antes se
   había hecho «Ping». Dos preguntas distintas al mismo equipo — que es
   literalmente cómo se diagnostica.

   El freno protege a la red de un ISP de un botón que cualquiera puede apretar
   en bucle. Es la clase de código que no se prueba «cuando haya tiempo».
"""

import time

import sonda


def freno(**kw):
    """Un freno limpio por test: el estado es del proceso y se contamina."""
    f = sonda.Freno()
    for k, v in kw.items():
        setattr(sonda, k, v)
    return f


class TestPorAccion:
    """🔴 El defecto exacto que reportó el usuario."""

    def test_repetir_la_MISMA_pregunta_se_frena(self):
        f = freno(ENFRIAMIENTO_S=10.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        assert f.permite("10.0.0.1", "ping")[0] is True
        ok, motivo, falta = f.permite("10.0.0.1", "ping")
        assert ok is False
        assert falta > 3
        # El mensaje tiene que decir que las otras SÍ se pueden: si no, la
        # persona cree que el equipo entero quedó bloqueado.
        assert "otras tres" in motivo

    def test_otra_pregunta_al_MISMO_equipo_pasa(self):
        # ping → camino → puertos → snmp es el flujo de diagnóstico. Frenarlo
        # es romper aquello para lo que existe la herramienta.
        f = freno(ENFRIAMIENTO_S=10.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        for accion in ("ping", "traza", "puertos", "snmp"):
            assert f.permite("10.0.0.1", accion)[0] is True, accion

    def test_la_misma_pregunta_a_OTRO_equipo_pasa(self):
        f = freno(ENFRIAMIENTO_S=10.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        assert f.permite("10.0.0.1", "ping")[0] is True
        assert f.permite("10.0.0.2", "ping")[0] is True


class TestEsperaCorta:
    """🔴 «Esperá 1 segundo» es peor que esperar el segundo."""

    def test_una_espera_corta_se_concede_y_se_duerme(self):
        f = freno(ENFRIAMIENTO_S=2.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        f.permite("10.0.0.1", "ping")
        ok, motivo, falta = f.permite("10.0.0.1", "ping")
        # Se permite, y devuelve cuánto hay que dormir antes de sondear.
        assert ok is True
        assert motivo == ""
        assert 0 < falta <= 2

    def test_una_espera_larga_se_niega_con_el_numero(self):
        f = freno(ENFRIAMIENTO_S=30.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        f.permite("10.0.0.1", "ping")
        ok, motivo, falta = f.permite("10.0.0.1", "ping")
        assert ok is False
        assert falta > 3
        assert "30 s" in motivo or "29 s" in motivo

    def test_el_turno_se_reserva_antes_de_dormir(self):
        """Sin reservar, dos pedidos a la vez esperan lo mismo y salen juntos.

        Es el error clásico de comprobar-y-después-actuar: los dos leen «falta
        1 s», los dos duermen 1 s, y los dos sondean en el mismo instante — que
        es exactamente lo que el freno venía a evitar.
        """
        f = freno(ENFRIAMIENTO_S=2.0, ESPERA_CORTA_S=3.0, POR_MINUTO=60)
        f.permite("10.0.0.1", "ping")
        ok1, _, falta1 = f.permite("10.0.0.1", "ping")
        ok2, _, falta2 = f.permite("10.0.0.1", "ping")
        assert ok1 is True
        # El segundo tiene que esperar MÁS que el primero, no lo mismo.
        assert falta2 > falta1


class TestTopeGlobal:
    def test_el_tope_global_no_se_espera_nunca(self):
        """🔴 Dormir en el tope global sería acumular pedidos, no frenarlos.

        El enfriamiento por par acompaña a una persona apurada; el tope global
        existe para cuando algo está martillando, y ahí hay que decir que no.
        """
        f = freno(ENFRIAMIENTO_S=0.0, ESPERA_CORTA_S=3.0, POR_MINUTO=3)
        for i in range(3):
            assert f.permite(f"10.0.0.{i}", "ping")[0] is True
        ok, motivo, falta = f.permite("10.0.0.9", "ping")
        assert ok is False
        assert falta == 0.0
        assert "tope global" in motivo

    def test_la_ventana_del_tope_es_movil(self):
        f = freno(ENFRIAMIENTO_S=0.0, ESPERA_CORTA_S=3.0, POR_MINUTO=1)
        assert f.permite("10.0.0.1", "ping")[0] is True
        assert f.permite("10.0.0.2", "ping")[0] is False
        # Se vacía a mano lo de hace más de un minuto: no se puede esperar 60 s
        # en un test, y lo que se prueba es que la lista se poda.
        f._minuto = [t - 61 for t in f._minuto]
        assert f.permite("10.0.0.2", "ping")[0] is True


def test_los_puertos_son_una_lista_fija():
    """🔴 Si esto crece a un rango, el panel pasa a ser un escáner."""
    assert len(sonda.PUERTOS) == 6
    for puerto, etiqueta in sonda.PUERTOS:
        assert isinstance(puerto, int) and 1 <= puerto <= 65535
        assert etiqueta
