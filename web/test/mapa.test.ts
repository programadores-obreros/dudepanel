import { describe, expect, it } from 'vitest';
import type { ElementoMapa } from '@/lib/consultas';
import { construirLienzo, partirTexto, TAMANIO_NODO } from '@/lib/mapa';

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
      elem({ element_id: 1, label: 'Torre Aurora', name: 'RT_Aurora_Torre' }),
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

describe('construirLienzo · fichas de anotación (static)', () => {
  it('no las cuenta como nodos', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, kind: 'static', x: 50, y: 50, label: 'eth2' }),
    ]);
    expect(l.nodos).toHaveLength(1);
    expect(l.rotulos).toHaveLength(1);
    expect(l.rotulos[0]!.lineas).toEqual(['eth2']);
  });

  // 🔴 La regresión que hay que impedir. Tratar los `static` como decoración y
  // sacarlos del grafo dejaba Segmentos con 18 líneas de 107 dibujables: 212 de sus
  // 308 enlaces tienen al menos una punta en una ficha de anotación.
  it('ANCLAN enlaces: un enlace equipo → ficha se dibuja', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0, status: 1 }),
      elem({ element_id: 2, kind: 'static', x: 200, y: 100, label: 'eth1\r\nVLAN2701' }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlaces).toHaveLength(1);
    expect(l.enlaces[0]).toMatchObject({ de: 1, a: 2, x1: 18, y1: 18 });
  });

  it('también entre dos fichas: en Segmentos hay 60 así', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 0, y: 0, label: 'sfpp1' }),
      elem({ element_id: 2, kind: 'static', x: 300, y: 0, label: 'sfpp2' }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlaces).toHaveLength(1);
  });

  it('el enlace se engancha al medio del borde izquierdo de la ficha', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      // Dos líneas → alto 24 → el ancla queda 12 por debajo del borde superior.
      elem({ element_id: 2, kind: 'static', x: 200, y: 100, label: 'a\nb' }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlaces[0]!.x2).toBe(200);
    expect(l.enlaces[0]!.y2).toBe(112);
  });

  // Una ficha no tiene estado. Si contara como "desconocido", todo enlace a una
  // anotación se vería gris y el mapa parecería enfermo sin estarlo.
  it('una ficha no ensucia el estado del enlace', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0, status: 1 }),
      elem({ element_id: 2, kind: 'static', x: 200, y: 0, label: 'eth1' }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlaces[0]!.estado).toBe(1);
  });

  it('un enlace entre dos fichas queda sin estado, no falsamente arriba', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 0, y: 0, label: 'a' }),
      elem({ element_id: 2, kind: 'static', x: 200, y: 0, label: 'b' }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlaces[0]!.estado).toBe(0);
  });

  it('descarta las que no tienen texto', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 10, y: 10, label: '   ', name: null }),
    ]);
    expect(l.rotulos).toEqual([]);
  });

  it('descarta las que no tienen posición, sin reubicarlas', () => {
    // A un equipo sin coordenadas hay que rescatarlo; a una ficha suelta que no
    // se sabe dónde va, no: sería ruido en el medio del mapa.
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: null, y: null, label: 'eth2' }),
    ]);
    expect(l.rotulos).toEqual([]);
    expect(l.sinPosicion).toBe(0);
  });

  it('el encuadre contempla el ancho y el alto del bloque de texto', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({
        element_id: 2,
        kind: 'static',
        x: 900,
        y: 900,
        label: 'bndn-SW16-Primero\nv2703, v2701, v2216\nTagged',
      }),
    ]);
    // El texto arranca en 900 y crece: el borde derecho tiene que pasarlo.
    expect(l.vista.x + l.vista.ancho).toBeGreaterThan(900 + 60);
    expect(l.vista.y + l.vista.alto).toBeGreaterThan(900 + 36);
  });

  it('un mapa que sólo tiene fichas igual se dibuja', () => {
    const l = construirLienzo([
      elem({ element_id: 1, kind: 'static', x: 10, y: 10, label: 'sólo texto' }),
    ]);
    expect(l.nodos).toEqual([]);
    expect(l.rotulos).toHaveLength(1);
    expect(l.vista.ancho).toBeGreaterThan(0);
  });
});

describe('partirTexto', () => {
  // Las etiquetas del origen son de 2011 y vienen con CR LF de Windows.
  it('parte por CR LF, LF y CR suelto', () => {
    expect(partirTexto('eth1 - \r\nVLAN2701\r\nUntagged')).toEqual([
      'eth1 -',
      'VLAN2701',
      'Untagged',
    ]);
    expect(partirTexto('a\rb')).toEqual(['a', 'b']);
  });

  it('descarta renglones vacíos', () => {
    expect(partirTexto('bndn-SW16\r\n\r\nTagged\r\n   \r\n')).toEqual(['bndn-SW16', 'Tagged']);
  });

  it('corta a cuatro renglones', () => {
    expect(partirTexto('1\n2\n3\n4\n5\n6')).toHaveLength(4);
  });

  it('recorta los renglones larguísimos', () => {
    // El más largo de la base real tiene 90 caracteres en un renglón.
    const largo = 'v2703, v2701, v2216, v2214, v2211, v2213, v2218, v3210, v3215';
    const [linea] = partirTexto(largo);
    expect(linea!.length).toBeLessThanOrEqual(34);
    expect(linea!.endsWith('…')).toBe(true);
  });

  it('sin texto devuelve lista vacía', () => {
    expect(partirTexto(null)).toEqual([]);
    expect(partirTexto('  \r\n ')).toEqual([]);
  });
});

describe('construirLienzo · recuento de enlaces', () => {
  // El visor compara estos dos números para declarar lo que no pudo dibujar.
  it('cuenta TODOS los enlaces del mapa, no sólo los dibujables', () => {
    const l = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, x: 100, y: 0 }),
      elem({ element_id: 9, kind: 'link', link_from: 1, link_to: 2, x: null, y: null }),
      // Punta en otro mapa o inexistente: no se dibuja, pero se cuenta.
      elem({ element_id: 10, kind: 'link', link_from: 1, link_to: 777, x: null, y: null }),
      elem({ element_id: 11, kind: 'link', link_from: 888, link_to: 2, x: null, y: null }),
    ]);
    expect(l.enlacesTotales).toBe(3);
    expect(l.enlaces).toHaveLength(1);
  });

  it('sin enlaces, el total es cero y no undefined', () => {
    expect(construirLienzo([elem({ element_id: 1 })]).enlacesTotales).toBe(0);
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
