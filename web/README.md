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
| `DUDE_FILES_DIR` | Directorio de The Dude con los iconos (PNG en su mayoría, algunos SVG). Si no está, el visor usa los suyos y el mapa sale completo igual. |
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
  middleware.ts comprime las respuestas (brotli/gzip)
  lib/          toda la lógica y toda la SQL — sin nada de Astro adentro
    db.ts           pool de PostgreSQL
    consultas.ts    ⭐ TODA la SQL del panel
    estado.ts       los 4 estados de The Dude y cómo se muestran
    mapa.ts         ⭐ geometría del visor (función pura, testeada)
    iconos.ts       resolución, higiene y servido de los iconos
    formato.ts      fechas, duraciones y números en es-AR
  components/   piezas de interfaz (.astro, cero JavaScript al cliente)
  scripts/      las cuatro islas de JavaScript que existen
  pages/        rutas — incluye /iconos/… , que sirve los PNG del disco
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

**Los iconos van por dos caminos según su formato.** Medido sobre la base real:
de los 56 iconos que usan los mapas, **47 son PNG, JPG o BMP** y sólo 9 son SVG.

- **SVG** → se incrusta como `<symbol>` y se referencia con `<use>`: viaja una
  vez, hereda el tema, cero peticiones. Como es SVG ajeno metido en nuestro
  documento, pasa por `higienizar()`.
- **Rasterizados** → se sirven desde `/iconos/…`. Un PNG en base64 serían más
  de 100 kB por página; el mapa más cargado usa 21 URLs distintas, o sea 21
  peticiones chiquitas que el navegador cachea y reusa entre mapas.

**El endpoint de iconos tiene lista blanca de extensiones.** En ese mismo
directorio viven `certificate.pem`, 123 `.log` y 109 `.txt`. Un endpoint que
sirviera «lo que le pidan» bajo `files/` publicaría la clave privada del
servidor de monitoreo. Se sirve una imagen o no se sirve nada, y hay tests que
lo verifican.

**El visor declara los enlaces que no pudo dibujar.** Un enlace sólo se traza
si sus dos puntas son elementos de ese mismo mapa, y en la base real eso a
menudo no pasa: `Segmentos` es un mapa de resumen y 147 de sus 308 enlaces terminan
en elementos dibujados en `Aurora`. Callarlo haría leer una red menos conectada
de la que hay, así que la barra inferior dice *«308 enlaces, 107 dibujados —
152 conectan con equipos de otros mapas, 49 tienen extremos que ya no existen»*
y ofrece **ir a esos mapas**. Se distinguen los dos motivos porque no son lo
mismo: uno se puede navegar, el otro es dato roto del origen.

**Los filtros viven en la URL, no en memoria.** `/dispositivos?estado=3&orden=tipo`
se comparte por WhatsApp, funciona con el botón de atrás y no obliga a mandarle
885 filas a un celular en 4G.

**Las respuestas se comprimen en el proceso** (`src/middleware.ts`), porque el
despliegue es un contenedor solo y no hay un nginx adelante que se pueda dar por
hecho. El SVG de un mapa grande es repetitivo hasta el absurdo: el mapa
real más pesado (`Segmentos`, 401 elementos) baja de 102 kB a 9,9 kB con brotli. Lo que **no** pasa por ahí son los archivos
estáticos: los sirve el adaptador antes que el middleware. Como van con
`immutable` y el nombre lleva hash, se pagan una sola vez (~41 kB de CSS y JS) y
después salen de la caché del navegador.

**El estado que muestra un mapa se recalcula en vivo**, no se lee de
`maps.devices_*`. Esas columnas las materializa el ETL y, si una corrida falla a
mitad, quedan describiendo una red que ya no existe. Con 40 mapas el recuento
cuesta milisegundos: se prefiere pagarlos antes que mostrar «todo verde» porque
un entero quedó viejo.

### Trampas del origen que ya están resueltas acá

| | |
|---|---|
| `timeLastUp` / `timeLastDown` | **No son fechas: son duraciones en segundos.** Mostrarlos como instante pone «1970» en pantalla. |
| `timeSinceChanged` | Al revés: **sí** es un epoch. Se usa vía `services.status_changed_at`. |
| `snapshot_reused = true` | El ETL corrió **bien** y no reescribió nada porque nada cambió. Es éxito, no falta de datos. |
| `map_elements.kind = 'static'` | Ficha de anotación de VLAN, de varias líneas y con CR LF. **No es un equipo, pero SÍ ancla enlaces**: 212 de los 308 de `Segmentos` terminan en una. Sacarlas del grafo dejaba el mapa con 18 líneas en vez de 107. |
| `files.rel_path` | Casi todo PNG/JPG, no SVG. Y el directorio tiene también `.pem`, `.log` y `.txt`. |
| Enlaces entre mapas | Las puntas de un enlace pueden vivir en otro lienzo. No es un error del ETL: The Dude lo guarda así. |
| `links.master_interface` | Es el `ifIndex` de SNMP, un número. El nombre de la interfaz **no existe** en la base. |
| `device_parents` | Puede estar **vacía**: en esta instalación la topología nunca se cargó. La sección aparece vacía y no rota. |

---

## Lo que el panel NO tiene, a propósito

**Ni usuarios ni contraseñas de los equipos.** The Dude guarda las credenciales
de cada router de el ISP en forma recuperable. El ETL no las enmascara: **no
las lee**. Una base que no las contiene no las puede filtrar, ni por un bug, ni
por un volcado, ni por un respaldo mal guardado.

Dos tests lo sostienen, y vale contar por qué son dos.

**Antes había uno solo y no podía fallar.** Recorría las claves del detalle de
un equipo buscando que ninguna se llamara `user`, `pwd`, `community`. Pero las
claves que devuelve el panel son alias en castellano —`nombre`, `direcciones`,
`perfil_snmp`—, así que la comparación nunca iba a coincidir con nada. Un
`sp.community AS clave_snmp` pasaba en verde. Era una garantía decorativa.

Lo que hay ahora:

- **Un centinela.** El seed planta un valor reconocible en `notifications`, la
  única tabla con texto libre que el panel no consulta nunca. Un segundo test
  verifica que el centinela siga en la base —si no, no probaría nada— y otro
  barre la respuesta de las dieciocho consultas del panel buscando ese valor.
  Busca el VALOR, no el nombre de la clave.
- **La lista de campos congelada.** El detalle de un equipo tiene que devolver
  exactamente los veinte campos acordados. Agregar uno rompe el test: no para
  prohibirlo, sino para que se vea en la revisión.

Comprobado ensanchando el `SELECT` a propósito: los dos fallan.

---

## Pendiente

- **Gráficos de series.** `chart_values` y `chart_sources` ya están en el
  esquema y el seed las carga; el panel todavía no las dibuja.
- **Verificación con lector de pantalla.** El marcado está pensado para eso
  (roles, `aria-label`, texto además del glifo), pero no se probó con NVDA ni
  con Orca.
- **Los bytes de `data/files/` todavía no se vieron.** Ya se sabe qué nombres y
  qué formatos registra la base, y el camino está probado con un SVG que imita
  la basura de un editor de 2011 (DOCTYPE, namespaces de Inkscape, degradados,
  `xlink:href` interno) más PNG y JPG de prueba. Falta montar el directorio real
  de la VM y mirar el resultado con los ojos.
- **Nadie miró el visor en una pantalla.** Todo lo verificado es el HTML servido
  y los tiempos. Que los 401 elementos de `Segmentos` se lean bien —que las fichas
  de VLAN no se pisen entre sí, que el zoom se sienta bien con el trackpad— es
  una afirmación no comprobada.
