"""Healthcheck del ETL: ¿la última corrida terminó bien y es reciente?

Sale 0 si sí, 1 si no. Docker no necesita más.

La pregunta importa porque el fallo típico de este servicio NO mata el proceso.
The Dude toma un bloqueo exclusivo al confirmar —SQLite 3.6.14 no tiene WAL— y
un ETL esperando ese bloqueo se ve perfectamente vivo desde afuera mientras el
panel muestra la red de hace seis horas. `docker ps` diría "Up 3 days".
"""
from __future__ import annotations

import os
import sys

import psycopg

INTERVALO = float(os.environ.get("SYNC_INTERVAL", "30"))

#: Tres vueltas perdidas más medio minuto de gracia. Con dos vueltas el
#: healthcheck se pondría nervioso por un SQLITE_BUSY que se resuelve solo.
MARGEN_S = INTERVALO * 3 + 30


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("falta DATABASE_URL", file=sys.stderr)
        return 1
    try:
        with psycopg.connect(url, connect_timeout=5) as con:
            fila = con.execute(
                "SELECT ok, error, extract(epoch FROM now() - finished_at)"
                "  FROM sync_runs WHERE finished_at IS NOT NULL"
                " ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
    except Exception as e:  # noqa: BLE001
        print(f"no puedo consultar sync_runs: {e}", file=sys.stderr)
        return 1

    if fila is None:
        print("todavía no hay ninguna corrida terminada", file=sys.stderr)
        return 1

    ok, error, antiguedad = fila
    if not ok:
        print(f"la última corrida falló: {error}", file=sys.stderr)
        return 1
    if antiguedad > MARGEN_S:
        print(f"la última corrida buena fue hace {antiguedad:.0f} s "
              f"(margen {MARGEN_S:.0f} s)", file=sys.stderr)
        return 1
    print(f"ok, hace {antiguedad:.0f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
