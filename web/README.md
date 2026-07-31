# Panel web de la red de el ISP

Reemplazo consultable desde el navegador de **The Dude 4.0beta3**, el cliente
Windows de 2011 que hoy corre en una sola máquina: para ver la red hay que ir
físicamente hasta ahí.

**Astro 5 en SSR + TailwindCSS 4 + PostgreSQL.** Sólo lectura: la fuente de
verdad es The Dude, y el ETL de `../etl/` es el único que escribe.

---

## Levantarlo

Hace falta **Node 22+**, **pnpm** y **Docker** (para la base).

```bash
# 1 · PostgreSQL desechable
docker run --rm -d --name dudepg \
  -e POSTGRES_USER=dude -e POSTGRES_PASSWORD=x -e POSTGRES_DB=dudepanel \
  -p 55433:5432 postgres:16-alpine

# 2 · Esquema y datos de prueba
psql postgres://dude:x@localhost:55433/dudepanel -f ../etl/schema.sql
psql postgres://dude:x@localhost:55433/dudepanel -f seed-dev.sql

# 3 · Configuración y arranque
cp .env.example .env      # y poné el DATABASE_URL de arriba
pnpm install
pnpm dev                  # http://localhost:4321
```

> `pnpm install` termina con `ERR_PNPM_IGNORED_BUILDS` por `esbuild` y `sharp`.
> **Es inofensivo**: los dos traen su binario en un paquete aparte por
> plataforma que sí se instala. Se dejó así a propósito, para no habilitar
> scripts de instalación de dependencias.

### Variables de entorno

| | |
|---|---|
| `DATABASE_URL` | **obligatoria.** La base que llena el ETL. |
| `DUDE_FILES_DIR` | Directorio `files/` de The Dude, con los SVG de los iconos. Si no está, el visor usa los suyos. |
| `PGPOOL_MAX` | Conexiones del pool. 10 por defecto. |
| `SYNC_UMBRAL_DEMORADA` / `SYNC_UMBRAL_VIEJA` | Segundos para avisar que los datos no están frescos. 180 y 600. |
| `PORT` · `HOST` | 4321 y `0.0.0.0`. |

---

## Comandos

```bash
pnpm dev      # desarrollo con recarga
pnpm build    # compila a dist/
pnpm preview  # sirve lo compilado
pnpm check    # tipos (astro check)
pnpm test     # vitest
```

Los tests de la capa de datos corren contra PostgreSQL de verdad. Necesitan
`psql` en el `PATH` y una base **desechable** —le aplican el esquema y el seed,
borrando lo que haya:

```bash
TEST_DATABASE_URL=postgres://dude:x@localhost:55433/dudepanel pnpm test
```

Sin esa variable, esos tests se saltean y el resto corre igual.

---

## Docker

```bash
docker build -t dudepanel-web .
docker run -d --name dudepanel -p 4321:4321 \
  -e DATABASE_URL=postgres://dude:clave@host:5432/dudepanel \
  -v /datos/dude/files:/datos/files:ro \
  -e DUDE_FILES_DIR=/datos/files \
  dudepanel-web
```

Build en tres etapas, corre como usuario `node` y trae `HEALTHCHECK`. El
healthcheck pega contra `/api/estado.json`, que consulta PostgreSQL: uno que
sólo mirara si el puerto contesta diría «sano» con la base caída, que es
exactamente el caso que hay que detectar.

Los iconos se montan **de sólo lectura**. El panel no tiene ninguna razón para
escribir en el directorio de The Dude.

---

## Cómo está armado

```
src/
  lib/          toda la lógica y toda la SQL — sin nada de Astro adentro
    db.ts           pool de PostgreSQL
    consultas.ts    ⭐ TODA la SQL del panel
    estado.ts       los 4 estados de The Dude y cómo se muestran
    mapa.ts         ⭐ geometría del visor (función pura, testeada)
    iconos.ts       lectura e higiene de los SVG del disco
    formato.ts      fechas, duraciones y números en es-AR
  components/   piezas de interfaz (.astro, cero JavaScript al cliente)
  scripts/      las cuatro islas de JavaScript que existen
  pages/        rutas
test/           vitest
```

`lib/` no importa nada de Astro: se puede probar sin renderizar. `pages/` no
sabe de columnas: pide funciones a `consultas.ts`.

### Decisiones que conviene conocer antes de tocar algo

**El estado nunca se comunica sólo con color.** Cada uno tiene además un glifo
(`✓ ! ✕ ?`) y una palabra, y en el mapa también un trazo distinto (continuo,
rayado, punteado). Hay operadores daltónicos y un tablero que sólo distingue
verde de rojo los deja afuera. Está cubierto por tests: si alguien saca el
glifo, `estado.test.ts` se pone rojo.

**Ninguna página se recarga sola.** El refresco pide un JSON chico cada 30 s y
parchea las cifras. Un `location.reload()` tira el zoom del mapa, el
desplazamiento y lo que estabas leyendo — es justo lo que hace la interfaz que
estamos reemplazando.

**El reloj de la sincronización corre en el navegador.** Si el servidor deja de
responder, la antigüedad sigue creciendo y la barra se pone roja sola. Un panel
que se congela mostrando verde miente.

**El mapa lo dibuja el servidor, no el cliente.** El SVG llega hecho: se ve
completo aunque el JavaScript no cargue nunca, y los nodos son `<a>` de verdad,
navegables con Tab. El script sólo mueve una matriz de transformación — con 401
elementos, desplazar el mapa es *una* escritura de atributo.

**Los iconos van incrustados como `<symbol>`.** No con `<image href>`. Un mapa
grande tiene cientos de nodos y un puñado de iconos distintos: así cada archivo
viaja una sola vez, hereda el tema y no genera peticiones extra. Como es SVG
ajeno metido en nuestro documento, pasa por `higienizar()`.

**Los filtros viven en la URL, no en memoria.** `/dispositivos?estado=3&orden=tipo`
se comparte por WhatsApp, funciona con el botón de atrás y no obliga a mandarle
885 filas a un celular en 4G.

### Trampas del origen que ya están resueltas acá

| | |
|---|---|
| `timeLastUp` / `timeLastDown` | **No son fechas: son duraciones en segundos.** Mostrarlos como instante pone «1970» en pantalla. |
| `timeSinceChanged` | Al revés: **sí** es un epoch. Se usa vía `services.status_changed_at`. |
| `snapshot_reused = true` | El ETL corrió **bien** y no reescribió nada porque nada cambió. Es éxito, no falta de datos. |
| `map_elements.kind = 'static'` | Rótulo de texto libre (`eth2`), no un equipo. Se dibuja como texto gris. |
| `links.master_interface` | Es el `ifIndex` de SNMP, un número. El nombre de la interfaz **no existe** en la base. |
| `device_parents` | Puede estar **vacía**: en esta instalación la topología nunca se cargó. La sección aparece vacía y no rota. |

---

## Lo que el panel NO tiene, a propósito

**Ni usuarios ni contraseñas de los equipos.** The Dude guarda las credenciales
de cada router de el ISP en forma recuperable. El ETL no las enmascara: **no
las lee**. Una base que no las contiene no las puede filtrar, ni por un bug, ni
por un volcado, ni por un respaldo mal guardado.

Hay un test que recorre las columnas del detalle de un equipo y falla si
aparece alguna que se llame `user`, `pwd`, `community` o parecido. Está para
que nadie las agregue «por conveniencia».

---

## Pendiente

- **Gráficos de series.** `chart_values` y `chart_sources` ya están en el
  esquema y el seed las carga; el panel todavía no las dibuja.
- **Verificación con lector de pantalla.** El marcado está pensado para eso
  (roles, `aria-label`, texto además del glifo), pero no se probó con NVDA ni
  con Orca.
- **Los iconos reales nunca se ejercitaron contra `data/files/` de producción.**
  El camino está testeado con SVG de prueba; falta ver qué trae realmente ese
  directorio de 2011.
- **Medición con el mapa de 401 elementos.** El seed llega a 76. El diseño está
  pensado para ese tamaño, pero no se cronometró con el mapa real.
