import { describe, expect, it } from 'vitest';
import {
  aAntiguedad,
  accionables,
  ANTIGUEDADES,
  antiguedadDe,
  CONTEO_VACIO,
  DIAS_RECIENTE,
  DIAS_RESIDUO,
  metaAntiguedad,
  porSegundos,
  segundosDesde,
  totalConteo,
} from '@/lib/antiguedad';

/**
 * El eje de antigüedad.
 *
 * Lo que se prueba acá no son los cortes —esos son una decisión y podrían ser
 * otros— sino las tres reglas que hacen que el eje NO se convierta en un cuarto
 * estado y NO invente datos que no tiene.
 */

const AHORA = new Date('2026-07-31T12:00:00Z');
const haceDias = (d: number) => new Date(AHORA.getTime() - d * 86_400_000);

describe('antiguedadDe', () => {
  it('clasifica por hace cuánto que cambió', () => {
    expect(antiguedadDe(3, haceDias(0.2), AHORA)).toBe('reciente');
    expect(antiguedadDe(3, haceDias(30), AHORA)).toBe('arrastre');
    expect(antiguedadDe(3, haceDias(1595), AHORA)).toBe('residuo');
  });

  it('🔴 un equipo ARRIBA no tiene antigüedad, por más viejo que sea', () => {
    // «Arriba desde hace cuatro años» es la mejor noticia posible de un enlace.
    // Si esto devolviera 'residuo', el mapa atenuaría los equipos sanos que
    // llevan más tiempo funcionando, que es exactamente al revés.
    expect(antiguedadDe(1, haceDias(1595), AHORA)).toBeNull();
    expect(antiguedadDe(1, haceDias(0.1), AHORA)).toBeNull();
  });

  it('los otros tres estados SÍ la tienen', () => {
    for (const estado of [0, 2, 3]) {
      expect(antiguedadDe(estado, haceDias(1000), AHORA)).toBe('residuo');
    }
  });

  it('🔴 sin fecha devuelve null: no se inventa una', () => {
    // 32 de los 885 equipos de la base real no tienen ningún servicio, así que
    // no tienen `status_changed_at`. Suponerlos recientes tranquilizaría de
    // gusto y suponerlos residuo alarmaría de gusto. `null` es «no sé».
    expect(antiguedadDe(3, null, AHORA)).toBeNull();
    expect(antiguedadDe(3, undefined, AHORA)).toBeNull();
    expect(antiguedadDe(3, 'no es una fecha', AHORA)).toBeNull();
  });
});

describe('segundosDesde', () => {
  it('nunca devuelve negativo', () => {
    // The Dude corre en un Windows de 2011 sin NTP confiable: un reloj
    // adelantado unos segundos daría «dentro de 4 s» en la columna.
    const futuro = new Date(AHORA.getTime() + 30_000);
    expect(segundosDesde(futuro, AHORA)).toBe(0);
  });

  it('mide en segundos', () => {
    expect(segundosDesde(haceDias(1), AHORA)).toBe(86_400);
  });
});

describe('los cortes', () => {
  it('son continuos: toda antigüedad cae en exactamente un escalón', () => {
    const vistos = new Set<string>();
    for (let d = 0; d <= 800; d += 0.5) {
      vistos.add(porSegundos(d * 86_400));
    }
    expect([...vistos].sort()).toEqual(['arrastre', 'reciente', 'residuo']);
  });

  it('el límite pertenece al escalón de arriba, sin agujeros', () => {
    expect(porSegundos(DIAS_RECIENTE * 86_400 - 1)).toBe('reciente');
    expect(porSegundos(DIAS_RECIENTE * 86_400)).toBe('arrastre');
    expect(porSegundos(DIAS_RESIDUO * 86_400 - 1)).toBe('arrastre');
    expect(porSegundos(DIAS_RESIDUO * 86_400)).toBe('residuo');
  });
});

describe('la presentación', () => {
  it('🔴 ninguna antigüedad depende de un carácter de una fuente', () => {
    // La primera versión usaba `● ◐ ○` y el del medio salía como `‹`: U+25D0 no
    // está en la fuente monoespaciada del sistema. La rampa se dibuja con CSS
    // (`.rampa`) justamente por eso, y este test impide que alguien la vuelva a
    // meter en el modelo de datos.
    for (const a of ANTIGUEDADES) {
      expect(a).not.toHaveProperty('glifo');
    }
  });

  it('cada escalón tiene una palabra y una explicación', () => {
    for (const a of ANTIGUEDADES) {
      expect(a.etiqueta.length).toBeGreaterThan(3);
      expect(a.explica.length).toBeGreaterThan(20);
    }
  });

  it('vienen de la más urgente a la menos', () => {
    const u = ANTIGUEDADES.map((a) => a.urgencia);
    expect(u).toEqual([...u].sort((x, y) => x - y));
    expect(ANTIGUEDADES[0]!.clave).toBe('reciente');
  });

  it('metaAntiguedad devuelve el mismo objeto que la lista', () => {
    for (const a of ANTIGUEDADES) expect(metaAntiguedad(a.clave)).toBe(a);
  });
});

describe('aAntiguedad', () => {
  it('acepta las tres y rechaza cualquier otra cosa', () => {
    expect(aAntiguedad('residuo')).toBe('residuo');
    expect(aAntiguedad('reciente')).toBe('reciente');
    expect(aAntiguedad('arrastre')).toBe('arrastre');
    // Viene de una URL que escribe cualquiera; no puede caer en la SQL.
    expect(aAntiguedad("residuo'; DROP TABLE devices; --")).toBeNull();
    expect(aAntiguedad(null)).toBeNull();
    expect(aAntiguedad(3)).toBeNull();
  });
});

describe('los recuentos', () => {
  it('«accionables» deja el residuo AFUERA — es la promesa del tablero', () => {
    const c = { reciente: 7, arrastre: 139, residuo: 121, sinFecha: 4 };
    expect(accionables(c)).toBe(146);
    expect(totalConteo(c)).toBe(271);
  });

  it('el conteo vacío es inmutable entre usos', () => {
    // Se clona en `aConteo`; si alguien lo mutara, el segundo tablero del
    // proceso arrancaría con los números del primero.
    const copia = { ...CONTEO_VACIO };
    copia.residuo = 99;
    expect(CONTEO_VACIO.residuo).toBe(0);
  });
});
