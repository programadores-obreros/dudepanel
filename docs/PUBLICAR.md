# Publicar una versión

Cómo pasar de un commit en `main` a dos imágenes en el registro con su digest
fijado. Es la mitad que va **antes** de «Actualizar a una versión nueva» en
[`PRODUCCION.md`](PRODUCCION.md).

> **Los valores concretos —dirección, puerto de SSH, usuario— van en el runbook
> interno de cada instalación, no acá.** Este documento es público. Se usan
> marcadores: `<SERVIDOR>`, `<PUERTO_SSH>`, `<USUARIO>`.

---

## 🔴 Por qué existe este documento

`PRODUCCION.md` decía, y sigue diciendo, cómo actualizar: cambiar
`PANEL_VERSION`, `dp pull`, `dp up -d`. **Faltaba de dónde salía la imagen con
ese commit** — y sin ese paso los otros tres no pueden funcionar.

`compose.prod.yml` no fija las imágenes por etiqueta sino por **etiqueta más
digest**:

```yaml
image: ghcr.io/programadores-obreros/dudepanel-web:${PANEL_VERSION}@${WEB_DIGEST}
```

Así que cambiar `PANEL_VERSION` sin cambiar `WEB_DIGEST` produce una referencia
que no existe, y `dp pull` falla. El fallo es limpio —no despliega nada— pero
deja a quien actualiza mirando un error que no explica qué le falta.

**Y hay una trampa peor, que es la que motivó escribir esto:**

```bash
docker compose -f compose.prod.yml build web
# → warning: No services to build
```

`compose.prod.yml` **no tiene sección `build:`**, sólo `image:`. El comando que
uno escribe por reflejo no falla: avisa en una línea de *warning* y devuelve 0.
Es fácil leerlo como «ya estaba construido» y dar por desplegado algo que no se
construyó nunca.

---

## El recorrido completo

```
commit en main
      │
      ├─→ git push origin main          ← el árbol, para Caddyfile y schema.sql
      │
      ▼
  en la VM:  git pull
      │
      ├─→ docker build      dos imágenes etiquetadas con el commit corto
      ├─→ verificar ADENTRO de la imagen        ← el paso que no se saltea
      ├─→ docker push       a GHCR
      │
      ▼
  deploy/digests.sh <commit> --aplicar          ← lee los digests DEL REGISTRO
      │
      ▼
  dp pull  →  dp up -d  →  verificar adentro del contenedor que corre
```

**Las imágenes se construyen en la VM, no en la máquina de quien desarrolla.**
No es una decisión de arquitectura: es lo que hay. Ahí está la sesión de GHCR y
ahí es amd64 seguro. Si algún día se hace en otro lado, hay que fijar
`--platform linux/amd64` explícitamente.

---

## 1 · Empujar el árbol

```bash
git push origin main
```

El árbol hace falta en la VM aunque las imágenes vengan del registro:
`Caddyfile` y `etl/schema.sql` **se montan desde el disco**, no viajan dentro de
la imagen.

---

## 2 · En la VM: traer el commit

```bash
ssh -p <PUERTO_SSH> <USUARIO>@<SERVIDOR>
cd /opt/dudepanel
sudo git pull --ff-only
sudo git log --oneline -1        # anotar el commit corto: es la versión
```

> ⚠️ **Todo va con `sudo`.** El repositorio es `root:root 755`, y sin `sudo` git
> contesta `detected dubious ownership`, que se lee como un problema de
> seguridad de git y en realidad es sólo el dueño del directorio.

---

## 3 · Construir

```bash
V=$(sudo git -C /opt/dudepanel rev-parse --short HEAD)
REPO=ghcr.io/programadores-obreros
cd /opt/dudepanel

sudo docker build --no-cache -t $REPO/dudepanel-web:$V -f web/Dockerfile web
sudo docker build --no-cache -t $REPO/dudepanel-etl:$V -f etl/Dockerfile etl
```

### 🔴 `--no-cache` no es paranoia

El constructor legacy de Docker devolvió, en este proyecto, **una imagen sin el
cambio adentro** — y el `build` terminó en `Successfully built`. Se dio por
desplegado un arreglo que no estaba. Se descubrió recién al hacer `grep` dentro
del contenedor que ya estaba corriendo en producción.

Un `build` exitoso dice que el Dockerfile corrió, **no** que tu cambio esté
adentro. Son dos afirmaciones distintas y sólo la segunda importa.

### Si sólo cambió uno de los dos

Igual hacen falta las **dos** etiquetas: `PANEL_VERSION` es una sola variable y
etiqueta a `web` y a `etl` por igual. Si `etl/` no cambió, se reetiqueta el
contenido que ya está en vez de reconstruirlo:

```bash
# Desde la referencia POR DIGEST de la versión anterior, no por etiqueta:
# es la única forma de estar seguro de qué contenido se está reetiquetando.
ANT=$(grep '^ETL_DIGEST=' .env.prod | cut -d= -f2)
VIEJA=$(grep '^PANEL_VERSION=' .env.prod | cut -d= -f2)
sudo docker tag $REPO/dudepanel-etl:$VIEJA@$ANT $REPO/dudepanel-etl:$V
```

Mismo contenido ⇒ mismo digest de manifiesto. Cuando `digests.sh` lo lea del
registro va a devolver exactamente el `ETL_DIGEST` anterior, y eso **es la
comprobación de que se reetiquetó lo que se creía**, no una casualidad.

Para saber si hace falta reconstruir:

```bash
sudo git diff --name-only <commit anterior>..HEAD -- etl/ | head
# vacío = el ETL no cambió
```

---

## 4 · Verificar ADENTRO de la imagen, antes de publicar

**Este es el paso que no se saltea.** Publicar es lo primero difícil de deshacer
del procedimiento: a partir de acá la imagen existe en el registro con un
nombre que alguien puede bajar.

```bash
sudo docker run --rm --entrypoint sh $REPO/dudepanel-web:$V -c \
  'grep -rl "<algo del cambio>" /app/dist/ | head'
```

Buscá una cadena que **sólo exista si tu cambio entró**: un texto nuevo de la
interfaz, el nombre de una función nueva, una regla de CSS. Y si el cambio fue
*borrar* algo, comprobá que el resto **ya no está** — que dé `0`.

> El bundle está minificado: `detail === 0` en el fuente es `detail===0` en el
> paquete. Buscar la forma con espacios da cero coincidencias y parece que el
> cambio no entró. Buscá la forma minificada, o algo que el minificador no toque
> (texto visible, nombres de clases CSS, atributos `data-`).

Para el ETL, que es Python sin minificar:

```bash
sudo docker run --rm --entrypoint sh $REPO/dudepanel-etl:$V -c \
  'grep -c "<algo del cambio>" /app/sync.py'
```

---

## 5 · Publicar

```bash
sudo docker push $REPO/dudepanel-web:$V
sudo docker push $REPO/dudepanel-etl:$V
```

Si contesta `denied` o `unauthorized`, falta la sesión:

```bash
sudo docker login ghcr.io -u <usuario de GitHub>
# la contraseña es un token con permiso `write:packages`
```

> 🔴 **El token no va en este repositorio ni en ningún archivo del despliegue.**
> Va al gestor de contraseñas. Un token con `write:packages` puede reemplazar
> el contenido de cualquier imagen del panel — o sea, es exactamente la llave
> del canal que todo este procedimiento existe para asegurar.

> ⚠️ **El digest que informa `docker push` NO es el que va en `.env.prod`.**
> `push` informa el digest del **índice multiarquitectura**; `digests.sh` fija
> el del manifiesto **amd64**, que es más estricto. Que sean distintos es lo
> esperado. No los copies del `push`: el paso siguiente los lee del registro
> justamente para que nadie los copie a mano.

---

## 6 · Fijar los digests

```bash
cd /opt/dudepanel
sudo sed -i "s|^PANEL_VERSION=.*|PANEL_VERSION=$V|" .env.prod
sudo ./deploy/digests.sh $V --aplicar
```

El script deja una copia en `.env.prod.bak` antes de tocar nada — ese archivo
tiene la contraseña de Postgres.

Tiene que imprimir las cuatro líneas y terminar en `✅ escrito`:

```
WEB_DIGEST=sha256:…
ETL_DIGEST=sha256:…
POSTGRES_DIGEST=sha256:…
CADDY_DIGEST=sha256:…
```

### Si se corta a la mitad

```
🔴 no pude leer el digest de caddy:2.11-alpine — ¿existe en el registro?
```

El script corre con `set -e`, así que **no escribe nada** si falla en cualquiera
de las cuatro. Eso deja `.env.prod` con la versión nueva y los digests viejos:
una combinación que hace **fallar el `pull`** en vez de desplegar algo
equivocado. Es el fallo que uno quiere.

Visto en la práctica, la causa fue transitoria —una lectura fallida contra
Docker Hub— y bastó reintentar. Antes de investigar, reintentá:

```bash
sudo ./deploy/digests.sh $V --aplicar
```

Si insiste, comprobá que el manifiesto se lee a mano:

```bash
sudo docker manifest inspect caddy:2.11-alpine | head -3
```

---

## 7 · Desplegar y verificar en el contenedor que corre

De acá en adelante sigue [`PRODUCCION.md`](PRODUCCION.md#actualizar-a-una-versión-nueva),
con una última comprobación que cierra el círculo:

```bash
alias dp='sudo docker compose -f /opt/dudepanel/compose.prod.yml --env-file /opt/dudepanel/.env.prod'

dp pull            # ANTES de tocar lo que está andando
dp up -d
dp ps              # los seis en healthy

# Y el cierre: lo mismo del paso 4, pero contra el contenedor VIVO.
sudo docker inspect dudepanel-web-1 --format '{{.Config.Image}}'
sudo docker exec dudepanel-web-1 sh -c 'grep -rl "<algo del cambio>" /app/dist/ | head'
```

**Verificar la imagen y verificar el contenedor no son lo mismo.** Entre las dos
cosas pasan un `push`, un `pull`, una resolución de digest y una recreación de
contenedor. Cada uno de esos pasos puede dejarte corriendo algo distinto de lo
que construiste, y el único que lo desmiente es el último.

---

## Retirar una versión

No hay que hacer nada. Las imágenes viejas quedan en el registro y en el disco
de la VM, y eso **es el rollback**: `PRODUCCION.md` lo resuelve cambiando un
número, pero sólo funciona si la imagen anterior sigue existiendo.

Antes de borrar imágenes viejas del disco de la VM —`docker image prune`—
comprobá que la versión anterior a la actual sigue estando. Es la que te va a
hacer falta apurado.

```bash
sudo docker images $REPO/dudepanel-web --format '{{.Tag}}\t{{.CreatedSince}}'
```
