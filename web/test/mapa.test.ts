import { describe, expect, it } from 'vitest';
import type { ElementoMapa } from '@/lib/consultas';
import { construirLienzo, TAMANIO_NODO } from '@/lib/mapa';

/** Fábrica corta para no repetir quince campos en cada caso. */
function elem(p: Partial<ElementoMapa> & { element_id: number }): ElementoMapa {
  return {
    kind: 'device',
    x: 0,
    y: 0,
    shape: 0,
    label: null,
    icon: null,
    link_from: null,
    link_to: null,
    link_width: null,
    name: null,
    status: 1,
    device_id: null,
    submap_id: null,
    direcciones: null,
    ...p,
  } as ElementoMapa;
}

describe('construirLienzo · nodos', () => {
  it('centra el nodo sobre la coordenada de The Dude', () => {
    // The Dude guarda la esquina superior izquierda; los enlaces salen del
    // centro. Si esto se corre, todas las líneas quedan desfasadas medio icono.
    const { nodos } = construirLienzo([elem({ element_id: 1, x: 100, y: 200 })]);
    expect(nodos[0]!.cx).toBe(100 + TAMANIO_NODO / 2);
    expect(nodos[0]!.cy).toBe(200 + TAMANIO_NODO / 2);
  });

  it('usa el label del elemento antes que el nombre del objeto', () => {
    const { nodos } = construirLienzo([
      elem({ element_id: 1, label: 'Torre Aurora', name: 'RT_Ponte_Torre' }),
    ]);
    expect(nodos[0]!.nombre).toBe('Torre Aurora');
  });

  it('cae al nombre del objeto si no hay label', () => {
    const { nodos } = construirLienzo([elem({ element_id: 1, label: '  ', name: 'RT_Core_A' })]);
    expect(nodos[0]!.nombre).toBe('RT_Core_A');
  });

  it('un elemento de equipo enlaza a su ficha', () => {
    const { nodos } = construirLienzo([elem({ element_id: 1, device_id: 42 })]);
    expect(nodos[0]!.href).toBe('/dispositivos/42');
  });

  it('un submapa enlaza al mapa, no al equipo', () => {
    const { nodos } = construirLienzo([
      elem({ element_id: 1, kind: 'submap', submap_id: 1002, device_id: null }),
    ]);
    expect(nodos[0]!.href).toBe('/mapas/1002');
  });

  it('el estado del submapa lo manda el recuento en vivo', () => {
    // La vista lo deriva de `maps.devices_*`, que puede estar viejo. Si le
    // pasamos el recalculado, gana ese.
    const { nodos } = construirLienzo(
      [elem({ element_id: 1, kind: 'submap', submap_id: 7, status: 1 })],
      new Map([[7, 3]]),
    );
    expect(nodos[0]!.estado).toBe(3);
  });
});

describe('construirLienzo · elementos sin coordenadas', () => {
  it('los acomoda en una grilla en vez de perderlos', () => {
    const { nodos, sinPosicion } = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, x: null, y: null }),
      elem({ element_id: 3, x: null, y: null }),
    ]);
    expect(sinPosicion).toBe(2);
    expect(nodos).toHaveLength(3);
    // Y quedan debajo del contenido con posición, no encima de él.
    expect(nodos[1]!.cy).toBeGreaterThan(nodos[0]!.cy);
    expect(nodos[1]!.reubicado).toBe(true);
    expect(nodos[0]!.reubicado).toBe(false);
  });

  it('no los apila uno sobre otro', () => {
    const { nodos } = construirLienzo([
      elem({ element_id: 1, x: null, y: null }),
      elem({ element_id: 2, x: null, y: null }),
    ]);
    expect([nodos[0]!.cx, nodos[0]!.cy]).not.toEqual([nodos[1]!.cx, nodos[1]!.cy]);
  });
});

describe('construirLienzo · enlaces', () => {
  const dos = [
    elem({ element_id: 1, x: 0, y: 0, status: 1 }),
    elem({ element_id: 2, x: 300, y: 400, status: 1 }),
  ];

  it('une los centros de los dos nodos', () => {
    const { enlaces } = construirLienzo([
      ...dos,
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0]).toMatchObject({ x1: 18, y1: 18, x2: 318, y2: 418, de: 1, a: 2 });
  });

  it('descarta el enlace cuyo extremo no está en este mapa', () => {
    // Sin esto, un extremo faltante se dibujaría en (0,0) y deformaría el
    // encuadre del mapa entero.
    const { enlaces, vista } = construirLienzo([
      ...dos,
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 9999, x: null, y: null }),
    ]);
    expect(enlaces).toHaveLength(0);
    expect(vista.x).toBeGreaterThan(-100);
  });

  it('el enlace hereda el peor estado de sus puntas', () => {
    const { enlaces } = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0, status: 1 }),
      elem({ element_id: 2, x: 100, y: 0, status: 3 }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(enlaces[0]!.estado).toBe(3);
  });

  it('un ancho de 0 o nulo cae al grosor por defecto, no a invisible', () => {
    const { enlaces } = construirLienzo([
      ...dos,
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, link_width: 0 }),
      elem({ element_id: 10, kind: 'link', link_from: 2, link_to: 1, link_width: null }),
    ]);
    expect(enlaces.every((l) => l.ancho >= 1)).toBe(true);
  });

  it('acota anchos absurdos', () => {
    const { enlaces } = construirLienzo([
      ...dos,
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, link_width: 900 }),
    ]);
    expect(enlaces[0]!.ancho).toBe(10);
  });
});

describe('construirLienzo · rótulos static', () => {
  // Los 100 elementos `static` de la base real son textos como «eth2» al lado
  // de un enlace. Dibujarlos como nodos inventaría cien equipos inexistentes.
  it('no los cuenta como nodos', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, kind: 'static', x: 50, y: 50, label: 'eth2' }),
    ]);
    expect(l.nodos).toHaveLength(1);
    expect(l.rotulos).toEqual([{ id: 2, x: 50, y: 50, texto: 'eth2' }]);
  });

  it('descarta los que no tienen texto', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 10, y: 10, label: '   ', name: null }),
    ]);
    expect(l.rotulos).toEqual([]);
  });

  it('descarta los que no tienen posición, sin reubicarlos', () => {
    // A un equipo sin coordenadas hay que rescatarlo; a un rótulo suelto que
    // no se sabe dónde va, no: sería ruido en el medio del mapa.
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: null, y: null, label: 'eth2' }),
    ]);
    expect(l.rotulos).toEqual([]);
    expect(l.sinPosicion).toBe(0);
  });

  it('entran en el encuadre', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, kind: 'static', x: 900, y: 900, label: 'eth9' }),
    ]);
    expect(l.vista.ancho).toBeGreaterThan(800);
  });

  it('un mapa que sólo tiene rótulos igual se dibuja', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 10, y: 10, label: 'sólo texto' }),
    ]);
    expect(l.nodos).toEqual([]);
    expect(l.rotulos).toHaveLength(1);
    expect(l.vista.ancho).toBeGreaterThan(0);
  });
});

describe('construirLienzo · encuadre', () => {
  it('deja margen alrededor del contenido', () => {
    const { vista } = construirLienzo([
      elem({ element_id: 1, x: 100, y: 100 }),
      elem({ element_id: 2, x: 500, y: 300 }),
    ]);
    expect(vista.x).toBeLessThan(118);
    expect(vista.ancho).toBeGreaterThan(400);
  });

  it('un mapa de un solo nodo tiene tamaño usable', () => {
    // Un viewBox de ancho 0 hace que el navegador no dibuje absolutamente nada.
    const { vista } = construirLienzo([elem({ element_id: 1, x: 50, y: 50 })]);
    expect(vista.ancho).toBeGreaterThanOrEqual(200);
    expect(vista.alto).toBeGreaterThanOrEqual(150);
  });

  it('un mapa vacío no explota', () => {
    const l = construirLienzo([]);
    expect(l.nodos).toEqual([]);
    expect(l.enlaces).toEqual([]);
    expect(l.vista.ancho).toBeGreaterThan(0);
  });

  it('sólo con enlaces colgados tampoco explota', () => {
    const l = construirLienzo([
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.nodos).toEqual([]);
    expect(l.enlaces).toEqual([]);
  });
});
