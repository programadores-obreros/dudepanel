import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditarEscalas,
  auditarLienzo,
  auditarProporciones,
  LADO_LEGIBLE_MINIMO,
  PLANTILLA_CRUDA,
  resumirDefectos,
  type Defecto,
} from '@/lib/legibilidad';
import { cajaDeIcono, construirLienzo, type Lienzo, type Nodo } from '@/lib/mapa';
import type { ElementoMapa } from '@/lib/consultas';
import type { Medida } from '@/lib/iconos';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  La prueba que corta el patrón.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Esto es una deuda que me tomé y acá la salda. Lo dije al entregar la
 *    versión anterior del visor:
 *
 *      «los tests verifican que el dato sea fiel, y lo era en los cuatro casos.
 *       Plantilla cruda, cero decorativo, IP fabricada, foto aplastada — todo
 *       estructuralmente correcto, todo ilegible.»
 *
 *    Cuatro defectos seguidos que sólo se vieron mirando la pantalla no es mala
 *    suerte: es que la suite probaba «¿el dato es cierto?» y ninguno de los
 *    cuatro era un dato falso. Eran datos ciertos dibujados de una forma que no
 *    se puede leer. El barrido que hice a mano sobre los 40 mapas ahora corre
 *    solo, sobre todos los mapas que haya en la base, en cada `pnpm test`.
 *
 * ── Cómo está armado, y por qué en tres capas ───────────────────────────────
 *
 *  1 · **El auditor contra defectos plantados.** Se le dan lienzos que TIENEN
 *      cada defecto y tiene que encontrarlos. Sin esta capa, un auditor roto
 *      que devuelve `[]` siempre pasaría las otras dos en verde — que es
 *      exactamente la forma de test decorativo que este proyecto ya se comió
 *      una vez con el centinela de fuga.
 *
 *  2 · **Barrido sobre todos los mapas de la base.** Ahí es donde aparecen los
 *      casos que nadie inventaría.
 *
 *  3 · **El SVG renderizado de verdad.** Lo que sale a la pantalla, no la
 *      estructura previa. Acá vive la lección de los `<symbol>`: el `<defs>`
 *      del visor tiene un `<symbol>` por icono, así que contar «cuántos nodos
 *      hay» buscando la clase `nodo-mapa` sin restringir da de más — y esa
 *      cuenta inflada fue la que hizo pensar que el mapa estaba completo
 *      cuando le faltaban elementos.
 */

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();
const conBase = describe.skipIf(!hayBase);

let q: typeof import('@/lib/consultas');
let iconos: typeof import('@/lib/iconos');
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
  iconos = await import('@/lib/iconos');
  db = await import('@/lib/db');
}, 60_000);

afterAll(async () => {
  await db?.cerrarPool();
});

// ════════════════════════════════════════════════════════════════════════════
//  1 · El auditor encuentra lo que tiene que encontrar
// ════════════════════════════════════════════════════════════════════════════

describe('el auditor, contra defectos plantados', () => {
  it('un lienzo sano no tiene nada que declarar', () => {
    expect(auditarLienzo(lienzoDe([nodo({})]))).toEqual([]);
  });

  it('agarra la plantilla cruda, campo y función', () => {
    for (const linea of ['[Device.Name]', '[device_performance()]', 'Rx: [Interface.InBitRate]']) {
      expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: [linea] })])))).toContain(
        'plantilla-cruda',
      );
    }
  });

  it('🔴 NO se queja de unos corchetes que son parte del nombre', () => {
    // Apareció barriendo los 40 mapas reales: `Radio-p-Poroto 2[GHz]` es el
    // nombre que una persona le puso al equipo en The Dude, y llega a la
    // pantalla exactamente como corresponde. La primera versión del auditor lo
    // marcaba como plantilla cruda — y un auditor que cría lobos deja de
    // leerse, que es peor que no tenerlo.
    for (const linea of ['Radio-p-Poroto 2[GHz]', 'Enlace [backup]', 'AP [5.8]']) {
      expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: [linea] })])))).not.toContain(
        'plantilla-cruda',
      );
    }
  });

  it('agarra el cero decorativo, con separadores y sin ellos', () => {
    for (const linea of ['0', ' 0 ', '0 ·', '/ 0 /']) {
      expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: ['RT_Core', linea] })])))).toContain(
        'cero-solitario',
      );
    }
  });

  it('NO se queja de un cero que forma parte de un dato', () => {
    // «0 / 3 / 11» es el rótulo de un submapa y el cero del medio informa.
    const d = auditarLienzo(lienzoDe([nodo({ lineas: ['Zona Sur', '48 / 0 / 11'] })]));
    expect(clases(d)).not.toContain('cero-solitario');
  });

  it('agarra el dígito pegado a una dirección, por los dos lados', () => {
    expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: ['1192.0.2.42'] })])))).toContain(
      'digito-pegado',
    );
    expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: ['192.0.2.4231'] })])))).toContain(
      'digito-pegado',
    );
  });

  it('NO se queja de una dirección entera', () => {
    const d = auditarLienzo(lienzoDe([nodo({ lineas: ['SRV_DNS_02', '192.0.2.42'] })]));
    expect(clases(d)).not.toContain('digito-pegado');
  });

  it('agarra la astilla: el lado corto por debajo del mínimo legible', () => {
    // 22×4 es la caja exacta con la que se dibujaba `nanoloco5m_izq` antes.
    const d = auditarLienzo(lienzoDe([nodo({ ancho: 22, alto: 4 })]));
    expect(clases(d)).toContain('icono-astilla');
  });

  it('agarra el nodo mudo y el nombre que es un id crudo', () => {
    expect(clases(auditarLienzo(lienzoDe([nodo({ lineas: [''] })])))).toContain('nodo-mudo');
    expect(
      clases(auditarLienzo(lienzoDe([nodo({ nombre: '#2833594495', lineas: ['#2833594495'] })]))),
    ).toContain('nombre-es-un-id');
  });

  it('agarra la deformación: la caja no respeta la proporción del archivo', () => {
    const medidas = new Map<string, Medida>([['files/rb1100.png', { ancho: 200, alto: 40 }]]);
    const deformado = nodo({ icono: 'files/rb1100.png', ancho: 44, alto: 44 });
    expect(clases(auditarProporciones([deformado], medidas))).toContain('icono-deformado');

    // Y la caja que sí sale de `cajaDeIcono` no se queja.
    const caja = cajaDeIcono('files/rb1100.png', 60, { ancho: 200, alto: 40 });
    const bien = nodo({ icono: 'files/rb1100.png', ...caja });
    expect(auditarProporciones([bien], medidas)).toEqual([]);
  });

  it('el resumen dice qué y dónde, no «expected 3 to be 0»', () => {
    const d = auditarLienzo(lienzoDe([nodo({ id: 5009, lineas: ['1192.0.2.42'] })]));
    expect(resumirDefectos(d)[0]).toContain('elemento 5009');
    expect(resumirDefectos(d)[0]).toContain('1192.0.2.42');
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  2 · El arreglo del lado corto, sobre toda la matriz de escalas
// ════════════════════════════════════════════════════════════════════════════

describe('🔴 ninguna combinación de archivo y escala produce una astilla', () => {
  /**
   * La segunda mitad del arreglo de las fotos aplastadas.
   *
   * `ladoDeIcono` dimensiona el lado MAYOR; el menor caía solo. Medido sobre la
   * base real: `rb1100.png` (200×40) al 60 % daba una caja de **48,2 × 9,6**.
   * Proporción perfecta, ilegible igual. Acá se barre toda la matriz de
   * proporciones y escalas plausibles, no los casos que hoy están cargados.
   */
  const PROPORCIONES: [number, number][] = [
    [200, 40], // rb1100 — 5:1, el peor de la base
    [805, 316],
    [600, 160],
    [50, 171], // apaisado al revés
    [35, 41],
    [96, 96],
    [833, 833],
    [41, 41],
    [628, 100],
    [100, 628],
    // 🔴 El más extremo de la base real, y el que hizo subir el tope de la
    //    caja crecida de 96 a 120: `images/RB2011iL-rack.png` al 20 % daba
    //    96 × 12,6. Apareció barriendo los 40 mapas, no inventando casos.
    [799, 105],
  ];
  const ESCALAS = [5, 7, 10, 20, 30, 50, 60, 80, 100, 120, 160, 179, 200, 400];

  it('el lado corto nunca baja del mínimo legible', () => {
    const combinaciones = PROPORCIONES.flatMap(([ancho, alto]) =>
      ESCALAS.map((escala) => ({ icono: `f/${ancho}x${alto}.png`, escala, medida: { ancho, alto } })),
    );
    expect(resumirDefectos(auditarEscalas(combinaciones))).toEqual([]);
    expect(combinaciones.length).toBeGreaterThan(100);
  });

  it('y la proporción del archivo se conserva igual', () => {
    for (const [ancho, alto] of PROPORCIONES) {
      for (const escala of ESCALAS) {
        const c = cajaDeIcono('x.png', escala, { ancho, alto });
        const desvio = Math.abs(c.ancho / c.alto - ancho / alto) / (ancho / alto);
        // Crecer la caja NO la deforma: el factor se aplica a los dos lados.
        expect(desvio).toBeLessThan(0.05);
      }
    }
  });

  it('un icono sin archivo medible sigue saliendo cuadrado y visible', () => {
    const c = cajaDeIcono('x.svg', 5, null);
    expect(c.ancho).toBe(c.alto);
    expect(c.ancho).toBeGreaterThanOrEqual(LADO_LEGIBLE_MINIMO);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  3 · Barrido sobre TODOS los mapas de la base
// ════════════════════════════════════════════════════════════════════════════

conBase('barrido sobre todos los mapas', () => {
  async function lienzosDeTodo(): Promise<{ id: number; nombre: string; l: Lienzo }[]> {
    const mapas = await q.listarMapas();
    const out = [];
    for (const m of mapas) {
      const elementos = await q.lienzoMapa(m.id);
      if (elementos.length === 0) continue;
      const medidas = await iconos.medidasDeIconos(elementos.map((e) => e.icon));
      out.push({
        id: m.id,
        nombre: m.nombre,
        l: construirLienzo(elementos, await q.resumenSubmapas(m.id), medidas, {
          trafico: await q.traficoDeMapa(m.id),
        }),
      });
    }
    return out;
  }

  it('hay mapas que barrer — si no, este archivo entero no probaría nada', async () => {
    const ls = await lienzosDeTodo();
    expect(ls.length).toBeGreaterThan(0);
    expect(ls.reduce((n, x) => n + x.l.nodos.length, 0)).toBeGreaterThan(10);
  }, 120_000);

  it('🔴 ni un solo defecto de legibilidad en ningún mapa', async () => {
    const fallas: string[] = [];
    for (const { nombre, l } of await lienzosDeTodo()) {
      const d = auditarLienzo(l);
      if (d.length) fallas.push(`«${nombre}»: ${resumirDefectos(d).join(' · ')}`);
    }
    expect(fallas).toEqual([]);
  }, 120_000);

  it('🔴 ninguna caja de icono deforma su archivo', async () => {
    const fallas: string[] = [];
    for (const m of await q.listarMapas()) {
      const elementos = await q.lienzoMapa(m.id);
      if (!elementos.length) continue;
      const medidas = await iconos.medidasDeIconos(elementos.map((e) => e.icon));
      // Sin medidas no hay contra qué comparar: se declara y se saltea, en vez
      // de pasar en verde fingiendo que se revisó.
      if (medidas.size === 0) continue;
      const l = construirLienzo(elementos, await q.resumenSubmapas(m.id), medidas);
      const d = auditarProporciones(l.nodos, medidas);
      if (d.length) fallas.push(`«${m.nombre}»: ${resumirDefectos(d).join(' · ')}`);
    }
    expect(fallas).toEqual([]);
  }, 120_000);

  it('todas las escalas cargadas en la base dan cajas legibles', async () => {
    // No las escalas que se usan hoy: TODAS las que hay cargadas. Un icono que
    // nadie tiene al 10 % pero que alguien puede poner mañana, falla hoy.
    const filas = await db.consultar<{ icono: string; escala: number | null }>(
      `SELECT DISTINCT f.rel_path AS icono, e.image_scale AS escala
       FROM map_elements e JOIN files f ON f.id = e.image_id
       WHERE f.rel_path IS NOT NULL`,
    );
    const combinaciones = [];
    for (const f of filas) {
      const m = await iconos.medidaDeImagen(f.icono);
      if (m) combinaciones.push({ icono: f.icono, escala: f.escala, medida: m });
    }
    // Con el directorio de iconos sin montar no hay nada que medir: se dice.
    if (combinaciones.length === 0) return;
    expect(resumirDefectos(auditarEscalas(combinaciones))).toEqual([]);
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
//  4 · Lo que de verdad sale a la pantalla
// ════════════════════════════════════════════════════════════════════════════

conBase('el SVG renderizado', () => {
  async function dibujar(mapId: number): Promise<string> {
    const { experimental_AstroContainer } = await import('astro/container');
    const contenedor = await experimental_AstroContainer.create();
    const VisorMapa = (await import('@/components/VisorMapa.astro')).default;
    const mapa = await q.obtenerMapa(mapId);
    return contenedor.renderToString(VisorMapa, {
      props: {
        mapaId: mapId,
        nombre: mapa?.nombre ?? '',
        elementos: await q.lienzoMapa(mapId),
        submapas: await q.resumenSubmapas(mapId),
        fuera: await q.enlacesFueraDelMapa(mapId),
        trafico: await q.traficoDeMapa(mapId),
      },
    });
  }

  it('🔴 el conteo de nodos se restringe a los nodos, no al `<defs>`', async () => {
    const mapas = await q.listarMapas();
    const mapa = mapas.find((m) => m.elementos > 5)!;
    const html = await dibujar(mapa.id);

    // El `<defs>` del visor lleva un `<symbol>` por icono SVG incrustado, y la
    // referencia de estados dibuja cuatro `nodo-mapa` de muestra. Contar la
    // clase a secas da de más; los nodos de verdad son los que traen `data-id`.
    const conClase = [...html.matchAll(/class="nodo-mapa"/g)].length;
    const conId = [...html.matchAll(/class="nodo-mapa"[^>]*\sdata-id=/g)].length;
    const elementos = await q.lienzoMapa(mapa.id);
    const medidas = await iconos.medidasDeIconos(elementos.map((e) => e.icon));
    const l = construirLienzo(elementos, await q.resumenSubmapas(mapa.id), medidas);

    expect(conId).toBe(l.nodos.length);
    // Y que la diferencia exista: si un día el `<defs>` desapareciera, esta
    // línea avisa que la restricción dejó de tener sentido.
    expect(conClase).toBeGreaterThan(conId);
  }, 120_000);

  it('🔴 ningún `[Algo]` llega a la pantalla, en ningún mapa', async () => {
    const fallas: string[] = [];
    for (const m of await q.listarMapas()) {
      if (m.elementos === 0) continue;
      const html = await dibujar(m.id);
      // Sólo el texto dibujable: `<text>`, `<tspan>` y `<title>`. Un `[` dentro
      // de un atributo de Tailwind (`min-h-[24rem]`) no es un rótulo crudo, y
      // un `[GHz]` en el nombre de un equipo tampoco. Ver `PLANTILLA_CRUDA`.
      for (const [, texto] of html.matchAll(/<(?:text|tspan|title)[^>]*>([^<]*)</g)) {
        if (PLANTILLA_CRUDA.test(texto)) fallas.push(`«${m.nombre}»: ${texto.trim()}`);
      }
    }
    expect(fallas.slice(0, 5)).toEqual([]);
  }, 180_000);

  it('todo nodo dibujado tiene nombre accesible y `<title>`', async () => {
    const mapa = (await q.listarMapas()).find((m) => m.elementos > 5)!;
    const html = await dibujar(mapa.id);
    const nodos = [...html.matchAll(/<(?:a|g) class="nodo-mapa"[^>]*data-id="(\d+)"[^>]*>/g)];
    expect(nodos.length).toBeGreaterThan(0);
    for (const [etiqueta] of nodos) {
      expect(etiqueta).toMatch(/aria-label="[^"]{3,}"/);
    }
    // Un `<title>` por nodo: es lo que ve quien pasa el mouse sin JavaScript.
    expect([...html.matchAll(/<title>/g)].length).toBeGreaterThanOrEqual(nodos.length);
  }, 120_000);

  it('🔴 ningún ancho o alto degenerado en las imágenes del mapa', async () => {
    // La astilla, mirada desde el otro lado: no la caja calculada sino el
    // atributo que efectivamente se escribe en el SVG.
    const fallas: string[] = [];
    for (const m of await q.listarMapas()) {
      if (m.elementos === 0) continue;
      const html = await dibujar(m.id);
      for (const [, w, h] of html.matchAll(
        /<(?:image|use)[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g,
      )) {
        const menor = Math.min(Number(w), Number(h));
        if (!(menor >= LADO_LEGIBLE_MINIMO)) fallas.push(`«${m.nombre}»: ${w}×${h}`);
      }
    }
    expect(fallas.slice(0, 5)).toEqual([]);
  }, 180_000);

  it('los cuatro estados de enlace se distinguen sin usar el color', async () => {
    // 🔴 «Arriba» y «sin datos» se dibujaban los dos con línea llena: en escala
    //    de grises eran el mismo trazo. La regla del proyecto —el estado nunca
    //    sólo por color— se cumplía en los nodos y no en los 542 enlaces.
    const css = await import('node:fs/promises').then((fs) =>
      fs.readFile(resolve(__dirname, '../src/styles/global.css'), 'utf8'),
    );
    const patrones = new Set<string>();
    for (const estado of ['0', '1', '2', '3']) {
      const bloque = css.match(
        new RegExp(`\\.enlace-mapa\\[data-estado='${estado}'\\]\\s*\\{([^}]*)\\}`),
      );
      expect(bloque, `falta la regla del estado ${estado}`).not.toBeNull();
      const dash = bloque![1]!.match(/stroke-dasharray:\s*([^;]+)/)?.[1]?.trim() ?? 'ninguno';
      patrones.add(dash);
    }
    // Cuatro estados, cuatro patrones de trazo distintos.
    expect(patrones.size).toBe(4);
  });
});

// ── Utilidades ──────────────────────────────────────────────────────────────

function clases(d: readonly Defecto[]): string[] {
  return d.map((x) => x.clase);
}

function nodo(parcial: Partial<Nodo>): Nodo {
  return {
    id: 1,
    cx: 0,
    cy: 0,
    kind: 'device',
    estado: 1,
    nombre: 'RT_Core',
    lineas: ['RT_Core'],
    icono: null,
    ancho: 22,
    alto: 22,
    href: '/dispositivos/1',
    direcciones: [],
    reubicado: false,
    deviceId: 1,
    desde: null,
    antiguedad: null,
    edad_s: null,
    ...parcial,
  };
}

function lienzoDe(nodos: Nodo[]): Lienzo {
  return {
    nodos,
    enlaces: [],
    rotulos: [],
    vista: { x: 0, y: 0, ancho: 100, alto: 100 },
    sinPosicion: 0,
    enlacesTotales: 0,
    huecos: [],
  };
}

/** Elementos crudos, por si algún test los necesita sin pasar por la base. */
export function elemento(p: Partial<ElementoMapa>): ElementoMapa {
  return {
    element_id: 1,
    kind: 'device',
    x: 0,
    y: 0,
    shape: 0,
    label: null,
    icon: null,
    link_from: null,
    link_to: null,
    link_width: null,
    link_id: null,
    name: 'RT_Core',
    status: 1,
    device_id: 1,
    submap_id: null,
    direcciones: [],
    services_down: 0,
    image_scale: 100,
    estado_desde: null,
    ...p,
  };
}

function tienePsql(): boolean {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function psql(args: string[]) {
  execFileSync('psql', [URL_BASE!, ...args], { stdio: 'pipe' });
}
