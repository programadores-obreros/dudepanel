# Imágenes de los equipos

Cómo la ficha de un equipo (`/dispositivos/<id>`) elige qué imagen mostrar, y
cómo cargar imágenes propias sin meter al ISP en un problema de derechos de
autor.

---

## Qué se ve hoy, sin hacer nada

Nada nuevo hizo falta cargar: **la imagen ya estaba en la base**.

De los elementos de mapa de esta instalación, **494 tienen un icono asignado a
mano**, y **53 de esos nombres de archivo nombran modelos reales**:
`rb2011.png`, `crs305.png`, `nanomder.png`, `airfiber-izq.png`,
`CCR1036-8G-2Splus.png`, `olt-tplink.png`, `basestation.png`… Son fotos de
catálogo que alguien fue poniendo durante años, y el panel ya las servía por
`/iconos/…`. Lo único que faltaba era mirarlas en grande: en el mapa se dibujan
a 40 px, donde una foto es una mancha.

La ficha resuelve la imagen en este orden:

| | De dónde | Cuándo |
|---|---|---|
| **1** | `web/public/equipos/…` | si existe una foto propia con el nombre que corresponde |
| **2** | el icono de The Dude, por `/iconos/…` | si es una imagen rasterizada Y el archivo está de verdad en `files/` |
| **3** | nada — y se explica qué falta | en cualquier otro caso |

### El modelo, cuando se puede leer

Debajo de la imagen aparece el modelo **sólo si está escrito literalmente en el
nombre del archivo**: `rb2011.png` → **RB2011**, `crs326-24g-2s.png` →
**CRS326**, `RB3011UiAS-RM.png` → **RB3011UiAS**.

Se reconocen cuatro prefijos de MikroTik —`RB`, `CCR`, `CRS`, `CSS`— seguidos
de tres o cuatro dígitos. Nada más.

🔴 **Y no se traduce nada.** `nanomder.png` es casi seguro una NanoStation M,
pero «casi seguro» no se pone en la ficha de un equipo: se lee como un dato
medido. Un modelo inventado es la misma clase de daño que la MAC falsa que
`lib/oui.ts` vino a tapar. Si no está escrito en el archivo, no se muestra.

Por lo mismo, el código se corta en el primer carácter que no es letra ni
dígito. En `ccr2116-01.png` el `-01` es el número de la foto, no del producto:
decir **CCR2116** da menos información y nunca da información falsa; decir
«CCR2116-01» sería nombrar un modelo que no existe.

### Cuando no hay imagen

El hueco **no** es un cuadro gris mudo. Dice cuál de las tres cosas pasó, porque
piden acciones distintas:

- **No hay icono asignado** — ni al equipo ni a su tipo. Es trabajo de carga.
- **Hay un pictograma, no una imagen** — el icono asignado es un `router.svg` o
  similar: line art genérico de The Dude, dibujado para 24 px. Ampliarlo no
  muestra el equipo, muestra el dibujo. Y un SVG cargado por `<img>` es un
  documento aparte que no hereda `currentColor`, así que en el tema oscuro
  saldría negro sobre negro.
- **El archivo no aparece** — The Dude apunta a una imagen que no está en
  `files/`. Casi siempre es que el directorio no se montó: revisar
  `DUDE_FILES_DIR`.

> 🔴 **Por qué hay que preguntarle al disco y no alcanza con pedir la URL.**
> `/iconos/…` **nunca devuelve 404**: cuando el archivo no está contesta **200
> con el pictograma de repuesto**, y está decidido así a propósito (un `<image>`
> de SVG no sabe reaccionar a un 404 y dejaría un hueco en el mapa). Perfecto
> para el mapa, inútil para la ficha: si ésta confiara en el estado HTTP, con
> `files/` sin montar mostraría 885 cajitas grises afirmando que ésa es la pinta
> del equipo.

---

## Cargar imágenes propias

### Dónde y con qué nombre

Van en **`web/public/equipos/`**, sin subdirectorios. El nombre decide a qué
equipos se les aplica:

| Nombre del archivo | A quién se le aplica |
|---|---|
| `<base-del-icono>.<ext>` | a **todos** los equipos que compartan ese icono |
| `dispositivo-<id>.<ext>` | a **ese equipo y nada más** |

`rb2011.webp` reemplaza a `images/rb2011.png` para todos los RB2011 de la red.
`dispositivo-3417.webp` reemplaza la imagen del equipo `/dispositivos/3417`, y
de ninguno más.

La clave es el nombre del archivo del icono **sin directorio, sin extensión y en
minúsculas**. `images/RB2011iL-rack.PNG` → clave `rb2011il-rack`.

El equipo puntual gana siempre: si están las dos, se muestra la del equipo.

**La ficha te dice el nombre exacto.** Cuando no hay imagen, el aviso escribe la
ruta completa que hay que crear. No hay que deducirla.

### Formatos

`webp` · `avif` · `png` · `jpg` · `jpeg` · `gif`

Ese es también el orden de preferencia, y sólo sirve para desempatar: si
conviven `rb2011.webp` y `rb2011.png`, gana el `webp`. **No hay conversión ni
redimensionado**: lo que se deja es lo que se sirve. Conviene dejar algo
razonable —del orden de 600 a 1000 px de lado y menos de 200 kB— porque el
destinatario típico es un celular en 4G.

El hueco de la imagen se reserva con proporción 4:3 y la foto se ajusta adentro
con `object-contain`, así que no hace falta que venga recortada: no se deforma
ni causa saltos de maquetación.

### Cuánto tarda en aparecer

El panel relee el directorio **cada 60 segundos**. Una foto recién copiada
aparece dentro del minuto siguiente, sin reiniciar nada.

### Dónde queda el directorio en producción

`public/` es una convención de Astro que sólo existe en el árbol de fuentes: al
compilar, su contenido se copia a `dist/client/`, y la imagen de Docker se lleva
`dist/` sin el `public/` original. El panel busca el directorio así:

1. `FOTOS_EQUIPOS_DIR`, si está definida.
2. `./dist/client/equipos` cuando corre compilado.
3. `./public/equipos` en desarrollo.

O sea que hay dos caminos:

- **Recompilar la imagen** con las fotos adentro. Es lo simple, y es lo que
  corresponde si las fotos son estables.
- **Montar un volumen** y apuntar `FOTOS_EQUIPOS_DIR` ahí. Es lo que sirve para
  agregar fotos sin volver a construir nada.

---

## 🔴 Derechos de autor — leer antes de copiar un archivo

**Este repositorio es público**: `github.com/programadores-obreros/dudepanel`.

Las fotos de producto de MikroTik, Ubiquiti, TP-Link y Cambium **son obra de
esos fabricantes y tienen derechos de autor**. Que estén publicadas en su sitio
no las hace libres: están publicadas para que las use quien vende sus productos,
bajo las condiciones que cada uno pone. Subirlas a un repositorio público de
GitHub las **redistribuye**, que es otra cosa distinta de usarlas — y encima el
historial de git no se borra: se reescribe, que es un dolor.

Por eso **`web/public/equipos/` está en `.gitignore`**. Las fotos viven en el
servidor y en el respaldo del servidor, nunca en el repositorio. La única
excepción del filtro es el `LEEME.md` que está adentro del directorio, para que
el directorio exista en el repo y quien lo abra entienda por qué está vacío.

### De dónde SÍ se pueden sacar

En orden de menos a más fricción:

1. **Fotos propias.** El técnico que va al sitio saca la foto con el celular.
   Cero problema legal, y encima muestra el equipo **como está instalado de
   verdad** —con su caja, su mástil y su cableado—, que para el que va a ir es
   más útil que la foto de estudio. Para éstas conviene
   `dispositivo-<id>.webp`.
2. **El banco de imágenes de partner de cada fabricante.** MikroTik, Ubiquiti y
   TP-Link tienen áreas para revendedores y partners donde publican material de
   producto para uso comercial, con sus condiciones escritas. El ISP ya es
   cliente de estas marcas: el acceso se pide con la cuenta de revendedor, al
   contacto comercial de siempre. **Ese es el camino correcto**, porque deja por
   escrito bajo qué permiso se están usando.
3. **La ficha técnica que manda el distribuidor.** Suele traer las imágenes y
   suele venir con permiso explícito de usarlas para vender el producto.

### De dónde NO

- **De Google Imágenes.** No dice quién es el autor ni bajo qué licencia está,
  y la mitad de los resultados son de otras tiendas que a su vez las tomaron de
  algún lado.
- **De la web del fabricante con clic derecho → Guardar imagen**, para después
  commitearla. Es exactamente lo que este documento viene a evitar.

Si aparece una imagen en el repositorio y nadie sabe de dónde salió, se saca.
La regla es la misma que rige el resto del proyecto: **si no se puede respaldar,
no se afirma.**

---

## Dónde está el código

| | |
|---|---|
| `web/src/lib/foto-equipo.ts` | la decisión: qué imagen, de dónde y por qué |
| `web/src/components/FotoEquipo.astro` | el dibujo. Sin una línea de JavaScript |
| `web/test/foto-equipo.test.ts` | las pruebas |

El componente no lleva script **a propósito**. La CSP del panel es
`default-src 'none'` con `script-src 'self' <hash>`, y un script en línea lo
bloquea el navegador **en silencio**: la página compila, se sirve, se ve bien y
no hace nada. Ya pasó acá con la página de cierre de sesión. Ver
`web/src/lib/cabeceras.ts`.
