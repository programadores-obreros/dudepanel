/**
 * De quién depende cada equipo, deducido del grafo de enlaces.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * 🔴 `device_parents` está VACÍA. The Dude no guardó `parentIDs` en ninguno de
 *    los 885 equipos, así que la ficha nunca puede decir «esto es arrastre,
 *    arreglá el troncal primero». La función existía y nunca disparaba.
 *
 * Pero la topología SÍ está: dibujada en los mapas, 1.076 aristas entre 792
 * nodos, de los cuales 669 son equipos. Eso es un grafo. Lo que ese grafo NO
 * tiene es **dirección**: «A está conectado con B» no dice cuál de los dos es
 * el padre. Todo este archivo es el intento de deducirlo, y de ser honesto
 * sobre cuánto se puede confiar en cada deducción.
 *
 *
 * ── Lo que se probó y NO funcionó ───────────────────────────────────────────
 *
 * Vale más que lo que sí, porque son los caminos que alguien va a querer
 * volver a intentar.
 *
 *  1. **`links.master_device_id`.** Está poblado en 1.096 de los 1.171
 *     enlaces, así que parece la respuesta. No lo es: no marca dirección,
 *     marca a quién le pregunta SNMP. Medido contra el grado del nodo —el
 *     troncal tiene más enlaces que el cliente— da **313 a favor, 329 en
 *     contra, 50 empates**. Es una moneda. Y contra el historial de caídas,
 *     8 aciertos y 12 fallas. Descartado con número.
 *
 *  2. **El nombre de la interfaz.** `chart_sources.name` trae
 *     `'ether10-Wan-aPenielRS (10) @ PenielBS2 tx'`, y un puerto que se llama
 *     «Wan» mira río arriba. Buenísimo… salvo que uniendo por
 *     `master_device_id` + `master_interface` resuelven **48 de 1.171**
 *     enlaces. No alcanza para nada.
 *
 *  3. **El historial de caídas como oráculo.** Si A es padre de B, cada vez
 *     que A se cae B se cae, pero no al revés. Es la prueba correcta y no se
 *     puede correr: de los 885 equipos sólo 310 tienen caídas, de los 696
 *     pares adyacentes sólo 153 las tienen en las dos puntas, y de esos sólo
 *     **20 muestran asimetría** — el resto se cae y se levanta junto, que es
 *     lo que pasa cuando se corta la luz de un sitio entero. Con 20 casos
 *     TODOS los métodos dan cerca de 10 y 10. **El oráculo no discrimina**, y
 *     decir que uno ganó con esa muestra sería inventar.
 *
 *  4. **El árbol de mapas.** Los submapas parecen jerarquía natural, pero el
 *     grafo de mapas tiene ciclos: `TelWiNet` contiene 29 submapas y está
 *     contenido 36 veces, porque cada mapa de sitio dibuja un atajo de vuelta.
 *     No hay raíz.
 *
 *
 * ── Lo que sí se usa, y por qué ─────────────────────────────────────────────
 *
 * Sin oráculo, la dirección sale de la ESTRUCTURA, con dos reglas:
 *
 *  **(a) Una hoja no puede ser padre de nadie.** Un nodo con un solo enlace no
 *  agrega tráfico de nadie: su único vecino está río arriba. No es heurística,
 *  es el dibujo. **349 de los 669 equipos del grafo son hojas** — más de la
 *  mitad del problema se resuelve sin inferir nada.
 *
 *  **(b) Para el interior, distancia a la raíz.** BFS desde el nodo de mayor
 *  grado de cada componente; el padre es el vecino que quedó un salto más
 *  cerca. Se eligió así después de medir: probando las 713 raíces posibles de
 *  la componente mayor contra el objetivo «grado(padre) ≥ grado(hijo)», el
 *  puntaje va de 0,896 a 0,933 — **la elección de raíz casi no mueve el
 *  resultado**, porque el grafo ya es 89 % árbol (696 aristas, 623 serían las
 *  de un bosque puro). Y el mejor puntaje lo saca `SW16-Primero-CRS317`, que
 *  es justamente el de mayor grado: dos criterios independientes que
 *  coinciden.
 *
 *
 * ── Y por eso cada respuesta lleva confianza ────────────────────────────────
 *
 * Ya hay precedente en este repo: `hayTopologia()` distingue «no cuelga de
 * nadie» de «el dato no está cargado», porque decir lo primero cuando es lo
 * segundo es una AFIRMACIÓN FALSA sobre la red. Acá pasa lo mismo un nivel más
 * arriba: «el padre es X» dicho con una moneda es peor que no decir nada, y a
 * las 3 AM manda a alguien a revisar el equipo equivocado.
 *
 * Reparto medido sobre los 885 equipos:
 *
 *   alta   349   es hoja: su único vecino está arriba, punto
 *   media  132   interior, camino único y el padre agrega más que el hijo
 *   baja   138   ambiguo (49) · cruza un sitio (61) · contradice el grado (28)
 *   ―       14   raíz del grafo dibujado
 *   ―       36   cuelga de un sitio sin ningún equipo arriba
 *   null   216   NO están en ningún enlace: de estos no se sabe nada
 *
 * O sea: **619 de los 885 equipos quedan con un padre identificado**, y de esos
 * 481 con confianza alta o media. Los 216 de abajo no son «raíces»: son equipos
 * que nadie dibujó conectado a nada, y eso es todo lo que se puede decir.
 */

/** Qué representa un nodo del grafo. Ver `v_topologia_aristas` en el esquema. */
export type TipoNodo = 'equipo' | 'sitio' | 'union';

/** Una arista NO dirigida, tal como sale de `v_topologia_aristas`. */
export interface Arista {
  nodo_a: number;
  nodo_b: number;
  tipo_a: TipoNodo;
  tipo_b: TipoNodo;
}

/**
 * Cuánto se le puede creer al padre inferido.
 *
 * 🔴 No es decorativo: la interfaz TIENE que mostrarlo. Un «depende de X» sin
 *    calificar se lee como dato de la base, y no lo es.
 */
export type Confianza = 'alta' | 'media' | 'baja';

/** Por qué salió esa confianza. Es lo que se le muestra al operador. */
export type Motivo =
  /** El equipo tiene un solo enlace: su vecino está arriba por estructura. */
  | 'hoja'
  /** Interior, un solo camino hacia la raíz, y el padre agrega más enlaces. */
  | 'jerarquia'
  /** Hay más de un vecino a la misma distancia: el BFS eligió uno cualquiera. */
  | 'ambiguo'
  /** El camino cruza la caja de un sitio: se sabe el LUGAR, no el equipo. */
  | 'via-sitio'
  /** El padre tiene MENOS enlaces que el hijo. Al revés de lo esperable. */
  | 'contradice-agregacion'
  /** Es la cabecera de su componente: nadie por encima en lo dibujado. */
  | 'raiz-del-grafo'
  /** Cuelga de un sitio y arriba del sitio no hay ningún equipo. */
  | 'sin-padre-resoluble'
  /** No aparece en ningún enlace. **No se sabe**, que no es «es raíz». */
  | 'fuera-del-grafo';

export interface Dependencia {
  /** Id del equipo del que depende, o `null` si no se pudo determinar. */
  padre: number | null;
  /** `null` cuando no hay padre: no se califica lo que no se afirma. */
  confianza: Confianza | null;
  motivo: Motivo;
  /**
   * Cuántos nodos que NO son equipos hubo que atravesar para llegar al padre.
   * Con 0 el enlace es directo; con 1 o más el camino pasó por la caja de un
   * sitio o por un rótulo, y el equipo concreto es una suposición.
   */
  saltos: number;
  /** Distancia a la raíz de su componente. La raíz es 0. */
  profundidad: number;
}

export interface Topologia {
  /** Sólo los equipos que aparecen en el grafo. El resto no está y punto. */
  readonly dependencias: ReadonlyMap<number, Dependencia>;
  /** Equipo → equipos que dependen de él, ya ordenados por id. */
  readonly hijos: ReadonlyMap<number, readonly number[]>;
  /** Cabeceras: un equipo por componente, cuando la cabecera es un equipo. */
  readonly raices: readonly number[];
  /** Cuántos pedazos sueltos tiene el grafo. Medido en producción: 15. */
  readonly componentes: number;
  /** Equipos presentes en el grafo. Medido: 669 de 885. */
  readonly equiposEnGrafo: number;
}

/** Lo que se responde de un equipo del que no hay ni un enlace dibujado. */
const FUERA: Dependencia = {
  padre: null,
  confianza: null,
  motivo: 'fuera-del-grafo',
  saltos: 0,
  profundidad: -1,
};

/**
 * Tope de saltos al subir la cadena.
 *
 * El mismo 12 que usa `cadenaDePadres` sobre `device_parents`. Acá el árbol de
 * BFS no puede tener ciclos por construcción, pero el tope se mantiene igual:
 * es también un límite de cuánto contexto le sirve a alguien mirando una ficha.
 */
export const TOPE_CADENA = 12;

/**
 * Deduce la dirección del grafo.
 *
 * Determinista a propósito — vecinos y nodos se recorren ordenados por id — para
 * que dos corridas con las mismas aristas den exactamente el mismo árbol. Sin
 * eso, el padre de un equipo ambiguo cambiaría entre recargas de la página y
 * nadie podría confiar en lo que ve.
 */
export function inferirTopologia(aristas: readonly Arista[]): Topologia {
  const vecinos = new Map<number, Set<number>>();
  const tipos = new Map<number, TipoNodo>();

  const anotar = (id: number, tipo: TipoNodo): void => {
    if (!vecinos.has(id)) vecinos.set(id, new Set());
    // El primer tipo gana. En la práctica no hay conflicto: los ids de The Dude
    // son únicos entre tipos de objeto (verificado, 0 colisiones).
    if (!tipos.has(id)) tipos.set(id, tipo);
  };

  for (const a of aristas) {
    if (a.nodo_a === a.nodo_b) continue;
    anotar(a.nodo_a, a.tipo_a);
    anotar(a.nodo_b, a.tipo_b);
    vecinos.get(a.nodo_a)!.add(a.nodo_b);
    vecinos.get(a.nodo_b)!.add(a.nodo_a);
  }

  const nodos = [...vecinos.keys()].sort((x, y) => x - y);
  const orden = new Map<number, number[]>();
  for (const n of nodos) orden.set(n, [...vecinos.get(n)!].sort((x, y) => x - y));

  const grado = (n: number): number => vecinos.get(n)?.size ?? 0;
  const esEquipo = (n: number): boolean => tipos.get(n) === 'equipo';

  // ── Componentes conexas ──────────────────────────────────────────────────
  const comps: number[][] = [];
  const visto = new Set<number>();
  for (const semilla of nodos) {
    if (visto.has(semilla)) continue;
    const pila = [semilla];
    visto.add(semilla);
    const c: number[] = [];
    while (pila.length > 0) {
      const u = pila.pop()!;
      c.push(u);
      for (const v of orden.get(u)!) {
        if (!visto.has(v)) {
          visto.add(v);
          pila.push(v);
        }
      }
    }
    comps.push(c);
  }

  // ── Raíz de cada componente ──────────────────────────────────────────────
  // Mayor grado; a igual grado gana un equipo sobre un seudo-nodo (una caja de
  // sitio no es un aparato y hace de raíz un lugar en vez de una máquina); a
  // igual todo, el id más chico, que es lo que vuelve esto reproducible.
  const raizDe = (c: readonly number[]): number => {
    let mejor = c[0];
    for (const n of c) {
      const g = grado(n) - grado(mejor);
      if (g > 0) mejor = n;
      else if (g === 0) {
        const e = Number(esEquipo(n)) - Number(esEquipo(mejor));
        if (e > 0 || (e === 0 && n < mejor)) mejor = n;
      }
    }
    return mejor;
  };

  // ── BFS: profundidad y padre en el árbol ─────────────────────────────────
  const profundidad = new Map<number, number>();
  const padreArbol = new Map<number, number | null>();
  const raicesCrudas: number[] = [];

  // 🔴 El BFS avanza NIVEL POR NIVEL y dentro de cada nivel expande primero los
  //    equipos, y sólo después las cajas de sitio y los rótulos.
  //
  //    No es cosmético. Cuando un nodo se puede alcanzar a la misma distancia
  //    por un equipo o por la caja de un sitio, el que lo descubre primero
  //    queda de padre — y son dos respuestas de calidad muy distinta: «depende
  //    de ese router» contra «depende de algo que está en Ponte». Expandiendo
  //    los equipos antes, gana siempre la respuesta concreta.
  //
  //    Medido en la base real, sólo por cambiar este orden: `con-padre` sube de
  //    610 a **619** y los `sin-padre-resoluble` bajan de 45 a **36**. Con el
  //    orden al revés el árbol es igual de válido y responde peor.
  const ordenExpansion = (a: number, b: number): number => {
    const e = Number(esEquipo(b)) - Number(esEquipo(a));
    return e !== 0 ? e : a - b;
  };

  for (const c of comps) {
    const r = raizDe(c);
    raicesCrudas.push(r);
    profundidad.set(r, 0);
    padreArbol.set(r, null);

    let nivel: number[] = [r];
    while (nivel.length > 0) {
      nivel.sort(ordenExpansion);
      const siguiente: number[] = [];
      for (const u of nivel) {
        for (const v of orden.get(u)!) {
          if (!profundidad.has(v)) {
            profundidad.set(v, profundidad.get(u)! + 1);
            padreArbol.set(v, u);
            siguiente.push(v);
          }
        }
      }
      nivel = siguiente;
    }
  }

  // ── De nodo a equipo: subir hasta el primer padre que sea un aparato ─────
  const dependencias = new Map<number, Dependencia>();
  const hijos = new Map<number, number[]>();

  for (const n of nodos) {
    if (!esEquipo(n)) continue;
    const prof = profundidad.get(n)!;

    // Vecinos a un salto de la raíz: si hay más de uno, el grafo tiene un ciclo
    // acá y el BFS eligió por orden de id, no por evidencia. Eso es 'ambiguo'.
    let candidatos = 0;
    for (const v of orden.get(n)!) if (profundidad.get(v) === prof - 1) candidatos++;

    let cur = padreArbol.get(n) ?? null;
    let saltos = 0;
    while (cur !== null && !esEquipo(cur)) {
      saltos++;
      cur = padreArbol.get(cur) ?? null;
    }

    if (cur === null) {
      dependencias.set(n, {
        padre: null,
        confianza: null,
        motivo: prof === 0 ? 'raiz-del-grafo' : 'sin-padre-resoluble',
        saltos,
        profundidad: prof,
      });
      continue;
    }

    // 🔴 El orden de estas ramas ES la política de confianza.
    //
    //    Primero lo que invalida: si hay ciclo o si el camino cruzó un sitio,
    //    da igual que el equipo sea una hoja — el padre concreto es un
    //    candidato, no un hecho. Una hoja colgada de la caja «Ponte» sabe que
    //    sube a Ponte; NO sabe a qué equipo de Ponte.
    let confianza: Confianza;
    let motivo: Motivo;
    if (candidatos > 1) {
      confianza = 'baja';
      motivo = 'ambiguo';
    } else if (saltos > 0) {
      confianza = 'baja';
      motivo = 'via-sitio';
    } else if (grado(n) === 1) {
      confianza = 'alta';
      motivo = 'hoja';
    } else if (grado(cur) >= grado(n)) {
      confianza = 'media';
      motivo = 'jerarquia';
    } else {
      // El «padre» tiene menos enlaces que el hijo. En una red de ISP el
      // tráfico agrega hacia arriba, así que esto huele a que el árbol quedó
      // colgado del lado equivocado. Se informa igual, pero avisando.
      confianza = 'baja';
      motivo = 'contradice-agregacion';
    }

    dependencias.set(n, { padre: cur, confianza, motivo, saltos, profundidad: prof });
    const lista = hijos.get(cur);
    if (lista) lista.push(n);
    else hijos.set(cur, [n]);
  }

  for (const lista of hijos.values()) lista.sort((x, y) => x - y);

  return {
    dependencias,
    hijos,
    raices: raicesCrudas.filter(esEquipo).sort((x, y) => x - y),
    componentes: comps.length,
    equiposEnGrafo: dependencias.size,
  };
}

/**
 * Qué se sabe de un equipo.
 *
 * Nunca devuelve `undefined`: un equipo que no está en el grafo devuelve
 * `fuera-del-grafo`, que es una respuesta y no un hueco. Es la misma regla que
 * `hayTopologia()` — «no se sabe» hay que poder decirlo en voz alta.
 */
export function dependenciaDe(topo: Topologia, equipo: number): Dependencia {
  return topo.dependencias.get(equipo) ?? FUERA;
}

/** Un eslabón de la cadena hacia arriba, con el porqué de cada paso. */
export interface Eslabon {
  id: number;
  /** 1 es el padre directo, 2 el abuelo. Mismo contrato que `Vecino.nivel`. */
  nivel: number;
  confianza: Confianza;
  motivo: Motivo;
}

/**
 * La cadena de dependencia hacia arriba, del padre a la cabecera.
 *
 * La confianza de cada eslabón es la del paso que lo trajo, no la del equipo
 * de origen: si el padre es firme y el abuelo es un salto ambiguo, hay que
 * poder ver exactamente dónde se afloja.
 */
export function cadenaAscendente(
  topo: Topologia,
  equipo: number,
  tope: number = TOPE_CADENA,
): Eslabon[] {
  const salida: Eslabon[] = [];
  const vistos = new Set<number>([equipo]);
  let actual = equipo;

  while (salida.length < tope) {
    const d = topo.dependencias.get(actual);
    if (!d || d.padre === null || d.confianza === null) break;
    // Guarda de ciclo. El árbol de BFS no puede tener uno, pero esta función
    // también corre sobre topologías armadas a mano en los tests y sobre lo
    // que devuelva una base futura: nadie se cuelga por un dato torcido.
    if (vistos.has(d.padre)) break;
    vistos.add(d.padre);
    salida.push({
      id: d.padre,
      nivel: salida.length + 1,
      confianza: d.confianza,
      motivo: d.motivo,
    });
    actual = d.padre;
  }

  return salida;
}

/** Los equipos que dependen directamente de éste. Ordenados por id. */
export function hijosDirectos(topo: Topologia, equipo: number): readonly number[] {
  return topo.hijos.get(equipo) ?? [];
}

/** Cómo quedó repartida la certeza. Es lo que se muestra para no exagerar. */
export interface Cobertura {
  /** Equipos en `devices`, se les haya inferido algo o no. */
  total: number;
  /** Cuántos aparecen en algún enlace dibujado. */
  en_grafo: number;
  /** Cuántos tienen un padre concreto. */
  con_padre: number;
  alta: number;
  media: number;
  baja: number;
  /** Cabeceras de componente: arriba de ellas no hay nada dibujado. */
  raices: number;
  /** Cuelgan de un sitio sin ningún equipo por encima. */
  sin_padre_resoluble: number;
  /** No aparecen en ningún enlace. De estos no se sabe NADA. */
  fuera_del_grafo: number;
  componentes: number;
}

export function coberturaDe(topo: Topologia, totalEquipos: number): Cobertura {
  let alta = 0;
  let media = 0;
  let baja = 0;
  let raices = 0;
  let sinPadre = 0;

  for (const d of topo.dependencias.values()) {
    if (d.confianza === 'alta') alta++;
    else if (d.confianza === 'media') media++;
    else if (d.confianza === 'baja') baja++;
    else if (d.motivo === 'raiz-del-grafo') raices++;
    else sinPadre++;
  }

  return {
    total: totalEquipos,
    en_grafo: topo.equiposEnGrafo,
    con_padre: alta + media + baja,
    alta,
    media,
    baja,
    raices,
    sin_padre_resoluble: sinPadre,
    // Un equipo puede no estar en el grafo Y no estar en `devices` si alguien
    // pasa un total inconsistente: el máximo con 0 evita informar un negativo.
    fuera_del_grafo: Math.max(totalEquipos - topo.equiposEnGrafo, 0),
    componentes: topo.componentes,
  };
}
