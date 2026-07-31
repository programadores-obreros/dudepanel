import { cajaDeIcono, type Lienzo, type Nodo } from './mapa';
import type { Medida } from './iconos';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  El barrido que antes se hacía a mano y a ojo.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Este archivo existe por una deuda concreta, y conviene que quede escrita.
 *
 *    Al entregar el visor la primera vez, la suite verificaba que el dato fuera
 *    FIEL y lo era: coordenadas correctas, estados correctos, iconos correctos.
 *    Todo verde. Y en pantalla se veían, uno atrás de otro:
 *
 *      1. plantillas crudas — `[Device.Name] [dev…` en 2.216 de 2.317 rótulos
 *      2. un cero decorativo solo, bajo 522 nombres de equipo
 *      3. `1192.0.2.42` — un contador pegado a una dirección
 *      4. fotos de 22×4 unidades: una astilla de cuatro píxeles de alto
 *
 *    Los cuatro pasaban todos los tests. **Cuatro defectos seguidos que sólo se
 *    vieron mirando la pantalla es un patrón, no mala suerte**: la suite probaba
 *    que el dato fuera cierto y ninguno de los cuatro era un dato falso. Eran
 *    datos ciertos dibujados de una manera que no se puede leer.
 *
 *    Este auditor es la prueba que corta el patrón. Recorre el lienzo ya armado
 *    —lo mismo que va a la pantalla— y busca las formas concretas en que un
 *    dato cierto se vuelve ilegible. `test/legibilidad.test.ts` lo corre contra
 *    TODOS los mapas de la base, no contra tres casos elegidos.
 *
 * ── Lo que NO hace, y por qué ───────────────────────────────────────────────
 *
 * No comprueba que dos etiquetas no se pisen: eso depende de la tipografía del
 * navegador y de la escala del zoom, y una regla aproximada daría falsos rojos
 * en cada corrida. Sigue siendo trabajo de mirar la pantalla. Lo que sí se
 * puede afirmar sin un navegador es todo lo de abajo, y es lo que se afirma.
 */

export type ClaseDefecto =
  /** Un `[Algo]` llegó a la pantalla sin resolver. */
  | 'plantilla-cruda'
  /** Un renglón que dice sólo `0`: no informa, decora. */
  | 'cero-solitario'
  /** Dígitos pegados a una dirección: `1192.0.2.42` no es ni contador ni IP. */
  | 'digito-pegado'
  /** El lado corto del icono no se puede mirar. */
  | 'icono-astilla'
  /** La caja del icono no respeta la proporción del archivo. */
  | 'icono-deformado'
  /** Un nodo que no dibuja ni una palabra: un cuadrado anónimo. */
  | 'nodo-mudo'
  /** El nombre accesible es un id crudo: `#2833594495`. */
  | 'nombre-es-un-id';

export interface Defecto {
  clase: ClaseDefecto;
  /** `element_id`, para poder ir a mirarlo. */
  elemento: number;
  /** Qué se vio exactamente. Va en el mensaje del test. */
  detalle: string;
}

/** Debajo de esto, en unidades del lienzo, un icono es una mancha. */
export const LADO_LEGIBLE_MINIMO = 14;
/**
 * Cuánto puede desviarse la caja de la proporción real del archivo.
 *
 * No es cero porque `cajaDeIcono` redondea a un decimal: una foto de 805×316
 * termina en 55,8 × 21,9 y la razón se corre en la tercera cifra. El 4 % cubre
 * el redondeo con margen y sigue siendo mil veces más fino que el 22×4 que se
 * vino a impedir.
 */
export const DESVIO_PROPORCION = 0.04;

/** Un renglón que es sólo un cero, con o sin signos alrededor. */
const CERO_SOLITARIO = /^[\s·/|,-]*0[\s·/|,-]*$/;
/**
 * Una plantilla de The Dude sin resolver.
 *
 * 🔴 La primera versión era `\[[A-Za-z_]` —«cualquier corchete que abra con
 *    letra»— y daba un FALSO POSITIVO que apareció recién al barrer los 40
 *    mapas reales:
 *
 *        Radio-p-Poroto 2[GHz]
 *
 *    Ese `[GHz]` es parte del NOMBRE del equipo, escrito por una persona en The
 *    Dude, y llega a la pantalla exactamente como corresponde. Un auditor que
 *    lo marca como defecto obliga a mirar dos casos sanos cada vez que corre, y
 *    un auditor que cría lobos deja de leerse.
 *
 * Las plantillas de The Dude tienen dos formas y sólo dos: un campo con punto
 * (`[Device.Name]`, `[NetMap.DevicesCount]`) o una función (`[algo()]`). Una
 * palabra suelta entre corchetes no es ninguna de las dos.
 */
export const PLANTILLA_CRUDA = /\[[A-Za-z_][\w.]*(?:\.[A-Za-z_]\w*|\(\))\]/;
/** Un número pegado adelante de algo con forma de IPv4. */
const DIGITO_ANTES_DE_IP = /\d{4,}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
/** …y pegado atrás, que es el mismo defecto por el otro lado. */
const DIGITO_DESPUES_DE_IP = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{4,}\b/;
/** El nombre de repuesto que se usaba antes: un id crudo con numeral. */
const NOMBRE_ID = /^#\d+$/;

/**
 * Todo lo que hace ilegible este lienzo. Vacío es lo que tiene que dar.
 *
 * `medidas` es opcional: sin ella no se pueden auditar las cajas de los iconos
 * —no se sabe qué proporción debería tener cada archivo— y esas dos reglas se
 * saltean. Se declara en el resultado con `auditarCajas` para que un test no
 * crea que revisó algo que no revisó.
 */
export function auditarLienzo(lienzo: Lienzo): Defecto[] {
  const defectos: Defecto[] = [];

  for (const n of lienzo.nodos) {
    for (const linea of n.lineas) {
      revisarTexto(defectos, n.id, linea);
    }
    revisarTexto(defectos, n.id, n.nombre);

    if (!n.lineas.some((l) => l.trim().length > 0)) {
      defectos.push({
        clase: 'nodo-mudo',
        elemento: n.id,
        detalle: 'el nodo no dibuja ningún texto',
      });
    }

    if (NOMBRE_ID.test(n.nombre.trim())) {
      defectos.push({
        clase: 'nombre-es-un-id',
        elemento: n.id,
        detalle: `el nombre accesible es «${n.nombre}»`,
      });
    }

    // El lado corto se mide siempre, con medidas o sin ellas: `cajaDeIcono` ya
    // devolvió la caja definitiva y es la que se va a dibujar.
    const menor = Math.min(n.ancho, n.alto);
    if (menor < LADO_LEGIBLE_MINIMO) {
      defectos.push({
        clase: 'icono-astilla',
        elemento: n.id,
        detalle: `caja de ${n.ancho}×${n.alto}: el lado corto mide ${menor}`,
      });
    }
  }

  for (const r of lienzo.rotulos) {
    for (const linea of r.lineas) revisarTexto(defectos, r.id, linea);
  }

  for (const e of lienzo.enlaces) {
    if (e.nombre) revisarTexto(defectos, e.id, e.nombre);
  }

  return defectos;
}

/**
 * Que la caja de cada nodo conserve la proporción de su archivo.
 *
 * Va aparte de `auditarLienzo` porque necesita las medidas naturales, que sólo
 * existen si el directorio de iconos está montado. Un test que las tenga la
 * llama; uno que no, no puede fingir que la revisó.
 */
export function auditarProporciones(
  nodos: readonly Nodo[],
  medidas: ReadonlyMap<string, Medida>,
): Defecto[] {
  const defectos: Defecto[] = [];
  for (const n of nodos) {
    if (!n.icono) continue;
    const m = medidas.get(n.icono);
    if (!m || m.ancho <= 0 || m.alto <= 0) continue;

    const esperada = m.ancho / m.alto;
    const dibujada = n.ancho / n.alto;
    const desvio = Math.abs(dibujada - esperada) / esperada;
    if (desvio > DESVIO_PROPORCION) {
      defectos.push({
        clase: 'icono-deformado',
        elemento: n.id,
        detalle:
          `${n.icono} es ${m.ancho}×${m.alto} (${esperada.toFixed(2)}:1) y se dibuja ` +
          `${n.ancho}×${n.alto} (${dibujada.toFixed(2)}:1)`,
      });
    }
  }
  return defectos;
}

/**
 * Que ninguna combinación de archivo y escala produzca una caja ilegible.
 *
 * Es la versión exhaustiva: no mira los mapas que hay, mira todas las escalas
 * que la base tiene cargadas para cada icono. Un icono que hoy nadie usa al
 * 10 % pero mañana sí, falla hoy.
 */
export function auditarEscalas(
  combinaciones: readonly { icono: string; escala: number | null; medida: Medida }[],
): Defecto[] {
  const defectos: Defecto[] = [];
  for (const [i, c] of combinaciones.entries()) {
    const caja = cajaDeIcono(c.icono, c.escala, c.medida);
    const menor = Math.min(caja.ancho, caja.alto);
    if (menor < LADO_LEGIBLE_MINIMO) {
      defectos.push({
        clase: 'icono-astilla',
        elemento: i,
        detalle:
          `${c.icono} (${c.medida.ancho}×${c.medida.alto}) al ${c.escala ?? 100} % ` +
          `da ${caja.ancho}×${caja.alto}`,
      });
    }
  }
  return defectos;
}

function revisarTexto(defectos: Defecto[], elemento: number, texto: string): void {
  if (PLANTILLA_CRUDA.test(texto)) {
    defectos.push({ clase: 'plantilla-cruda', elemento, detalle: `«${texto}»` });
  }
  if (CERO_SOLITARIO.test(texto)) {
    defectos.push({ clase: 'cero-solitario', elemento, detalle: `«${texto}»` });
  }
  if (DIGITO_ANTES_DE_IP.test(texto) || DIGITO_DESPUES_DE_IP.test(texto)) {
    defectos.push({ clase: 'digito-pegado', elemento, detalle: `«${texto}»` });
  }
}

/** Agrupa por clase para que el mensaje del test se pueda leer. */
export function resumirDefectos(defectos: readonly Defecto[]): string[] {
  const porClase = new Map<ClaseDefecto, Defecto[]>();
  for (const d of defectos) {
    const xs = porClase.get(d.clase) ?? [];
    xs.push(d);
    porClase.set(d.clase, xs);
  }
  return [...porClase.entries()].map(
    ([clase, xs]) =>
      `${clase} ×${xs.length} — p. ej. elemento ${xs[0]!.elemento}: ${xs[0]!.detalle}`,
  );
}
