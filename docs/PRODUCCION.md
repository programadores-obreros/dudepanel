# Producción — el panel publicado en internet

Cómo poner el panel detrás de un nombre de dominio, con certificado válido y
contraseña, usando imágenes ya construidas.

> **Los valores concretos —dominio, dirección, puerto de SSH, usuario, rangos de
> la red de gestión— van en el runbook interno de cada instalación, no acá.**
> Este documento es público. Un repositorio con host, puerto y usuario es un
> mapa de dónde pegar. Se usan marcadores: `<DOMINIO>`, `<SERVIDOR>`,
> `<USUARIO>`, `<PUERTO_SSH>`, `<RANGO_DE_GESTION>`.

Para el despliegue local, por túnel SSH y sin proxy, seguí `DESPLIEGUE.md`.
Este documento es el otro caso: el panel expuesto.

---

## 🔴 Antes de nada: qué se está publicando

El panel **no tiene autenticación propia**. Ninguna. No hay sesión, no hay
login, no hay usuarios en la base: cualquiera que le llegue por HTTP ve todo.

Y todo es:

- **885 equipos** con sus direcciones IP.
- La **topología completa de un ISP**: quién cuelga de quién, 1.171 enlaces.
- **Qué está caído en este momento**, y desde cuándo.

Eso no es un tablero de métricas. Es un plano de la red y una lista de blancos
en vivo, con los que están débiles señalados en rojo.

**La autenticación de Caddy es la única barrera de aplicación.** Si se rompe, se
saca, o alguien la puentea publicando el `4321` "un ratito para probar", no hay
una segunda línea. Por eso este despliegue no tiene ninguna otra forma de llegar
al panel, y por eso hay que resistir la tentación de agregarle una.

Lo que **sí** hay, y hay que mantener, es defensa en profundidad *alrededor*:

| capa | qué frena | estado |
|---|---|---|
| Filtro por origen en `ufw` | Que el mundo siquiera vea el puerto | **Preparado, no activo.** Ver más abajo |
| TLS de Let's Encrypt | Escucha pasiva y suplantación | Activo |
| Usuario y contraseña en Caddy | Acceso anónimo | Activo |
| Panel sin puerto publicado | Que se lo esquive por un túnel | Activo |
| Red `interna` sin salida | Que la base o el ETL llamen a casa | Activo |
| Panel sin credenciales de los equipos | Que un fallo del panel entregue los routers | Por diseño del ETL |

### Un puerto abierto es una puerta

En este mismo despliegue, hace poco, se encendió el servidor web propio de The
Dude para usarlo como oráculo de verificación. Su login de 2011 —con el
certificado de ejemplo de MikroTik de 2005 y **TLSv1**— quedó atendiendo desde
internet, porque el 443 ya estaba abierto en el cortafuegos «sin nada detrás».

**Poner un servicio detrás de un puerto abierto lo convierte en una puerta.** Un
puerto abierto sin servicio es inofensivo hasta el segundo en que deja de estarlo,
y ese segundo no avisa.

Y el error de método fue peor que el descuido: **se verificó que el cortafuegos
bloqueaba el 8081 y se concluyó que también bloqueaba el 443.** Comprobar un
puerto no dice nada sobre otro. Cada puerto se verifica solo, uno por uno, y
**desde afuera de la red del ISP** — un escaneo desde la oficina entra por la
red de gestión y da resultados tranquilizadores que son mentira.

---

## Lo que hace falta antes de empezar

- [ ] **DNS**: `<DOMINIO>` resolviendo a la IP pública de la VM. Verificar con
      `dig +short <DOMINIO>` **desde afuera**, no desde la VM.
- [ ] **Puertos 80 y 443 alcanzables desde internet.** Los dos. El 80 no es
      opcional aunque todo se sirva por 443: es por donde entra el desafío
      HTTP-01 de Let's Encrypt. Cerrarlo "porque redirige nomás" rompe la
      renovación y se nota a los 60 días, no hoy.
- [ ] **`/srv/thedude/data` en un sistema de archivos local**, con `dude.db` y
      `files/` adentro. `stat -f -c %T <ruta>` tiene que decir `ext2/ext3`,
      `ext4`, `xfs` o `btrfs`. Nunca NFS, CIFS ni virtiofs.
- [ ] **Docker con Compose v2** (`docker compose version`).
- [ ] **Los hashes de las contraseñas ya generados** y las contraseñas en claro
      repartidas por un canal que no sea este repositorio.
- [ ] **~350 MB de RAM libres.** Medido en reposo: Postgres 199 MB, ETL 55 MB,
      panel 22 MB, Caddy 14 MB.

---

## Puesta en marcha

```bash
ssh -p <PUERTO_SSH> <USUARIO>@<SERVIDOR>

sudo mkdir -p /opt/dudepanel && cd /opt/dudepanel
sudo git clone https://github.com/programadores-obreros/dudepanel.git .

sudo cp .env.prod.example .env.prod
sudo $EDITOR .env.prod
```

En `.env.prod` van cinco cosas obligatorias. Si falta alguna, Compose **no
arranca** y dice cuál: todas están declaradas con `:?` a propósito, porque un
valor vacío que se toma por bueno falla más tarde y peor.

```ini
PANEL_VERSION=<commit corto de la imagen>
PANEL_DOMINIO=<DOMINIO>
ACME_EMAIL=<casilla que alguien lea>
POSTGRES_PASSWORD=<openssl rand -hex 24>
DUDE_DATA=/srv/thedude/data
```

### 🔴 Y una sexta que no falla ruidosamente: el permiso de lectura

The Dude corre como root y deja su base en `600 root:root`. El ETL corre como
`dude`, uid 10001. **No la puede abrir.**

Y esto no se ve como un error: Compose levanta los cuatro servicios, Caddy
consigue el certificado, el sitio contesta 200 con la contraseña — y muestra
**cero equipos**. El único rastro está en `docker logs dudepanel-etl-1`:
`PermissionError: [Errno 13] Permission denied: '/origen/dude.db'`, reiniciando
cada 30 segundos para siempre.

**Un panel vacío no se lee como un fallo. Se lee como una red sin equipos.**

Hay que crear el grupo **antes** de levantar nada:

```bash
sudo groupadd -g 3000 dudepanel                       # sin miembros humanos
sudo chgrp dudepanel /srv/thedude/data /srv/thedude/data/dude.db*
sudo chmod 750 /srv/thedude/data
sudo chmod 640 /srv/thedude/data/dude.db*
```

Y en `.env.prod`:

```ini
DUDE_GID=3000
```

> **Por qué así y no de la forma fácil.** `chmod 644 dude.db` resuelve el
> síntoma y publica, para cualquiera que tenga una cuenta en la máquina, el
> usuario y la contraseña de acceso a **todos los routers del ISP** — The Dude
> los guarda en claro porque tiene que presentarlos. Y `user: root` en el ETL
> tira `cap_drop: ALL` a la basura por un permiso de lectura.
>
> El grupo concede exactamente lo que hace falta: **un** proceso, **un** archivo,
> **lectura**. Nadie más lo lleva puesto.

> ⚠️ El `dude.db*` con comodín incluye el `dude.db-journal`. The Dude corre con
> `journal_mode=PERSIST`, así que ese archivo **está siempre**, y SQLite le
> copia los permisos de la base cuando lo recrea. Dejarlo afuera funciona hasta
> el día que no.

> 🔴 **`openssl rand -hex`, nunca `-base64`.** Base64 produce `/` y `+`, y la
> contraseña se interpola cruda en `DATABASE_URL`. Una barra **termina la
> sección de autoridad de la URI** y el arranque falla con
> `failed to resolve host 'dude'` — un mensaje que apunta a DNS y no tiene nada
> que ver. Con 32 caracteres base64 la probabilidad de que salga al menos un
> carácter problemático es del **64 %**: dos de cada tres despliegues.

Y arriba:

```bash
sudo docker compose -f compose.prod.yml --env-file .env.prod up -d
sudo docker compose -f compose.prod.yml --env-file .env.prod ps
```

Los cuatro tienen que llegar a `healthy`. Caddy pide el certificado en el
arranque: mirarlo mientras pasa.

```bash
sudo docker compose -f compose.prod.yml logs -f caddy
```

Buscar `certificate obtained successfully`. Si en cambio aparece
`could not get certificate from issuer`, el problema es DNS o el puerto 80 —
ver la tabla de fallos al final.

> ⚠️ **Escribir el comando completo cada vez es un incordio y lleva a errores.**
> Conviene un alias en la sesión de operación:
> ```bash
> alias dp='sudo docker compose -f /opt/dudepanel/compose.prod.yml --env-file /opt/dudepanel/.env.prod'
> ```
> De acá en adelante este documento escribe `dp` por eso.

---

## Verificación — en este orden

El orden importa. Lo primero no es "¿anda el panel?" sino "¿rompí producción?".

### 1 · ¿La base de The Dude sigue intacta?

```bash
sudo sqlite3 /srv/thedude/data/dude.db "PRAGMA user_version; SELECT count(*) FROM objs;"
```

Tiene que dar `1` y unos 14.900. **Si `user_version` no es 1, parar todo**: The
Dude lee ese número para saber si la base tiene esquema, y con `0` concluye que
está vacía y le escribe 152 objetos por defecto encima.

### 2 · ¿El ETL sincronizó?

```bash
dp exec db psql -U dude -tAc \
  "SELECT started_at, ok, devices, services, maps, map_elements, duration_ms
   FROM sync_runs ORDER BY id DESC LIMIT 3;"
```

Referencia de la instalación real: **885 dispositivos · 859 servicios ·
40 mapas · 2.317 elementos**.

### 3 · 🔴 ¿Se filtró alguna credencial?

No es opcional. Es la garantía central del proyecto y se comprueba, no se
confía.

```bash
dp run --rm \
  -e TEST_DATABASE_URL="postgresql://dude:$POSTGRES_PASSWORD@db:5432/dude" \
  etl python -m pytest test_sync.py -q -k credencial
```

Ese test **primero comprueba que el origen SÍ tiene secretos** —si no, pasaría
por vacío sin probar nada— y recién después verifica que ninguno llegó.

### 4 · ¿Sin credenciales queda afuera?

**Desde una máquina que no sea la VM**, y ojalá desde afuera de la red del ISP:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMINIO>/
# → 401

curl -s -o /dev/null -w '%{http_code}\n' https://<DOMINIO>/api/estado.json
# → 401
```

**Los dos tienen que dar 401.** Un panel donde el HTML pide contraseña y el JSON
no, no pide contraseña — y `/api/estado.json` devuelve el resumen de la red
entera.

### 5 · ¿Con credenciales entra?

```bash
curl -s -o /dev/null -w '%{http_code}\n' -u '<usuario>' https://<DOMINIO>/
# → 200
```

> **La primera petición después de reiniciar Caddy tarda ~0,7 s.** Medido. No es
> un problema de red: es bcrypt con coste 14 verificando la contraseña. Caddy
> guarda en memoria las verificaciones exitosas, así que a partir de la segunda
> baja a ~17 ms. Ese medio segundo es a propósito — es el mismo medio segundo
> que paga quien intente adivinar.

### 6 · ¿El panel quedó realmente cerrado por abajo?

```bash
# El contenedor no debe publicar NADA.
dp ps --format '{{.Service}} {{.Ports}}'
#   caddy   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
#   web     4321/tcp          ← "expuesto", NO publicado. Sin `->` no hay host.
#   db      5432/tcp
#   etl

# Y nada escuchando en el 4321 del anfitrión:
sudo ss -ltnp | grep ':4321' || echo 'nadie ✅'
```

> ⚠️ Desde el propio anfitrión sí se le puede pegar al contenedor por su IP de
> la red bridge (`http://172.x.x.x:4321/`). **Eso es normal y no es una fuga**:
> no hay regla de NAT ni ruta que lo alcance desde afuera de la VM. Pero
> significa que **cualquiera con una sesión en la VM ve el panel sin
> contraseña**, así que el acceso SSH a la VM es parte del perímetro. No es un
> detalle: es la razón por la que la lista de pendientes incluye cerrar la
> autenticación por contraseña en SSH.

### 7 · ¿El certificado y las cabeceras?

```bash
curl -sI -u '<usuario>' https://<DOMINIO>/ | grep -iE 'strict-transport|x-content-type|referrer-policy|x-frame|content-security'
```

Tienen que estar las cinco. Y **el `content-security-policy` tiene que traer un
`sha256-...` adentro**: ése es el hash del script del tema. Si en algún momento
aparece un CSP sin ese hash, alguien puso uno en Caddy — sacarlo, ver la sección
siguiente.

```bash
# Y que el 80 redirija:
curl -sI http://<DOMINIO>/ | head -2
# → HTTP/1.1 308 Permanent Redirect
```

---

## 🔴 El CSP no se toca desde Caddy

La aplicación ya emite un `Content-Security-Policy` estricto, y **lleva adentro
el hash sha256 del script en línea que aplica el tema claro/oscuro antes del
primer pintado**.

Poner un CSP en Caddy —aunque sea "el mismo", copiado— lo pisa. Y como el hash
cambia con cada cambio de ese script, o sea con cada despliegue, la copia se
desincroniza sola.

**El síntoma no es un error.** Es un parpadeo blanco en cada carga de página. Se
ve como un problema de CSS, se busca en el CSS, y no está en el CSS.

Lo mismo vale para `Cross-Origin-*` y `Permissions-Policy`: ya vienen de la app.

Las cabeceras que Caddy **sí** pone son las que la app no puede o no cubre:

- **`Strict-Transport-Security`**: sólo la puede poner quien termina el TLS.
- **`X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`**, y con el
  prefijo `?`, que en Caddy significa *«poné esto sólo si la respuesta no lo
  trae ya»*. Sin ese `?`, Caddy pisaría las de la app.

Ese `?` no es cosmético. Los estáticos de `/_astro/*` los sirve el manejador
estático de Astro **antes** del middleware, así que salen sin ninguna cabecera
de seguridad: medido, un `.css` de 42 kB llegaba pelado. El `?` los cubre sin
tocar lo que la app ya define.

---

## Compresión: por qué Caddy también comprime

Parecía trabajo duplicado. Se midió, y no lo es.

| recurso | sin comprimir | por Caddy | quién comprime |
|---|---:|---:|---|
| `/` (portada) | 39.825 B | 6.335 B | **la app** (Caddy la deja pasar) |
| `/api/estado.json` | 2.333 B | 617 B | **la app** |
| `/_astro/*.css` | 42.092 B | 9.047 B | **Caddy** |
| `/_astro/*.js` | 2.250 B | 1.061 B | **Caddy** |

Las respuestas dinámicas ya salen comprimidas del middleware de la app; Caddy ve
el `Content-Encoding` puesto y no las toca. Los estáticos **no pasan por ese
middleware** y salían crudos: ahí es donde `encode` gana los 33 kB del CSS.

No duplica lo que la app hace, cubre lo que la app no alcanza.

> ⚠️ **`br` no va en la lista de `encode`.** La compilación estándar de Caddy
> sabe *leer* brotli pero no sabe *escribirlo*: el codificador se sacó y vive en
> un complemento externo. Ponerlo hace que Caddy **ni siquiera arranque**
> (`module not registered: http.encoders.br`) y el conjunto entero se queda sin
> puerta.

### Y lo que cuesta el proxy

Medido con 10 peticiones de cada tipo, desde dentro de la misma red de Docker,
comparando el panel directo contra el panel a través de TLS + contraseña +
compresión + `reverse_proxy`:

| recurso | directo | por Caddy | costo |
|---|---:|---:|---:|
| `/` | 16,5 ms | 18,9 ms | **+2,4 ms** |
| `/api/estado.json` | 7,0 ms | 10,1 ms | **+3,1 ms** |
| `/_astro/*.css` | 0,8 ms | 4,4 ms | **+3,6 ms** |

Tres milisegundos por petición, contra 33 kB menos por carga fría. En el 4G de
un celular a las tres de la mañana esa cuenta no está ni cerca de ser pareja.

---

## Actualizar a una versión nueva

El despliegue está atado a un **commit**, no a `latest`. Eso vuelve el
procedimiento aburrido, que es exactamente lo que se busca.

> ### 🔴 Antes: la imagen de ese commit tiene que existir
>
> Acá faltaba un paso, y sin él los de abajo no pueden funcionar. Las imágenes
> **no se construyen solas**: no hay integración continua, y
> `compose.prod.yml` no tiene sección `build:` —un
> `docker compose build web` contesta `No services to build` y devuelve 0, que
> es fácil de leer como «ya estaba construido»—.
>
> Hay que **construirlas en la VM, verificarlas por dentro y publicarlas en
> GHCR** antes de tocar `PANEL_VERSION`. Ese procedimiento está en
> [`PUBLICAR.md`](PUBLICAR.md).
>
> Si venís de ahí, `PANEL_VERSION` y los cuatro digests **ya quedaron
> escritos** por `deploy/digests.sh --aplicar` y podés saltear el paso 3.

```bash
# 1 · ANOTAR QUÉ ESTÁ CORRIENDO. Este es el paso que se saltea y se extraña.
dp images
grep PANEL_VERSION /opt/dudepanel/.env.prod
```

Guardá ese valor donde lo vayas a encontrar apurado. No en la terminal.

```bash
# 2 · Actualizar el árbol (para `Caddyfile` y `etl/schema.sql`, que se montan)
cd /opt/dudepanel && sudo git pull

# 3 · Cambiar la versión Y LOS DIGESTS. Los dos: la imagen está fijada por
#     `etiqueta@digest`, así que mover sólo la etiqueta da una referencia que
#     no existe y `dp pull` falla.
sudo sed -i 's/^PANEL_VERSION=.*/PANEL_VERSION=<commit nuevo>/' .env.prod
sudo ./deploy/digests.sh <commit nuevo> --aplicar

# 4 · Bajar las imágenes ANTES de tocar nada que esté andando
dp pull

# 5 · Recrear
dp up -d

# 6 · Comprobar que lo que corre es lo que construiste. No es lo mismo que el
#     paso 5 haya salido bien: entre la imagen y el contenedor pasan un push,
#     un pull, una resolución de digest y una recreación.
sudo docker inspect dudepanel-web-1 --format '{{.Config.Image}}'
sudo docker exec dudepanel-web-1 sh -c 'grep -rl "<algo del cambio>" /app/dist/ | head'
```

`dp pull` como paso separado no es ceremonia: si la imagen no existe o GHCR está
caído, te enterás **antes** de haber apagado el panel, no en el medio.

Después, la verificación completa. Toda. Especialmente el punto 3 —el test de
credenciales— porque una versión nueva del ETL es exactamente el cambio que
podría empezar a copiar campos que antes omitía.

---

## Rollback

Es cambiar un número.

```bash
sudo sed -i 's/^PANEL_VERSION=.*/PANEL_VERSION=<el commit anterior>/' /opt/dudepanel/.env.prod
dp up -d
```

Un minuto, y sin sorpresas, **siempre que el esquema de Postgres no haya
cambiado**.

> 🔴 **Si la versión nueva traía migración de esquema, el rollback de la imagen
> no alcanza.** `etl/schema.sql` sólo se aplica cuando el volumen `db-data` está
> vacío: la base ya migrada se queda migrada, y el ETL viejo se va a encontrar
> con columnas que no conoce.
>
> En ese caso el camino es distinto y hay que aceptar perder la historia
> acumulada, o restaurar un `pg_dump` previo:
>
> ```bash
> dp down                       # SIN -v
> sudo docker volume rm dudepanel_db-data
> sudo git checkout <commit anterior> -- etl/schema.sql
> dp up -d                      # la base se rearma y el ETL la repuebla
> ```
>
> El ETL reconstruye todo desde `dude.db` en una corrida — **salvo la historia
> acumulada** después de que se empiece a podar la base de The Dude. En cuanto
> se empiece a podar, `pg_dump` deja de ser conveniencia y pasa a ser el único
> lugar donde vive el pasado. Antes de cualquier actualización con migración:
>
> ```bash
> dp exec -T db pg_dump -U dude dude | gzip > /var/backups/panel-$(date +%F).sql.gz
> ```

---

## Rotar una contraseña

Se hace **sin tocar la contraseña en claro en ningún archivo**. Sólo el hash
llega al repositorio.

```bash
# 1 · Generar el hash. Pide la contraseña por teclado y no la deja en el
#     historial del shell — por eso no se usa `--plaintext`.
sudo docker run --rm -it caddy:2.11-alpine caddy hash-password
#   Enter password:
#   Confirm password:
#   $2a$14$........
```

> Sin banderas, esa versión de Caddy usa **bcrypt con coste 14**, que es
> exactamente lo que tienen los hashes que ya están en el `Caddyfile`. Si algún
> día cambia el default —el `--help` ya empuja hacia argon2id— hay que pedirlo
> a mano: `--algorithm bcrypt --bcrypt-cost 14`. Los dos formatos conviven en el
> mismo bloque, así que mezclarlos funciona; pero conviene que todos digan lo
> mismo para que se pueda comparar de un vistazo.

```bash
# 2 · Reemplazar la línea de esa persona en el `Caddyfile`
sudo $EDITOR /opt/dudepanel/Caddyfile
```

```bash
# 3 · Aplicar. Recrea sólo Caddy; el panel y la base no se enteran.
dp up -d caddy
```

```bash
# 4 · Verificar las DOS cosas: que la nueva entra y que la vieja NO.
curl -s -o /dev/null -w 'nueva: %{http_code}\n' -u '<usuario>' https://<DOMINIO>/
curl -s -o /dev/null -w 'vieja: %{http_code}\n' -u '<usuario>:<la anterior>' https://<DOMINIO>/
# → nueva: 200   ·   vieja: 401
```

**El paso 4 no se saltea.** Rotar y no comprobar que la vieja murió es no haber
rotado: es haber agregado una.

### Dar de baja a alguien

Borrar su línea del bloque `basic_auth` y `dp up -d caddy`. Verificar con un 401
usando sus credenciales, igual que arriba.

### ¿Y los hashes en un repositorio público?

Son bcrypt con **coste 14**: ~0,7 s por intento, medido en esta misma máquina.
Un ataque fuera de línea contra ese coste es caro, no imposible — la seguridad
real la da la contraseña, no el hash. **Que sean largas y generadas, no
elegidas.** Si en algún momento se prefiere sacarlos del repositorio, la salida
es reemplazar cada hash por `{$PANEL_HASH_<QUIEN>}` en el `Caddyfile` y ponerlos
en `.env.prod`, que no se versiona.

---

## Defensa en profundidad: filtrar por origen

Todo lo de arriba deja el panel accesible **desde cualquier lugar del mundo**,
protegido sólo por usuario y contraseña. Funciona, y es un solo secreto entre el
plano de la red y quien lo quiera.

Si el panel no necesita llegar desde cualquier lado —y casi nunca lo necesita—
se le suma una capa que no depende de ningún secreto: **de dónde venís**.

> **Esto NO está activo.** Va acá documentado y decidido, para que activarlo sea
> una tarde tranquila y no una improvisación durante un incidente.

```bash
# ── Filtro por origen. Copiar, reemplazar los marcadores, y leer el aviso. ──

# 1 · Primero las reglas que DEJAN pasar. Siempre antes del deny, siempre.
sudo ufw allow from <RANGO_DE_LA_OFICINA>   to any port 80,443 proto tcp comment 'panel · oficina'
sudo ufw allow from <RANGO_DE_GESTION>      to any port 80,443 proto tcp comment 'panel · gestión'

# 2 · Y recién después, el que las bloquea al resto.
sudo ufw deny 80,443/tcp comment 'panel · sólo por origen'

sudo ufw status numbered
```

> 🔴 **El orden no es estilo, es la diferencia entre andar y no andar.** `ufw`
> evalúa de arriba hacia abajo y se queda con la primera coincidencia. Un `deny`
> por encima de los `allow` te deja afuera a vos también — y si estabas
> administrando por la web, te acabás de cerrar la puerta desde adentro.
>
> 🔴 **Y esto rompe Let's Encrypt.** El desafío HTTP-01 lo hace un servidor de
> Let's Encrypt, desde una IP que no se puede predecir ni listar. Con el 80
> filtrado por origen, **la renovación falla en silencio** y el certificado se
> vence a los 60 días.
>
> Las dos salidas, y hay que elegir una **antes** de aplicar el filtro:
>
> **a)** Dejar el **80 abierto a todos** y filtrar sólo el 443. Caddy en el 80
> únicamente redirige y atiende el desafío: no hay panel ahí. Es la opción
> simple y la recomendada.
>
> ```bash
> sudo ufw allow 80/tcp comment 'ACME + redirección · sin panel detrás'
> sudo ufw allow from <RANGO_DE_LA_OFICINA> to any port 443 proto tcp
> sudo ufw allow from <RANGO_DE_GESTION>    to any port 443 proto tcp
> sudo ufw deny 443/tcp
> ```
>
> **b)** Pasar a **DNS-01**, que valida por un registro TXT y no necesita ningún
> puerto abierto. Requiere una compilación de Caddy con el complemento del
> proveedor de DNS y una credencial de API. Más piezas, pero permite cerrar el
> 80 y el 443 por completo. Sólo vale la pena si hay una razón concreta.

**Y después verificar desde afuera, uno por uno.** No desde la oficina: desde
una conexión que no sea de la red del ISP. Comprobar un puerto no dice nada
sobre otro — ése fue el error que dejó un login de 2011 en internet.

### ⚠️ Docker y `ufw` no se llevan bien

En muchas instalaciones Docker escribe sus propias reglas de NAT y **se saltea
`ufw` para los puertos publicados**. Antes de creer que el filtro está puesto:

```bash
sudo iptables -t nat -S DOCKER | grep -E '443|80'
sudo ufw status verbose
```

Y después la única prueba que vale: **pedirle a alguien de afuera que intente
entrar.** Si el filtro no funciona, el panel está abierto y `ufw status` va a
seguir diciendo que no.

---

## Operación diaria

```bash
dp ps                          # ¿los cuatro healthy?
dp logs -f etl                 # qué está haciendo la sincronización
dp logs -f caddy               # certificados, arranques
dp restart etl                 # forzar una sincronización

# Quién entró, cuándo, y a qué
dp exec caddy tail -f /var/log/caddy/acceso.log | jq -c '{ts,user_id,status,uri:.request.uri}'
```

> El registro de accesos **no guarda credenciales**. Caddy reemplaza la cabecera
> `Authorization` por `REDACTED` antes de escribir — verificado buscando la
> contraseña en claro y su codificación base64 dentro del archivo entero: cero
> coincidencias. Lo que sí guarda es `user_id`, o sea **quién** entró. Eso es lo
> que hace falta cuando algo pasa.
>
> Rota solo: 10 MiB por archivo, 5 archivos, nada más viejo que 90 días.

### Respaldo

```bash
dp exec -T db pg_dump -U dude dude | gzip > /var/backups/panel-$(date +%F).sql.gz
```

Hoy es manual y hay que acordarse. Automatizarlo está pendiente.

### Dar de baja el despliegue

```bash
dp down                        # deja los volúmenes
dp down -v                     # 🔴 BORRA la base Y LOS CERTIFICADOS
```

> 🔴 **`down -v` se lleva puesto `caddy-data`**, donde viven la cuenta de ACME y
> los certificados. Volver a levantar los pide de nuevo, y Let's Encrypt permite
> **5 certificados por dominio cada 7 días**: con cinco arranques en falso el
> sitio se queda sin TLS una semana entera. Si hay que limpiar la base, borrar
> el volumen puntual:
>
> ```bash
> dp down && sudo docker volume rm dudepanel_db-data
> ```

**The Dude no se entera de nada**: nunca se le escribió un byte.

---

## Si algo sale mal

| síntoma | causa probable | qué mirar |
|---|---|---|
| `could not get certificate from issuer` | El DNS no apunta acá, o el 80 no llega | `dig +short <DOMINIO>` desde afuera · `curl -sI http://<DOMINIO>/.well-known/acme-challenge/x` desde afuera |
| `too many certificates already issued` | Se reinició en falso 5 veces | 🔴 Esperar. Son 7 días. No hay atajo. Mientras tanto no borrar `caddy-data` |
| **502** con credenciales correctas | El panel está caído; Caddy está bien | `dp ps` · `dp logs web`. Que Caddy siga en pie es a propósito: sin él no se renueva el certificado |
| **401** con credenciales que eran correctas | El `Caddyfile` cambió y no se recargó, o al revés | `dp exec caddy cat /etc/caddy/Caddyfile` y comparar · `dp up -d caddy` |
| **401** en todo, incluso los estáticos | Es lo esperado | El sitio entero está detrás de la contraseña, a propósito |
| Caddy no arranca: `module not registered: http.encoders.br` | Alguien agregó `br` a `encode` | Sacarlo. La compilación estándar no sabe escribir brotli |
| La página parpadea en blanco al cargar | Alguien puso un CSP en Caddy | `curl -sI ... \| grep content-security` — si no trae `sha256-`, no es el de la app. Sacar el CSP del `Caddyfile` |
| El panel funciona pero se ve sin estilos | El CSS quedó bloqueado por un CSP ajeno | Lo mismo de arriba |
| 🔴 **El sitio anda pero muestra CERO equipos** | El ETL nunca sincronizó | `dp logs etl`. Las dos causas están acá abajo. **Ninguna se ve desde el navegador** |
| `PermissionError: '/origen/dude.db'`, reiniciando | Falta el grupo de lectura | Crear `dudepanel` y poner `DUDE_GID` — ver «el permiso de lectura» arriba |
| `database is locked` cada 30 s, exacto | 🔴 El ETL está leyendo el archivo VIVO | **No es contención**: The Dude toma el lock `EXCLUSIVE` y no lo suelta nunca. El ETL tiene que leer una copia. Comprobar que el volumen `etl-trabajo` esté montado y `DUDE_SNAPSHOT` apunte adentro |
| `OrigenInestable: ... quick_check` | La copia salió cosida de dos instantes | Se descarta sola y reintenta. Constante = disco muy lento o `dude.db` enorme |
| El panel muestra datos viejos | El ETL no corre | `dp logs etl` |
| `user_version` distinto de 1 | 🔴 la base de The Dude está mal | **Parar y restaurar** desde el respaldo de la base |
| Faltan iconos | `files/` no montado | Revisar `DUDE_DATA` en `.env.prod` |
| `required variable ... is missing a value` | Falta algo en `.env.prod` | El mensaje dice cuál. Es a propósito: mejor no arrancar que arrancar mal |
| `failed to resolve host 'dude'` | La contraseña de Postgres tiene `/` o `+` | Regenerarla con `openssl rand -hex 24` |
| La primera petición tarda ~0,7 s | bcrypt coste 14, sin caché todavía | No es un fallo. La segunda baja a ~17 ms |

---

## Lo que quedó afuera, y por qué

- **HTTP/3 (QUIC)**. El mapeo `443/udp` está en `compose.prod.yml`, comentado.
  Suma superficie UDP que hay que abrir también en el cortafuegos, y el panel no
  gana nada medible con ella. Descomentar sólo con un número en la mano.
- **Un CSP en Caddy.** Ver arriba. Lo rompe.
- **Brotli en Caddy.** No existe en la compilación estándar y no hace falta: lo
  que más pesa ya sale en brotli desde la app.
- **Filtro por origen activo.** Documentado y decidido, no encendido: hay que
  resolver primero cómo queda ACME, y eso es una decisión de quien opera la red.
- **Limitación de tasa.** Caddy la trae en un complemento externo. Con bcrypt de
  coste 14 cada intento fallido ya cuesta ~0,7 s de CPU del atacante, que es un
  freno decente. Si algún día se ven intentos en el registro de accesos, se
  revisa.
