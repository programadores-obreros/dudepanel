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

# 🔴 Este directorio TIENE que existir en la imagen, con este dueño y este modo.
#
#    Acá va la copia de trabajo de `dude.db` (ver `dudeobj.instantanea`), y del
#    otro lado se monta un volumen de Docker. Un volumen con nombre que arranca
#    vacío HEREDA dueño y permisos de lo que la imagen tenga en ese punto de
#    montaje; si el directorio no existe, Docker lo crea `root:root 755` y el
#    ETL —que corre como `dude`— no puede escribir la copia.
#
#    El 700 tampoco es de adorno: esa copia tiene el usuario y la contraseña de
#    acceso a todos los equipos monitoreados.
RUN mkdir -p /trabajo && chown dude:dude /trabajo && chmod 700 /trabajo

COPY --from=build /instalado /usr/local

WORKDIR /app
# 🔴 TODOS los módulos, no sólo los que corren en el bucle del ETL.
#
#    `syslog.py` y `respaldo.py` son herramientas de línea de comandos que se
#    ejecutan a mano, no en cada corrida. Es tentador dejarlas afuera «porque
#    el servicio no las usa» — y es un error, porque el único lugar desde donde
#    se pueden correr contra la base de producción es un contenedor con estas
#    dependencias, en la red `interna`.
#
#    Y esa red es `internal: true`: NO tiene salida a internet. Así que un
#    `pip install` ahí adentro falla, y no hay forma de traer el módulo en el
#    momento. O está en la imagen, o no se puede correr.
#
#    Se descubrió intentando importar seis años de historia en producción:
#    `ModuleNotFoundError: No module named 'psycopg'` primero, y
#    `can't open file '/app/syslog.py'` después.
#
#    ⚠️ `camino.py` está en la imagen pero NO puede correr en el servicio `etl`:
#       ese servicio vive en la red `interna` (`internal: true`) y trazar
#       necesita salida. Medido: `[Errno 101] Network is unreachable`. Va como
#       servicio aparte con `networks: [interna, borde]`, o a mano desde un
#       contenedor con salida. Ver el encabezado de `camino.py`.
#
#    ⚠️ Lo mismo vale para `sonda.py`, que además necesita el sysctl
#       `net.ipv4.ping_group_range` abierto para hacer ping ICMP sin
#       privilegios. Si no lo tiene, cae solo a UDP y lo informa.
COPY dudeobj.py sync.py syslog.py respaldo.py camino.py sonda.py schema.sql ./
COPY salud.py /usr/local/bin/salud.py

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DUDE_DB=/origen/dude.db \
    DUDE_FILES=/origen/files \
    DUDE_SNAPSHOT=/trabajo/dude.db \
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
