import { describe, expect, it } from 'vitest';
import { desde, desdeUnix, duracion, fechaHora, numero, porcentaje } from '@/lib/formato';

describe('duracion', () => {
  it('usa segundos abajo del minuto', () => {
    expect(duracion(0)).toBe('0 s');
    expect(duracion(45)).toBe('45 s');
    expect(duracion(59)).toBe('59 s');
  });

  it('usa minutos abajo de la hora', () => {
    expect(duracion(60)).toBe('1 min');
    expect(duracion(3599)).toBe('59 min');
  });

  it('combina horas y minutos con el minuto en dos dígitos', () => {
    // El relleno con cero es para que la columna quede alineada en la tabla.
    expect(duracion(3600)).toBe('1 h');
    expect(duracion(3600 + 7 * 60)).toBe('1 h 07 min');
    expect(duracion(3600 * 5 + 42 * 60)).toBe('5 h 42 min');
  });

  it('combina días y horas', () => {
    expect(duracion(86_400)).toBe('1 d');
    expect(duracion(86_400 * 3 + 3600 * 4)).toBe('3 d 4 h');
  });

  it('pasa a meses arriba de treinta días', () => {
    expect(duracion(86_400 * 31)).toBe('1 mes');
    expect(duracion(86_400 * 75)).toBe('2 meses');
  });

  it('no inventa números cuando no hay dato', () => {
    expect(duracion(null)).toBe('—');
    expect(duracion(undefined)).toBe('—');
    expect(duracion(NaN)).toBe('—');
  });

  it('un negativo no produce basura', () => {
    expect(duracion(-500)).toBe('0 s');
  });
});

describe('desde', () => {
  it('mide contra el momento que se le pasa', () => {
    const ahora = new Date('2026-07-31T03:00:00Z');
    const hace = new Date('2026-07-31T01:15:00Z');
    expect(desde(hace, ahora)).toBe('1 h 45 min');
  });

  it('tolera fechas inválidas', () => {
    expect(desde('no soy una fecha')).toBe('—');
    expect(desde(null)).toBe('—');
  });
});

describe('desdeUnix', () => {
  // The Dude usa 0 para "nunca pasó", no para el 1 de enero de 1970.
  it('trata el cero como "nunca"', () => {
    expect(desdeUnix(0)).toBeNull();
    expect(desdeUnix(-1)).toBeNull();
  });

  it('convierte segundos Unix a Date', () => {
    expect(desdeUnix(1_785_000_000)?.getTime()).toBe(1_785_000_000_000);
  });

  it('tolera nulos', () => {
    expect(desdeUnix(null)).toBeNull();
    expect(desdeUnix(undefined)).toBeNull();
  });
});

describe('fechaHora', () => {
  it('omite el año cuando es el mismo', () => {
    const ahora = new Date('2026-07-31T12:00:00Z');
    const salida = fechaHora('2026-07-31T05:14:00Z', ahora);
    expect(salida).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it('muestra el año cuando es otro', () => {
    const ahora = new Date('2026-07-31T12:00:00Z');
    expect(fechaHora('2025-01-04T05:14:00Z', ahora)).toContain('2025');
  });

  it('devuelve raya cuando no hay fecha', () => {
    expect(fechaHora(null)).toBe('—');
  });
});

describe('numero y porcentaje', () => {
  it('separa miles con punto, como en es-AR', () => {
    expect(numero(14916)).toBe('14.916');
    expect(numero(885)).toBe('885');
  });

  it('no muestra NaN cuando el total es cero', () => {
    expect(porcentaje(0, 0)).toBe('—');
    expect(numero(NaN)).toBe('—');
    expect(numero(null)).toBe('—');
  });

  it('redondea el porcentaje', () => {
    expect(porcentaje(363, 859)).toBe('42 %');
    expect(porcentaje(1, 3)).toBe('33 %');
  });
});
