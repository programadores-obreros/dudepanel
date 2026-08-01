# La historia que estaba en texto

Cómo se rescatan seis años de caídas que la base de The Dude perdió, y qué hay
que saber para no creerles más de lo que dicen.

---

## Qué pasó

El 12 de junio de 2026 `dude.db` chocó contra el techo de 2 GiB —`wine32` es de
32 bits y ese techo no se mueve— y la rearmaron desde cero. **La tabla `outages`
arranca ese día.** Todo lo anterior se perdió.

Pero The Dude tenía puesta una regla de notificación «log to syslog», y esa
regla venía escribiendo cada subida y cada bajada de servicio a archivos de
texto en `files/`. Esos archivos no estaban en la base, así que **sobrevivieron**:

```
 44 archivos
141.678 líneas
2020-05-26 → 2026-07-27
```

Este importador los trae de vuelta a una tabla consultable.

---

## 🔴 Lo primero: NO son seis años continuos

Medido sobre los 44 archivos:

| año | líneas |
|---|---:|
| 2020 | 2.928 |
| 2021 | 936 |
| **2022** | **0** |
| **2023** | **0** |
| 2024 | 2.584 |
| 2025 | 29.331 |
| 2026 | 105.899 |

**Dos años enteros sin un solo registro.** No sabemos si The Dude estuvo apagado,
si le sacaron la regla de notificación o si alguien borró los archivos. Sabemos
que no están.

Decir «historia desde 2020» sin decir esto sería contar una historia falsa sin
mentir en ningún número. Por eso hay dos mecanismos, y los dos son obligatorios
para cualquier cosa que se muestre encima de estos datos:

- **`v_syslog_cobertura`** emite una fila **por mes**, incluidos los meses
  vacíos, con `hueco = true`. Un `GROUP BY` común no devuelve fila para un mes
  sin datos, y así 2022 y 2023 simplemente *no aparecerían*.
- **`syslog_outages.spans_gap`** marca las caídas cuyo intervalo cruza uno de
  esos vacíos. Un `down` de diciembre de 2021 emparejado con el `up` de enero de
  2024 produce una caída de **dos años que nunca existió**: lo que se cortó fue
  el registro, no el enlace.

---

## El formato

```
2025.11.23-14:53:39 <IP-DEL-SERVIDOR>: Service ping on Peniel_E_Lasalle2AF is now down (timeout)
2025.11.23-14:56:09 <IP-DEL-SERVIDOR>: Service ping on Peniel_E_Lasalle2AF is now up (ok)
```

En todo el histórico hay **una sola sonda**: `ping`. Y dos motivos de caída:

| motivo | líneas | qué significa |
|---|---:|---|
| `timeout` | 69.446 | el equipo no contesta |
| `local problem` | 79 | **el problema es del servidor de monitoreo** |

Esa diferencia importa y se guarda en `syslog_outages.down_reason`. Una caída
`local problem` no dice absolutamente nada del equipo: se le cayó la placa o se
quedó sin ruta al que estaba mirando. Contarla como indisponibilidad del equipo
es atribuirle una falla ajena.

### Hay una segunda fuente mezclada adentro

Alguien apuntó también un MikroTik al mismo destino de syslog. 2.642 de las
141.678 líneas no son eventos de servicio:

```
<H>: pptp,ppp,info ponte: usuario-fs: terminating... - failed to authenticate ourselves to peer
<H>: ipsec,info ponte: respond new phase 1 (Identity Protection): ...
<H>: pptp,info ponte: TCP connection established from ...
```

**No se descartan.** Van enteras a `syslog_other`, clasificadas por los propios
tópicos de MikroTik (`pptp,ppp,info`, `ipsec,info`) — que es mejor taxonomía que
cualquiera que inventáramos por palabras clave, y viene gratis en la línea. Que
**438 de ellas digan «failed to authenticate»** es información operativa que hoy
no mira nadie.

### Y lo que no entra en ninguna de las dos

Las líneas que ni el sobre `fecha <host>:` matchean se **cuentan** en
`syslog_files.ignored_lines` y se guarda una **muestra por forma distinta** (los
números se aplastan antes de comparar, así `error 1` y `error 2` son la misma
forma). Nunca revientan la corrida y nunca desaparecen en silencio.

> El texto libre de una fuente externa —`syslog_other.message` y las muestras—
> pasa por un redactor que enmascara `password` / `pwd` / `community` /
> `secret` / `token` antes de guardarse. Son las dos únicas columnas del esquema
> con texto ajeno, y la regla del proyecto es que ninguna tabla guarde
> credenciales.

---

## Cómo se reconstruye una caída desde dos líneas

Un `down` seguido de un `up` del mismo equipo y la misma sonda es una caída. Eso
es lo fácil. Lo que decide si esto sirve o no son los casos feos, y todos se
resuelven con la misma regla:

> **Nunca inventar un instante que el texto no dice, y nunca tirar una línea en
> silencio.**

| lo que hay | `closure` | qué se guarda |
|---|---|---|
| `down` → `up` | `closed` | la caída completa, con duración |
| `down` → nada | `open` | `ended_at` y `duration_s` en **NULL** |
| nada → `up` | `no_start` | `started_at` en **NULL** |
| `down` → `down` → `up` | `closed` | **una** caída desde el primer `down`, `down_events = 2` |

### Por qué NULL y no 0

Un NULL no se suma. Una caída sin cerrar, un `up` huérfano o un reloj que saltó
no pueden contaminar ningún promedio de disponibilidad. Un `0` sí lo haría, y en
silencio.

### Los dos `down` seguidos

The Dude notifica transiciones, así que dos `down` seguidos significan que el
`up` del medio se perdió. Se puede leer de dos maneras y las dos son
defendibles: **una caída larga**, o **dos cortas** con un intervalo desconocido
en el medio.

Se elige la primera **porque la segunda obliga a inventar la hora del `up` que
falta**. Para no perder la otra lectura se guarda `last_down_at`:

```
pesimista  = [started_at,   ended_at]     ← lo que dice la tabla
optimista  = [last_down_at, ended_at]     ← a un SELECT de distancia
```

Y `down_events > 1` avisa de que la elección existe.

### Los `up` sin `down` pueden venir en manada

⚠️ Cuando The Dude arranca, todos los servicios pasan de `unknown` a `up` y eso
dispara la notificación. **Doscientos `no_start` dentro del mismo minuto no son
doscientas caídas: son un arranque del servidor.** Desde el texto no hay forma
de distinguirlos, así que se guardan igual pero nunca con duración.

### El reloj para atrás

Seis años de un Windows 7 sin NTP confiable. Lo primero que uno escribe acá es
una guarda contra la duración negativa, y **es código muerto**: como los eventos
se ordenan por hora, la resta nunca puede dar negativo. Lo que un salto de reloj
produce de verdad es que el `up` aparezca *antes* que el `down`, y eso sale como
un `no_start` suelto más una caída `open`. Feo, pero visible, y sin un solo
número inventado.

### Las caídas que cruzan de un archivo a otro

Ésta es la razón de que la reconstrucción lea de **la tabla de eventos** y no del
flujo de cada archivo. El `down` está en el archivo que se rota y el `up` en el
siguiente; reconstruyendo por archivo darían un `open` y un `no_start` en vez de
la caída que realmente pasó.

El desempate cuando dos eventos comparten el segundo es: primero el archivo cuyo
primer evento es más viejo, después el número de línea. **Ordenar por el nombre
del archivo sería adivinar** — nada garantiza que `syslog.10.txt` sea posterior a
`syslog.9.txt`.

---

## El reloj: no hay zona horaria en el formato

`2025.11.23-14:53:39` y nada más. Es la hora local del servidor que escribió la
línea, y es un supuesto.

Se maneja así:

1. **Se elige explícitamente** (`--tz`, default
   `America/Argentina/Buenos_Aires`) y **queda escrita en `syslog_files.tz`**.
   Un supuesto que no queda anotado es un supuesto que dentro de un año nadie
   puede auditar.
2. **Se guarda la hora cruda** en `occurred_local`. Cuesta 8 bytes y permite
   corregir la zona con un `UPDATE` (`syslog.py reinterpretar --tz ...`) en vez
   de volver a conseguir 44 archivos que capaz ya no están.
3. **Se puede MEDIR si acertamos.** Ver abajo.

> Argentina no mueve el reloj desde 2009, así que en todo el rango 2020-2026 no
> hay ni una hora ambigua ni una inexistente: la conversión es un desplazamiento
> fijo de `-03`.

### `syslog.py zona` — la incógnita se vuelve una medición

Del 2026-06-12 al 2026-07-27 las dos fuentes se solapan. `outages` viene de The
Dude con epoch unix —UTC de verdad, sin ambigüedad— y el syslog viene con la
zona que le dijimos. Si la zona es la correcta, las mismas caídas caen a la misma
hora.

El comando desplaza el syslog hora por hora y cuenta cuántas caídas encuentran
pareja. **Medido** contra las 11.988 caídas reales:

```
  -9 h   2036
  -6 h   2714
  -3 h   2841
  +0 h   6519    ← el pico
  +3 h   2858
  +6 h   2745
```

El pico tiene que ser **0** y tiene que ser **claro**. Los ecos en ±3, ±6 y ±9
son ruido de fondo de las caídas periódicas: si el ganador no le saca el doble al
segundo, la medición no concluye nada.

Si un día gana `+3`, la zona está mal por tres horas — que es exactamente el
error que ya apareció en la VM nueva, que venía en UTC.

---

## Nombre → id: el 25 % que no resuelve

El texto trae **nombres**; el panel necesita **ids**. Y los nombres no son una
clave.

```
452  nombres distintos aparecen en los logs
338  existen hoy en devices.name        (75 %)
114  NO existen                         (25 %)
```

Los 114 son equipos renombrados o dados de baja:
`AirFiber Nicole_E_Ponte`, `Peniel_E_Ponte 24GHZ ex 10 Ghz`,
`Cambium_Panel_1001`, `MK-SW2-NicoleBT2`, y hasta direcciones IP usadas como
nombre.

**Se guardan igual, con `device_id` en NULL.** Tirar un cuarto del histórico
porque a alguien le cambiaron el nombre sería perder justo lo que este trabajo
viene a rescatar.

### 🔴 No hay emparejamiento por parecido, y es a propósito

Uno de los nombres es literalmente **`Peniel_E_Ponte 24GHZ ex 10 Ghz`**: el «ex»
es la historia de renombres metida adentro del nombre. Un `similarity()` contra
eso devuelve coincidencias plausibles y falsas.

**Una caída atribuida al equipo equivocado miente; una caída sin atribuir se
nota.** La primera es peor.

### Y del lado del inventario tampoco hay unicidad

De los 798 nombres distintos de `devices`, **80 los comparten más de un equipo**
(167 servicios `ping`). Para ésos el nombre no alcanza.

Por eso `match_kind` tiene cuatro valores y no dos:

| `match_kind` | qué significa | qué ids quedan |
|---|---|---|
| `service` | el par (equipo, sonda) da **exactamente un** servicio | `device_id` + `service_id` |
| `device` | el nombre da un equipo solo, pero sin esa sonda | sólo `device_id` |
| `ambiguous` | el nombre lo comparten varios equipos | ninguno |
| `unknown` | el nombre no está en el inventario | ninguno |

La resolución es un `UPDATE` aparte y **re-ejecutable**: los equipos se
renombran, y un nombre que hoy no resuelve puede resolver mañana sin volver a
leer los 44 archivos.

```bash
python syslog.py resolver
```

Y se «des-resuelve» sola: si un equipo se borra de The Dude, su caída vuelve a
`unknown` en vez de quedarse con un id apuntando a la nada.

---

## Idempotencia: correrlo dos veces no duplica nada

Tres mecanismos apilados.

**1 · La clave natural del evento.**

```sql
UNIQUE (occurred_at, device_name, probe_name, state, ordinal)
```

No incluye `source_file`, justamente para que la misma línea presente en dos
archivos —el solape típico de una rotación— entre **una** vez.

**2 · El `ordinal`.** Cuenta cuántas veces apareció antes esa misma línea en el
mismo archivo. Sin él, dos equipos que se llaman igual cayendo en el mismo
segundo escriben dos líneas idénticas y una se perdería contra la clave única.
No es teórico: en la prueba contra las 11.988 caídas reales hubo **283 líneas
exactamente repetidas y no se perdió ninguna** (23.970 líneas de servicio →
23.970 eventos).

**3 · La tabla de caídas es derivada.** `syslog_outages` no se «actualiza»: es
una **función pura** de `syslog_events`, y se vacía y se recalcula entera en cada
pasada. El precio es que los `id` no son estables entre reconstrucciones —nadie
los referencia— y a cambio mejorar el algoritmo es cambiar `reconstruir()` y
listo, sin ninguna migración.

Y encima de todo, el atajo: si el `sha256` del archivo no cambió, ni se abre.

**Medido** sobre 141.661 líneas en 44 archivos:

| corrida | qué hace | eventos | otras | caídas |
|---|---|---:|---:|---:|
| 1ª | carga todo | 139.022 | 2.639 | 69.504 |
| 2ª | saltea los 44 archivos | 139.022 | 2.639 | 69.504 |
| 3ª | `--forzar`: relee y reescribe todo | 139.022 | 2.639 | 69.504 |

---

## 🔴 Por qué NO hay clave foránea a `devices` ni a `services`

`sync.py` hace `DELETE FROM services` + `INSERT` en **cada corrida, cada 30
segundos**, porque el origen no sabe decir qué cambió.

- Con `REFERENCES services(id) ON DELETE CASCADE`, seis años de historia se
  evaporarían **dos veces por minuto**.
- Con `RESTRICT`, reventaría el ETL entero.

Es el mismo precedente, y el mismo precio, que ya está documentado en
`map_element_positions`. Hay un test que lo prueba borrando `services` y
`devices` enteras y exigiendo que la historia siga ahí, y otro que verifica que
nadie agregó una FK de buena fe.

**El dato autoritativo de estas tablas es el nombre en texto.** Los ids son una
resolución de mejor esfuerzo.

---

## Las tablas

| tabla | qué es |
|---|---|
| `syslog_files` | un renglón por archivo: sha256, tz usada, conteos por clase, muestras de lo no entendido |
| `syslog_events` | la materia prima, una fila por línea de servicio. **Fuente de verdad** |
| `syslog_other` | las 2.642 líneas del MikroTik, con sus tópicos |
| `syslog_outages` | las caídas reconstruidas. **Derivada**, se recalcula entera |

| vista | qué es |
|---|---|
| `v_syslog_cobertura` | una fila por mes **incluidos los vacíos**, con `hueco` |
| `v_historia_caidas` | las dos fuentes juntas con `origen` a la vista |

### ⚠️ `v_historia_caidas`: no sumar sin filtrar

Del 2026-06-12 en adelante las dos fuentes cubren el mismo período y la misma
caída puede estar dos veces: una registrada por The Dude con su reloj, otra
reconstruida desde texto. La columna `solapado` marca las filas de syslog que
caen dentro del rango que ya cubre `outages`.

Para un total sin doble conteo:

```sql
SELECT * FROM v_historia_caidas
 WHERE origen = 'dude' OR NOT solapado;
```

Y quedarse con la versión `'dude'` donde exista: viene con epoch unix, no con una
zona horaria supuesta.

---

## Uso

```bash
# la pasada completa: parsear, cargar, reconstruir y resolver
python syslog.py importar --dir /origen/files --tz America/Argentina/Buenos_Aires

# qué hay cargado
python syslog.py reporte

# volver a resolver nombres, después de renombrar equipos en The Dude
python syslog.py resolver

# ¿la zona horaria elegida es la correcta?
python syslog.py zona

# corregirla sin volver a leer los archivos
python syslog.py reinterpretar --tz UTC

# rehacer las caídas con otro criterio de hueco
python syslog.py reconstruir --hueco-dias 7
```

`DATABASE_URL` sale del entorno, igual que en `sync.py`. El default de `--glob`
es `*.txt` — **confirmarlo contra el directorio real** antes de la corrida
buena; si no coincide con nada, el comando lo dice y sale con código 2.

> ⚠️ El archivo se llama `etl/syslog.py` y **tapa el módulo `syslog` de la
> biblioteca estándar** para todo lo que corra con `etl/` en el `sys.path`. Hoy
> no lo importa nadie —ni `logging`, ni `psycopg`— pero si algún día aparece un
> `AttributeError` raro sobre `syslog.LOG_DAEMON`, la causa es ésta.

---

## Qué está verificado y qué no

**Verificado, con números:**

- 146 pruebas en verde, incluidas las 60 que ya existían.
- El esquema aplicado en tres pasadas —viejo (`git show HEAD:etl/schema.sql`),
  nuevo, nuevo otra vez— sin un error.
- Corrida a escala: 141.661 líneas en 44 archivos con la distribución medida
  (incluido el hueco de 2022-2023) contra el inventario real de 885 equipos y
  859 servicios. **13,6 s** de punta a punta. Detectó los **24 meses vacíos**
  (2022-01 … 2023-12) y clasificó **338 nombres que existen** (291 `service`,
  34 `ambiguous`, 13 `device`) y **114 que no** — clavado contra lo medido.
- **Ida y vuelta contra los datos reales:** se generó syslog a partir de las
  11.988 caídas que The Dude registró de verdad y se volvió a reconstruir.
  De las 6.519 que resuelven a un servicio, **6.519 tienen el instante de inicio
  IDÉNTICO** al de la fila original. Cero deriva.
- El comando `zona` encontró el desplazamiento **0** con 6.519 coincidencias,
  más del doble que el segundo candidato.
- Idempotencia a escala: tres corridas seguidas, mismos conteos exactos.

**NO verificado, y hay que hacerlo con los archivos de verdad:**

- **El patrón de nombre de los archivos.** `--glob '*.txt'` es una suposición.
- **La codificación.** Se lee con `errors="replace"`; si los nombres de equipo
  traen acentos y el archivo no es UTF-8, van a entrar con caracteres de
  reemplazo. Mirar `syslog_files.ignored_samples` y buscar `` en los nombres
  después de la primera corrida.
- **Cuántas líneas no entienden el sobre.** Las 141.678 se explican con
  69.525 + 69.511 + 2.642, así que deberían ser **cero** — pero eso hay que
  verlo en `syslog_files.ignored_lines`, no darlo por hecho.
- **Cuántos `no_start` son arranques de The Dude.** Se van a ver como manadas
  dentro del mismo minuto. Vale la pena contarlos antes de mostrar nada.
- **Si el corpus tiene estados además de `up`/`down`.** El importador los guarda
  y los cuenta; `syslog.py reporte` los lista.
