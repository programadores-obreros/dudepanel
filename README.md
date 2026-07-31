# dudepanel

**Un panel web moderno para The Dude 4.0beta3**, el monitor de red de MikroTik
que salió en 2011 y está discontinuado desde entonces.

Lee su base SQLite **en sólo lectura**, la replica a PostgreSQL con un modelo
relacional propio, y sirve una interfaz en Astro + Tailwind: mapas de topología,
búsqueda por nombre o IP, estado en vivo, desde cualquier navegador.

---

## El problema que resuelve

The Dude sigue siendo bueno en lo suyo, pero su cliente es una aplicación
Windows que corre en **una** máquina. Para ver la red hay que ir hasta ahí. Trae
un servidor web propio, sí — de 2005, con maquetación por tablas anidadas, sin
responsive, que recarga la página entera cada 30 segundos.

Y su base es una sola tabla de blobs binarios: no se puede consultar, ni
agregar, ni cruzar con nada.

```
dude.db (SQLite, intocable)  ──ro──►  ETL  ──►  PostgreSQL  ──►  panel web
```

| lo que aporta | cómo |
|---|---|
| **Consultable desde cualquier lado** | Navegador, también en el teléfono |
| **SQL de verdad** | `JOIN`, índices, agregaciones, búsqueda por trigramas |
| **Riesgo cero para producción** | Sólo lectura, montaje `:ro`, otra máquina si hace falta |
| **Sin credenciales** | Ver abajo. Es la decisión de diseño más importante |
| **Sobrevive a The Dude** | El día que migren a otro monitor, cambia quién alimenta Postgres. La gente sigue mirando el mismo panel |

### Y algo que no es obvio

The Dude guarda todo en un SQLite de 32 bits. En junio de 2026 esa base **chocó
contra 2 GiB y murió**, y hubo que rearmarla desde cero perdiendo la historia.
El techo sigue exactamente donde estaba.

Replicando la historia a PostgreSQL, la base local se puede podar: **el techo
deja de ser una cuenta regresiva.**

---

## 🔴 Sobre las credenciales

The Dude conserva el usuario y la contraseña de acceso a **cada equipo
monitoreado**, en forma recuperable. No puede hacer otra cosa: tiene que
presentarlos al autenticarse, y un sistema que presenta secretos no puede
guardar hashes.

**Este proyecto no los enmascara: no los lee.**

```python
SECRETO = re.compile(r"(pass|pwd|secret|community|privkey|authkey|wpa|psk|^user$)", re.I)
```

Los campos existen en el origen —`pwd` en 885 objetos, `user` en 885,
`community` en 3— y el decodificador los omite. Hay un test que lo verifica en
cada corrida.

**Una base que no los contiene no los puede filtrar**: ni por un fallo, ni por
un volcado, ni por un respaldo mal guardado.

---

## Cómo levantarlo

```bash
cp .env.example .env
$EDITOR .env                     # POSTGRES_PASSWORD y DUDE_DATA
docker compose up -d
```

El panel queda en `http://127.0.0.1:4321` **del anfitrión**, a propósito. Para
llegarle desde otra máquina:

```bash
ssh -L 4321:127.0.0.1:4321 usuario@servidor
```

> ⚠️ **No lo publiques en una placa pública sin poner un proxy inverso con TLS
> real y autenticación delante.** No es paranoia de manual: en este mismo
> despliegue, encender el servidor web propio de The Dude dejó su login de 2011
> —con el certificado de ejemplo de MikroTik de 2005 y TLSv1— atendiendo desde
> internet, porque el puerto ya estaba abierto en el cortafuegos «sin nada
> detrás». Poner un servicio detrás de un puerto abierto lo convierte en puerta.

### Requisitos del origen

- `dude.db` accesible en un **sistema de archivos local**. Nunca NFS, CIFS ni
  virtiofs: SQLite depende de bloqueos POSIX confiables. Un *block device* de
  red (iSCSI, Ceph RBD, qcow2 sobre NFS) sí sirve.
- El directorio `files/` al lado, que es de donde salen los iconos SVG: en la
  base sólo está el índice, los bytes están en disco.

---

## Estructura

```
docs/FORMATO-DUDE.md   El contrato: cómo se lee el formato binario de The Dude.
                       Todo medido sobre una base real de 14.925 objetos.
etl/dudeobj.py         Decodificador. Sólo lectura, sin credenciales.
etl/schema.sql         Esquema de PostgreSQL. El contrato con el frontend.
etl/sync.py            El servicio de sincronización.
web/                   Astro + Tailwind, SSR.
```

**Empezá por `docs/FORMATO-DUDE.md`.** MikroTik nunca documentó este formato y
no lo va a hacer: 4.0beta3 es de enero de 2011, es la última versión para
Windows y está discontinuada.

Eso, que suena a problema, **es la garantía del proyecto: el formato no puede
cambiar porque el proveedor se fue.**

---

## Cómo se verificó que el decodificador acierta

The Dude trae un servidor web propio que muestra los mismos datos en tablas.
Está apagado de fábrica y se puede encender.

**Ese es el oráculo**: cualquier duda de semántica se resuelve comparando la
salida del panel contra la suya, servicio por servicio, 859 veces. Convierte la
ingeniería inversa de un formato binario en algo demostrable, no en una apuesta.

---

## Estado

Los números de referencia, de una instalación real:

| | |
|---|---:|
| Dispositivos | 885 |
| Servicios monitoreados | 859 |
| Enlaces | 1.171 |
| Mapas | 40 |
| Elementos de mapa dibujados | 2.317 |
| Objetos totales en el origen | 14.925 |

---

## Licencia

MIT.

The Dude es marca de MikroTik. Este proyecto **no lo incluye, no lo modifica y
no lo redistribuye**: sólo lee su base de datos, en sólo lectura.
