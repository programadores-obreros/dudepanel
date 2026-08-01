#!/usr/bin/env bash
#
# Lee del registro el digest de cada imagen del despliegue y escribe las líneas
# que van en `.env.prod`.
#
# ── Por qué existe ───────────────────────────────────────────────────────────
#
# `compose.prod.yml` fija las cuatro imágenes por digest, no por etiqueta. Una
# etiqueta es un puntero mutable: quien pueda publicar en el registro reemplaza
# el contenido y el próximo `pull` se lo lleva en silencio. Un digest es el
# hash del contenido — si la imagen cambió, el `pull` FALLA.
#
# 🔴 Y este script existe porque el paso manual es el que se saltea.
#
#    Copiar cuatro hashes de 64 caracteres a mano garantiza dos cosas: que
#    alguien se va a equivocar, y que alguien —cansado, un martes a las once—
#    va a volver a poner la etiqueta «total es lo mismo». No es lo mismo: es la
#    diferencia entre «confío en que nadie tocó la etiqueta» y «el contenido es
#    éste o no arranca».
#
# Uso:
#   ./deploy/digests.sh                 # con el PANEL_VERSION de .env.prod
#   ./deploy/digests.sh 2362d0e         # con una versión puntual
#   ./deploy/digests.sh 2362d0e --aplicar   # y además lo escribe en .env.prod
#
set -euo pipefail

REPO=ghcr.io/programadores-obreros
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PROD="$AQUI/.env.prod"

# Las de terceros van con su etiqueta EXACTA, leída del compose. Escribirlas
# acá a mano sería una segunda fuente de verdad que se desincroniza sola: el
# día que alguien suba Caddy a la 2.12 en el compose, este script seguiría
# preguntando por la 2.11 y el digest no coincidiría con nada.
leer_etiqueta() {  # $1 = nombre de la imagen, sin el digest
  grep -oE "image: $1:[A-Za-z0-9._-]+" "$AQUI/compose.prod.yml" | head -1 | sed 's/.*://'
}

VERSION="${1:-}"
if [[ -z "$VERSION" || "$VERSION" == --* ]]; then
  [[ -r "$ENV_PROD" ]] || { echo "🔴 no puedo leer $ENV_PROD y no me pasaste una versión" >&2; exit 1; }
  VERSION="$(grep '^PANEL_VERSION=' "$ENV_PROD" | cut -d= -f2 | tr -d ' \r')"
fi
[[ -n "$VERSION" ]] || { echo "🔴 no hay PANEL_VERSION" >&2; exit 1; }

#: El sha256 de la cadena VACÍA. Si un método falla y devuelve nada, hashearlo
#: produce exactamente esto: un digest de 64 caracteres, perfectamente
#: plausible, y completamente falso. Se comprobó de casualidad probando
#: `imagetools inspect --raw | sha256sum`, que en esta máquina no imprime nada.
#: Un valor que se ve bien y es mentira es peor que un error.
VACIO="sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

digest() {  # $1 = referencia completa con etiqueta
  local d
  # 🔴 Pregunta al REGISTRO, no al disco. `docker inspect` contestaría con la
  #    imagen local, que puede ser una vieja con el mismo nombre — justo el
  #    error que este script viene a evitar.
  #
  #    Y NO se usa `buildx imagetools --format`: en esta máquina esa bandera
  #    no existe (`unknown flag: --format`) y falla en silencio si se le tapa
  #    el stderr. Medido, no supuesto.
  #    🔴 Y se elige linux/amd64 EXPLÍCITAMENTE, no «la primera».
  #
  #       `manifest inspect -v` sobre una imagen multiarquitectura devuelve una
  #       LISTA: `postgres:16-alpine` trae 16 plataformas. Tomar `d[0]` andaba
  #       de casualidad —ahí la primera es amd64— y en otra imagen podría ser
  #       `linux/armv6`. El digest sería válido, el `pull` andaría en esta
  #       máquina, y la VM no podría ejecutar la imagen. Un fallo que aparece
  #       recién en el servidor.
  #
  #       Fijar la plataforma es además MÁS estricto: clava el contenido y la
  #       arquitectura. Para un despliegue de una sola máquina, eso es una
  #       ventaja, no una limitación.
  d="$(docker manifest inspect -v "$1" 2>/dev/null \
       | python3 -c 'import sys, json
ARQ, SO = "amd64", "linux"
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
entradas = d if isinstance(d, list) else [d]
for e in entradas:
    desc = e.get("Descriptor", {}) or {}
    plat = desc.get("platform", {}) or {}
    if plat.get("architecture") == ARQ and plat.get("os") == SO:
        print(desc.get("digest", "")); break
else:
    # Imagen de una sola plataforma: no trae descriptor de plataforma.
    if len(entradas) == 1:
        print((entradas[0].get("Descriptor", {}) or {}).get("digest", ""))' 2>/dev/null || true)"

  if [[ -z "$d" ]]; then
    echo "🔴 no pude leer el digest de $1 — ¿existe en el registro? ¿hay sesión iniciada?" >&2
    exit 1
  fi
  if [[ "$d" != sha256:* || ${#d} -ne 71 ]]; then
    echo "🔴 respuesta rara para $1: $d" >&2; exit 1
  fi
  if [[ "$d" == "$VACIO" ]]; then
    echo "🔴 $1 devolvió el hash de la cadena vacía: el método falló en silencio" >&2; exit 1
  fi
  echo "$d"
}

PG_TAG="$(leer_etiqueta postgres)"
CADDY_TAG="$(leer_etiqueta caddy)"

echo "# Digests para PANEL_VERSION=$VERSION · generado por deploy/digests.sh" >&2
echo "# Terceros según compose.prod.yml: postgres:$PG_TAG · caddy:$CADDY_TAG" >&2
echo >&2

WEB="$(digest "$REPO/dudepanel-web:$VERSION")"
ETL="$(digest "$REPO/dudepanel-etl:$VERSION")"
PG="$(digest "postgres:$PG_TAG")"
CADDY="$(digest "caddy:$CADDY_TAG")"

SALIDA="WEB_DIGEST=$WEB
ETL_DIGEST=$ETL
POSTGRES_DIGEST=$PG
CADDY_DIGEST=$CADDY"

echo "$SALIDA"

if [[ " $* " == *" --aplicar "* ]]; then
  [[ -w "$ENV_PROD" ]] || { echo "🔴 no puedo escribir $ENV_PROD" >&2; exit 1; }
  # Copia de seguridad antes de tocar: este archivo tiene la contraseña de
  # Postgres y los editores automáticos son la forma clásica de perderla.
  cp -a "$ENV_PROD" "$ENV_PROD.bak"
  while IFS='=' read -r clave valor; do
    if grep -q "^$clave=" "$ENV_PROD"; then
      sed -i "s|^$clave=.*|$clave=$valor|" "$ENV_PROD"
    else
      echo "$clave=$valor" >> "$ENV_PROD"
    fi
  done <<< "$SALIDA"
  echo >&2
  echo "✅ escrito en $ENV_PROD (copia en $ENV_PROD.bak)" >&2
fi
