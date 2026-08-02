import type { ElementoMapa, ResumenSubmapa, TraficoEnlace } from './consultas';
import type { Medida } from './iconos';
import { aEstado, estadoAgregado, type Estado } from './estado';
import { antiguedadDe, segundosDesde, type Antiguedad } from './antiguedad';
import { clasificar, type Vida } from './vida';
import {
  DESCONOCIDA,
  huecosOrdenados,
  resolverRotulo,
  SIN_VALOR,
  type DatosRotulo,
  type Hueco,
} from './plantillas';

/**
 * Convierte las filas de `v_map_canvas` en geometría lista para dibujar.
 *
 * Es una función pura y sin dependencias de la base a propósito: es la parte
 * del visor que más fácil se rompe (coordenadas, enlaces colgados, elementos
 * sin posición) y así se puede probar sola.
 */

/** Lado del recuadro de un nodo, en unidades del lienzo original de The Dude. */
export const TAMANIO_NODO = 36;

/**
 * ── Cuánto mide el icono de un nodo ─────────────────────────────────────────
 *
 * 🔴 The Dude guarda una escala POR ELEMENTO (`map_elements.image_scale`, un
 *    porcentaje) y el visor la tiraba: dibujaba los 499 iconos en un cuadro
 *    fijo de 22×22. Dos consecuencias, y la segunda era peor que la primera:
 *
 *     1. Se aplanaba el mapa. El operador puso `olt-tplink.png` al 100 % y
 *        `nanoloco5m_izq.png` al 7 % en el MISMO mapa, y los dos salían iguales.
 *     2. Se destrozaba la proporción. Con un cuadro de 22×22 y
 *        `preserveAspectRatio=meet`, una foto de 467×92 entraba como **22×4**:
 *        una astilla de cuatro píxeles de alto. Por eso «no se reconocían».
 *
 * ── Por qué no se copia la fórmula de The Dude ──────────────────────────────
 *
 * The Dude dibuja `natural × escala/100`. Medido sobre la base real, eso pide
 * lados de 15 a 628 unidades, con mediana 97. Y no entra: la distancia mediana
 * al nodo vecino es 131 unidades, así que el 23 % de los iconos taparía al de
 * al lado, algunos por 8×. Recortar con un techo tampoco sirve — en `Ponte`,
 * 57 de sus 61 iconos quedan pegados a cualquier techo usable y el mapa vuelve
 * a quedar plano, que es justo el defecto que se viene a arreglar.
 *
 * Lo que importa del dato del operador no es la magnitud absoluta: es el ORDEN.
 * Así que se comprime el rango con una raíz cuadrada, que preserva el orden
 * entero y mete un rango de 42× dentro de uno de 4×. Medido con la curva de
 * abajo sobre los 433 iconos rasterizados de la base:
 *
 *     lado mediano 43 · rango 20–88 · sólo 3 % tapa a un vecino
 *     tamaños distintos — AViveroS 9 (antes 1) · MGomez 6 · Ponte 19
 *
 * La raíz no es decoración estadística: el ojo juzga el tamaño de una figura
 * por su ÁREA, no por su lado. Comprimir el lado con una raíz hace que el área
 * dibujada crezca en proporción a lo que pidió el operador.
 *
 * ── El costo de la compresión, dicho ────────────────────────────────────────
 *
 * Verificado el 31/07/2026 sobre los 1.047 nodos: la curva **conserva el orden
 * entero** —0 inversiones en 113.796 pares comparados— pero el rango dinámico
 * cae de 41,9× a 4,4×, y **36 nodos quedan pegados al techo de 88**. Entre esos
 * 36, la diferencia de tamaño que puso el operador ya no se ve.
 *
 * Es un costo elegido, no un descuido: la alternativa es que el 23 % de los
 * iconos tape al vecino. Pero que esté escrito acá, porque el día que alguien
 * pregunte «por qué estos dos se ven iguales si en The Dude no lo son», la
 * respuesta es esta y no un bug.
 */

/** Lado que se le da a un icono «típico», el que pide 100 unidades. */
const LADO_BASE = 44;
/** Debajo de esto es una mancha, por más que la escala diga 5 %. */
const LADO_MINIMO = 20;
/** Arriba de esto empieza a tapar al vecino. La mediana de vecinos es 131. */
const LADO_MAXIMO = 88;
/** Lado que se le supone a lo que no se puede medir. Es la mediana medida. */
const PEDIDO_TIPICO = 100;
/**
 * Lado de un nodo que NO tiene ninguna imagen asignada. El de toda la vida.
 *
 * 🔴 Son mayoría: 563 de los 1.047 nodos de la base real, y 554 de ellos con la
 *    escala en 100 — que ahí no es una decisión sino el valor de fábrica de una
 *    columna que nadie tocó, porque no hay imagen que escalar. Agrandarlos
 *    junto con los demás llenaba el mapa de dibujos de repuesto enormes que no
 *    dicen nada y le comen el lugar a los que sí traen una foto.
 *
 *    Dejándolos como estaban, el tamaño pasa a significar algo: un nodo grande
 *    es un nodo del que alguien se tomó el trabajo de cargar una foto.
 */
const LADO_SIN_ICONO = 22;

/**
 * 🔴 El lado MENOR de una foto no puede bajar de esto. La astilla, parte dos.
 *
 * `ladoDeIcono` dimensiona el lado MAYOR. Con eso alcanzaba para que un icono
 * no fuera diminuto… y no alcanzaba para que se pudiera reconocer. Medido sobre
 * la base real el 31/07/2026:
 *
 *     rb1100.png · natural 200×40 · escala 60 · 14 elementos
 *       lado mayor 48,2  →  caja dibujada  48,2 × 9,6
 *
 * **Nueve coma seis unidades de alto.** Sobre un mapa cuya distancia mediana
 * entre nodos es 131, eso es una línea. La proporción era correcta —la foto no
 * se deformaba— y aun así no se veía nada, que es exactamente el defecto que
 * este archivo ya había arreglado una vez desde el otro lado.
 *
 * La corrección es crecer la caja ENTERA hasta que el lado menor llegue acá,
 * conservando la proporción. No se recorta ni se estira: se agranda.
 */
const LADO_MENOR_MINIMO = 16;
/**
 * Tope del lado mayor cuando la caja tuvo que crecer para respetar el mínimo.
 *
 * Por encima de `LADO_MAXIMO` a propósito: una foto apaisada de 5:1 que respete
 * 16 de alto necesita 80 de ancho, y negárselo la devuelve a ser una astilla.
 *
 * 🔴 120 y no 96, y el número salió del barrido sobre los 40 mapas reales, no
 *    de una estimación. Con 96 quedaba un caso afuera:
 *
 *      images/RB2011iL-rack.png · 799×105 · 7,6:1 · al 20 %  →  96 × 12,6
 *
 *    Doce coma seis. Para que ese lado corto llegue a 16 el ancho tiene que
 *    poder llegar a 122. 120 es lo más cerca que se puede estar sin cruzar la
 *    distancia mediana entre nodos vecinos, que está medida en 131: pasarse de
 *    ahí es empezar a tapar al de al lado, que rompe el mapa entero en vez de
 *    un icono. Con 120 el caso queda en 120 × 15,8 y todos los demás entran.
 */
const LADO_MAXIMO_CRECIDO = 120;

/**
 * Cuánto mide el icono de este nodo, en unidades del lienzo.
 *
 * `medida` es el tamaño natural del archivo; puede faltar —los SVG no tienen
 * uno comparable en píxeles, y un archivo puede no estar— y entonces se lo
 * trata como el caso típico, que deja la escala mandando igual.
 */
export function ladoDeIcono(escala: number | null | undefined, medida?: Medida | null): number {
  // `image_scale` puede venir nula, y 0 o negativo no es una escala.
  const esc = esNum(escala) && escala > 0 ? escala : 100;
  const natural = medida ? Math.max(medida.ancho, medida.alto) : PEDIDO_TIPICO;
  const pedido = (natural * esc) / 100;
  const lado = LADO_BASE * Math.sqrt(pedido / PEDIDO_TIPICO);
  return Math.round(Math.min(Math.max(lado, LADO_MINIMO), LADO_MAXIMO) * 10) / 10;
}

/**
 * La caja del icono, ya con la proporción del archivo y con un piso de
 * legibilidad en el lado menor.
 *
 * Devolver ancho y alto por separado —y no un cuadrado— fue la primera mitad
 * del arreglo: es lo que impide que una foto apaisada de 467×92 se dibuje como
 * una astilla dentro de un cuadro que no le corresponde.
 *
 * 🔴 La segunda mitad es `LADO_MENOR_MINIMO`, y faltaba: la proporción quedaba
 *    perfecta y el resultado seguía sin verse, porque `ladoDeIcono` dimensiona
 *    el lado MAYOR y el menor caía solo. Hay una prueba que barre todos los
 *    iconos de la base con todas sus escalas y falla si alguna caja baja del
 *    piso. Ver `test/legibilidad.test.ts`.
 */
export function cajaDeIcono(
  icono: string | null | undefined,
  escala: number | null | undefined,
  medida?: Medida | null,
): { ancho: number; alto: number } {
  // Sin imagen asignada no hay nada que escalar: la escala que traiga la fila
  // es el valor de fábrica, no una intención. Ver `LADO_SIN_ICONO`.
  if (!icono) return { ancho: LADO_SIN_ICONO, alto: LADO_SIN_ICONO };

  const lado = ladoDeIcono(escala, medida);
  if (!medida || medida.ancho <= 0 || medida.alto <= 0) return { ancho: lado, alto: lado };

  const mayor = Math.max(medida.ancho, medida.alto);
  let ancho = (medida.ancho / mayor) * lado;
  let alto = (medida.alto / mayor) * lado;

  // Crecer, no recortar: la foto no se deforma nunca, la caja se agranda hasta
  // que el lado corto se pueda mirar. El tope evita que una proporción extrema
  // se coma al vecino.
  const menor = Math.min(ancho, alto);
  if (menor > 0 && menor < LADO_MENOR_MINIMO) {
    const factor = Math.min(LADO_MENOR_MINIMO / menor, LADO_MAXIMO_CRECIDO / Math.max(ancho, alto));
    if (factor > 1) {
      ancho *= factor;
      alto *= factor;
    }
  }

  const r = (n: number) => Math.round(n * 10) / 10;
  return { ancho: r(ancho), alto: r(alto) };
}

export interface Nodo {
  id: number;
  /** Centro del nodo. The Dude guarda la esquina superior izquierda. */
  cx: number;
  cy: number;
  kind: 'device' | 'network' | 'submap';
  estado: Estado;
  /**
   * Nombre para leer y para anunciar: título, `aria-label` y pista del icono.
   * Es la plantilla ya resuelta y SIN recortar — al lector de pantalla no le
   * sirve `Vega_P_Aurora_A…`.
   */
  nombre: string;
  /**
   * El rótulo dibujable, ya resuelto y partido en renglones.
   *
   * 🔴 Son varios a propósito. El rótulo típico de The Dude trae dos líneas
   *    —nombre y dirección— y antes se metían en un solo `<text>`, donde el
   *    salto colapsa a un espacio y el recorte de 20 caracteres se comía la
   *    segunda. Ver `partirTexto`.
   */
  lineas: string[];
  icono: string | null;
  /** Caja del icono en unidades del lienzo, ya con la proporción del archivo. */
  ancho: number;
  alto: number;
  href: string | null;
  direcciones: string[];
  /** `true` si el elemento no traía coordenadas y se lo ubicó en la grilla. */
  reubicado: boolean;
  /** Id del equipo, para pedirle la tarjeta al servidor. Nulo si no es uno. */
  deviceId: number | null;
  /** Desde cuándo está en este estado. Ver `consultas.estado_desde`. */
  desde: string | null;
  /** Antigüedad del estado. `null` si está arriba o no se sabe desde cuándo. */
  antiguedad: Antiguedad | null;
  /** Antigüedad en segundos, para el texto exacto. */
  edad_s: number | null;
  /**
   * ¿Sigue en servicio, o es arrastre de un mapa que nadie actualizó?
   *
   * 🔴 NO se confunde con `antiguedad`, aunque las dos hablen de tiempo.
   *
   *    `antiguedad` mide hace cuánto que el nodo está COMO ESTÁ: un equipo
   *    caído hace un año es `residuo`. `vida` mide si el equipo EXISTE: ese
   *    mismo nodo puede ser un router apagado que mañana vuelve, o un poste
   *    que se desmontó en 2021. Son dos preguntas y la segunda decide si el
   *    nodo se dibuja.
   *
   * `null` cuando el elemento no es un equipo —un rótulo, un submapa— y por
   * lo tanto no tiene vida que medir. Esos se dibujan siempre.
   */
  vida: Vida | null;
  /** Por qué dio esa clasificación. Va en el globito: esconder exige explicar. */
  vidaMotivo: string | null;
}

export interface Enlace {
  id: number;
  /** Ids de los dos nodos que une; el refresco en vivo los vuelve a mirar. */
  de: number;
  a: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ancho: number;
  nombre: string | null;
  /**
   * El rótulo resuelto, cuando dice algo ADEMÁS del nombre: hoy, el tráfico.
   *
   * 🔴 Va aparte de `nombre` y no lo reemplaza. Antes era `e.name || rotulo`, o
   *    sea que el nombre del enlace ganaba y el rótulo se tiraba. Con el
   *    tráfico apagado eso no se notaba —el rótulo quedaba vacío igual—, pero
   *    en cuanto se encendió, los 14 enlaces de `Ponte` que tienen nombre
   *    propio Y caudal medido mostraban sólo el nombre. El caudal es el dato
   *    que cambia durante una guardia; el nombre no cambia nunca.
   */
  detalle: string | null;
  estado: Estado;
}

/**
 * Elemento `static`: recuadro de anotación.
 *
 * 🔴 No son un adorno, y suponerlo costaba caro.
 *
 * En la base real son 100 y no dicen «eth2» a secas: son fichas de varias
 * líneas que describen la configuración de un puerto —
 *
 *     bndn-SW16-Primero
 *     v2703, v2701, v2216, v2214, v2211, v2213, v2218, v3210, v3215
 *     Tagged
 *
 * — y, sobre todo, **los enlaces se conectan a ellas**. En el mapa Segmentos, 212
 * de sus 308 enlaces tienen al menos una punta en un `static`. Tratarlos como
 * texto decorativo y sacarlos del grafo dejaba el mapa con 18 líneas de 107
 * dibujables: la red se veía desconectada.
 *
 * Así que anclan enlaces como cualquier nodo, pero **no son nodos**: no tienen
 * estado, ni icono, ni adónde llevar. Se dibujan como texto.
 */
export interface Rotulo {
  id: number;
  /** Esquina superior izquierda del bloque de texto. */
  x: number;
  y: number;
  /** Punto donde se enganchan los enlaces: el medio del borde izquierdo. */
  ax: number;
  ay: number;
  lineas: string[];
}

/** Alto de una línea de anotación, en unidades del lienzo. */
export const ALTO_LINEA = 12;
/** Alto de una línea del rótulo de un nodo. Más chica que la de una ficha. */
export const ALTO_LINEA_NODO = 10;
/** Más de esto no entra sin tapar el mapa; el texto completo va en el `<title>`. */
const MAX_LINEAS = 4;
const MAX_CARACTERES = 34;
/**
 * Límites del rótulo de un nodo, más apretados que los de una ficha `static`.
 *
 * El texto va centrado bajo un icono de 36 unidades y los nodos del mapa más
 * grande están a ~70 de distancia: tres renglones de 22 caracteres es lo que
 * entra sin que dos equipos vecinos se pisen las etiquetas.
 */
const MAX_LINEAS_NODO = 3;
const MAX_CARACTERES_NODO = 22;

/**
 * Enlaces que existen en el mapa pero no se pudieron dibujar, y por qué.
 *
 * Que falten líneas no es lo grave: lo grave sería no decirlo. Un operador que
 * abre Segmentos, ve 107 líneas donde hay 308 enlaces y no recibe ninguna
 * explicación, concluye que la red está menos conectada de lo que está.
 */
export interface DiagnosticoEnlaces {
  total: number;
  dibujados: number;
  /** Alguna punta vive en OTRO mapa. Se puede ir a verlo. */
  otroMapa: number;
  /** Alguna punta apunta a un objeto que ya no existe. Dato roto del origen. */
  rotos: number;
}

export interface Lienzo {
  nodos: Nodo[];
  enlaces: Enlace[];
  rotulos: Rotulo[];
  /** Caja del contenido, ya con margen. */
  vista: { x: number; y: number; ancho: number; alto: number };
  /** Elementos que venían sin coordenadas y hubo que acomodar. */
  sinPosicion: number;
  /** Cuántos enlaces traía el mapa y cuántos quedaron dibujados. */
  enlacesTotales: number;
  /**
   * Plantillas de rótulo que no se pudieron resolver, y cuántas veces.
   *
   * Misma regla que `DiagnosticoEnlaces`: que falte un dato no es lo grave,
   * lo grave sería no decirlo. El visor las declara al pie del mapa.
   */
  huecos: Hueco[];
}

const MARGEN = 60;
/** Separación de la grilla donde caen los elementos sin coordenadas. */
const PASO_GRILLA = 110;

/** Todo lo que `construirLienzo` necesita que no venga en las propias filas. */
export interface ContextoLienzo {
  submapas?: ReadonlyMap<number, ResumenSubmapa>;
  /** Tamaño natural de cada icono, por `rel_path`. Ver `medidasDeIconos`. */
  medidas?: ReadonlyMap<string, Medida>;
  /** Última medición de tráfico por `link_id`. Ver `traficoDeMapa`. */
  trafico?: ReadonlyMap<number, TraficoEnlace>;
  /**
   * El instante contra el que se miden TODAS las antigüedades de este dibujo.
   *
   * Uno solo para el mapa entero: con 401 elementos, tomar la hora por elemento
   * hace que dos nodos que cambiaron en el mismo segundo salgan con edades
   * distintas, y que un test que compara dos nodos sea escamoso.
   */
  ahora?: Date;
  /**
   * Cuántos días de historia hay, para clasificar la vida de cada nodo.
   *
   * 🔴 Si no viene, la vida queda en `null` para TODOS y el mapa se dibuja
   *    entero, como antes. Es el fallo seguro: ante la duda se muestra de más,
   *    nunca de menos. Esconder un equipo vivo porque a la página se le olvidó
   *    pasar un parámetro sería el peor de los dos errores posibles.
   */
  alcanceDias?: number;
}

/**
 * La vida de un elemento del mapa, o `null` si no corresponde preguntársela.
 *
 * Devuelve las dos claves juntas para que el armado del nodo sea un `...spread`
 * y no dos líneas que alguien pueda actualizar a medias.
 */
function vidaDe(
  e: ElementoMapa,
  alcanceDias: number | undefined,
): Pick<Nodo, 'vida' | 'vidaMotivo'> {
  // Sin equipo detrás no hay vida que medir: un rótulo o un submapa se dibujan
  // siempre. Y sin alcance, tampoco se clasifica — ver `ContextoLienzo`.
  if (e.device_id == null || alcanceDias === undefined) {
    return { vida: null, vidaMotivo: null };
  }
  const v = clasificar(
    {
      dias_sin_senal: e.dias_sin_senal ?? null,
      arriba_ahora: e.arriba_ahora ?? false,
      estado_manual: e.estado_manual ?? null,
    },
    alcanceDias,
  );
  return { vida: v.vida, vidaMotivo: v.motivo };
}

export function construirLienzo(
  elementos: readonly ElementoMapa[],
  submapas: ReadonlyMap<number, ResumenSubmapa> = new Map(),
  /** Tamaño natural de cada icono, por `rel_path`. Ver `medidasDeIconos`. */
  medidas: ReadonlyMap<string, Medida> = new Map(),
  ctx: ContextoLienzo = {},
): Lienzo {
  const trafico = ctx.trafico ?? new Map<number, TraficoEnlace>();
  const ahora = ctx.ahora ?? new Date();
  const nodos: Nodo[] = [];
  const porId = new Map<number, Nodo>();
  // Uno solo para todo el mapa: 2.216 rótulos con plantilla no necesitan 2.216
  // arreglos intermedios para después juntarlos.
  const huecos = new Map<string, Hueco>();

  const conPosicion = elementos.filter((e) => e.kind !== 'link' && e.kind !== 'static');

  // Los elementos sin coordenada se acomodan en una grilla debajo del contenido
  // en vez de descartarse: perder un equipo del mapa porque el ETL no le
  // encontró itemX es exactamente el bug que nadie nota hasta que se cae.
  const yBase = maximo(conPosicion.map((e) => e.y).filter(esNum), 0) + PASO_GRILLA * 1.5;
  const xBase = minimo(conPosicion.map((e) => e.x).filter(esNum), 0);
  let huerfanos = 0;

  for (const e of conPosicion) {
    const tieneXY = esNum(e.x) && esNum(e.y);
    let x: number;
    let y: number;
    if (tieneXY) {
      x = e.x as number;
      y = e.y as number;
    } else {
      x = xBase + (huerfanos % 8) * PASO_GRILLA;
      y = yBase + Math.floor(huerfanos / 8) * PASO_GRILLA;
      huerfanos++;
    }

    const submapa = e.submap_id != null ? (submapas.get(e.submap_id) ?? null) : null;
    const estado =
      e.kind === 'submap' && submapa ? submapa.estado : aEstado(e.status);

    // El rótulo se resuelve ANTES de partirlo: `[Device.AddressesColumn]` se
    // expande a varias líneas y tiene que poder generar sus propios saltos.
    const texto = resolverRotulo(e.label, datosDe(e, submapa), huecos);
    const lineas = partirTexto(texto, MAX_LINEAS_NODO, MAX_CARACTERES_NODO);
    const nombre = nombreDe(texto, e);

    // 🔴 LA CADENA DE ICONOS, y el segundo escalón estaba sin usar.
    //
    //    The Dude resuelve el dibujo de un nodo en dos pasos: primero el icono
    //    del ELEMENTO y, si no tiene, el del TIPO al que pertenece el equipo.
    //    Nosotros hacíamos sólo el primero, así que **123 elementos salían con
    //    la cajita gris de repuesto teniendo su imagen a un JOIN de
    //    distancia** — el archivo existe en `files/`, el panel ya lo sirve con
    //    HTTP 200, y la columna estaba en la base desde el primer día.
    //
    //    Va con la escala del TIPO, no la del elemento: `image_scale` del tipo
    //    «Algun dispositivo» es 60, y son 122 de esos 123 equipos. Usar la del
    //    elemento con la imagen del tipo la dibujaría al tamaño equivocado.
    const icono = e.icon ?? e.icon_tipo ?? null;
    const escala = e.icon ? e.image_scale : e.image_scale_tipo;
    const caja = cajaDeIcono(icono, escala, icono ? medidas.get(icono) : null);

    // 🔴 Sólo los equipos tienen «desde cuándo»: sale de sus servicios. Un
    //    submapa agrega decenas de equipos con fechas distintas y una sola
    //    antigüedad para todos sería un promedio inventado, así que no lleva.
    const desde = e.kind === 'device' ? (e.estado_desde ?? null) : null;
    const edad_s = segundosDesde(desde, ahora);

    const nodo: Nodo = {
      id: e.element_id,
      cx: x + TAMANIO_NODO / 2,
      cy: y + TAMANIO_NODO / 2,
      ancho: caja.ancho,
      alto: caja.alto,
      kind: e.kind as Nodo['kind'],
      estado,
      nombre,
      deviceId: e.device_id ?? null,
      desde,
      edad_s,
      antiguedad: antiguedadDe(estado, desde, ahora),
      ...vidaDe(e, ctx.alcanceDias),
      // Un nodo sin nada legible seguiría siendo un cuadrado anónimo en el
      // mapa. Si el rótulo se quedó sin líneas —`[Network.SubnetsColumn]` a
      // secas, por ejemplo— al menos se dibuja de qué elemento se trata.
      lineas: lineas.length ? lineas : [recortar(nombre, MAX_CARACTERES_NODO)],
      icono,
      href: hrefDe(e),
      direcciones: e.direcciones ?? [],
      reubicado: !tieneXY,
    };
    nodos.push(nodo);
    porId.set(nodo.id, nodo);
  }

  // Rótulos. Van ANTES de los enlaces porque también los anclan.
  const rotulos: Rotulo[] = [];
  for (const e of elementos) {
    if (e.kind !== 'static') continue;
    // Hoy ninguna de las 100 fichas trae plantilla, pero pasan por el mismo
    // resolvedor que el resto: si mañana alguien le pone `[Device.Name]` a una
    // anotación desde The Dude, se resuelve sola en vez de mostrar el corchete.
    const lineas = partirTexto(resolverRotulo(e.label ?? e.name, {}, huecos));
    if (!lineas.length || !esNum(e.x) || !esNum(e.y)) continue;
    rotulos.push({
      id: e.element_id,
      x: e.x,
      y: e.y,
      ax: e.x,
      ay: e.y + (lineas.length * ALTO_LINEA) / 2,
      lineas,
    });
  }

  // Puntos a los que un enlace se puede enganchar: nodos Y rótulos.
  // Los rótulos no tienen estado, así que no tiñen el enlace — un enlace a una
  // ficha de VLAN vale lo que valga el equipo del otro extremo.
  const anclas = new Map<number, { x: number; y: number; estado: Estado | null }>();
  for (const n of nodos) anclas.set(n.id, { x: n.cx, y: n.cy, estado: n.estado });
  for (const r of rotulos) anclas.set(r.id, { x: r.ax, y: r.ay, estado: null });

  // Un enlace con un extremo que no está en este mapa se descarta: dibujarlo
  // apuntando a (0,0) deforma el encuadre y confunde más de lo que informa.
  // Pero se CUENTA, y el visor lo declara. Ver `DiagnosticoEnlaces`.
  const enlaces: Enlace[] = [];
  let enlacesTotales = 0;
  for (const e of elementos) {
    if (e.kind !== 'link') continue;
    enlacesTotales++;
    // 🔴 Se resuelve SIEMPRE, aunque el enlace tenga nombre propio y el rótulo
    //    no vaya a usarse. Con `e.name || resolverRotulo(...)` el `||`
    //    cortocircuitaba y los 1.169 `[Interface.InBitRate]` del mapa no se
    //    contaban: el pie declaraba «device_performance()» y nada más. Un
    //    diagnóstico que se apaga solo cuando el dato no molesta no sirve.
    // 🔴 TODAS las líneas útiles, no la primera. El rótulo de un enlace de The
    //    Dude trae `Rx:` en un renglón y `Tx:` en el otro; quedarse con la
    //    primera tira la mitad del dato justo cuando por fin hay dato.
    const rotulo =
      lineasCrudas(resolverRotulo(e.label, datosDeEnlace(e, trafico, ahora), huecos))
        .filter((l) => l !== SIN_VALOR && l !== DESCONOCIDA)
        .join(' · ') || null;
    const propio = e.name?.trim() || null;

    const a = e.link_from != null ? anclas.get(e.link_from) : undefined;
    const b = e.link_to != null ? anclas.get(e.link_to) : undefined;
    if (!a || !b) continue;

    enlaces.push({
      id: e.element_id,
      de: e.link_from as number,
      a: e.link_to as number,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      // `link_width` viene en unidades de The Dude; 0 o nulo significa "el
      // grosor por defecto", no "invisible".
      ancho: Math.min(Math.max(e.link_width || 2, 1), 10),
      // `||` y no `??`: `links.name` llega como cadena vacía en varios enlaces
      // y con `??` el `<title>` salía en blanco. Si no hay nombre se cae al
      // rótulo resuelto, y si tampoco hay, decide el visor.
      nombre: propio || rotulo,
      // El rótulo se conserva aparte cuando el enlace ADEMÁS tiene nombre
      // propio. Ver el comentario de `Enlace.detalle`.
      detalle: propio && rotulo ? rotulo : null,
      // Un enlace está tan sano como sus dos puntas; las que no tienen estado
      // (los rótulos) no cuentan, si no todo enlace a una ficha se vería gris.
      estado: estadoAgregado([a.estado, b.estado].filter((s) => s !== null)),
    });
  }

  return {
    nodos,
    enlaces,
    rotulos,
    vista: encuadrar(nodos, rotulos),
    sinPosicion: huerfanos,
    enlacesTotales,
    huecos: huecosOrdenados(huecos),
  };
}

/** Lo que el rótulo de este elemento puede llegar a pedir. */
function datosDe(e: ElementoMapa, submapa: ResumenSubmapa | null): DatosRotulo {
  return {
    nombre: e.name,
    direcciones: e.direcciones ?? [],
    serviciosCaidos: e.services_down,
    submapa,
  };
}

/**
 * Lo que puede pedir el rótulo de un ENLACE: su nombre y su tráfico.
 *
 * La edad de cada muestra se calcula acá, una vez, contra el `ahora` del dibujo
 * entero. Ver `Medicion` en `plantillas.ts`.
 */
function datosDeEnlace(
  e: ElementoMapa,
  trafico: ReadonlyMap<number, TraficoEnlace>,
  ahora: Date,
): DatosRotulo {
  const t = e.link_id != null ? trafico.get(e.link_id) : undefined;
  const medir = (bits: number | null | undefined, ts: string | null | undefined) => {
    if (bits == null || ts == null) return null;
    const edad_s = segundosDesde(ts, ahora);
    return edad_s == null ? null : { bits, edad_s };
  };
  return {
    nombre: e.name,
    entrada: medir(t?.entrada_bits, t?.entrada_ts),
    salida: medir(t?.salida_bits, t?.salida_ts),
  };
}

/**
 * Con qué nombre se anuncia el nodo.
 *
 * Primero la plantilla resuelta —es lo que el operador configuró que dijera ese
 * elemento— y sin recortar, porque de acá salen el `<title>` y el `aria-label`.
 * Los marcadores no cuentan: anunciar «Equipo — Caído» es más útil que anunciar
 * «Equipo ‹?› — Caído».
 *
 * 🔴 El último recurso NO es el id crudo. Antes lo era, y en la base real dos
 *    nodos terminaban dibujando `#2833594495` en el mapa: un número de nueve
 *    dígitos que no le sirve a nadie y que encima se lee como si fuera un dato.
 *    Ahora dice qué es y que no tiene nombre, que es la verdad; el id sigue
 *    estando en `data-id` para quien lo necesite.
 */
function nombreDe(texto: string, e: ElementoMapa): string {
  const propio = primeraLinea(texto) || e.name?.trim();
  if (propio) return propio;
  const que =
    e.kind === 'submap' ? 'Submapa' : e.kind === 'network' ? 'Red' : 'Equipo';
  return `${que} sin nombre`;
}

/** La primera línea con contenido real; los marcadores no son contenido. */
function primeraLinea(texto: string): string | null {
  for (const l of lineasCrudas(texto)) {
    if (l !== SIN_VALOR && l !== DESCONOCIDA) return l;
  }
  return null;
}

/**
 * Parte la etiqueta de un rótulo en líneas dibujables.
 *
 * El origen las guarda con CR LF de Windows (son de 2011) y algunas llegan a
 * 90 caracteres en cuatro renglones. Se recorta para que no tapen el mapa; el
 * texto entero igual viaja en el `<title>` del elemento.
 */
export function partirTexto(
  bruto: string | null | undefined,
  maxLineas = MAX_LINEAS,
  maxCaracteres = MAX_CARACTERES,
): string[] {
  return lineasCrudas(bruto)
    .slice(0, maxLineas)
    .map((l) => recortar(l, maxCaracteres));
}

/** Los renglones con contenido, sin recortar. */
export function lineasCrudas(bruto: string | null | undefined): string[] {
  if (!bruto) return [];
  return bruto
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function recortar(l: string, max: number): string {
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
}

/** Aire entre el borde del icono y el recuadro de estado que lo envuelve. */
export const PADDING_NODO = 7;

/**
 * Media caja del recuadro de un nodo.
 *
 * El recuadro ya no es un cuadrado fijo: envuelve al icono, que ahora tiene el
 * tamaño y la proporción que pidió el operador. Nunca baja de `TAMANIO_NODO`
 * para que un icono chico siga teniendo un blanco cómodo donde hacer clic.
 */
export function medioRecuadro(n: Pick<Nodo, 'ancho' | 'alto'>): { x: number; y: number } {
  return {
    x: Math.max(n.ancho / 2 + PADDING_NODO, TAMANIO_NODO / 2),
    y: Math.max(n.alto / 2 + PADDING_NODO, TAMANIO_NODO / 2),
  };
}

/** Caja que contiene todo lo dibujable, con margen para iconos y etiquetas. */
function encuadrar(nodos: readonly Nodo[], rotulos: readonly Rotulo[]): Lienzo['vista'] {
  if (nodos.length === 0 && rotulos.length === 0) {
    return { x: 0, y: 0, ancho: 400, alto: 300 };
  }
  // De los rótulos se miden las dos esquinas: el texto crece hacia la derecha y
  // hacia abajo, y una ficha de cuatro renglones en el borde quedaría cortada.
  const ANCHO_CARACTER = 5.6;
  // De los nodos se miden los BORDES, no el centro: con el icono dimensionado
  // por su escala un nodo puede medir 88 unidades, y encuadrar por el centro
  // dejaba la mitad de la foto fuera del lienzo.
  const xs = [
    ...nodos.flatMap((n) => [n.cx - medioRecuadro(n).x, n.cx + medioRecuadro(n).x]),
    ...rotulos.flatMap((r) => [
      r.x,
      r.x + Math.max(...r.lineas.map((l) => l.length)) * ANCHO_CARACTER,
    ]),
  ];
  const ys = [
    ...nodos.flatMap((n) => [
      n.cy - medioRecuadro(n).y,
      // Abajo del recuadro va la etiqueta, que puede llevar tres renglones.
      n.cy + medioRecuadro(n).y + 14 + n.lineas.length * ALTO_LINEA_NODO,
    ]),
    ...rotulos.flatMap((r) => [r.y, r.y + r.lineas.length * ALTO_LINEA]),
  ];
  const x0 = Math.min(...xs) - MARGEN;
  const y0 = Math.min(...ys) - MARGEN;
  const x1 = Math.max(...xs) + MARGEN;
  const y1 = Math.max(...ys) + MARGEN;
  return {
    x: x0,
    y: y0,
    // Un mapa de un solo nodo daría ancho 0 y el navegador no dibuja nada.
    ancho: Math.max(x1 - x0, 200),
    alto: Math.max(y1 - y0, 150),
  };
}

function hrefDe(e: ElementoMapa): string | null {
  if (e.kind === 'submap' && e.submap_id != null) return `/mapas/${e.submap_id}`;
  if (e.device_id != null) return `/dispositivos/${e.device_id}`;
  return null;
}

function esNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function maximo(xs: readonly number[], porDefecto: number): number {
  return xs.length ? Math.max(...xs) : porDefecto;
}

function minimo(xs: readonly number[], porDefecto: number): number {
  return xs.length ? Math.min(...xs) : porDefecto;
}
