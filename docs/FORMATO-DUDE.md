# El formato de datos de The Dude 4.0beta3

**Este documento es el contrato.** El ETL lee de acá; el esquema de PostgreSQL
sale de acá. Todo lo que dice está **medido sobre la base real de el ISP**
(14.925 objetos), no deducido de documentación — de la que no existe.

---

## 1 · La única tabla que importa

```sql
CREATE TABLE objs (id integer primary key, obj blob);
```

No hay tabla `device`, ni `map`, ni `user`. **Todo es un blob** con una lista
plana de propiedades:

```
registro := u8 largoNombre │ nombre │ u16be largoValor │ valor
```

Repetido hasta agotar el blob. Los registros vienen **ordenados
alfabéticamente** por nombre de campo.

### Los tipos numéricos, que son la trampa principal

| campo | codificación | ejemplo |
|---|---|---|
| **Todo entero de 4 bytes** | **u32 little-endian, sin excepciones** | `51 02 00 00` = 593 |
| Puertos | u32 little-endian, como el resto | `A1 00 00 00` = 161 |
| Direcciones IP | **4 bytes big-endian** | `C0 00 02 0B` = 192.0.2.11 |
| Listas de IP | N × 4 bytes | 8 bytes = 2 direcciones |
| Booleanos | 1 byte | `00` no · `01` sí |
| «Ninguno» | `FF FF FF FF` | **no es 4.294.967.295** |
| Cadenas | latin-1, rellenadas con `\0` | usar `.rstrip(b"\0")` |

> 🔴 **`0xFFFFFFFF` significa NULL.** Guardarlo como número produce basura en
> cualquier informe.

> ### 🔴 Corregido el 31/07/2026: NO hay campos big-endian
>
> Este documento decía que los puertos venían en big-endian, «`00 A1` = 161».
> **Es falso.** Los bytes reales son `A1 00 00 00`: alguien vio el `A1` primero
> y lo leyó al revés. **Todo entero de 4 bytes de este formato es
> little-endian.**
>
> Sólo son big-endian dos cosas, y se decodifican aparte: el `u16` de largo en
> el encabezado de cada registro, y las direcciones IPv4.
>
> Medido comparando las dos lecturas:
>
> | campo | bytes | little-endian | big-endian |
> |---|---|---:|---:|
> | `http`.defaultPort | `50 00 00 00` | **80** | 1.342.177.280 |
> | `ssh`.defaultPort | `16 00 00 00` | **22** | 369.098.752 |
> | perfil SNMP.port | `a1 00 00 00` | **161** | 2.701.131.776 |
> | config.webServerPort | `91 1f 00 00` | **8.081** | 2.434.727.936 |
> | `ethernet`.snmpType | `06 00 00 00` | **6** (ifType IANA) | 100.663.296 |
>
> 80, 22, 161, 8081 y el ifType 6 no son coincidencias.

### Colores

Vienen como `R, G, B, 0` — o sea `0xRRGGBB`. **Leídos como entero
little-endian, el rojo sale azul.**

### `dnsNames` es una lista, no una cadena

Cada nombre viene precedido por su largo en u32 LE.

---

## 2 · `sys-type` es el discriminador, no `type`

`sys-type` está en los **14.925** objetos. El campo `type` está en 1.584 y es
otra cosa (el tipo que ve el usuario).

Los `sys-type` **por debajo de `0x100` son el esquema** — iguales en cualquier
instalación de The Dude. Los de arriba son **instancias**: cada mapa y cada log
recibe el suyo al crearse, así que **cambian entre instalaciones y no se pueden
codificar a mano**.

| `sys-type` | qué es | cant. |
|---|---|---:|
| `0x0f` | **Dispositivos** | 885 |
| `0x11` | Servicios monitoreados | 859 |
| `0x1f` | **Enlaces** | 1.171 |
| `0x29` | Sondas en ejecución | 1.083 |
| `0x0a` | **Mapas de red** | 40 |
| `0x05` | Archivos (iconos SVG, fuentes) | 335 |
| `0x0d` | Sondas (definiciones) | 29 |
| `0x39` | Funciones | 20 |
| `0x04` | Herramientas | 20 |
| `0x0e` | Tipos de dispositivo | 18 |
| `0x15` | **Usuarios** | 8 |
| `0x18` | Notificaciones | 6 |
| `0x22` | Tipos de enlace | 6 |
| `0x07` | Logs | 6 |
| `0x14` | Grupos de permisos | 4 |
| `0x3a` | **Perfiles SNMP** | 3 |
| `0x43` | Reglas de syslog | 2 |
| `0x10` | Redes / submapas | 2 |
| `0x03` | Configuración del servidor | 1 |
| `0x01` | Listas ordenadas | 59 |

Más **8.000 entradas de log** y **2.317 elementos de dibujo**, que son
instancias.

---

## 3 · 🔴 Cómo se arman los mapas

Esta es la parte que hace posible dibujarlos, y no es obvia.

```
mapa (0x0a)  ──elementsID──►  objeto lista (0x01, mismo nombre)
                                      ▲
elemento de mapa  ──sys-type──────────┘
```

**El `sys-type` de un elemento ES el id del objeto-lista del mapa.** O sea:

```sql
JOIN  elemento.sys_type = mapa.elements_id
```

Verificado sobre los 40 mapas: **38 tienen elementos, 0 elementos huérfanos.**
(Los 2 sin elementos son mapas vacíos, no un fallo del join.)

### Campos de un elemento

| campo | qué es |
|---|---|
| `itemX` · `itemY` | **coordenadas** en el lienzo, u32 LE |
| `itemID` | a qué objeto representa |
| `itemType` | **qué clase de cosa es** — ver abajo |
| `itemShape` | forma del nodo |
| `itemImage` | id de un archivo (`0x05`) — el icono SVG |
| `itemUpColor`, `itemDownCompleteColor`, `itemDownPartialColor`, `itemUnknownColor`, `itemAckedColor` | colores por estado |
| `linkID`, `linkFrom`, `linkTo` | sólo en elementos de enlace |
| `linkWidth`, `linkUseWidth` | grosor de la línea |

### 🔴 La clasificación usa DOS campos, no uno

Este documento decía que `itemType` alcanzaba. **No alcanza**, y el error hacía
contar 1.170 enlaces como si fueran dispositivos.

`type` es el discriminador de primer nivel; `itemType` sólo manda cuando
`type = 0`:

| `type` | `itemType` | cant. | qué es | `itemID` apunta a |
|---:|---:|---:|---|---|
| 0 | 0 | **884** | dispositivo | objeto `0x0f` |
| 0 | 1 | 2 | red | objeto `0x10` |
| 0 | 2 | 161 | submapa | objeto `0x0a` |
| 0 | 3 | 100 | **rótulo de texto** (`eth2`, `eth4`) | *nada* |
| 1 | — | **1.170** | **enlace** | *nada* — usa `linkID`/`linkFrom`/`linkTo` |

Lo que decía antes —«2.054 dispositivos, 100 enlaces»— eran 884 equipos **más**
1.170 enlaces sumados por ignorar `type`, y los «100 enlaces» son rótulos:
**ninguno de los 100 tiene `linkID`.** Los 1.170 enlaces reales, todos lo tienen.

---

## 4 · Estado de los servicios

Un servicio (`0x11`) es lo que pinta el mapa de verde o rojo.

| campo | qué es |
|---|---|
| `status` | **0 desconocido · 1 arriba · 2 caído parcial · 3 caído** |
| `deviceID` | a qué equipo pertenece |
| `probeID` | con qué sonda se mide |
| `enabled` · `acked` | habilitado · reconocido por un operador |
| `probesDown` | fallos consecutivos |
| `timeSinceChanged` | **el único instante real** (epoch, u32 LE) |
| `timeLastUp` · `timeLastDown` | 🔴 **DURACIONES, no fechas** — ver abajo |

> ### 🔴 Los nombres de The Dude mienten
>
> `timeLastDown` **no es «cuándo se cayó»: es cuánto duró la última caída.**
> Verificado: coincide exacto con `outages.duration` en **251 de los 311**
> servicios con historial.
>
> Mostrarlos como fecha pone «1970» en pantalla. Para «hace cuánto que está
> así», el campo es `timeSinceChanged`.

> El mapeo de `status` se dedujo de los cuatro colores que define la
> configuración del servidor (`mapUpColor`, `mapDownPartialColor`,
> `mapDownCompleteColor`, `mapUnknownColor`) y **se verifica contra la interfaz
> web propia de The Dude**, que muestra `up` / `unknown` / `acked` en texto.
>
> 🔴 **Esa interfaz es el oráculo del proyecto.** Cualquier duda sobre
> semántica se resuelve comparando contra ella, servicio por servicio.

Distribución al 31/07/2026: `1`→363 · `3`→267 · `0`→214 · `2`→15

---

## 5 · Dispositivos

| campo | qué es |
|---|---|
| `addresses` | **lista** de IP, 4 bytes cada una |
| `dnsNames` | nombres DNS |
| `typeID` | tipo de dispositivo (`0x0e`) |
| `parentIDs` | **la topología** — de quién cuelga |
| `macs` | direcciones MAC |
| `routerOS` | si es un MikroTik |
| `snmpProfileID` | `0xFFFFFFFF` = hereda el del servidor |
| `probeInterval`, `probeTimeout`, `probeDownCount` | `0` = hereda |

### 🔴 Campos que NUNCA se copian a PostgreSQL

```
user  pwd  password  community  snmpCommunity  v3AuthPassword  v3PrivPassword
customField1  customField2  customField3
```

> ### 🔴 Por qué `customField` está en esa lista
>
> **No es paranoia preventiva.** En la base real de el ISP, **seis
> dispositivos tienen la contraseña del equipo escrita a mano en
> `customField1`**, en claro, con formato `usuario:clave`.
>
> Es un campo de texto libre: la convención de nombres no protege nada ahí. Un
> filtro que confía en que los secretos se llamen «password» habría copiado esas
> seis a PostgreSQL sin que ningún test se quejara.
>
> **Lo único que protege un campo de texto libre es no leerlo.**

The Dude guarda las credenciales de **cada router de el ISP en forma
recuperable** — no puede guardar hashes porque tiene que presentarlas al
autenticarse. **El ETL las omite, no las enmascara: no las lee.**

Un panel de sólo lectura no tiene ninguna razón para conocerlas, y una base que
no las contiene no las puede filtrar.

---

## 6 · Los iconos están en la base… casi

Los 335 objetos `0x05` son los archivos: `ap.svg`, `bridge.svg`, `client.svg`,
`router.svg`, `globe.svg`, fuentes, el certificado.

**Pero el campo `data` del blob viene en 0 bytes**: el contenido real vive en
disco, en `data/files/`. El objeto de la base es sólo el índice.

El ETL registra la metadata (id → nombre de archivo) y **el contenido se lee del
directorio `files/`**, que se monta junto a `dude.db`.

---

## 7 · Las tablas de historia

| tabla | filas (31/07) | qué es |
|---|---:|---|
| `outages` | 11.988 | caídas registradas |
| `chart_values_raw` | 821.266 | mediciones crudas |
| `chart_values_10min` | 320.568 | promedio 10 min |
| `chart_values_2hour` | 386.746 | promedio 2 h |
| `chart_values_1day` | 52.184 | promedio diario |

Esquema: `(sourceIDandTime INTEGER, value REAL)` — la clave **empaqueta el id de
la fuente y el tiempo en un solo entero de 64 bits**. Hay que desempaquetarla.

> 🔴 **Acá está la oportunidad grande.** `dude.db` murió en junio de 2026 al
> chocar contra **2 GiB** —`wine32` es de 32 bits y ese techo no se mueve— y hoy
> va por 34 MB creciendo. Si la historia se replica a PostgreSQL, se puede podar
> la local **y el techo deja de ser una cuenta regresiva.**

---

## 8 · Restricciones de lectura

**SQLite 3.6.14** (mayo 2009) está compilado dentro de `dude.exe`. Eso importa:

- **WAL no existe** — llegó en 3.7.0. The Dude usa `journal_mode=PERSIST`.
- En modo *rollback journal*, el escritor toma **bloqueo exclusivo** al
  confirmar. **Cualquier lector recibe `SQLITE_BUSY`.**

Por lo tanto el ETL **debe**:

```python
sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
# + reintentos con espera exponencial ante SQLITE_BUSY
```

Y **jamás** abrirla para escritura. Un bug que escriba corrompe el monitoreo de
producción.

> El journal `dude.db-journal` **siempre existe** en modo PERSIST. Su presencia
> no significa nada. Sólo la cabecera lo dice: caliente ⟺ los primeros 8 bytes
> son `d9 d5 05 f9 20 a1 63 d7`.
