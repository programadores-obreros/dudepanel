import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cadenaAscendente,
  coberturaDe,
  dependenciaDe,
  hijosDirectos,
  inferirTopologia,
  type Arista,
} from '@/lib/topologia';

/**
 * La inferencia de topología, que es la parte del panel que más fácil MIENTE.
 *
 * 🔴 `device_parents` está vacía: The Dude nunca guardó `parentIDs`. Todo lo
 *    que este módulo dice sobre quién depende de quién es DEDUCIDO de un grafo
 *    que no tiene dirección. Un error acá no se ve como un error: se ve como
 *    una ficha que manda a alguien, a las 3 de la mañana, a revisar el equipo
 *    equivocado mientras el troncal sigue caído.
 *
 * Por eso el grueso de estas pruebas son grafos armados a mano de cinco nodos:
 * son los únicos casos donde se puede saber la respuesta correcta de antemano y
 * comparar. Sobre la base real sólo se pueden verificar invariantes.
 */

// ── Ayudas para escribir grafos legibles ────────────────────────────────────
// Los ids son chicos y a mano a propósito: un caso de prueba tiene que caber en
// la cabeza. Del 100 para arriba son equipos, del 900 sitios, del 800 rótulos.

const eq = (a: number, b: number): Arista => ({
  nodo_a: Math.min(a, b),
  nodo_b: Math.max(a, b),
  tipo_a: 'equipo',
  tipo_b: 'equipo',
});

/** Equipo ↔ caja de sitio. `sitio` siempre va del lado que corresponda. */
const sitio = (equipo: number, mapa: number): Arista =>
  equipo < mapa
    ? { nodo_a: equipo, nodo_b: mapa, tipo_a: 'equipo', tipo_b: 'sitio' }
    : { nodo_a: mapa, nodo_b: equipo, tipo_a: 'sitio', tipo_b: 'equipo' };

/** Equipo ↔ rótulo de texto libre (los `static` del mapa). */
const rotulo = (equipo: number, texto: number): Arista =>
  equipo < texto
    ? { nodo_a: equipo, nodo_b: texto, tipo_a: 'equipo', tipo_b: 'union' }
    : { nodo_a: texto, nodo_b: equipo, tipo_a: 'union', tipo_b: 'equipo' };

describe('inferirTopologia — una hoja no puede ser padre de nadie', () => {
  // La estrella es el caso que resuelve más de la mitad de la red real: 349 de
  // los 669 equipos del grafo tienen un solo enlace.
  const estrella = [eq(100, 101), eq(100, 102), eq(100, 103)];

  it('las hojas cuelgan del centro con confianza alta', () => {
    const t = inferirTopologia(estrella);
    for (const hoja of [101, 102, 103]) {
      expect(dependenciaDe(t, hoja)).toMatchObject({
        padre: 100,
        confianza: 'alta',
        motivo: 'hoja',
        saltos: 0,
      });
    }
  });

  it('el centro es la cabecera y NO tiene padre inventado', () => {
    const d = dependenciaDe(inferirTopologia(estrella), 100);
    expect(d.padre).toBeNull();
    expect(d.motivo).toBe('raiz-del-grafo');
    // 🔴 Sin confianza porque no hay nada que calificar: no se afirmó nada.
    expect(d.confianza).toBeNull();
  });

  it('los hijos salen ordenados y completos', () => {
    expect(hijosDirectos(inferirTopologia(estrella), 100)).toEqual([101, 102, 103]);
    expect(hijosDirectos(inferirTopologia(estrella), 101)).toEqual([]);
  });
});

describe('inferirTopologia — «no se sabe» hay que poder decirlo', () => {
  /**
   * 🔴 EL TEST QUE JUSTIFICA TODO EL MÓDULO.
   *
   * Es el mismo defecto que arregló `hayTopologia()` un nivel más abajo: la
   * ficha decía «No cuelga de ningún equipo. Es raíz de la topología» sobre
   * equipos de los que simplemente no había dato. Eso es una AFIRMACIÓN FALSA
   * sobre la red del ISP, no un hueco de interfaz.
   *
   * En la base real son **216 de los 885 equipos** los que no aparecen en
   * ningún enlace dibujado. Si esto se rompe, esos 216 pasan a declararse
   * troncales.
   */
  it('un equipo que no está en ningún enlace NO es una raíz', () => {
    const t = inferirTopologia([eq(100, 101)]);
    const fuera = dependenciaDe(t, 999);
    const raiz = dependenciaDe(t, 100);

    expect(fuera.motivo).toBe('fuera-del-grafo');
    expect(raiz.motivo).toBe('raiz-del-grafo');
    // Los dos no tienen padre, y por eso mismo el motivo es lo único que los
    // distingue: quien lea sólo `padre === null` va a decir la mentira.
    expect(fuera.padre).toBeNull();
    expect(raiz.padre).toBeNull();
    expect(fuera.motivo).not.toBe(raiz.motivo);
  });

  it('el que está fuera del grafo no aparece en el conteo de equipos', () => {
    const t = inferirTopologia([eq(100, 101)]);
    expect(t.dependencias.has(999)).toBe(false);
    expect(coberturaDe(t, 50).fuera_del_grafo).toBe(48);
  });
});

describe('inferirTopologia — cuándo NO hay que creerle', () => {
  it('cruzar la caja de un sitio baja la confianza: se sabe el lugar, no el equipo', () => {
    // 101 sube a la caja «Ponte» (900) y del otro lado hay un equipo. Que 101
    // dependa de 100 es plausible; que dependa de ÉSE equipo de Ponte, no.
    const t = inferirTopologia([eq(100, 102), eq(100, 103), sitio(100, 900), sitio(101, 900)]);
    const d = dependenciaDe(t, 101);
    expect(d.padre).toBe(100);
    expect(d.motivo).toBe('via-sitio');
    expect(d.confianza).toBe('baja');
    expect(d.saltos).toBe(1);
  });

  it('ser hoja NO alcanza si el camino cruzó un sitio', () => {
    // 101 tiene grado 1: es una hoja. Pero su vecino es una caja, no un aparato.
    const t = inferirTopologia([eq(100, 102), eq(100, 103), sitio(100, 900), sitio(101, 900)]);
    expect(dependenciaDe(t, 101).motivo).not.toBe('hoja');
  });

  it('un ciclo deja la elección de padre en un empate, y se declara', () => {
    // 100 es la raíz (grado 3). 101 y 102 están los dos a distancia 1 y además
    // conectados entre sí; 103 cuelga de los dos: dos padres a la misma
    // distancia, y el BFS eligió uno por orden de id, no por evidencia.
    const t = inferirTopologia([
      eq(100, 101),
      eq(100, 102),
      eq(100, 104),
      eq(101, 103),
      eq(102, 103),
    ]);
    const d = dependenciaDe(t, 103);
    expect(d.motivo).toBe('ambiguo');
    expect(d.confianza).toBe('baja');
    expect([101, 102]).toContain(d.padre);
  });

  it('un padre con menos enlaces que el hijo se marca: el árbol puede estar dado vuelta', () => {
    // Cadena 100–101–102, con 102 abriéndose en tres. El de mayor grado es 102,
    // así que la raíz es 102 y 101 queda arriba de 100 aunque 100 no agregue
    // nada… pero el caso que importa es el revés: un padre más chico que el
    // hijo. Lo armamos explícitamente.
    const t = inferirTopologia([
      eq(100, 101),
      eq(100, 102),
      eq(100, 103),
      eq(100, 104),
      eq(101, 105),
      eq(105, 106),
      eq(105, 107),
      eq(105, 108),
    ]);
    // 105 (grado 4) cuelga de 101 (grado 2). El tráfico debería agregar hacia
    // arriba y acá no: se informa igual, pero avisando.
    const d = dependenciaDe(t, 105);
    expect(d.padre).toBe(101);
    expect(d.motivo).toBe('contradice-agregacion');
    expect(d.confianza).toBe('baja');
  });

  it('el reparto de confianza cierra con la cantidad de equipos del grafo', () => {
    const t = inferirTopologia([eq(100, 102), eq(100, 103), sitio(100, 900), sitio(101, 900)]);
    const c = coberturaDe(t, 10);
    expect(c.alta + c.media + c.baja).toBe(c.con_padre);
    expect(c.con_padre + c.raices + c.sin_padre_resoluble).toBe(c.en_grafo);
    expect(c.en_grafo + c.fuera_del_grafo).toBe(c.total);
  });
});

describe('inferirTopologia — el desempate entre un padre concreto y un lugar', () => {
  /**
   * Medido en la base real: expandir primero los equipos y después las cajas
   * sube los equipos con padre de 610 a **619** y baja los
   * `sin-padre-resoluble` de 45 a **36**. Las dos respuestas son válidas; una
   * es útil y la otra no.
   */
  it('a igual distancia gana el padre que es un aparato, no el que es un sitio', () => {
    // 103 se alcanza en dos saltos por dos caminos: 100 → 101 → 103 (equipos)
    // y 100 → 900 → 103 (por la caja del sitio). Tiene que ganar 101.
    const t = inferirTopologia([
      eq(100, 101),
      eq(100, 102),
      eq(100, 104),
      sitio(100, 900),
      eq(101, 103),
      sitio(103, 900),
    ]);
    const d = dependenciaDe(t, 103);
    expect(d.padre).toBe(101);
    expect(d.saltos).toBe(0);
    expect(d.motivo).not.toBe('via-sitio');
  });

  it('cuando arriba del sitio no hay ningún equipo, se dice que no se pudo', () => {
    // Dos equipos colgados de una caja suelta: ninguno de los dos tiene un
    // aparato por encima. Inventar uno sería peor que admitirlo.
    const t = inferirTopologia([sitio(101, 900), sitio(102, 900)]);
    const d = dependenciaDe(t, 102);
    expect(d.padre === null || d.motivo === 'via-sitio').toBe(true);
    if (d.padre === null) expect(d.motivo).toBe('sin-padre-resoluble');
  });
});

describe('inferirTopologia — determinismo', () => {
  /**
   * Sin esto, el padre de un equipo ambiguo cambiaría entre dos recargas de la
   * misma página. Un dato que se mueve solo no se puede usar para decidir nada,
   * y encima destruye la confianza en los que sí son firmes.
   */
  const aristas = [
    eq(100, 101),
    eq(100, 102),
    eq(100, 104),
    eq(101, 103),
    eq(102, 103),
    sitio(104, 900),
    rotulo(101, 800),
  ];

  it('el orden de las aristas de entrada no cambia una sola respuesta', () => {
    const directo = inferirTopologia(aristas);
    const alReves = inferirTopologia([...aristas].reverse());
    const mezclado = inferirTopologia([aristas[3], aristas[0], aristas[5], aristas[1], aristas[6], aristas[4], aristas[2]]);

    const foto = (t: ReturnType<typeof inferirTopologia>): string =>
      [...t.dependencias.keys()]
        .sort((a, b) => a - b)
        .map((id) => `${id}:${JSON.stringify(dependenciaDe(t, id))}`)
        .join('|');

    expect(foto(alReves)).toBe(foto(directo));
    expect(foto(mezclado)).toBe(foto(directo));
  });

  it('las aristas repetidas y los auto-lazos no cambian nada', () => {
    const sucio = [
      ...aristas,
      eq(100, 101),
      eq(101, 100),
      { nodo_a: 100, nodo_b: 100, tipo_a: 'equipo', tipo_b: 'equipo' } as Arista,
    ];
    expect(coberturaDe(inferirTopologia(sucio), 10)).toEqual(
      coberturaDe(inferirTopologia(aristas), 10),
    );
  });
});

describe('cadenaAscendente', () => {
  // Cadena de verdad: 104 → 103 → 102 → 101 → 100, con 100 abriéndose para que
  // el de mayor grado —y por lo tanto la raíz— sea 100.
  const linea = [
    eq(100, 101),
    eq(100, 110),
    eq(100, 111),
    eq(101, 102),
    eq(102, 103),
    eq(103, 104),
  ];

  it('sube hasta la cabecera y numera los niveles desde 1', () => {
    const c = cadenaAscendente(inferirTopologia(linea), 104);
    expect(c.map((e) => e.id)).toEqual([103, 102, 101, 100]);
    expect(c.map((e) => e.nivel)).toEqual([1, 2, 3, 4]);
  });

  it('cada eslabón trae la confianza del paso que lo trajo', () => {
    const c = cadenaAscendente(inferirTopologia(linea), 104);
    // 104 es hoja: el primer paso es el más firme de todos.
    expect(c[0].confianza).toBe('alta');
    expect(c[0].motivo).toBe('hoja');
    for (const e of c) expect(['alta', 'media', 'baja']).toContain(e.confianza);
  });

  it('el tope corta la cadena sin romperla', () => {
    expect(cadenaAscendente(inferirTopologia(linea), 104, 2).map((e) => e.id)).toEqual([103, 102]);
    expect(cadenaAscendente(inferirTopologia(linea), 104, 0)).toEqual([]);
  });

  it('una cabecera y un equipo que no existe devuelven cadena vacía', () => {
    const t = inferirTopologia(linea);
    expect(cadenaAscendente(t, 100)).toEqual([]);
    expect(cadenaAscendente(t, 999)).toEqual([]);
  });

  it('nunca se cuelga, aunque le pasen una topología con un ciclo', () => {
    // El árbol de BFS no puede tener ciclos, pero esta función también corre
    // sobre lo que devuelva una base futura. Que no se cuelgue es la garantía.
    const torcida = {
      dependencias: new Map([
        [1, { padre: 2, confianza: 'alta' as const, motivo: 'hoja' as const, saltos: 0, profundidad: 1 }],
        [2, { padre: 1, confianza: 'alta' as const, motivo: 'hoja' as const, saltos: 0, profundidad: 1 }],
      ]),
      hijos: new Map<number, readonly number[]>(),
      raices: [],
      componentes: 1,
      equiposEnGrafo: 2,
    };
    expect(cadenaAscendente(torcida, 1).map((e) => e.id)).toEqual([2]);
  });
});

describe('inferirTopologia — grafo partido y grafo vacío', () => {
  it('cada pedazo suelto tiene su propia cabecera', () => {
    const t = inferirTopologia([eq(100, 101), eq(100, 102), eq(200, 201), eq(200, 202)]);
    expect(t.componentes).toBe(2);
    expect(t.raices).toEqual([100, 200]);
    expect(dependenciaDe(t, 101).padre).toBe(100);
    expect(dependenciaDe(t, 201).padre).toBe(200);
  });

  it('sin aristas no se afirma nada de nadie', () => {
    const t = inferirTopologia([]);
    expect(t.equiposEnGrafo).toBe(0);
    expect(coberturaDe(t, 885)).toMatchObject({
      total: 885,
      en_grafo: 0,
      con_padre: 0,
      fuera_del_grafo: 885,
      componentes: 0,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Contra PostgreSQL de verdad: la vista y la capa de consultas
// ════════════════════════════════════════════════════════════════════════════
//
// Mismo arranque que `consultas.test.ts`: esquema + seed sobre una base
// DESECHABLE. Sin base los tests de arriba corren igual — la lógica que puede
// mentir es la de arriba, y esa garantía no puede depender de Docker.

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();
const conBase = describe.skipIf(!hayBase);

let q: typeof import('@/lib/consultas');
let db: typeof import('@/lib/db');

beforeAll(async () => {
  if (!hayBase) return;
  process.env.DATABASE_URL = URL_BASE;

  const raiz = resolve(__dirname, '..');
  const esquema = resolve(raiz, '../etl/schema.sql');
  const seed = resolve(raiz, 'seed-dev.sql');
  if (!existsSync(esquema)) throw new Error(`No está ${esquema}`);

  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', esquema]);
  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', seed]);

  q = await import('@/lib/consultas');
  db = await import('@/lib/db');
  q.olvidarTopologia();
}, 60_000);

afterAll(async () => {
  await db?.cerrarPool();
});

conBase('v_topologia_aristas', () => {
  it('devuelve el grafo normalizado: sin auto-lazos, sin repetidas, a < b', () => {
    return q
      .topologiaInferida()
      .then(() => db.consultar<{ mal: number }>(
        `SELECT (SELECT count(*) FROM v_topologia_aristas WHERE nodo_a >= nodo_b)
              + (SELECT count(*) - count(DISTINCT (nodo_a, nodo_b)) FROM v_topologia_aristas)
              AS mal`,
      ))
      .then((f) => expect(Number(f[0].mal)).toBe(0));
  });

  it('todo nodo existe: no inventa ids que no están en la base', async () => {
    const [f] = await db.consultar<{ huerfanos: number }>(
      `WITH n AS (
         SELECT nodo_a AS id, tipo_a AS tipo FROM v_topologia_aristas
         UNION SELECT nodo_b, tipo_b FROM v_topologia_aristas
       )
       SELECT count(*)::int AS huerfanos FROM n
        WHERE (tipo = 'equipo' AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.id = n.id))
           OR (tipo = 'sitio'  AND NOT EXISTS (SELECT 1 FROM maps m WHERE m.id = n.id))
           OR (tipo = 'union'  AND NOT EXISTS (SELECT 1 FROM map_elements e WHERE e.id = n.id))`,
    );
    expect(f.huerfanos).toBe(0);
  });

  it('descarta la punta colgada y CONSERVA el enlace entre mapas', async () => {
    const [f] = await db.consultar<{ colgada: number; cruzado: number }>(
      // 5999 no existe: el seed lo trae a propósito, como las 78 de la base
      // real. 103 ↔ 117 es el enlace que cruza de «Núcleo» a «Zona Norte», y
      // ése SÍ tiene que estar: es lo que evita que el grafo se parta.
      `SELECT (SELECT count(*)::int FROM v_topologia_aristas
                WHERE nodo_a = 5999 OR nodo_b = 5999) AS colgada,
              (SELECT count(*)::int FROM v_topologia_aristas
                WHERE nodo_a = 103 AND nodo_b = 117) AS cruzado`,
    );
    expect(f.colgada).toBe(0);
    expect(f.cruzado).toBe(1);
  });

  it('los rótulos entran como «union» y los submapas como «sitio»', async () => {
    const filas = await db.consultar<{ tipo_b: string; n: number }>(
      `SELECT tipo_b, count(*)::int AS n FROM v_topologia_aristas
        WHERE tipo_a = 'equipo' AND tipo_b <> 'equipo' GROUP BY 1 ORDER BY 1`,
    );
    expect(filas.map((f) => f.tipo_b)).toEqual(['sitio', 'union']);
  });
});

conBase('la inferencia sobre el seed', () => {
  it('🔴 con device_parents VACÍA —el estado real— la inferencia igual responde', async () => {
    // Éste es el punto de todo el trabajo. El seed sí carga `device_parents`
    // porque ahí se prueba `cadenaDePadres`; **la base de producción no**: The
    // Dude no guardó `parentIDs` en ninguno de los 885 equipos. Así que la
    // prueba honesta es vaciarla y ver que la inferencia sigue contestando,
    // porque no lee esa tabla: lee los enlaces dibujados en los mapas.
    // La copia se guarda en JS y no en una tabla TEMP: las temporales viven en
    // UNA conexión y el pool tiene diez, así que `coberturaTopologia` —que hace
    // dos consultas en paralelo— puede caer en otra y no verla.
    const copia = await db.consultar<{ device_id: number; parent_id: number }>(
      'SELECT device_id, parent_id FROM device_parents',
    );
    try {
      await db.consultar('DELETE FROM device_parents');
      expect(await q.hayTopologia()).toBe(false);
      expect(await q.cadenaDePadres(112)).toEqual([]);

      q.olvidarTopologia();
      const c = await q.coberturaTopologia();
      expect(c.con_padre).toBeGreaterThan(0);
      expect(c.en_grafo).toBeGreaterThan(0);
      expect((await q.cadenaDePadresInferida(112)).length).toBeGreaterThan(0);
    } finally {
      await db.consultar(
        `INSERT INTO device_parents (device_id, parent_id)
         SELECT * FROM unnest($1::bigint[], $2::bigint[])`,
        [copia.map((f) => f.device_id), copia.map((f) => f.parent_id)],
      );
      q.olvidarTopologia();
    }
  });

  it('una hoja cuelga de su único vecino, con nombre y estado resueltos', async () => {
    const [padre] = await q.cadenaDePadresInferida(100);
    expect(padre).toMatchObject({ id: 101, nivel: 1, confianza: 'alta', motivo: 'hoja' });
    expect(padre.nombre).toBeTruthy();
  });

  it('la cadena sube atravesando el enlace entre mapas', async () => {
    // 112 está en «Zona Norte» y la cabecera en «Núcleo»: sin el enlace
    // cruzado esta cadena se cortaría a mitad de camino.
    expect((await q.cadenaDePadresInferida(112)).map((p) => p.id)).toEqual([110, 130, 117, 103]);
  });

  it('los niveles crecen de a uno, igual que en cadenaDePadres', async () => {
    const c = await q.cadenaDePadresInferida(112);
    expect(c.map((p) => p.nivel)).toEqual([1, 2, 3, 4]);
  });

  it('hijosInferidos es el reverso exacto de la cadena', async () => {
    const hijos = await q.hijosInferidos(110);
    expect(hijos.map((h) => h.id)).toContain(112);
    for (const h of hijos) {
      expect((await q.cadenaDePadresInferida(h.id))[0].id).toBe(110);
    }
  });

  it('la cabecera no tiene padre, y eso NO es lo mismo que no tener dato', async () => {
    expect(await q.cadenaDePadresInferida(103)).toEqual([]);
    expect((await q.dependenciaInferida(103)).motivo).toBe('raiz-del-grafo');

    // Un equipo del seed que no está en ningún enlace. Si algún día alguien le
    // dibuja uno, este test avisa en vez de mentir en silencio.
    const [suelto] = await db.consultar<{ id: number }>(
      `SELECT d.id FROM devices d
        WHERE NOT EXISTS (SELECT 1 FROM v_topologia_aristas a
                           WHERE a.nodo_a = d.id OR a.nodo_b = d.id)
        ORDER BY d.id LIMIT 1`,
    );
    if (suelto) {
      expect((await q.dependenciaInferida(suelto.id)).motivo).toBe('fuera-del-grafo');
    }
  });
});

conBase('arrastreDe — la advertencia que nunca disparaba', () => {
  it('señala al ancestro caído más cercano, no a cualquiera', async () => {
    // Se tumba la cabecera y se pregunta desde bien abajo del árbol.
    await db.consultar('UPDATE devices SET status = 3 WHERE id IN (103, 130)');
    q.olvidarTopologia();
    try {
      const a = await q.arrastreDe(112);
      // 130 está más cerca que 103: es al que hay que ir a mirar primero.
      expect(a.culpable?.id).toBe(130);
      expect(a.motivo_sin_padre).toBeNull();
      expect(['alta', 'media', 'baja']).toContain(a.culpable?.confianza);
    } finally {
      await db.consultar('UPDATE devices SET status = 1 WHERE id IN (103, 130)');
      q.olvidarTopologia();
    }
  });

  it('sin ancestro caído no acusa a nadie', async () => {
    await db.consultar('UPDATE devices SET status = 1 WHERE id IN (103, 110, 117, 130)');
    q.olvidarTopologia();
    const a = await q.arrastreDe(112);
    expect(a.culpable).toBeNull();
    expect(a.motivo_sin_padre).toBeNull();
  });

  it('🔴 «no hay culpable» y «no sé de quién depende» se responden distinto', async () => {
    const cabecera = await q.arrastreDe(103);
    expect(cabecera.culpable).toBeNull();
    expect(cabecera.motivo_sin_padre).toBe('raiz-del-grafo');

    const inexistente = await q.arrastreDe(999_999);
    expect(inexistente.culpable).toBeNull();
    expect(inexistente.motivo_sin_padre).toBe('fuera-del-grafo');
  });
});

conBase('caidasExplicadasPorArrastre', () => {
  it('los números cierran entre sí', async () => {
    const r = await q.caidasExplicadasPorArrastre();
    expect(r.total).toBeGreaterThan(0);
    expect(r.explicadas).toBeLessThanOrEqual(r.total);
    expect(r.por_padre_directo).toBeLessThanOrEqual(r.explicadas);
    expect(r.sin_cadena).toBeLessThanOrEqual(r.total);
    const suma = r.por_confianza.alta + r.por_confianza.media + r.por_confianza.baja;
    expect(suma).toBe(r.explicadas);
  });

  it('el total coincide con las caídas que tienen equipo', async () => {
    const r = await q.caidasExplicadasPorArrastre();
    const [f] = await db.consultar<{ n: number }>(
      'SELECT count(*)::int AS n FROM outages WHERE device_id IS NOT NULL',
    );
    expect(r.total).toBe(f.n);
  });

  it('acotar la ventana nunca puede devolver MÁS caídas', async () => {
    const todo = await q.caidasExplicadasPorArrastre();
    const semana = await q.caidasExplicadasPorArrastre(24 * 7);
    expect(semana.total).toBeLessThanOrEqual(todo.total);
    expect(semana.explicadas).toBeLessThanOrEqual(todo.explicadas);
  });

  it('sin ningún equipo caído, nada se explica por arrastre', async () => {
    // Se deja UNA sola caída en toda la base: no hay con qué solaparse, así
    // que el arrastre tiene que dar cero. Si diera otra cosa, estaría contando
    // a un equipo como culpable de su propia caída.
    //
    // La copia va a una tabla común y no a una TEMP, por lo mismo que arriba:
    // una TEMP vive en una sola conexión y el pool tiene diez.
    await db.consultar('DROP TABLE IF EXISTS _resguardo_outages');
    await db.consultar('CREATE TABLE _resguardo_outages AS SELECT * FROM outages');
    try {
      await db.consultar(
        'DELETE FROM outages WHERE id <> (SELECT min(id) FROM outages WHERE device_id IS NOT NULL)',
      );
      expect((await q.caidasExplicadasPorArrastre()).explicadas).toBe(0);
    } finally {
      await db.consultar('DELETE FROM outages');
      await db.consultar('INSERT INTO outages SELECT * FROM _resguardo_outages');
      await db.consultar('DROP TABLE _resguardo_outages');
    }
  });
});

conBase('el cache de la topología', () => {
  it('devuelve el mismo objeto hasta que se lo olvida', async () => {
    const a = await q.topologiaInferida();
    expect(await q.topologiaInferida()).toBe(a);
    q.olvidarTopologia();
    const b = await q.topologiaInferida();
    expect(b).not.toBe(a);
    // Mismo grafo, así que el resultado tiene que ser idéntico.
    expect(coberturaDe(b, 100)).toEqual(coberturaDe(a, 100));
  });
});

// ── Utilidades del arranque ─────────────────────────────────────────────────

function psql(args: string[]): void {
  execFileSync('psql', [URL_BASE!, ...args], { stdio: 'pipe' });
}

function tienePsql(): boolean {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
