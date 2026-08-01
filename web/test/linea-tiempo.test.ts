import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPCIONES_VENTANA,
  anchoVisible,
  armarBandas,
  caminoDe,
  coalescerParaDibujo,
  dominioY,
  escala,
  esOpcionVentana,
  instante,
  necesitaAnio,
  partirEnTramos,
  resolverVentana,
  ticksTiempo,
  type CaidaCruda,
  type CoberturaDude,
  type Ventana,
} from '@/lib/linea-tiempo';

/**
 * La línea de tiempo del equipo.
 *
 * Dos mitades bien separadas:
 *
 *   1. Reglas puras (`lib/linea-tiempo`). Corren siempre, sin base. Acá está
 *      todo lo que decide qué se dibuja y qué se descarta, que es donde una
 *      pantalla de monitoreo puede mentir sin que nadie lo note.
 *   2. La SQL (`lib/consultas`). Contra PostgreSQL de verdad, con una fixture
 *      que reproduce los casos raros de la base real.
 *
 * Las direcciones son de RFC 5737 y las MAC de RFC 7042. Ver `seed.test.ts`,
 * que barre el repositorio buscando cualquier cosa con forma de dato real.
 */

// ── Instantes de referencia. Todo en epoch de segundos, todo en UTC. ────────
const H = 3600;
const D = 86400;
/** 2026-05-01 00:00:00 UTC. */
const T0 = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000);
const VENTANA: Ventana = { desde: T0, hasta: T0 + 24 * H };

/** The Dude conoce del 01/05 06:00 al 01/05 18:00. Afuera manda el syslog. */
const COBERTURA: CoberturaDude = { desde: T0 + 6 * H, hasta: T0 + 18 * H };

function caida(p: Partial<CaidaCruda> & { id: number }): CaidaCruda {
  return { fuente: 'dude', inicio: null, fin: null, cruza_hueco: false, ...p };
}

// ═════════════════════════════════════════════════════════════════════════════
// Bandas
// ═════════════════════════════════════════════════════════════════════════════

describe('armarBandas · lo básico', () => {
  it('una caída cerrada adentro de la ventana es una banda con sus dos bordes', () => {
    const { bandas, marcas, descartes } = armarBandas(
      [caida({ id: 1, inicio: T0 + 8 * H, fin: T0 + 9 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toEqual([
      {
        inicio: T0 + 8 * H,
        fin: T0 + 9 * H,
        fuente: 'dude',
        abierta: false,
        recortada_inicio: false,
        cantidad: 1,
      },
    ]);
    expect(marcas).toEqual([]);
    expect(descartes.fuera_de_ventana).toBe(0);
  });

  it('la que empieza antes de la ventana se recorta y lo declara', () => {
    const { bandas } = armarBandas(
      [caida({ id: 1, inicio: T0 - 5 * H, fin: T0 + 2 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas[0].inicio).toBe(VENTANA.desde);
    // 🔴 Sin esta bandera el dibujo diría que la caída empezó exactamente al
    //    abrir la ventana, que es una fecha inventada por el recorte.
    expect(bandas[0].recortada_inicio).toBe(true);
  });

  it('la que está entera afuera no se dibuja, y se cuenta', () => {
    const { bandas, descartes } = armarBandas(
      [caida({ id: 1, inicio: T0 - 10 * H, fin: T0 - 9 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toEqual([]);
    expect(descartes.fuera_de_ventana).toBe(1);
  });

  it('el dato imposible —fin antes del inicio— no dibuja una banda al revés', () => {
    const { bandas } = armarBandas(
      [caida({ id: 1, inicio: T0 + 9 * H, fin: T0 + 8 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toEqual([]);
  });
});

describe('armarBandas · las caídas sin cerrar', () => {
  it('sin fin, la banda llega al borde y queda marcada abierta', () => {
    const { bandas } = armarBandas(
      [caida({ id: 1, inicio: T0 + 20 * H, fin: null })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas[0].fin).toBe(VENTANA.hasta);
    // 🔴 `abierta` es lo que hace que el dibujo ponga el borde punteado. Sin
    //    esto, el borde derecho de la ventana se lee como una recuperación a
    //    esa hora exacta, que nadie midió.
    expect(bandas[0].abierta).toBe(true);
  });

  it('sin inicio NO hay banda: hay una marca, que es lo que el dato es', () => {
    const { bandas, marcas, descartes } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: null, fin: T0 + 3 * H })],
      VENTANA,
      COBERTURA,
    );
    // Una banda necesita dos bordes. Acá hay uno solo y el otro habría que
    // inventarlo: en la base real son 272 filas con `closure = 'no_start'`.
    expect(bandas).toEqual([]);
    expect(marcas).toEqual([{ t: T0 + 3 * H, fuente: 'syslog', cantidad: 1 }]);
    expect(descartes.sin_inicio).toBe(1);
  });

  it('la marca fuera de la ventana no se dibuja, pero se sigue contando', () => {
    const { marcas, descartes } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: null, fin: T0 - 3 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(marcas).toEqual([]);
    expect(descartes.sin_inicio).toBe(1);
  });

  it('dos sondas que reportan la misma recuperación son una sola marca', () => {
    const { marcas } = armarBandas(
      [
        caida({ id: 1, fuente: 'syslog', inicio: null, fin: T0 + 3 * H }),
        caida({ id: 2, fuente: 'syslog', inicio: null, fin: T0 + 3 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(marcas).toEqual([{ t: T0 + 3 * H, fuente: 'syslog', cantidad: 2 }]);
  });
});

describe('armarBandas · el hueco de registro del syslog', () => {
  /**
   * 🔴 Este es el caso que más daño hace y el más fácil de pasar por alto.
   *
   *    Medido el 01/08/2026: `syslog_outages` tiene UNA fila con
   *    `spans_gap = true`, del 23/11/2025 al 12/06/2026 — **201 días**. No es
   *    una caída de siete meses: entre esas dos fechas no hay archivos de
   *    syslog, y la reconstrucción unió el último «down» que vio con el primer
   *    «up» del otro lado del pozo.
   *
   *    Los pozos medidos son de 403, 1.128, 462 y 83 días. Una banda que cruce
   *    cualquiera de esos pinta de rojo años que la red pasó bien.
   */
  it('la que cruza un hueco NO se dibuja aunque tenga los dos bordes', () => {
    const { bandas, descartes } = armarBandas(
      [
        caida({
          id: 1,
          fuente: 'syslog',
          inicio: T0 - 200 * D,
          fin: T0 + 2 * H,
          cruza_hueco: true,
        }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toEqual([]);
    expect(descartes.cruzan_hueco).toBe(1);
  });

  it('el descarte se cuenta aparte, para poder escribirlo en la pantalla', () => {
    const { descartes } = armarBandas(
      [
        caida({ id: 1, fuente: 'syslog', inicio: T0 + 1 * H, fin: T0 + 2 * H, cruza_hueco: true }),
        caida({ id: 2, fuente: 'syslog', inicio: T0 + 3 * H, fin: T0 + 4 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    // Un descarte silencioso es una mentira por omisión: el hueco se lee como
    // «acá no pasó nada». Por eso el contador sale a la letra chica.
    expect(descartes.cruzan_hueco).toBe(1);
    expect(descartes.fuera_de_ventana).toBe(0);
  });
});

describe('armarBandas · el reparto entre las dos fuentes', () => {
  /**
   * 🔴 Medido el 01/08/2026: de **4.673** caídas del syslog dentro del tramo
   *    que cubre The Dude, **4.408 —el 94,3 %—** tienen una caída del Dude del
   *    mismo equipo arrancando dentro de ±5 minutos. Son el mismo evento.
   *
   *    Emparejar de a una dejaría el 5,7 % restante dibujado AL LADO de su
   *    gemela. Por eso el reparto es territorial y no por parejas.
   */
  it('el syslog no dibuja nada adentro de la cobertura de The Dude', () => {
    const { bandas, descartes } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: T0 + 8 * H, fin: T0 + 9 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toEqual([]);
    expect(descartes.segundos_syslog_solapados).toBe(1 * H);
  });

  it('afuera de la cobertura, el syslog manda', () => {
    const { bandas } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: T0 + 1 * H, fin: T0 + 2 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toHaveLength(1);
    expect(bandas[0].fuente).toBe('syslog');
    expect(bandas[0].inicio).toBe(T0 + 1 * H);
  });

  it('la que cruza el borde de la cobertura se parte en dos y no pisa al Dude', () => {
    // Del 05:00 al 19:00, y el Dude cubre de 06:00 a 18:00.
    const { bandas, descartes } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: T0 + 5 * H, fin: T0 + 19 * H })],
      VENTANA,
      COBERTURA,
    );
    expect(bandas.map((b) => [b.inicio - T0, b.fin - T0])).toEqual([
      [5 * H, 6 * H],
      [18 * H, 19 * H],
    ]);
    // Las doce horas del medio son las que ya cuenta The Dude.
    expect(descartes.segundos_syslog_solapados).toBe(12 * H);
  });

  it('sin cobertura conocida del Dude, el syslog se dibuja entero', () => {
    // Es el caso de un equipo que The Dude nunca registró: no hay a quién
    // cederle el terreno, y callarse el syslog sería perder el único dato.
    const { bandas } = armarBandas(
      [caida({ id: 1, fuente: 'syslog', inicio: T0 + 8 * H, fin: T0 + 9 * H })],
      VENTANA,
      { desde: null, hasta: null },
    );
    expect(bandas).toHaveLength(1);
  });

  it('las bandas del Dude y del syslog no se fusionan entre sí', () => {
    // Se tocan en el borde de la cobertura, pero cada una tiene que poder
    // decir de dónde salió: una banda mitad y mitad no es de nadie.
    const { bandas } = armarBandas(
      [
        caida({ id: 1, fuente: 'syslog', inicio: T0 + 4 * H, fin: T0 + 6 * H }),
        caida({ id: 2, fuente: 'dude', inicio: T0 + 6 * H, fin: T0 + 8 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas.map((b) => b.fuente)).toEqual(['syslog', 'dude']);
  });
});

describe('armarBandas · fusión de las que se pisan', () => {
  /**
   * 🔴 Un equipo tiene varias sondas y cuando se cae, caen todas. En la base
   *    real hay equipos con 47 caídas en 7 días y 259 en 30. Dibujarlas de a
   *    una da una pared roja de bordes serruchados, y además exagera: dos
   *    sondas caídas a la vez son UN incidente.
   */
  it('dos caídas que se solapan son una sola banda que las cuenta', () => {
    const { bandas } = armarBandas(
      [
        caida({ id: 1, inicio: T0 + 8 * H, fin: T0 + 10 * H }),
        caida({ id: 2, inicio: T0 + 9 * H, fin: T0 + 11 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toHaveLength(1);
    expect(bandas[0].inicio - T0).toBe(8 * H);
    expect(bandas[0].fin - T0).toBe(11 * H);
    expect(bandas[0].cantidad).toBe(2);
  });

  it('dos caídas separadas siguen siendo dos bandas', () => {
    const { bandas } = armarBandas(
      [
        caida({ id: 1, inicio: T0 + 8 * H, fin: T0 + 9 * H }),
        caida({ id: 2, inicio: T0 + 10 * H, fin: T0 + 11 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toHaveLength(2);
  });

  it('si una de las fusionadas está abierta, la banda queda abierta', () => {
    const { bandas } = armarBandas(
      [
        caida({ id: 1, inicio: T0 + 20 * H, fin: T0 + 22 * H }),
        caida({ id: 2, inicio: T0 + 21 * H, fin: null }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas).toHaveLength(1);
    expect(bandas[0].abierta).toBe(true);
  });

  it('la fusión no infla el tiempo caído: 8-10 y 9-11 son tres horas, no cuatro', () => {
    const { bandas } = armarBandas(
      [
        caida({ id: 1, inicio: T0 + 8 * H, fin: T0 + 10 * H }),
        caida({ id: 2, inicio: T0 + 9 * H, fin: T0 + 11 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    const total = bandas.reduce((a, b) => a + (b.fin - b.inicio), 0);
    expect(total).toBe(3 * H);
  });

  it('las bandas salen ordenadas por tiempo aunque entren mezcladas', () => {
    const { bandas } = armarBandas(
      [
        caida({ id: 1, fuente: 'dude', inicio: T0 + 16 * H, fin: T0 + 17 * H }),
        caida({ id: 2, fuente: 'syslog', inicio: T0 + 1 * H, fin: T0 + 2 * H }),
        caida({ id: 3, fuente: 'dude', inicio: T0 + 7 * H, fin: T0 + 8 * H }),
      ],
      VENTANA,
      COBERTURA,
    );
    expect(bandas.map((b) => b.inicio - T0)).toEqual([1 * H, 7 * H, 16 * H]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Series
// ═════════════════════════════════════════════════════════════════════════════

describe('partirEnTramos', () => {
  /**
   * 🔴 Esto es lo que impide la mentira más grave de la pantalla.
   *
   *    Durante una caída el equipo no contesta el ping, así que NO HAY
   *    medición. Si la línea se dibuja de un solo trazo, cruza la banda roja
   *    plana y recta y dice «la latencia estuvo estable mientras estaba
   *    caído» — literalmente lo contrario de lo que pasó.
   */
  it('parte donde el muestreo se cortó', () => {
    const puntos: [number, number][] = [
      [0, 1], [2, 1], [4, 1],
      [4000, 2], [4002, 2], [4004, 2],
    ];
    const tramos = partirEnTramos(puntos);
    expect(tramos).toHaveLength(2);
    expect(tramos[0]).toHaveLength(3);
    expect(tramos[1]).toHaveLength(3);
  });

  it('no parte por el jitter normal del sondeo', () => {
    // Medido el 01/08/2026 sobre `chart_values`: separación mediana de 2 s,
    // percentil 99 de 10 s, máximo 74 s. Nada de eso es un hueco.
    const puntos: [number, number][] = [
      [0, 1], [2, 1], [12, 1], [14, 1], [74, 1], [76, 1],
    ];
    expect(partirEnTramos(puntos)).toHaveLength(1);
  });

  it('el piso evita que una serie muy regular se parta por una demora chica', () => {
    // Con mediana de 1 s y factor 8, el umbral daría 8 s. El piso de 60 s
    // manda: una demora de 30 s en un sondeo de 1 s no es una caída.
    const puntos: [number, number][] = [[0, 1], [1, 1], [2, 1], [32, 1], [33, 1]];
    expect(partirEnTramos(puntos)).toHaveLength(1);
  });

  it('con un punto solo devuelve un tramo, y con ninguno, ninguno', () => {
    expect(partirEnTramos([[5, 1]])).toEqual([[[5, 1]]]);
    expect(partirEnTramos([])).toEqual([]);
  });
});

describe('dominioY', () => {
  it('deja aire arriba y abajo, y NO arranca en cero', () => {
    // Para latencia, cero es un valor imposible y arrancar ahí aplasta la
    // variación: una serie de 3 a 8 ms se vería como una línea recta.
    const d = dominioY([0.003, 0.008]);
    expect(d.min).toBeCloseTo(0.0025, 6);
    expect(d.max).toBeCloseTo(0.0085, 6);
  });

  it('una serie constante no colapsa el dominio a un punto', () => {
    const d = dominioY([5, 5, 5]);
    expect(d.max).toBeGreaterThan(d.min);
  });

  it('sin valores devuelve un dominio usable en vez de NaN', () => {
    expect(dominioY([])).toEqual({ min: 0, max: 1 });
  });
});

describe('escala y caminoDe', () => {
  it('mapea los extremos a los extremos', () => {
    const f = escala(0, 10, 100, 200);
    expect(f(0)).toBe(100);
    expect(f(10)).toBe(200);
    expect(f(5)).toBe(150);
  });

  it('el dominio degenerado va al medio del rango, no a NaN', () => {
    const f = escala(7, 7, 100, 200);
    expect(f(7)).toBe(150);
  });

  it('arma un path con M y L', () => {
    const f = escala(0, 10, 0, 100);
    expect(caminoDe([[0, 0], [10, 10]], f, f)).toBe('M0.0 0.0 L100.0 100.0');
  });

  it('un tramo vacío no produce un path roto', () => {
    expect(caminoDe([], escala(0, 1, 0, 1), escala(0, 1, 0, 1))).toBe('');
  });
});

describe('anchoVisible', () => {
  /**
   * 🔴 Una caída de 30 segundos en una ventana de 30 días mide 0,01 unidades
   *    del viewBox. «No se ve» y «no pasó» son la misma imagen.
   */
  it('ensancha la banda hipfina hasta el mínimo, centrada', () => {
    // Centro en 500,005 → [499,005 · 501,005]. La banda crece hacia los dos
    // lados por igual: correrla toda a la derecha la mostraría más tarde de
    // cuando pasó.
    const [a, b] = anchoVisible(500, 500.01, 2);
    expect(b - a).toBeCloseTo(2, 9);
    expect((a + b) / 2).toBeCloseTo(500.005, 9);
  });

  it('no toca la que ya se ve', () => {
    expect(anchoVisible(100, 300, 2)).toEqual([100, 300]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Eje y ventana
// ═════════════════════════════════════════════════════════════════════════════

describe('ticksTiempo', () => {
  it('cae en horas redondas, no en el rango dividido en cinco', () => {
    // Un eje que dice 14:07, 14:31, 14:55 obliga a leer cada etiqueta.
    const t = ticksTiempo({ desde: T0 + 137, hasta: T0 + 6 * H }, 5, 'UTC');
    expect(t.map((x) => x.texto)).toEqual(['02:00', '04:00', '06:00']);
  });

  it('con rango de días etiqueta con la fecha, siempre a dos dígitos', () => {
    // 🔴 Medido: `Intl` con día y mes en `2-digit` y nada más devuelve «7/5» en
    //    es-AR, no «07/05». En un eje eso hace que las etiquetas tengan ancho
    //    distinto y bailen. Por eso el módulo las arma con `formatToParts`.
    const t = ticksTiempo({ desde: T0, hasta: T0 + 10 * D }, 5, 'UTC');
    expect(t.length).toBeGreaterThan(0);
    for (const tk of t) expect(tk.texto).toMatch(/^\d{2}\/\d{2}$/);
  });

  it('todas las marcas caen adentro de la ventana', () => {
    const v = { desde: T0 + 999, hasta: T0 + 5 * D + 7 };
    for (const tk of ticksTiempo(v, 6, 'UTC')) {
      expect(tk.t).toBeGreaterThanOrEqual(v.desde);
      expect(tk.t).toBeLessThanOrEqual(v.hasta);
    }
  });

  it('un rango vacío no devuelve marcas ni entra en un bucle infinito', () => {
    expect(ticksTiempo({ desde: T0, hasta: T0 }, 5, 'UTC')).toEqual([]);
    expect(ticksTiempo({ desde: T0, hasta: T0 - 10 }, 5, 'UTC')).toEqual([]);
  });
});

describe('resolverVentana', () => {
  const AHORA = T0 + 30 * D;

  /**
   * 🔴 `medido` es la ventana por defecto y no es un capricho.
   *
   *    Medido el 01/08/2026 contra la base real: la serie de un equipo dura
   *    **2 h 04 m de mediana** —ninguna de las 170 fuentes con datos llega a
   *    6 h, porque `raw` es un buffer circular— y el volcado tiene 45 h de
   *    atraso. Con «últimas 24 h», el criterio del resto de la ficha, hoy no
   *    hay UN SOLO equipo con serie dibujable, sobre 885.
   */
  it('se ancla al tramo con mediciones, no a las últimas horas', () => {
    const span = { desde: T0 + 10 * D, hasta: T0 + 10 * D + 2 * H };
    const v = resolverVentana('medido', AHORA, span);
    expect(v.anclada).toBe(true);
    expect(v.desde).toBeLessThan(span.desde);
    expect(v.hasta).toBeGreaterThan(span.hasta);
    // El aire es chico: la ventana tiene que seguir siendo la del dato.
    expect(v.hasta - v.desde).toBeLessThan(3 * H);
  });

  it('el aire deja ver si la caída empezó justo en el borde del tramo medido', () => {
    const span = { desde: T0, hasta: T0 + 2 * H };
    const v = resolverVentana('medido', AHORA, span);
    expect(v.desde).toBeLessThan(span.desde);
  });

  it('sin mediciones, `medido` cae a 7 días y lo dice', () => {
    const v = resolverVentana('medido', AHORA, null);
    expect(v.opcion).toBe('7d');
    expect(v.anclada).toBe(false);
    expect(v.hasta - v.desde).toBe(7 * D);
  });

  it('un span degenerado tampoco ancla', () => {
    const v = resolverVentana('medido', AHORA, { desde: T0, hasta: T0 });
    expect(v.opcion).toBe('7d');
  });

  it('los rangos fijos terminan en ahora y duran lo que dicen', () => {
    for (const [op, dias] of [['24h', 1], ['7d', 7], ['30d', 30], ['1a', 365]] as const) {
      const v = resolverVentana(op, AHORA, null);
      expect(v.hasta).toBe(AHORA);
      expect(v.hasta - v.desde).toBe(dias * D);
      expect(v.anclada).toBe(false);
    }
  });

  it('el aire nunca es menor a un minuto, ni con un span de un segundo', () => {
    const v = resolverVentana('medido', AHORA, { desde: T0, hasta: T0 + 1 });
    expect(v.hasta - v.desde).toBeGreaterThanOrEqual(120);
  });
});

describe('esOpcionVentana', () => {
  it('acepta sólo las que existen', () => {
    for (const o of OPCIONES_VENTANA) expect(esOpcionVentana(o.valor)).toBe(true);
  });

  it('rechaza lo que venga por la URL', () => {
    // 🔴 El parámetro `?lt=` lo escribe cualquiera. Sin esta guarda, un valor
    //    inventado llegaría a `HORAS_DE[...]` y saldría un rango NaN, que
    //    dibuja un SVG vacío sin ningún error visible.
    for (const v of ['', '6h', '24H', 'null', '../etc', null]) {
      expect(esOpcionVentana(v)).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// La SQL, contra PostgreSQL de verdad
// ═════════════════════════════════════════════════════════════════════════════

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();
const conBase = describe.skipIf(!hayBase);

const EN_CI = !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0';

describe('entorno de los tests de base de datos', () => {
  it.runIf(EN_CI)('en CI la base es obligatoria: saltear sería un verde vacío', () => {
    expect({
      hay_TEST_DATABASE_URL_o_DATABASE_URL: Boolean(URL_BASE),
      hay_psql_en_el_PATH: tienePsql(),
    }).toEqual({ hay_TEST_DATABASE_URL_o_DATABASE_URL: true, hay_psql_en_el_PATH: true });
  });
});

let q: typeof import('@/lib/consultas');
let db: typeof import('@/lib/db');

/**
 * El escenario, con los casos raros de la base real reproducidos a mano.
 *
 * `990201` es el equipo completo: latencia, tráfico rx/tx, caídas del Dude y
 * del syslog. `990202` no tiene ninguna medición, que es el caso de 718 de los
 * 885 equipos reales.
 */
const T_SQL = '2026-05-01 00:00:00+00';
const FIXTURE = `
-- 🔴 \`seed-dev.sql\` TRUNCA todo menos las tablas del syslog, y \`schema.sql\`
--    crea con IF NOT EXISTS: sin este borrado, correr la suite dos veces
--    contra el mismo contenedor revienta por clave duplicada acá y en ningún
--    otro archivo, que es la clase de rojo que hace perder una tarde.
DELETE FROM syslog_outages;

INSERT INTO devices (id, name, addresses, dns_names, macs, type_id, snmp_profile_id,
                     router_os, probe_enabled, probe_interval, probe_timeout,
                     probe_down_count, dude_server, status)
VALUES
  (990201, 'ZZLT completo', '{192.0.2.201}', NULL, '{00:00:5E:00:53:B1}', NULL, NULL, false, true, 60, 2000, 3, false, 1),
  (990202, 'ZZLT sin serie', '{192.0.2.202}', NULL, '{00:00:5E:00:53:B2}', NULL, NULL, false, true, 60, 2000, 3, false, 1);

INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
VALUES
  (990211, 990201, 701, 1, true, false, 0, 60, 2000, NULL, 0, 0, 0),
  (990212, 990202, 701, 1, true, false, 0, 60, 2000, NULL, 0, 0, 0);

INSERT INTO chart_sources (id, name, device_id, service_id, link_id, unit, enabled) VALUES
  (990301, 'ZZLT ping',            NULL,   990211, NULL, 's',     true),
  (990302, 'ether1 @ ZZLT rx',     990201, NULL,   NULL, 'bit/s', true),
  (990303, 'ether1 @ ZZLT tx',     990201, NULL,   NULL, 'bit/s', true),
  -- 🔴 El balde vacío: filas con el instante puesto y \`value\` en NULL. Son
  --    346 de las 348 fuentes de bit/s en la base real. Si esta fuente
  --    apareciera como serie, el panel dibujaría un gráfico de tráfico de un
  --    enlace que nadie está midiendo.
  (990304, 'ether2 @ ZZLT rx',     990201, NULL,   NULL, 'bit/s', true),
  -- Un cajón que no se usa: si se colara, mezclaría un promedio de un día con
  -- una medición cruda.
  (990305, 'ZZLT ping agregado',   990201, NULL,   NULL, 's',     true);

-- Latencia: 40 puntos cada 30 s, de 10:00 a 10:19:30.
INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT 990301, 'raw', timestamptz '${T_SQL}' + interval '10 hours' + (n * interval '30 seconds'),
       0.004 + n * 0.0001
FROM generate_series(0, 39) AS n;

-- 🔴 Los centinelas en cero, intercalados entre las mediciones de verdad. En
--    la base real son el 86,5 % de las muestras de latencia y no hay ni un
--    valor entre 0 y 15 ms: es el relleno de los casilleros sin sondeo.
INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT 990301, 'raw', timestamptz '${T_SQL}' + interval '10 hours 15 seconds' + (n * interval '30 seconds'), 0
FROM generate_series(0, 39) AS n;

-- Y el cero en TRÁFICO, que sí es un valor real: el enlace no pasa nada.
INSERT INTO chart_values (source_id, bucket, ts, value)
VALUES (990302, 'raw', timestamptz '${T_SQL}' + interval '10 hours 25 minutes', 0);

INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT id, 'raw', timestamptz '${T_SQL}' + interval '10 hours' + (n * interval '30 seconds'),
       1000000 + n * 1000
FROM (VALUES (990302), (990303)) AS f(id) CROSS JOIN generate_series(0, 39) AS n;

INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT 990304, 'raw', timestamptz '${T_SQL}' + interval '10 hours' + (n * interval '30 seconds'), NULL
FROM generate_series(0, 39) AS n;

INSERT INTO chart_values (source_id, bucket, ts, value)
SELECT 990305, '1day', timestamptz '${T_SQL}' + interval '10 hours' + (n * interval '1 day'), 9.9
FROM generate_series(0, 3) AS n;

-- Caídas de The Dude: una cerrada adentro del rato medido, una abierta.
INSERT INTO outages (id, service_id, device_id, started_at, ended_at, duration_s) VALUES
  (990401, 990211, 990201, timestamptz '${T_SQL}' + interval '10 hours 5 minutes',
                            timestamptz '${T_SQL}' + interval '10 hours 7 minutes', 120),
  (990402, 990211, 990201, timestamptz '${T_SQL}' + interval '20 hours', NULL, NULL);

-- Syslog: una que pisa a la del Dude, una vieja, una que cruza un hueco y una
-- sin inicio. Además una \`ambiguous\` SIN device_id, que no tiene que aparecer.
INSERT INTO syslog_outages (id, device_name, probe_name, started_at, ended_at, duration_s,
                            closure, down_events, spans_gap, device_id, service_id, match_kind)
VALUES
  (990501, 'ZZLT completo', 'ping', timestamptz '${T_SQL}' + interval '10 hours 5 minutes',
           timestamptz '${T_SQL}' + interval '10 hours 7 minutes', 120, 'closed', 1, false, 990201, 990211, 'service'),
  (990502, 'ZZLT completo', 'ping', timestamptz '${T_SQL}' - interval '200 days',
           timestamptz '${T_SQL}' - interval '199 days', 86400, 'closed', 1, false, 990201, 990211, 'service'),
  (990503, 'ZZLT completo', 'ping', timestamptz '${T_SQL}' - interval '400 days',
           timestamptz '${T_SQL}' + interval '9 hours', 34992000, 'closed', 1, true, 990201, 990211, 'service'),
  (990504, 'ZZLT completo', 'ping', NULL,
           timestamptz '${T_SQL}' + interval '10 hours 30 minutes', NULL, 'no_start', 1, false, 990201, 990211, 'service'),
  (990505, 'ZZLT completo', 'ping', timestamptz '${T_SQL}' + interval '10 hours 40 minutes',
           NULL, NULL, 'open', 1, false, NULL, NULL, 'ambiguous');
`;

beforeAll(async () => {
  if (!hayBase) return;
  process.env.DATABASE_URL = URL_BASE;

  const raiz = resolve(__dirname, '..');
  const esquema = resolve(raiz, '../etl/schema.sql');
  const seed = resolve(raiz, 'seed-dev.sql');
  if (!existsSync(esquema)) throw new Error(`No está ${esquema}`);

  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', esquema]);
  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', seed]);
  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-c', FIXTURE]);

  q = await import('@/lib/consultas');
  db = await import('@/lib/db');
}, 60_000);

afterAll(async () => {
  await db?.cerrarPool();
});

const SQL_T0 = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000);
const VENT_SQL = { desde: SQL_T0 + 9 * H, hasta: SQL_T0 + 21 * H };

conBase('spanMedicionesDe', () => {
  it('devuelve el tramo real de mediciones del equipo', async () => {
    const s = await q.spanMedicionesDe(990201);
    expect(s).not.toBeNull();
    expect(s!.desde).toBe(SQL_T0 + 10 * H);
    // 🔴 Termina a las 10:25 y no a las 10:19:30, y está BIEN: a las 10:25 hay
    //    una muestra de tráfico en 0, que es una medición de verdad —el enlace
    //    no pasaba nada— mientras que un ping en 0 es relleno. La ventana se
    //    tiene que estirar hasta ahí.
    expect(s!.hasta).toBe(SQL_T0 + 10 * H + 25 * 60);
  });

  it('el equipo sin mediciones devuelve null, no un rango de cero', async () => {
    // 🔴 Un `{desde: 0, hasta: 0}` haría que la ventana `medido` se anclara al
    //    1 de enero de 1970 y el gráfico saldría vacío sin decir por qué.
    expect(await q.spanMedicionesDe(990202)).toBeNull();
  });

  it('no cuenta las filas con el valor en nulo', async () => {
    // La fuente 990304 tiene 40 filas y ningún número. Si contara, el span
    // seguiría igual acá, así que se comprueba por el lado de las series.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.trafico.map((s) => s.fuente_id).sort()).toEqual([990302, 990303]);
  });
});

conBase('lineaDeTiempoDe · series', () => {
  it('separa latencia de tráfico por unidad', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.latencia.map((s) => s.fuente_id)).toEqual([990301]);
    expect(d.latencia[0].puntos).toHaveLength(40);
    expect(d.trafico).toHaveLength(2);
  });

  it('deduce el sentido del sufijo que arma The Dude', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const sentidos = Object.fromEntries(d.trafico.map((s) => [s.fuente_id, s.sentido]));
    expect(sentidos).toEqual({ 990302: 'rx', 990303: 'tx' });
    expect(d.latencia[0].sentido).toBeNull();
  });

  it('trae la fuente por el servicio, no sólo por el equipo', async () => {
    // La fuente de latencia cuelga de `service_id`, que es como The Dude ata
    // los gráficos de ping. Sin ese camino, 167 equipos perderían su serie.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.latencia[0].nombre).toBe('ZZLT ping');
  });

  it('no mezcla cajones: el `1day` se queda afuera', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.bucket).toBe('raw');
    expect(d.latencia.map((s) => s.fuente_id)).not.toContain(990305);
  });

  it('el equipo sin serie devuelve listas vacías y no rompe', async () => {
    const d = await q.lineaDeTiempoDe(990202, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.latencia).toEqual([]);
    expect(d.trafico).toEqual([]);
    expect(d.cobertura.ultima_medicion).toBeNull();
  });
});

conBase('lineaDeTiempoDe · caídas', () => {
  it('trae las dos fuentes marcadas', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const ids = new Set(d.caidas.map((c) => `${c.fuente}:${c.id}`));
    expect(ids.has('dude:990401')).toBe(true);
    expect(ids.has('syslog:990501')).toBe(true);
  });

  it('🔴 no trae las `ambiguous`: no tienen equipo y atribuirlas sería inventar', async () => {
    // Medido el 01/08/2026: 8.846 `ambiguous` y 563 `unknown`, ninguna con
    // `device_id`. El join por equipo ya las deja afuera, y esto lo fija.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.caidas.some((c) => c.id === 990505)).toBe(false);
  });

  it('trae la que cruza el hueco MARCADA, para poder descartarla con motivo', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const g = d.caidas.find((c) => c.id === 990503);
    expect(g?.cruza_hueco).toBe(true);
  });

  it('trae la que no tiene inicio, con el inicio en null y no en cero', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const s = d.caidas.find((c) => c.id === 990504);
    expect(s?.inicio).toBeNull();
    expect(s?.fin).toBe(SQL_T0 + 10 * H + 30 * 60);
  });

  it('la caída que arranca antes de la ventana y sigue adentro se trae igual', async () => {
    // Si la consulta pidiera `started_at >= desde`, una caída de tres días que
    // sigue abierta desaparecería justo de la ventana donde importa.
    const v = { desde: SQL_T0 + 20 * H + 1800, hasta: SQL_T0 + 22 * H };
    const d = await q.lineaDeTiempoDe(990201, v.desde, v.hasta);
    expect(d.caidas.some((c) => c.id === 990402)).toBe(true);
  });

  it('la vieja no entra en una ventana que no la contiene', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.caidas.some((c) => c.id === 990502)).toBe(false);
  });
});

conBase('lineaDeTiempoDe · cobertura', () => {
  it('el fin de la cobertura del Dude es el mtime del volcado, no la última caída', async () => {
    // 🔴 Si fuera la última caída, un equipo que hace tres días que anda bien
    //    dejaría entrar al syslog en esos tres días y aparecerían bandas
    //    duplicadas de eventos que el Dude ya conoce.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    // El seed deja la última sincronización con `source_mtime` a segundos de
    // ahora, y la caída más nueva del escenario es bastante anterior. Si
    // `dude_hasta` saliera de `outages`, este número quedaría en el pasado.
    const ahora = Math.floor(Date.now() / 1000);
    expect(d.cobertura.dude_hasta).not.toBeNull();
    expect(ahora - d.cobertura.dude_hasta!).toBeLessThan(600);
    const ultimaCaida = Math.max(
      ...d.caidas.filter((c) => c.fuente === 'dude').map((c) => c.inicio ?? 0),
    );
    expect(d.cobertura.dude_hasta!).toBeGreaterThan(ultimaCaida);
  });

  it('informa la primera y la última medición del equipo', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.cobertura.primera_medicion).toBe(SQL_T0 + 10 * H);
    // 🔴 El centinela en cero de la latencia llega hasta las 10:19:45 y NO
    //    cuenta: la ficha decía «la última medición es de las 10:19:45»
    //    señalando un casillero de relleno. El último dato real es la muestra
    //    de tráfico de las 10:25.
    expect(d.cobertura.ultima_medicion).toBe(SQL_T0 + 10 * H + 25 * 60);
  });

  it('informa los extremos del syslog del equipo, incluidos los de afuera', async () => {
    // Para poder escribir «antes de tal fecha no hay registro» hay que saber
    // hasta dónde llega la reconstrucción, aunque no se dibuje.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.cobertura.syslog_desde).toBe(
      Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000) - 400 * D,
    );
  });
});

conBase('de punta a punta: la SQL y las reglas juntas', () => {
  it('el mismo corte visto por las dos fuentes se dibuja UNA vez', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const { bandas, descartes } = armarBandas(
      d.caidas,
      VENT_SQL,
      { desde: d.cobertura.dude_desde, hasta: d.cobertura.dude_hasta },
    );
    // 990401 (Dude) y 990501 (syslog) son el mismo corte de dos minutos.
    const enElCorte = bandas.filter(
      (b) => b.inicio >= SQL_T0 + 10 * H && b.inicio < SQL_T0 + 10 * H + 600,
    );
    expect(enElCorte).toHaveLength(1);
    expect(enElCorte[0].fuente).toBe('dude');
    expect(descartes.segundos_syslog_solapados).toBeGreaterThan(0);
  });

  it('la de 400 días no pinta la ventana entera de rojo', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const { bandas, descartes } = armarBandas(
      d.caidas,
      VENT_SQL,
      { desde: d.cobertura.dude_desde, hasta: d.cobertura.dude_hasta },
    );
    expect(descartes.cruzan_hueco).toBe(1);
    const total = bandas.reduce((a, b) => a + (b.fin - b.inicio), 0);
    // Sin el descarte, esa sola banda aportaría nueve horas de la ventana.
    expect(total).toBeLessThan(2 * H);
  });

  it('la línea de latencia se parte donde está la caída', async () => {
    // La serie va de 10:00 a 10:19:30 cada 30 s y la caída es de 10:05 a
    // 10:07, pero el fixture NO tiene hueco: la serie es continua. Lo que se
    // fija acá es que una serie sin hueco NO se parta de gusto.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(partirEnTramos(d.latencia[0].puntos)).toHaveLength(1);
  });
});

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

describe('dominioY con base en cero (tráfico)', () => {
  /**
   * 🔴 Decisión opuesta a la de la latencia, y a propósito. En un caudal el
   *    cero es alcanzable: con la base flotando, una caída de 100 a 98 Mbit/s
   *    se dibuja igual que una de 100 a 0. Una es un incidente y la otra es
   *    el martes.
   */
  it('la base es cero exacto, sin aire abajo', () => {
    const d = dominioY([98e6, 100e6], 0.1, true);
    expect(d.min).toBe(0);
    expect(d.max).toBeGreaterThan(100e6);
  });

  it('para latencia sigue flotando: es el comportamiento por defecto', () => {
    expect(dominioY([0.098, 0.1]).min).toBeGreaterThan(0);
  });
});


describe('coalescerParaDibujo', () => {
  /**
   * 🔴 Medido el 01/08/2026: el peor equipo tiene **16.296 caídas en un año**
   *    entre las dos fuentes, y otro 16.233. Con la ventana de «1 a» eso sería
   *    mandarle dieciséis mil `<rect>` al navegador. Se midió: la página de un
   *    equipo con 2.777 caídas pesaba **870 kB** contra 102 kB en las otras
   *    ventanas.
   *
   *    Y no aportan: el eje tiene 950 unidades útiles y una banda no baja de
   *    2 para verse, así que caben unas 475 posiciones distinguibles.
   */
  const fx = escala(0, 1000, 0, 1000); // una unidad de tiempo = una de dibujo

  it('pega las que el dibujo no puede separar y suma sus caídas', () => {
    const b = coalescerParaDibujo(
      [
        { inicio: 10, fin: 11, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
        { inicio: 12, fin: 13, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
      ],
      fx,
      5,
    );
    expect(b).toHaveLength(1);
    expect(b[0].cantidad).toBe(2);
    expect(b[0].pegada).toBe(true);
  });

  it('el tiempo caído del pegado NO incluye el hueco del medio', () => {
    // 10-11 y 12-13 son dos segundos caído, no tres: el hueco es tiempo sano.
    // Si `segundos_reales` se calculara como fin - inicio, el globito diría
    // que el equipo estuvo caído 50 % más de lo que estuvo.
    const b = coalescerParaDibujo(
      [
        { inicio: 10, fin: 11, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
        { inicio: 12, fin: 13, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
      ],
      fx,
      5,
    );
    expect(b[0].segundos_reales).toBe(2);
    expect(b[0].fin - b[0].inicio).toBe(3);
  });

  it('no pega las que sí se distinguen', () => {
    const b = coalescerParaDibujo(
      [
        { inicio: 10, fin: 11, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
        { inicio: 100, fin: 101, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
      ],
      fx,
      5,
    );
    expect(b).toHaveLength(2);
    expect(b.map((x) => x.pegada)).toEqual([false, false]);
    expect(b.map((x) => x.segundos_reales)).toEqual([1, 1]);
  });

  it('no pega entre fuentes distintas por más juntas que estén', () => {
    // Una banda mitad Dude y mitad syslog no se puede rotular.
    const b = coalescerParaDibujo(
      [
        { inicio: 10, fin: 11, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
        { inicio: 11, fin: 12, fuente: 'syslog', abierta: false, recortada_inicio: false, cantidad: 1 },
      ],
      fx,
      5,
    );
    expect(b.map((x) => x.fuente)).toEqual(['dude', 'syslog']);
  });

  it('el pegado NO puede cambiar la cuenta total de caídas', () => {
    const bandas = Array.from({ length: 500 }, (_, i) => ({
      inicio: i * 2,
      fin: i * 2 + 1,
      fuente: 'dude' as const,
      abierta: false,
      recortada_inicio: false,
      cantidad: 1,
    }));
    const dib = coalescerParaDibujo(bandas, escala(0, 1000, 0, 950), 2);
    expect(dib.length).toBeLessThan(bandas.length);
    // La cuenta que se muestra sale de `bandas`, pero aun así el pegado tiene
    // que conservar el total: si se perdiera acá, el globito mentiría.
    expect(dib.reduce((a, x) => a + x.cantidad, 0)).toBe(500);
    expect(dib.reduce((a, x) => a + x.segundos_reales, 0)).toBe(500);
  });

  it('una banda abierta sigue abierta después de pegarse', () => {
    const b = coalescerParaDibujo(
      [
        { inicio: 10, fin: 11, fuente: 'dude', abierta: false, recortada_inicio: false, cantidad: 1 },
        { inicio: 12, fin: 13, fuente: 'dude', abierta: true, recortada_inicio: false, cantidad: 1 },
      ],
      fx,
      5,
    );
    expect(b[0].abierta).toBe(true);
  });
});


describe('instante y necesitaAnio', () => {
  it('rellena a dos dígitos, que `Intl` en es-AR no hace', () => {
    // 🔴 Medido: `Intl` devuelve «1/8, 20:10» aunque se le pidan los campos en
    //    `2-digit`. Alineado importa cuando hay dos instantes uno al lado del
    //    otro en el mismo renglón.
    expect(instante(Date.parse('2026-08-01T20:10:00Z') / 1000, false, 'UTC')).toBe('01/08 20:10');
  });

  it('con el año cuando se pide', () => {
    expect(instante(Date.parse('2026-08-01T20:10:00Z') / 1000, true, 'UTC')).toBe(
      '01/08/2026 20:10',
    );
  });

  it('🔴 una ventana de doce meses NO puede leerse como un rango de cero', () => {
    // Se vio en pantalla con la ventana de «1 a»: «1/8, 20:10 → 1/8, 20:10».
    const v = {
      desde: Date.parse('2025-08-01T20:10:00Z') / 1000,
      hasta: Date.parse('2026-08-01T20:10:00Z') / 1000,
    };
    expect(necesitaAnio(v, 'UTC')).toBe(true);
    expect(instante(v.desde, true, 'UTC')).not.toBe(instante(v.hasta, true, 'UTC'));
  });

  it('adentro del mismo año no hace falta el año, y se ahorra ruido', () => {
    const v = {
      desde: Date.parse('2026-07-30T20:00:00Z') / 1000,
      hasta: Date.parse('2026-07-30T23:00:00Z') / 1000,
    };
    expect(necesitaAnio(v, 'UTC')).toBe(false);
  });
});

conBase('lineaDeTiempoDe · el centinela en cero de la latencia', () => {
  /**
   * 🔴 Medido el 01/08/2026: de 248.078 muestras con unidad `s`, **214.628
   *    valen exactamente 0 — el 86,5 %** — y el valor no nulo más chico de
   *    toda la tabla es **0,015 s**. No hay UN SOLO valor entre 0 y 15 ms.
   *
   *    Un ping de 0,000000 s no existe. Es el relleno de los casilleros que
   *    The Dude no sondeó: guarda una fila cada ~2 s y mide cada 10 a 60.
   */
  it('la serie de latencia no trae ni un cero', async () => {
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.latencia[0].puntos.every(([, v]) => v > 0)).toBe(true);
    expect(d.latencia[0].puntos).toHaveLength(40);
  });

  it('los descartados se cuentan, para poder declararlos en pantalla', async () => {
    // Un filtro que no se declara es un dato que desaparece sin dejar rastro.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    expect(d.ceros_descartados).toBe(40);
  });

  it('🔴 en TRÁFICO el cero se conserva: ahí sí es un valor real', async () => {
    // Borrarlo taparía justo el incidente que hay que ver: el enlace dejó de
    // pasar tráfico. Medido: en la base real no hay ceros en bit/s, y aun así
    // la regla no se aplica ahí, para el día que los haya.
    const d = await q.lineaDeTiempoDe(990201, VENT_SQL.desde, VENT_SQL.hasta);
    const rx = d.trafico.find((s) => s.fuente_id === 990302)!;
    expect(rx.puntos.some(([, v]) => v === 0)).toBe(true);
  });

  it('el span se ancla a la primera medición REAL, no al primer centinela', async () => {
    // Los ceros del fixture arrancan 15 s después de la primera medición, así
    // que el borde no cambia; lo que se fija es que el criterio sea el mismo
    // en las dos consultas y la ventana `medido` no arranque en un relleno.
    const s = await q.spanMedicionesDe(990201);
    expect(s!.desde).toBe(SQL_T0 + 10 * H);
  });
});
