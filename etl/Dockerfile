# ─────────────────────────────────────────────────────────────────────────────
#  ETL: The Dude (SQLite, sólo lectura) → PostgreSQL
#
#  Dos etapas para que en la final no quede ni pip ni un compilador. La imagen
#  que corre en producción tiene que poder hacer exactamente una cosa: leer un
#  archivo y escribir en Postgres.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.12-slim AS build

WORKDIR /wheels
COPY requirements.txt .
# --prefix aísla la instalación para poder copiarla entera después. `psycopg
# [binary]` llega como rueda precompilada, así que acá tampoco hace falta gcc.
RUN pip install --no-cache-dir --prefix=/instalado -r requirements.txt


FROM python:3.12-slim

# UID fijo y alto: no colisiona con usuarios del anfitrión y hace predecibles
# los permisos del montaje de origen, que es de sólo lectura pero igual tiene
# que ser legible por ESTE usuario.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin dude

COPY --from=build /instalado /usr/local

WORKDIR /app
COPY dudeobj.py sync.py schema.sql ./
COPY salud.py /usr/local/bin/salud.py

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DUDE_DB=/origen/dude.db \
    DUDE_FILES=/origen/files \
    SYNC_INTERVAL=30 \
    SCHEMA_FILE=/app/schema.sql

USER dude

# El healthcheck NO pregunta "¿el proceso vive?" —eso ya lo sabe Docker— sino
# "¿la última corrida terminó bien y es reciente?". Un ETL que quedó trabado
# leyendo una base bloqueada sigue teniendo el proceso arriba y sirviendo datos
# de hace horas: ese es exactamente el fallo que hay que detectar.
#
# El margen es 3 intervalos + 30 s: tolera una vuelta perdida sin alarmar, y no
# tolera tres.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["python", "/usr/local/bin/salud.py"]

ENTRYPOINT ["python", "-u", "/app/sync.py"]
