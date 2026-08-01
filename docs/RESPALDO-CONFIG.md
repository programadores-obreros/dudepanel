# Respaldo de la configuración de los equipos

> 🔴 **Este es el primer módulo del proyecto que se conecta a la red.** Todo lo
> demás lee una base de datos. Esto habla con los routers, así que arranca
> **apagado** y no se enciende solo.

Para un ISP la configuración de un router vale más que cualquier gráfico. Con
el `export` de ayer, una placa quemada vuelve en diez minutos. Sin él, el
equipo se rearma de memoria y lo que faltaba aparece durante la semana
siguiente, de a un cliente por vez.

---

## 🔴 Lo primero: la herramienta obvia no sirve acá

Lo natural era copiar a **Oxidized** o **RANCID**: entrar por SSH y correr
`/export`. Se midió antes de escribir una línea, escaneando **sólo puertos
TCP** —sin intentar ningún login— contra los 25 RouterOS que estaban arriba en
la red real el 01/08/2026:

| puerto | qué es | equipos | |
|---:|---|---:|---|
| 8728 | API de RouterOS | **16** | 64 % |
| 8291 | Winbox | 12 | 48 % |
| 8729 | API sobre TLS | 9 | 36 % |
| **22** | **SSH** | **5** | **20 %** ← el que usa Oxidized |
| 80 | web | 4 | 16 % |

**Un respaldo por SSH llegaría al 20 % de los equipos.** Y peor: los 5 que
tienen el 22 abierto tienen **también** el 8729, así que SSH no suma un solo
equipo que la API no alcance. Habría sido construir la herramienta equivocada
y enterarse después de tenerla andando.

## Y el número que decide el trabajo pendiente

Tomando para cada equipo el camino **más seguro** que tiene disponible:

| clasificación | equipos | |
|---|---:|---|
| **API sobre TLS** (8729) | **9** | 36 % — se puede respaldar sin exponer nada |
| sólo 8728, en claro | 7 | 28 % — la contraseña viajaría sin cifrar |
| sin puerto de administración | 9 | 36 % — no hay por dónde entrar |

**Sólo un tercio de los routers se puede respaldar hoy sin regalar la
credencial.** Ese es el hallazgo, no un detalle: antes de encender esto hay
trabajo de configuración **en los equipos**.

Habilitar la API segura en RouterOS es una línea:

```
/ip service set api-ssl disabled=no
```

Hacerlo en los 7 que hoy sólo tienen el 8728 sube la cobertura segura de 36 % a
64 % y no cuesta nada. **Es lo primero que haría antes de encender el respaldo.**

---

## Las cinco decisiones, y por qué

**1 · La credencial no va a la base ni al repositorio.** Va por entorno, y sólo
la lee este módulo. La base del panel se replica, se respalda y se consulta
desde la interfaz: una contraseña de router ahí es una contraseña de router en
cada copia de Postgres y a un `SELECT` de distancia de cualquier fallo de la
aplicación.

**2 · Por omisión no se conecta a nada.** Sin `RESPALDO_USUARIO` y
`RESPALDO_CLAVE`, corre el relevamiento de puertos —que no necesita ninguna— y
nada más. Encender algo que entra a 155 routers tiene que ser un acto
deliberado, no lo que pasa si nadie hace nada.

**3 · El puerto en claro exige permiso aparte.** No alcanza con tener la
credencial: hay que poner `RESPALDO_PERMITIR_CLARO=1` sabiendo que por el 8728
la contraseña cruza la red de gestión sin cifrar. Por omisión está prohibido y
el módulo dice a cuántos equipos deja afuera.

**4 · Se guarda texto, no un binario.** El `/export` es texto y eso es lo que
permite ver **qué** cambió entre ayer y hoy. Un `.backup` binario sólo sirve
para restaurar, no para auditar — y la pregunta de las tres de la mañana casi
nunca es «restaurame todo», es «¿qué tocaron?».

**5 · No se guarda todo.** El export trae claves de PPPoE, de wireless y
comunidades SNMP. Se tachan antes de escribir, **dejando el nombre del campo**:
así el diff sigue pudiendo decir «acá cambió la contraseña» sin guardar cuál
es. Un respaldo que duplica todas las contraseñas del ISP en otra base no es
una solución, es un problema nuevo con nombre de solución.

> ⚠️ Se usa `/export hide-sensitive` **y además** el tachado propio. Lo segundo
> existe porque lo primero depende de que alguien se acuerde del parámetro.
>
> Y si un día el tachado devuelve **cero** sobre un export de más de 40 líneas,
> el módulo avisa: lo más probable no es que el router no tenga secretos, sino
> que cambió el formato y la expresión dejó de reconocerlos.

---

## Lo que este respaldo NO garantiza

**El TLS del 8729 cifra, pero no autentica al equipo.** RouterOS genera un
certificado autofirmado por router; verificarlo contra una autoridad fallaría
en los 155 y la única salida sería apagar TLS, que es peor.

O sea: protege de que **alguien lea** la contraseña en la red, no de que
alguien **se haga pasar** por el router. Cerrar eso requiere poner certificados
propios en los equipos — trabajo de configuración, no de código.

Se dice acá porque una garantía a medias que se cree completa es peor que
ninguna.

---

## Cómo encenderlo

```bash
# 1 · Relevar primero. No necesita credenciales y contesta la pregunta que
#     hoy nadie puede contestar: ¿a cuántos de mis routers podría llegar?
python -m respaldo relevar

# 2 · Crear en los equipos un usuario SÓLO de lectura. No usar el de
#     administración: este proceso corre solo, todas las noches.
#     En RouterOS:
#       /user group add name=respaldo policy=read,api,!write,!policy,!ftp
#       /user add name=respaldo group=respaldo password=...

# 3 · Recién ahí, las credenciales por entorno
export RESPALDO_USUARIO=respaldo
export RESPALDO_CLAVE='…'
```

> 🔴 **Un usuario de sólo lectura, no el de administración.** Si mañana este
> panel tiene un fallo, la diferencia entre una credencial que puede leer y una
> que puede escribir es la diferencia entre una fuga y una red reconfigurada
> por otro.

## Estado

| | |
|---|---|
| Relevamiento de puertos | ✅ anda, sin credenciales |
| Cliente de la API de RouterOS | ✅ escrito y probado sobre bytes |
| Tachado de secretos | ✅ 21 pruebas |
| Almacenamiento con versiones y diff | ⏳ pendiente |
| Programación automática | ⏳ pendiente |
| Equipos que no son RouterOS | ⏳ los 730 restantes; hay Ubiquiti y Cambium |
