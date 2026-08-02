import { describe, expect, it } from 'vitest';
import {
  alarma,
  clasificar,
  DIAS_ACTIVO,
  DIAS_BAJA,
  metaVida,
  sqlEsActivo,
  VIDAS,
  type SenalDeVida,
} from '@/lib/vida';

/** Historia de sobra: el caso donde el alcance no limita nada. */
const LARGO = DIAS_BAJA * 4;

const s = (p: Partial<SenalDeVida> = {}): SenalDeVida => ({
  dias_sin_senal: null,
  arriba_ahora: false,
  estado_manual: null,
  ...p,
});

describe('clasificar', () => {
  it('estar arriba ahora es prueba suficiente, sin mirar nada más', () => {
    const v = clasificar(s({ arriba_ahora: true, dias_sin_senal: 9999 }), LARGO);
    expect(v.vida).toBe('activo');
    expect(v.manual).toBe(false);
  });

  it('el veredicto humano gana sobre el cálculo, en las dos direcciones', () => {
    // Un equipo callado hace años que una persona rescató.
    const rescatado = clasificar(s({ dias_sin_senal: 9999, estado_manual: 'activo' }), LARGO);
    expect(rescatado.vida).toBe('activo');
    expect(rescatado.manual).toBe(true);

    // Y uno que responde perfecto, pero que alguien SABE que ya no va más.
    const condenado = clasificar(
      s({ dias_sin_senal: 0, arriba_ahora: true, estado_manual: 'baja' }),
      LARGO,
    );
    expect(condenado.vida).toBe('baja');
    expect(condenado.manual).toBe(true);
  });

  it('los bordes de la ventana caen del lado que dicen los umbrales', () => {
    expect(clasificar(s({ dias_sin_senal: DIAS_ACTIVO }), LARGO).vida).toBe('activo');
    expect(clasificar(s({ dias_sin_senal: DIAS_ACTIVO + 1 }), LARGO).vida).toBe('dudoso');
    expect(clasificar(s({ dias_sin_senal: DIAS_BAJA - 1 }), LARGO).vida).toBe('dudoso');
    expect(clasificar(s({ dias_sin_senal: DIAS_BAJA }), LARGO).vida).toBe('baja');
  });

  describe('🔴 sin señales, el ALCANCE de la historia decide', () => {
    it('con historia corta dice «no sé» (dudoso), NUNCA baja', () => {
      // El caso real: la base se rearmó de cero el 12/06/2026 y hay ~50 días.
      const v = clasificar(s({ dias_sin_senal: null }), 50);
      expect(v.vida).toBe('dudoso');
      expect(v.motivo).toContain('50');
    });

    it('con historia suficiente, el silencio SÍ es la respuesta', () => {
      expect(clasificar(s({ dias_sin_senal: null }), DIAS_BAJA).vida).toBe('baja');
      expect(clasificar(s({ dias_sin_senal: null }), LARGO).vida).toBe('baja');
    });

    it('el borde exacto del alcance no oculta equipos de más', () => {
      expect(clasificar(s({ dias_sin_senal: null }), DIAS_BAJA - 1).vida).toBe('dudoso');
    });
  });

  it('siempre explica por qué: una clasificación que esconde no puede ser muda', () => {
    const casos: SenalDeVida[] = [
      s({ arriba_ahora: true }),
      s({ dias_sin_senal: 0 }),
      s({ dias_sin_senal: 1 }),
      s({ dias_sin_senal: DIAS_ACTIVO + 5 }),
      s({ dias_sin_senal: DIAS_BAJA + 5 }),
      s({ dias_sin_senal: null }),
      s({ estado_manual: 'activo' }),
      s({ estado_manual: 'baja' }),
    ];
    for (const c of casos) {
      for (const alcance of [10, LARGO]) {
        const v = clasificar(c, alcance);
        expect(v.motivo.length, JSON.stringify(c)).toBeGreaterThan(10);
        expect(v.motivo.endsWith('.'), v.motivo).toBe(true);
      }
    }
  });

  it('«hace 1 día» en singular: el plural mal puesto se lee como un descuido', () => {
    expect(clasificar(s({ dias_sin_senal: 1 }), LARGO).motivo).toContain('1 día.');
    expect(clasificar(s({ dias_sin_senal: 2 }), LARGO).motivo).toContain('2 días');
    expect(clasificar(s({ dias_sin_senal: 0 }), LARGO).motivo).toContain('hoy');
  });
});

describe('alarma', () => {
  it('sólo alarman los activos — es el punto de todo el módulo', () => {
    expect(alarma('activo')).toBe(true);
    expect(alarma('dudoso')).toBe(false);
    expect(alarma('baja')).toBe(false);
  });
});

describe('metadatos', () => {
  it('cada estado tiene un destino distinto en el mapa', () => {
    expect(VIDAS.map((v) => v.enMapa)).toEqual(['visible', 'atenuado', 'oculto']);
  });

  it('los tres estados están y no se repiten', () => {
    expect(new Set(VIDAS.map((v) => v.clave)).size).toBe(3);
    for (const v of VIDAS) expect(metaVida(v.clave)).toBe(v);
  });

  it('los umbrales son coherentes: activo < baja', () => {
    expect(DIAS_ACTIVO).toBeLessThan(DIAS_BAJA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 El predicado SQL y la función TypeScript tienen que decir LO MISMO
//
// `sqlEsActivo` existe porque el historial de caídas se pagina y el filtro
// tiene que estar en el WHERE. Eso deja la regla escrita dos veces, y una
// regla escrita dos veces es una regla que algún día va a decir dos cosas
// distintas — salvo que algo las ate. Esto es ese algo.
//
// Se corre la matriz COMPLETA de combinaciones contra Postgres de verdad y se
// compara fila por fila con `clasificar()`. No se simula el SQL: se ejecuta.
// Los tres valores que Postgres trata distinto —true, false y NULL— son
// justamente donde vive el error, y en JS `null <= 30` da `false` mientras que
// en SQL `NULL <= 30` da NULL. Parecen lo mismo y no lo son.
// ─────────────────────────────────────────────────────────────────────────────

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!URL_BASE)('sqlEsActivo coincide con clasificar', () => {
  it('en las 48 combinaciones posibles', async () => {
    process.env.DATABASE_URL = URL_BASE;
    const { consultar, cerrarPool } = await import('@/lib/db');

    const dias = [null, 0, 1, DIAS_ACTIVO, DIAS_ACTIVO + 1, DIAS_BAJA - 1, DIAS_BAJA, 9999];
    const manuales = [null, 'activo', 'baja'] as const;
    const casos: SenalDeVida[] = [];
    for (const d of dias)
      for (const arriba of [false, true])
        for (const m of manuales)
          casos.push({ dias_sin_senal: d, arriba_ahora: arriba, estado_manual: m });

    // Una sola ida y vuelta con la matriz entera: el punto es comparar, no
    // medir latencia, pero 48 consultas sueltas harían el test lento y frágil.
    const filas = await consultar<{ i: number; activo: boolean }>(
      `SELECT t.i, ${sqlEsActivo('t', '$4')} AS activo
         FROM unnest($1::int[], $2::bool[], $3::text[])
              WITH ORDINALITY AS t(dias_sin_senal, arriba_ahora, estado_manual, i)
        ORDER BY t.i`,
      [
        casos.map((c) => c.dias_sin_senal),
        casos.map((c) => c.arriba_ahora),
        casos.map((c) => c.estado_manual),
        DIAS_ACTIVO,
      ],
    );

    expect(filas.length).toBe(casos.length);
    const desacuerdos = filas
      .map((f, i) => ({
        caso: casos[i],
        sql: f.activo,
        ts: clasificar(casos[i], DIAS_BAJA * 4).vida === 'activo',
      }))
      .filter((r) => r.sql !== r.ts);

    expect(desacuerdos).toEqual([]);
    await cerrarPool();
  }, 30_000);
});
