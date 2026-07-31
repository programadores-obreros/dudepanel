# syntax=docker/dockerfile:1
# ════════════════════════════════════════════════════════════════════════════
#  Panel web de la red del ISP.
#
#  Tres etapas. La final no lleva ni pnpm, ni el código fuente, ni las
#  dependencias de desarrollo: sólo Node, `dist/` y lo que hace falta para
#  ejecutar. Menos superficie que auditar y una imagen que se baja rápido —
#  esto se despliega desde una oficina, no desde un datacenter.
# ════════════════════════════════════════════════════════════════════════════

ARG NODE_VERSION=22-alpine

# ── 1 · Dependencias ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack enable

# Sólo los manifiestos: mientras no cambien, esta capa sale de la caché y no se
# vuelve a instalar nada aunque cambie todo el código.
COPY package.json pnpm-lock.yaml ./
# Dos decisiones acá:
#
#  · Sin `--mount=type=cache`: eso exige BuildKit, y este Dockerfile tiene que
#    construir igual con el motor viejo de Docker.
#  · `--ignore-scripts`: los únicos paquetes con script de instalación son
#    esbuild y sharp, y los dos traen su binario en un paquete aparte por
#    plataforma (`@esbuild/linux-x64`, `@img/sharp-linux-x64`) que se instala
#    solo. Ejecutar código arbitrario de dependencias durante el build no
#    aporta nada y es superficie de ataque regalada.
RUN pnpm install --frozen-lockfile --ignore-scripts


# ── 2 · Compilación ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# El build no toca la base: `astro build` sólo compila. Ver el comentario en
# `obtenerPool`, que abre el pool de forma perezosa justamente por esto.
RUN pnpm run build

# Se vuelven a instalar SÓLO las de producción.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# `astro` tiene que quedar: el entrypoint importa `astro/app/node`. Pero se
# arrastra el compilador entero —TypeScript, Vite, esbuild, Rollup, Shiki,
# sharp, lightningcss—, que en tiempo de ejecución no se toca. Son 125 MB de
# imagen que nadie va a ejecutar nunca.
#
# 🔴 Podar por lista es frágil: una versión futura de Astro podría empezar a
#    necesitar alguno en tiempo de ejecución, y el fallo aparecería recién en
#    producción. Por eso abajo va un arranque de verdad que lo comprueba: si la
#    poda rompió algo, FALLA EL BUILD y nunca sale la imagen.
RUN cd node_modules/.pnpm && rm -rf \
      typescript@* prettier@* \
      esbuild@* '@esbuild+'* \
      sharp@* '@img+'* \
      lightningcss* \
      shiki@* '@shikijs+'* \
      vite@* '@vitejs+'* rollup@* '@rollup+'* \
      '@types+'* '@babel+'*

# Prueba de humo: se levanta el servidor real y se le pide la portada.
# Sin DATABASE_URL la página igual responde 200 —el layout atrapa el error de
# base y dibuja el aviso—, así que esto verifica el renderizador de punta a
# punta sin necesitar PostgreSQL en el build.
RUN PORT=8099 node ./dist/server/entry.mjs & \
    ok=0; \
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do \
      sleep 1; \
      if node -e "fetch('http://127.0.0.1:8099/').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"; then ok=1; break; fi; \
    done; \
    if [ "$ok" != 1 ]; then echo 'La poda de node_modules rompió el servidor'; exit 1; fi; \
    echo 'Prueba de humo: el servidor levanta y sirve la portada.'


# ── 3 · Ejecución ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    ASTRO_TELEMETRY_DISABLED=1

# El usuario `node` viene en la imagen oficial. Nada de esto necesita root, y un
# panel de sólo lectura que corre como root es una escalada regalada.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# `tini` como PID 1: sin él, Node no recibe SIGTERM y `docker stop` termina
# matando el proceso a los 10 s en vez de dejarlo cerrar el pool.
RUN apk add --no-cache tini

USER node
EXPOSE 4321

# Pega contra una ruta que consulta PostgreSQL de verdad. Un healthcheck que
# sólo mira que el puerto conteste diría "sano" con la base caída, que es
# precisamente el caso que hay que detectar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/estado.json').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(d=>process.exit(d.resumen?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "./dist/server/entry.mjs"]
