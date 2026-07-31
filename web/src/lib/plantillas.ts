/**
 * Los rótulos del mapa son PLANTILLAS, no texto.
 *
 * 🔴 Esto es lo que hacía ilegible el mapa: The Dude guarda en `label` una
 *    plantilla y la resuelve recién al dibujar. El panel la mostraba literal,
 *    así que en pantalla se leía `[Device.Name] [dev…` en vez del nombre del
 *    equipo. Medido sobre la base real: **2.216 de los 2.317 elementos** traen
 *    al menos una plantilla — el 96 %.
 *
 * Se resuelve acá, en el render, y no en el ETL: `[Device.ServicesDown]` y los
 * contadores de submapa cambian con el estado de la red, y congelarlos hasta la
 * próxima sincronización pondría un número viejo en pantalla sin avisar.
 *
 * ── Las cinco salidas posibles de un campo ──────────────────────────────────
 *
 *  1. **Valor.** Tenemos el dato. Se escribe.
 *  2. **Sin valor** (`—`). Conocemos el campo y para ESTE objeto no hay nada:
 *     un equipo sin dirección cargada. Un guion, no una cadena vacía que deje
 *     la línea fantasma.
 *  3. **Silencio.** Tenemos el dato y su lectura honesta es NADA. Es el caso de
 *     «cero servicios caídos»: no es un hueco ni un faltante, es el estado
 *     normal, y el estado normal no se anuncia. Ver `Device.ServicesDown`.
 *  4. **Sin replicar.** Conocemos el campo y el panel no tiene de dónde
 *     sacarlo. No se escribe nada y **se cuenta**: el visor lo declara al pie.
 *     Si además es lo único que había en esa línea, la línea se descarta — lo
 *     que quedaría es andamio («Rx: », «Tx: ») sin ningún dato adentro.
 *  5. **Desconocida** (`‹?›`). Una plantilla que no está en esta tabla. Se
 *     marca en pantalla y se cuenta, para que se pueda agregar después.
 *
 * Lo que NUNCA pasa: mostrar la plantilla cruda, o inventar un número. Un
 * enlace que dice `[Interface.InBitRate]` es basura; uno que no dice nada y lo
 * declara al pie es honesto; uno que dice `0 Mbps` cuando no sabemos es una
 * mentira, y en un panel de monitoreo una mentira cuesta una salida a terreno.
 *
 * ── 🔴 Y dos campos pegados JAMÁS se concatenan ─────────────────────────────
 *
 * The Dude deja escribir campos sin nada en el medio, y en la base hay 3.259
 * adyacencias así. Concatenar sus valores fabrica un dato que no existe:
 *
 *     [Device.ServicesDown][Device.AddressesColumn]
 *       0  +  192.0.2.104   →   «0192.0.2.104»      ← visto en pantalla
 *       3  +  192.0.2.104   →   «3192.0.2.104»      ← peor: parece una IP
 *
 * Eso no es un problema estético, es **un número inventado con forma de
 * dirección**, que es justo lo que este resolvedor existe para no hacer. La
 * regla, entonces: dos campos que emiten texto nunca quedan pegados. Si alguno
 * de los dos es de bloque (`Column`) se separan con un salto de línea; si no,
 * con ` · `. Entre campo y texto literal no hace falta: el literal ya separa.
 */

import { bitsPorSegundo, duracion } from './formato';

/** Conocemos el campo, pero este objeto no tiene valor para él. */
export const SIN_VALOR = '—';
/** No sabemos qué es esta plantilla. Que se vea. */
export const DESCONOCIDA = '‹?›';
/** Une dos campos que la plantilla dejó pegados y que no son de bloque. */
export const SEPARADOR = ' · ';

/**
 * Sabemos leer el campo, y para ESTE objeto no hay dato utilizable.
 *
 * 🔴 Es la sexta salida, y hubo que agregarla el 31/07/2026 por un error caro:
 *    el tráfico de los enlaces estaba marcado como «no replicado» —o sea, «el
 *    panel no sabe de dónde sacarlo»— cuando en realidad el panel sí sabe y lo
 *    que faltaba era la serie de ese enlace en particular. Son cosas distintas:
 *    la primera es una carencia del panel y se arregla programando; la segunda
 *    es una carencia del dato y se arregla mirando por qué esa fuente no
 *    reporta. Meterlas en la misma bolsa hizo que nadie mirara ninguna.
 *
 * Se comporta como `sin-replicar` en pantalla (no escribe nada) pero se cuenta
 * aparte, y el pie del mapa las declara con textos distintos.
 */
export const SIN_DATO: unique symbol = Symbol('sin-dato');

/** Recuentos de un submapa, calculados en vivo. Ver `resumenSubmapas`. */
export interface ConteoSubmapa {
  total: number;
  arriba: number;
  parciales: number;
  caidos: number;
}

/**
 * Una medición de tráfico ya leída de `chart_values`, con su edad.
 *
 * 🔴 La edad viaja JUNTO al valor y no se calcula al formatear. Motivo: el
 *    resolvedor tiene que ser puro para poder probarlo, y «hace cuánto» depende
 *    del reloj. Se resuelve una vez por dibujo, en `construirLienzo`, contra un
 *    único `ahora`; así los 1.169 rótulos de un mapa hablan todos del mismo
 *    instante en vez de correrse unos milisegundos entre ellos.
 */
export interface Medicion {
  /** El valor crudo, en bits por segundo (`chart_sources.unit` dice `bit/s`). */
  bits: number;
  /** Antigüedad de la muestra, en segundos. */
  edad_s: number;
}

/** Todo lo que un rótulo puede llegar a pedir sobre el elemento que lo lleva. */
export interface DatosRotulo {
  /** Nombre del objeto: equipo, submapa o enlace. */
  nombre?: string | null;
  direcciones?: readonly string[] | null;
  serviciosCaidos?: number | null;
  submapa?: ConteoSubmapa | null;
  /** Última medición de tráfico del enlace, por sentido. Ver `Medicion`. */
  entrada?: Medicion | null;
  salida?: Medicion | null;
}

/**
 * Una plantilla que quedó sin resolver, y cuántas veces apareció en el mapa.
 *
 * 🔴 `resueltos` no es decoración: es lo que convierte el pie del mapa en una
 *    medición en caliente en vez de una afirmación que envejece.
 *
 *    Este archivo llegó a decir, con números adentro y sonando muy sólido, que
 *    sólo el 0,4 % de los enlaces tenía tráfico. Era verdad **el día que se
 *    midió** —el ETL replica la serie de a 250.000 filas por vuelta y recién
 *    arrancaba— y quedó escrito como si fuera una propiedad del sistema. Hoy la
 *    cobertura real es del 14,8 %, y la funcionalidad estuvo apagada por una
 *    medición vencida. **Una cobertura medida una vez no es una propiedad del
 *    sistema.** Por eso ahora se cuenta en cada dibujo y se muestra al pie.
 */
export interface Hueco {
  /** Tal cual está en la base: `[Interface.InBitRate]`. */
  plantilla: string;
  /** Cómo nombrarla frente al operador. */
  como: string;
  motivo: 'sin-replicar' | 'desconocida' | 'sin-dato';
  /** Cuántas veces se pidió y no se pudo escribir. */
  veces: number;
  /** Cuántas veces se pidió y SÍ salió un valor, en este mismo dibujo. */
  resueltos: number;
}

/**
 * Un campo de plantilla de The Dude.
 *
 * Sin `resolver` significa «lo conocemos y no lo tenemos»: es una declaración
 * explícita, no un olvido. La diferencia con una plantilla desconocida importa,
 * porque la primera se puede planificar y la segunda hay que investigarla.
 */
interface Campo {
  como: string;
  /**
   * El campo ocupa renglones propios y nunca se pega a lo que tenga al lado.
   *
   * Son los `…Column` de The Dude, y el nombre no es casual: no son un valor,
   * son un bloque. `[Device.AddressesColumn]` de un equipo con tres IPs son
   * tres renglones; pegarle algo adelante corrompe el primero.
   */
  bloque?: boolean;
  /**
   * Qué escribir. Tres retornos especiales, y las diferencias importan:
   *
   *  · `null`      → el campo existe y este objeto no tiene valor → se escribe `—`.
   *  · `''`        → tenemos el valor y su lectura honesta es NADA → no se escribe.
   *  · `SIN_DATO`  → sabemos leerlo y para este objeto no hay dato utilizable →
   *                  no se escribe y se CUENTA aparte. Ver `SIN_DATO`.
   */
  resolver?: (d: DatosRotulo) => string | null | typeof SIN_DATO;
}

const CAMPOS: Record<string, Campo> = {
  // ── Equipo ────────────────────────────────────────────────────────────────
  'Device.Name': {
    como: 'nombre del equipo',
    resolver: (d) => limpio(d.nombre),
  },
  'Device.FirstAddress': {
    como: 'primera dirección',
    resolver: (d) => limpio(d.direcciones?.[0]),
  },
  // 🔴 Una dirección POR LÍNEA, que es lo que dice el nombre del campo. El
  //    salto se resuelve acá y lo parte después `partirTexto`, igual que
  //    cualquier rótulo multilínea.
  'Device.AddressesColumn': {
    como: 'direcciones del equipo',
    bloque: true,
    resolver: (d) => (d.direcciones?.length ? d.direcciones.join('\n') : null),
  },
  // 🔴 Con cero NO se escribe nada, y es una decisión, no un descuido.
  //
  //    Medido sobre la base real: de los 761 elementos que llevan este campo,
  //    **522 tienen cero** y 239 un número que importa. «Cero servicios caídos»
  //    es el estado normal de un equipo sano: decirlo en 522 nodos no informa,
  //    decora. Y encima el rótulo más usado del mapa —610 elementos— tiene este
  //    campo solo en su segunda línea, así que el mapa entero quedaba salpicado
  //    de ceros sueltos que además no aclaraban cero DE QUÉ.
  //
  //    Con valor sí se escribe, y con la unidad puesta: un `2` suelto bajo el
  //    nombre de un equipo no dice si son servicios, interfaces o vecinos.
  //
  //    ⚠️ Ojo con generalizar esto a los contadores de submapa de más abajo:
  //       ahí el cero SÍ informa, porque va posicionado entre barras. Medido:
  //       31 de los 33 submapas tienen un 0 en el medio, y silenciarlo
  //       imprimiría «24 /  / 5». Ver el comentario de `NetMap.DevicesCount`.
  'Device.ServicesDown': {
    como: 'servicios caídos',
    resolver: (d) => {
      const n = d.serviciosCaidos;
      if (n == null) return null;
      if (n <= 0) return '';
      return `${n} caído${n === 1 ? '' : 's'}`;
    },
  },

  // ── Submapa ───────────────────────────────────────────────────────────────
  'NetMap.Name': {
    como: 'nombre del submapa',
    resolver: (d) => limpio(d.nombre),
  },
  // 🔴 Estos tres SÍ escriben el cero, al revés que `Device.ServicesDown`.
  //    No es una inconsistencia: los tres van posicionados entre barras
  //    —«24 / 0 / 5»— y ahí el cero es la información. Callarlo daría
  //    «24 /  / 5», y peor: «24 / 5» se leería como si los 5 fueran parciales.
  //    Medido: 31 de los 33 submapas tienen un 0 en el medio.
  'NetMap.DevicesCount': {
    como: 'equipos del submapa',
    resolver: (d) => (d.submapa ? String(d.submapa.total) : null),
  },
  'NetMap.DevicesDownCount': {
    como: 'equipos caídos del submapa',
    resolver: (d) => (d.submapa ? String(d.submapa.caidos) : null),
  },
  // Separado de los caídos porque The Dude lo separa: el rótulo de 145
  // elementos dice «total / parciales / caídos» y sumarlos cambiaría lo que
  // el operador viene leyendo desde 2011.
  'NetMap.DevicesPartiallyDownCount': {
    como: 'equipos con caída parcial del submapa',
    resolver: (d) => (d.submapa ? String(d.submapa.parciales) : null),
  },

  // ── Tráfico del enlace ────────────────────────────────────────────────────
  //
  // 🔴 ESTOS DOS ESTUVIERON APAGADOS POR ERROR, y vale contar exactamente cómo.
  //
  //    Son las plantillas MÁS frecuentes del mapa —1.169 elementos cada una— y
  //    las únicas que no salen de una columna: son el tráfico del enlace y
  //    viven en `chart_values` vía `chart_sources`. Acá decía, con números y
  //    todo, que resolverlas no valía la pena:
  //
  //      «de las 348 fuentes con link_id, sólo 10 tienen alguna muestra;
  //       esas 10 cubren 5 enlaces — el 0,4 %»
  //
  //    Eso era cierto el día que se midió, y el número no era el problema: el
  //    problema fue **escribir una foto como si fuera una propiedad**. El ETL
  //    replica la historia de a 250.000 filas por vuelta y 1,58 millones no
  //    entran de un saque, así que la cobertura sube sola con los días. Una
  //    medición vieja apagó una funcionalidad entera.
  //
  // 🔴 Y hay una segunda trampa, que se descubrió al arreglar la primera:
  //
  //        filas en chart_values:                  1.584.013
  //        filas CON valor (value IS NOT NULL):    1.039.093
  //        fuentes bit/s con algún valor:                 10   ← no 348
  //
  //    Contar FILAS por fuente dice que las 348 fuentes con enlace tienen
  //    mediciones. Contar VALORES dice que diez. La diferencia son 544.920
  //    filas que traen el instante y no traen el número: el balde existe y
  //    está vacío. Las dos cuentas se corren con la misma consulta y una sola
  //    palabra de diferencia, y dan órdenes de magnitud distintos.
  //
  //    Por eso `traficoDeMapa` pide `value IS NOT NULL` explícitamente, y por
  //    eso **acá no va ningún porcentaje**. La cobertura se cuenta EN CALIENTE,
  //    en cada dibujo, y el pie del mapa declara la que encontró esta vez. Un
  //    número escrito en un comentario vuelve a envejecer; uno calculado, no.
  //    Ver `Hueco.resueltos`.
  //
  // ── Y qué se considera «fresco» ───────────────────────────────────────────
  //
  //    Un número de hace tres días mostrado como si fuera de ahora es PEOR que
  //    un guion: el guion dice «no sé» y el número dice «así está la red», que
  //    es mentira. Tres escalones:
  //
  //      · hasta 20 min  → el valor solo. Es la cadencia del balde de 10 min
  //                        de The Dude más margen: es «ahora».
  //      · hasta 48 h    → el valor CON la edad pegada: «5,92 Gbps (12 h)».
  //      · más de 48 h   → no se escribe. Se cuenta como `sin-dato` y el pie lo
  //                        declara. Preferimos el hueco a la mentira.
  'Interface.InBitRate': {
    como: 'tráfico de entrada del enlace',
    resolver: (d) => trafico(d.entrada),
  },
  'Interface.OutBitRate': {
    como: 'tráfico de salida del enlace',
    resolver: (d) => trafico(d.salida),
  },

  // ── Conocidas y no replicadas ─────────────────────────────────────────────
  // El objeto `network` no trae subredes al esquema: los 2 elementos que la
  // usan no tienen ni `device_id` ni `submap_id` de dónde colgarse.
  'Network.SubnetsColumn': { como: 'subredes de la red', bloque: true },
};

/** Hasta acá una muestra es «ahora» y se escribe sola. */
export const TRAFICO_FRESCO_S = 20 * 60;
/** Más allá de esto no se escribe: el hueco es más honesto que el número. */
export const TRAFICO_VENCIDO_S = 48 * 3600;

/**
 * Un caudal listo para el rótulo, o `SIN_DATO` si no hay nada que se pueda
 * mostrar sin mentir.
 *
 * La edad va entre paréntesis y abreviada porque el rótulo del mapa se recorta
 * a 22 caracteres: `5,92 Gbps (12 h)` entra, `5,92 Gbps hace 12 horas` no.
 */
function trafico(m: Medicion | null | undefined): string | typeof SIN_DATO {
  if (!m || !Number.isFinite(m.bits) || m.bits < 0) return SIN_DATO;
  if (m.edad_s > TRAFICO_VENCIDO_S) return SIN_DATO;
  const valor = bitsPorSegundo(m.bits);
  return m.edad_s <= TRAFICO_FRESCO_S ? valor : `${valor} (${duracion(m.edad_s)})`;
}

/** `[algo()]`: una función de script de The Dude, que vive en su propia base. */
const FUNCION = /^([A-Za-z_][A-Za-z0-9_]*)\(\)$/;
/**
 * Cualquier cosa entre corchetes. No anidan: The Dude tampoco los anida.
 *
 * Va con grupo de captura y se usa con `split`, no con `replace`: partir la
 * línea en literales y campos alternados es lo que permite saber si dos campos
 * quedaron pegados. Con `replace` cada sustitución es ciega a su vecina, y de
 * ahí salía `0192.0.2.104`.
 */
const TOKEN = /\[([^[\]]*)\]/;

/**
 * Resuelve una plantilla de rótulo contra los datos del elemento.
 *
 * Devuelve el texto ya resuelto, todavía multilínea: partirlo y recortarlo es
 * trabajo de `partirTexto`, que ya sabe hacerlo para las fichas `static`.
 *
 * `huecos` es un acumulador opcional y compartido: el mapa más grande tiene 401
 * elementos y no tiene sentido armar un arreglo por cada uno para después
 * juntarlos.
 */
export function resolverRotulo(
  bruto: string | null | undefined,
  datos: DatosRotulo = {},
  huecos?: Map<string, Hueco>,
): string {
  if (!bruto) return '';
  if (!bruto.includes('[')) return bruto;

  const salida: string[] = [];

  for (const linea of bruto.split(/\r\n|\n|\r/)) {
    // Índices pares = texto literal; impares = el cuerpo de un campo.
    const partes = linea.split(TOKEN);

    let texto = '';
    let campos = 0;
    /** Campos que no escribieron nada: silenciosos o no replicados. */
    let callados = 0;
    /** El último que escribió fue un campo (no texto literal). */
    let veniaCampo = false;
    /** …y era de bloque, así que lo próximo también arranca en otro renglón. */
    let veniaBloque = false;

    for (let i = 0; i < partes.length; i++) {
      const parte = partes[i]!;

      if (i % 2 === 0) {
        if (!parte) continue;
        if (veniaBloque) texto = cortar(texto);
        texto += parte;
        veniaCampo = false;
        veniaBloque = false;
        continue;
      }

      campos++;
      const campo = campoDe(parte.trim());
      const escrito = escribir(campo, parte, datos, huecos);
      if (!escrito) {
        callados++;
        continue;
      }

      // 🔴 Acá se impide `0192.0.2.104`. Dos campos con texto nunca quedan
      //    pegados: si alguno es de bloque van en renglones distintos, y si no,
      //    los separa un punto medio.
      if (campo?.bloque || veniaBloque) texto = cortar(texto);
      else if (veniaCampo) texto += SEPARADOR;

      texto += escrito;
      veniaCampo = true;
      veniaBloque = !!campo?.bloque;
    }

    // Una línea cuyos campos NINGUNO escribió nada no dice nada: lo que queda
    // es el andamio del rótulo. `Rx: [Interface.InBitRate]
    // [snmp_wireless_link_rx_rate()]` sin ninguno de los dos números es «Rx: »,
    // y `[device_performance()][Device.ServicesDown]` con cero caídos es una
    // línea en blanco bajo 522 nombres de equipo.
    if (campos > 0 && callados === campos) continue;

    salida.push(texto);
  }

  return salida.join('\n');
}

/** Qué campo es, o `null` si no lo conocemos. */
function campoDe(clave: string): Campo | null {
  return CAMPOS[clave] ?? (FUNCION.test(clave) ? funcion(clave) : null);
}

/** Qué escribe un campo; cadena vacía si no escribe nada. Anota los huecos. */
function escribir(
  campo: Campo | null,
  cuerpo: string,
  datos: DatosRotulo,
  huecos: Map<string, Hueco> | undefined,
): string {
  const crudo = `[${cuerpo}]`;
  if (!campo) {
    anotar(huecos, crudo, `plantilla ${crudo}`, 'desconocida');
    return DESCONOCIDA;
  }
  if (!campo.resolver) {
    anotar(huecos, crudo, campo.como, 'sin-replicar');
    return '';
  }

  const v = campo.resolver(datos);

  // Sabemos leerlo y este objeto no tiene con qué. Se calla igual que
  // `sin-replicar` pero se cuenta aparte: una es carencia del panel y la otra
  // del dato, y confundirlas fue exactamente el error que apagó el tráfico.
  if (v === SIN_DATO) {
    anotar(huecos, crudo, campo.como, 'sin-dato');
    return '';
  }

  // Se cuenta el acierto también. Sin esto el pie sólo puede decir cuántas
  // veces falló, y «996 sin serie» a secas suena a que no funciona nada;
  // «996 sin serie · 173 con dato» describe el sistema que hay.
  anotarExito(huecos, crudo, campo.como);

  // `null` es «acá va un dato y no lo tengo» y se marca con un guion; `''` es
  // «lo tengo y no hay nada que decir» y se calla. Una línea que desaparece
  // sola no distingue las dos cosas, y son distintas.
  return v ?? SIN_VALOR;
}

/** Cierra el renglón en curso, si es que había alguno abierto. */
function cortar(texto: string): string {
  return texto === '' || texto.endsWith('\n') ? texto : texto + '\n';
}

/**
 * Los huecos del mapa, del más frecuente al menos. Para declararlos al pie.
 *
 * Filtra las plantillas que se resolvieron SIEMPRE: si `[Device.Name]` salió
 * bien en los 401 elementos, no hay nada que declarar. Lo que queda son las que
 * fallaron al menos una vez, y cada una viene con cuántas veces sí anduvo.
 */
export function huecosOrdenados(huecos: Map<string, Hueco>): Hueco[] {
  return [...huecos.values()]
    .filter((h) => h.veces > 0)
    .sort((a, b) => b.veces - a.veces || a.plantilla.localeCompare(b.plantilla));
}

/**
 * Las funciones de script (`device_performance()`, `snmp_wireless_link_info()`)
 * no son campos: son código que The Dude corre contra el equipo en el momento
 * de dibujar, y su cuerpo vive en la base de The Dude, no en el esquema que
 * replica el ETL. No hay forma de resolverlas desde acá, y por eso son
 * `sin-replicar` y no `desconocida`: sabemos exactamente qué son.
 */
function funcion(clave: string): Campo {
  return { como: `función de The Dude «${clave}»` };
}

function anotar(
  huecos: Map<string, Hueco> | undefined,
  plantilla: string,
  como: string,
  motivo: Hueco['motivo'],
): void {
  if (!huecos) return;
  const previo = huecos.get(plantilla);
  if (previo) {
    previo.veces++;
    // Un campo que a veces resuelve y a veces no queda con el motivo del
    // fallo, no con el del acierto: lo que hay que declarar es la falta.
    previo.motivo = motivo;
  } else {
    huecos.set(plantilla, { plantilla, como, motivo, veces: 1, resueltos: 0 });
  }
}

/** Igual que `anotar`, pero del lado que salió bien. Ver `Hueco.resueltos`. */
function anotarExito(
  huecos: Map<string, Hueco> | undefined,
  plantilla: string,
  como: string,
): void {
  if (!huecos) return;
  const previo = huecos.get(plantilla);
  if (previo) previo.resueltos++;
  else huecos.set(plantilla, { plantilla, como, motivo: 'sin-dato', veces: 0, resueltos: 1 });
}

function limpio(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}
