import { describe, expect, it } from 'vitest';
import { aEstado, clasePildora, ESTADOS, estadoAgregado, metaEstado } from '@/lib/estado';

describe('aEstado', () => {
  it('acepta los cuatro valores de The Dude', () => {
    expect(aEstado(0)).toBe(0);
    expect(aEstado(1)).toBe(1);
    expect(aEstado(2)).toBe(2);
    expect(aEstado(3)).toBe(3);
  });

  it('convierte las cadenas que llegan de la URL', () => {
    expect(aEstado('3')).toBe(3);
    expect(aEstado('1')).toBe(1);
  });

  // Un estado desconocido tiene que caer en "sin datos", nunca en "arriba":
  // pintar de verde algo que no sabemos es la peor falla posible en un panel
  // de monitoreo.
  it('cualquier basura cae en desconocido, jamás en arriba', () => {
    for (const v of [null, undefined, '', 'up', 4, -1, 99, NaN, {}, []]) {
      expect(aEstado(v)).toBe(0);
    }
  });
});

describe('metaEstado', () => {
  it('cada estado tiene glifo, etiqueta y clase propios', () => {
    const glifos = ESTADOS.map((e) => e.glifo);
    const claves = ESTADOS.map((e) => e.clave);
    expect(new Set(glifos).size).toBe(4);
    expect(new Set(claves).size).toBe(4);
  });

  // La regla no negociable del proyecto: nunca sólo color.
  it('ningún estado se distingue únicamente por el color', () => {
    for (const e of ESTADOS) {
      expect(e.glifo.length).toBeGreaterThan(0);
      expect(e.etiqueta.length).toBeGreaterThan(0);
    }
  });

  it('los glifos no son emojis', () => {
    for (const e of ESTADOS) {
      expect(e.glifo).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('ordena por urgencia: caído primero, arriba último', () => {
    expect(ESTADOS.map((e) => e.valor)).toEqual([3, 2, 0, 1]);
  });

  it('clasePildora arma la clase completa', () => {
    expect(clasePildora(3)).toBe('pildora pildora-caido');
    expect(clasePildora(1)).toBe('pildora pildora-up');
    expect(clasePildora('cualquier cosa')).toBe('pildora pildora-desconocido');
  });
});

describe('estadoAgregado', () => {
  it('manda el peor: un caído entre cien arriba deja el conjunto caído', () => {
    expect(estadoAgregado([...Array(100).fill(1), 3])).toBe(3);
  });

  it('parcial gana a arriba y a desconocido', () => {
    expect(estadoAgregado([1, 2])).toBe(2);
    expect(estadoAgregado([0, 2])).toBe(2);
  });

  it('desconocido gana a arriba', () => {
    expect(estadoAgregado([1, 1, 0])).toBe(0);
  });

  it('todo arriba es arriba', () => {
    expect(estadoAgregado([1, 1, 1])).toBe(1);
  });

  it('un conjunto vacío es desconocido, no arriba', () => {
    expect(estadoAgregado([])).toBe(0);
  });

  it('caído gana a parcial', () => {
    expect(estadoAgregado([2, 3, 1])).toBe(3);
  });

  it('metaEstado y estadoAgregado coinciden en la urgencia', () => {
    expect(metaEstado(3).urgencia).toBeLessThan(metaEstado(2).urgencia);
    expect(metaEstado(2).urgencia).toBeLessThan(metaEstado(0).urgencia);
    expect(metaEstado(0).urgencia).toBeLessThan(metaEstado(1).urgencia);
  });
});
