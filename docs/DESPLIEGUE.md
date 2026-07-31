# Despliegue en la VM del monitoreo

Cómo poner el panel a andar junto al contenedor de The Dude, sin tocarlo.

> Escrito para una VM Ubuntu 24.04 donde ya corre The Dude bajo Wine en Docker.
> Sirve igual para cualquier anfitrión que tenga `dude.db` en un sistema de
> archivos local.
>
> **Los valores concretos —dirección, puerto de SSH, usuario, rangos de la red
> de gestión— van en el runbook interno de cada instalación, no acá.** Este
> documento es público: un repositorio con host, puerto y usuario es un mapa
> de dónde pegar. Se usan marcadores.

---

## Antes de empezar: entender qué convive con qué

```
/srv/thedude/data/
  ├── dude.db          ← The Dude ESCRIBE acá.  El panel sólo LEE.
  ├── dude.db-journal
  └── files/           ← los iconos SVG
```

**Dos procesos sobre el mismo archivo.** Eso funciona, pero con condiciones que
no son negociables:

- El panel monta el directorio **`:ro`**. Es la última barrera si el código
  falla: del otro lado está el monitoreo de un ISP.
- SQLite 3.6.14 —la versión compilada dentro de `dude.exe`, de 2009— **no tiene
  WAL**. El escritor toma bloqueo exclusivo al confirmar y el lector recibe
  `SQLITE_BUSY`. El ETL reintenta; es esperable y no es un error.
- **Nunca sobre NFS, CIFS ni virtiofs.** SQLite depende de bloqueos POSIX
  confiables. Un *block device* de red (iSCSI, Ceph RBD, qcow2 sobre NFS) sí
  sirve: el bloqueo ocurre en el kernel del huésped sobre ext4.

Verificar antes de seguir:

```bash
stat -f -c %T /srv/thedude/data      # ext2/ext3, ext4, xfs o btrfs
```

---

## Recursos

El panel agrega tres contenedores al anfitrión. Medido sobre el despliegue real:

| | en reposo |
|---|---|
| PostgreSQL 16 | ~120 MB |
| ETL (Python) | ~60 MB |
| Web (Node SSR) | ~90 MB |
| **Total** | **~270 MB** |

En una VM de **4 vCPU y 8 GB**, con The Dude usando 250 MB y la CPU al 20 %,
hay lugar de sobra.

> ⚠️ **El disco sí hay que mirarlo.** Las tablas de historia (`chart_values`,
> `outages`) crecen sin techo a propósito — ese es medio sentido del proyecto,
> porque `dude.db` no puede pasar de 2 GiB. Prever una política de retención
> antes de que el volumen `db-data` se vuelva el problema.

---

## Puesta en marcha

```bash
ssh -p <PUERTO_SSH> <USUARIO>@<SERVIDOR>

sudo mkdir -p /opt/dudepanel && cd /opt/dudepanel
sudo git clone https://github.com/programadores-obreros/dudepanel.git .

sudo cp .env.example .env
sudo $EDITOR .env
```

En `.env`:

```ini
POSTGRES_PASSWORD=<openssl rand -hex 24>
DUDE_DATA=/srv/thedude/data
SYNC_INTERVAL=30
WEB_PORT=4321
```

> **Generá la contraseña, no la inventes** — pero con `-hex`, no con `-base64`.
>
> 🔴 `openssl rand -base64 24` produce `/` y `+`, y la contraseña se interpola
> cruda en `DATABASE_URL`. Una barra **termina la sección de autoridad de la
> URI** y el arranque falla con `failed to resolve host 'dude'`, un mensaje que
> apunta a DNS y no tiene nada que ver. Con 32 caracteres base64 la
> probabilidad de que salga al menos un carácter problemático es **del 64 %**:
> dos de cada tres despliegues.
>
> `openssl rand -hex 24` da sólo `[0-9a-f]`, y 96 bits de entropía sobran.

```bash
sudo docker compose up -d
sudo docker compose ps
```

---

## Verificación — en este orden

**1 · ¿La base de The Dude sigue intacta?** Es lo primero, siempre.

```bash
sudo sqlite3 /srv/thedude/data/dude.db "PRAGMA user_version; SELECT count(*) FROM objs;"
```

Tiene que dar `1` y unos 14.900. **Si `user_version` no es 1, parar todo**: The
Dude lee ese número para saber si la base tiene esquema, y con `0` concluye que
está vacía y le escribe 152 objetos por defecto encima.

**2 · ¿El ETL sincronizó?**

```bash
sudo docker compose exec db psql -U dude -tAc \
  "SELECT started_at, ok, devices, services, maps, map_elements, duration_ms
   FROM sync_runs ORDER BY id DESC LIMIT 3;"
```

Referencia de una instalación real: **885 dispositivos · 859 servicios ·
40 mapas · 2.317 elementos**.

**3 · 🔴 ¿Se filtró alguna credencial?** No es opcional. Es la garantía central
del proyecto y se comprueba, no se confía.

> 🔴 Acá había un chequeo que miraba **nombres de columna** contra un patrón.
> **No servía**: las columnas las fija `schema.sql`, que es estático, así que
> devolvía vacío siempre — hoy y en cualquier futuro. Confirmaba lo que ya
> sabíamos y daba la sensación de haber verificado. Un chequeo que no puede
> fallar no es un chequeo.
>
> El correcto busca **valores**, y para eso está el test del ETL: lee del origen
> las credenciales de verdad y las busca dentro de cada tabla ya escrita.

```bash
sudo docker compose run --rm \
  -e TEST_DATABASE_URL="postgresql://dude:$POSTGRES_PASSWORD@db:5432/dude" \
  etl python -m pytest test_sync.py -q -k credencial
```

Ese test **primero comprueba que el origen SÍ tiene secretos** —si no, pasaría
por vacío sin probar nada— y recién después verifica que ninguno llegó.

**4 · ¿El panel responde?**

```bash
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/
```

---

## Cómo se mira

El panel escucha **sólo en `127.0.0.1` del anfitrión**, a propósito.

```bash
ssh -L 4321:127.0.0.1:4321 -p <PUERTO_SSH> <USUARIO>@<SERVIDOR>
# y abrir http://localhost:4321
```

### Para que lo use el equipo desde la red de gestión

Si el cortafuegos está en *deny* y sólo deja pasar SSH, **no distingue si venís
de internet o de adentro**: el equipo tampoco llega.

Cuando se quiera abrir, va **por origen**, nunca «a cualquiera»:

```bash
sudo ufw allow from <RANGO_DE_GESTION> to any port 4321 proto tcp
```

Y hay que cambiar la publicación del puerto en `docker-compose.yml`, que hoy
está atada a `127.0.0.1`.

> ### 🔴 Antes de exponerlo, leé esto
>
> En este mismo despliegue, encender el servidor web propio de The Dude dejó su
> login de 2011 —con el certificado de ejemplo de MikroTik de 2005 y **TLSv1**—
> atendiendo desde internet, porque el puerto 443 ya estaba abierto en `ufw`
> «sin nada detrás».
>
> **Poner un servicio detrás de un puerto abierto lo convierte en una puerta.**
>
> Y el error de método fue peor que el descuido: se verificó que `ufw` bloqueaba
> el `8081` y se concluyó que también el `443`. **Comprobar un puerto no dice
> nada sobre otro.** Verificar **desde afuera de la red del ISP**, uno por uno.
>
> Si el panel tiene que salir de la red de gestión, va detrás de un proxy
> inverso con TLS real y autenticación. No directo.

---

## Operación

```bash
# ver qué está haciendo el ETL
sudo docker compose logs -f etl

# forzar una sincronización
sudo docker compose restart etl

# respaldar la base del panel (NO la de The Dude, que tiene su propio proceso)
sudo docker compose exec -T db pg_dump -U dude dude | gzip > panel-$(date +%F).sql.gz
```

> El respaldo del panel es **conveniencia, no seguro**: todo su contenido se
> reconstruye desde `dude.db` en una corrida… **excepto la historia acumulada**
> después de que se pode la base local. En cuanto se empiece a podar, este
> respaldo pasa a ser el único lugar donde vive el pasado. Automatizarlo ahí.

---

## Si algo sale mal

| síntoma | causa probable | qué mirar |
|---|---|---|
| `sync_runs.ok = false` con `database is locked` | The Dude estaba confirmando | Normal si es esporádico. Constante = revisar `SYNC_INTERVAL` |
| El panel muestra datos viejos | El ETL no corre | `docker compose logs etl` |
| `user_version` distinto de 1 | 🔴 la base de The Dude está mal | **Parar y restaurar** desde el respaldo de la base |
| Faltan iconos | `files/` no montado | Revisar `DUDE_DATA` en `.env` |
| Mapas sin elementos | El join falló | 38 de 40 mapas tienen elementos; 2 están vacíos de verdad |

### Desinstalar sin dejar rastro

```bash
sudo docker compose down -v      # -v también borra el volumen de Postgres
```

**The Dude no se entera de nada**: nunca se le escribió un byte.
