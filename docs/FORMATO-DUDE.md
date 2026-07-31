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
| Enteros generales (`itemX`, `probeInterval`, IDs) | **u32 little-endian** | `51 02 00 00` = 593 |
| Puertos (`port`, `defaultPort`, `webServerPort`) | **u16/u32 big-endian** | `00 A1` = 161 |
| Direcciones IP | **4 bytes big-endian** | `0A E3 0B 13` = 192.0.2.799 |
| Listas de IP | N × 4 bytes | 8 bytes = 2 direcciones |
| Booleanos | 1 byte | `00` no · `01` sí |
| «Ninguno» | `FF FF FF FF` | **no es 4.294.967.295** |
| Cadenas | latin-1, rellenadas con `\0` | usar `.rstrip(b"\0")` |

> 🔴 **`0xFFFFFFFF` significa NULL.** Guardarlo como número produce basura en
> cualquier informe.

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

### `itemType` — medido, no supuesto

| valor | significa | `itemID` apunta a | cant. |
|---:|---|---|---:|
| `0` | **dispositivo** | objeto `0x0f` | 2.054 |
| `1` | **red** | objeto `0x10` | 2 |
| `2` | **submapa** | objeto `0x0a` | 161 |
| `3` | **enlace** | *nada* — usa `linkFrom`/`linkTo` | 100 |

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
| `timeLastUp` · `timeLastDown` · `timeSinceChanged` | marcas de tiempo |

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
user   pwd   password   community   snmpCommunity   v3AuthPassword   v3PrivPassword
```

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
