import { describe, expect, it } from 'vitest';
import type { ElementoMapa, ResumenSubmapa } from '@/lib/consultas';
import {
  cajaDeIcono,
  construirLienzo,
  ladoDeIcono,
  medioRecuadro,
  partirTexto,
  TAMANIO_NODO,
} from '@/lib/mapa';

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
    services_down: null,
    image_scale: 100,
    ...p,
  } as ElementoMapa;
}

/** Un submapa con sus recuentos, como los devuelve `resumenSubmapas`. */
function submapa(p: Partial<ResumenSubmapa> = {}): ResumenSubmapa {
  return { estado: 1, total: 0, arriba: 0, parciales: 0, caidos: 0, ...p };
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
      new Map([[7, submapa({ estado: 3, total: 4, caidos: 1 })]]),
    );
    expect(nodos[0]!.estado).toBe(3);
  });
});

describe('construirLienzo · el rótulo es una PLANTILLA', () => {
  // 🔴 El bug que motivó todo esto: 2.216 de los 2.317 elementos de la base
  //    real traen plantilla, y se dibujaban literales. En pantalla se leía
  //    «[Device.Name] [dev…».
  it('resuelve nombre y dirección, y las deja en renglones separados', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[Device.FirstAddress]',
        name: 'Vega_P_Aurora_AC2',
        direcciones: ['192.0.2.13'],
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['Vega_P_Aurora_AC2', '192.0.2.13']);
    // Y el nombre para el `<title>` y el lector de pantalla es el de verdad.
    expect(nodos[0]!.nombre).toBe('Vega_P_Aurora_AC2');
  });

  it('nunca deja un corchete en pantalla', () => {
    const { nodos } = construirLienzo([
      elem({ element_id: 1, label: '[Device.Name]\r\n[Loquesea.Nuevo]', name: 'RT_Core' }),
    ]);
    expect(nodos[0]!.lineas.join('\n')).not.toMatch(/\[[A-Za-z]/);
  });

  it('`AddressesColumn` pone una dirección por línea', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[Device.AddressesColumn]',
        name: 'SW-Core',
        direcciones: ['192.0.2.1', '192.0.2.2'],
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['SW-Core', '192.0.2.1', '192.0.2.2']);
  });

  it('un equipo sin dirección muestra un guion, no una línea fantasma', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[Device.FirstAddress]',
        name: 'RT_Core',
        direcciones: [],
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['RT_Core', '—']);
  });

  it('el rótulo de submapa arma «total / parciales / caídos» como The Dude', () => {
    const { nodos } = construirLienzo(
      [
        elem({
          element_id: 1,
          kind: 'submap',
          submap_id: 7,
          name: 'Ponte',
          label:
            '[NetMap.Name]\r\n[NetMap.DevicesCount] / [NetMap.DevicesPartiallyDownCount] / [NetMap.DevicesDownCount]',
        }),
      ],
      new Map([[7, submapa({ estado: 3, total: 95, arriba: 67, parciales: 0, caidos: 11 })]]),
    );
    expect(nodos[0]!.lineas).toEqual(['Ponte', '95 / 0 / 11']);
  });

  it('cero servicios caídos no deja un renglón decorativo', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[Device.ServicesDown]',
        name: 'RT_Core',
        services_down: 0,
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['RT_Core']);
  });

  it('con servicios caídos sí, y se lee de qué son', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[Device.ServicesDown]',
        name: 'RT_Core',
        services_down: 2,
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['RT_Core', '2 caídos']);
  });

  // 🔴 La regresión cara: el contador pegado adelante de la dirección fabricaba
  //    `3192.0.2.104`, un número con forma de IP que no existe en ningún lado.
  it('el contador nunca se pega a la dirección', () => {
    const { nodos } = construirLienzo([
      elem({
        element_id: 1,
        label: '[Device.Name]\r\n[device_performance()][Device.ServicesDown][Device.AddressesColumn]',
        name: 'Mimosa a Oso',
        services_down: 3,
        direcciones: ['192.0.2.104'],
      }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['Mimosa a Oso', '3 caídos', '192.0.2.104']);
    expect(nodos[0]!.lineas.join('\n')).not.toContain('3192');
  });

  it('una plantilla que no conocemos se marca y se registra', () => {
    const l = construirLienzo([
      elem({ element_id: 1, label: '[Device.Name]\r\n[Device.Inventada]', name: 'RT_Core' }),
    ]);
    expect(l.nodos[0]!.lineas).toEqual(['RT_Core', '‹?›']);
    expect(l.huecos).toEqual([
      {
        plantilla: '[Device.Inventada]',
        como: 'plantilla [Device.Inventada]',
        motivo: 'desconocida',
        veces: 1,
        // Cuántas veces SÍ salió. Es lo que vuelve al pie del mapa una
        // medición en caliente en vez de una afirmación que envejece.
        resueltos: 0,
      },
    ]);
  });

  it('una línea cuyos únicos campos no tenemos se cae entera', () => {
    // `Rx: [Interface.InBitRate][snmp_wireless_link_rx_rate()]` sin ninguno de
    // los dos números es «Rx: », que es peor que no mostrar nada.
    const l = construirLienzo([
      elem({
        element_id: 1,
        label: 'Radio Norte\r\nRx: [Interface.InBitRate][snmp_wireless_link_rx_rate()]',
        name: 'Radio Norte',
      }),
    ]);
    expect(l.nodos[0]!.lineas).toEqual(['Radio Norte']);
    // Pero se declara, con nombre y cantidad.
    // 🔴 `sin-dato` y no `sin-replicar` para el tráfico: el panel SÍ sabe leer
    //    ese campo desde que se encendió; lo que falta es la serie de ESTE
    //    enlace. Son cosas distintas y confundirlas fue lo que tuvo la
    //    funcionalidad apagada. Ver `SIN_DATO` en `plantillas.ts`.
    expect(l.huecos.map((h) => [h.plantilla, h.veces, h.motivo])).toEqual([
      ['[Interface.InBitRate]', 1, 'sin-dato'],
      ['[snmp_wireless_link_rx_rate()]', 1, 'sin-replicar'],
    ]);
  });

  it('el enlace sin nombre propio no cae en la plantilla cruda', () => {
    // 1.168 de los 1.170 enlaces tienen `label` que resuelve a nada; muchos
    // traen además `links.name` en cadena vacía, y con `??` el título salía
    // en blanco.
    const { enlaces } = construirLienzo([
      elem({ element_id: 1, x: 0, y: 0 }),
      elem({ element_id: 2, x: 100, y: 0 }),
      elem({
        element_id: 9,
        kind: 'link',
        link_from: 1,
        link_to: 2,
        name: '  ',
        label: 'Rx: [Interface.InBitRate]\r\nTx: [Interface.OutBitRate]',
      }),
    ]);
    expect(enlaces[0]!.nombre).toBeNull();
  });

  it('un rótulo sin plantilla no se toca', () => {
    const { nodos } = construirLienzo([
      elem({ element_id: 1, label: 'Torre Aurora', name: 'RT_Aurora_Torre' }),
    ]);
    expect(nodos[0]!.lineas).toEqual(['Torre Aurora']);
    expect(nodos[0]!.nombre).toBe('Torre Aurora');
  });

  it('un mapa sin huecos no declara nada', () => {
    const l = construirLienzo([elem({ element_id: 1, label: 'eth2' })]);
    expect(l.huecos).toEqual([]);
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

/**
 * 🔴 El tamaño del icono, que el visor tiraba.
 *
 * `map_elements.image_scale` es un porcentaje sobre el tamaño natural del
 * archivo, y el visor dibujaba todo en un cuadro fijo de 22×22. En la base real
 * conviven escalas de 5 a 384 dentro del MISMO mapa.
 */
describe('ladoDeIcono · la escala de The Dude', () => {
  it('un icono típico queda cerca del tamaño base', () => {
    // 100 px naturales al 100 % es el caso mediano medido en la base.
    expect(ladoDeIcono(100, { ancho: 100, alto: 100 })).toBe(44);
  });

  it('respeta el ORDEN que puso el operador', () => {
    const nat = { ancho: 200, alto: 200 };
    const chico = ladoDeIcono(10, nat);
    const medio = ladoDeIcono(50, nat);
    const grande = ladoDeIcono(100, nat);
    expect(chico).toBeLessThan(medio);
    expect(medio).toBeLessThan(grande);
  });

  it('y también el orden entre dos archivos con la MISMA escala', () => {
    // Es la información que se pierde si se dibuja por la escala sola: entre
    // los 127 elementos en escala 100 los naturales van de 41 a 628 px.
    const chico = ladoDeIcono(100, { ancho: 41, alto: 41 });
    const grande = ladoDeIcono(100, { ancho: 628, alto: 397 });
    expect(chico).toBeLessThan(grande);
  });

  it('comprime el rango: 42× de entrada entran en 4,4× de salida', () => {
    // Copiar la fórmula de The Dude pediría lados de 15 a 628 unidades, y la
    // distancia mediana al vecino es 131: el mapa se taparía a sí mismo.
    const min = ladoDeIcono(5, { ancho: 300, alto: 141 });
    const max = ladoDeIcono(100, { ancho: 628, alto: 397 });
    expect(max / min).toBeLessThan(5);
  });

  it('nunca baja del piso, por más que la escala diga 5 %', () => {
    expect(ladoDeIcono(5, { ancho: 35, alto: 41 })).toBe(20);
    expect(ladoDeIcono(1, { ancho: 30, alto: 89 })).toBe(20);
  });

  it('nunca pasa del techo, por más que la escala diga 384 %', () => {
    expect(ladoDeIcono(384, { ancho: 3447, alto: 685 })).toBe(88);
  });

  // La columna es nullable y la base trae ceros. Ninguno de los dos es escala.
  it('una escala nula o cero se trata como 100, no como invisible', () => {
    const cien = ladoDeIcono(100, { ancho: 200, alto: 100 });
    expect(ladoDeIcono(null, { ancho: 200, alto: 100 })).toBe(cien);
    expect(ladoDeIcono(0, { ancho: 200, alto: 100 })).toBe(cien);
    expect(ladoDeIcono(-5, { ancho: 200, alto: 100 })).toBe(cien);
  });

  it('sin tamaño natural —un SVG— la escala sigue mandando', () => {
    // El `viewBox` de un SVG está en unidades arbitrarias: compararlo contra
    // los píxeles de un PNG no significa nada, así que no se lo mide.
    expect(ladoDeIcono(100, null)).toBe(44);
    expect(ladoDeIcono(300, null)).toBeGreaterThan(44);
    expect(ladoDeIcono(25, null)).toBeLessThan(44);
  });
});

describe('cajaDeIcono · la proporción del archivo', () => {
  // 🔴 La mitad del bug: con un cuadro de 22×22 y `preserveAspectRatio=meet`,
  //    una foto de 467×92 entraba como 22×4. Una astilla, no un icono.
  it('una foto apaisada no se dibuja dentro de un cuadrado', () => {
    const c = cajaDeIcono('a.png', 100, { ancho: 467, alto: 92 });
    expect(c.ancho).toBeGreaterThan(c.alto * 4);
    expect(c.ancho / c.alto).toBeCloseTo(467 / 92, 1);
  });

  it('el lado mayor es el que manda el tamaño… salvo que el menor no se vea', () => {
    // Proporción suave: el mayor sale clavado de `ladoDeIcono`.
    const cuadrado = cajaDeIcono('a.png', 100, { ancho: 80, alto: 89 });
    expect(Math.max(cuadrado.ancho, cuadrado.alto)).toBe(
      ladoDeIcono(100, { ancho: 80, alto: 89 }),
    );

    // 🔴 Proporción marcada: 30×89 al 100 % pedía un mayor de 41,5 y dejaba el
    //    menor en 14. Ahí el piso de legibilidad manda y la caja ENTERA crece,
    //    así que el mayor pasa a ser más grande que `ladoDeIcono`. Es la regla
    //    nueva, y el test la dice en vez de tolerarla.
    const flaco = cajaDeIcono('a.png', 100, { ancho: 30, alto: 89 });
    expect(Math.max(flaco.ancho, flaco.alto)).toBeGreaterThan(
      ladoDeIcono(100, { ancho: 30, alto: 89 }),
    );
    expect(Math.min(flaco.ancho, flaco.alto)).toBeGreaterThanOrEqual(16);
    expect(flaco.alto / flaco.ancho).toBeCloseTo(89 / 30, 1);
  });

  it('🔴 el lado MENOR no baja del mínimo legible, y la caja crece entera', () => {
    // `rb1100.png` real: 200×40 al 60 %. Antes daba 48,2 × 9,6 — proporción
    // impecable y nueve unidades de alto sobre un mapa cuya distancia mediana
    // entre nodos es 131. Se veía una línea.
    const c = cajaDeIcono('a.png', 60, { ancho: 200, alto: 40 });
    expect(Math.min(c.ancho, c.alto)).toBeGreaterThanOrEqual(16);
    // Creció, no se recortó: la foto sigue siendo 5:1.
    expect(c.ancho / c.alto).toBeCloseTo(5, 1);
  });

  it('sin medida cae a un cuadrado, que es lo honesto', () => {
    const c = cajaDeIcono('a.png', 100, null);
    expect(c.ancho).toBe(c.alto);
  });
});

describe('medioRecuadro · el chapón envuelve al icono', () => {
  it('crece con el icono en vez de recortarlo', () => {
    const chico = medioRecuadro({ ancho: 20, alto: 20 });
    const grande = medioRecuadro({ ancho: 88, alto: 40 });
    expect(grande.x).toBeGreaterThan(chico.x);
    expect(grande.x * 2).toBeGreaterThanOrEqual(88);
  });

  it('pero nunca se achica más que el blanco mínimo para hacer clic', () => {
    const c = medioRecuadro({ ancho: 8, alto: 8 });
    expect(c.x * 2).toBe(TAMANIO_NODO);
    expect(c.y * 2).toBe(TAMANIO_NODO);
  });
});

describe('construirLienzo · el icono dimensionado', () => {
  it('toma la medida del archivo por su rel_path', () => {
    const { nodos } = construirLienzo(
      [elem({ element_id: 1, icon: 'images/olt-tplink.png', image_scale: 100 })],
      new Map(),
      new Map([['images/olt-tplink.png', { ancho: 467, alto: 92 }]]),
    );
    expect(nodos[0]!.ancho).toBeGreaterThan(nodos[0]!.alto * 4);
  });

  it('sin medidas no rompe: cae al cuadrado del tamaño base', () => {
    const { nodos } = construirLienzo([elem({ element_id: 1, icon: 'x.png' })]);
    expect(nodos[0]!.ancho).toBe(nodos[0]!.alto);
    expect(nodos[0]!.ancho).toBeGreaterThan(0);
  });

  it('🔴 el encuadre incluye los bordes del icono, no sólo el centro', () => {
    // Con un icono de 88 unidades, encuadrar por el centro dejaba media foto
    // fuera del lienzo.
    const conIcono = construirLienzo(
      [elem({ element_id: 1, x: 0, y: 0, icon: 'g.png', image_scale: 100 })],
      new Map(),
      new Map([['g.png', { ancho: 628, alto: 397 }]]),
    );
    const sinIcono = construirLienzo([elem({ element_id: 1, x: 0, y: 0, image_scale: 5 })]);
    expect(conIcono.vista.ancho).toBeGreaterThan(sinIcono.vista.ancho);
  });
});

describe('cajaDeIcono · sin imagen asignada', () => {
  // 563 de los 1.047 nodos de la base no tienen ninguna imagen, y 554 traen la
  // escala en 100 porque nadie la tocó nunca: no hay nada que escalar. Si se
  // los agranda igual, el mapa se llena de dibujos de repuesto grandes que le
  // comen el lugar a los nodos que sí traen una foto de verdad.
  it('un nodo sin icono queda como estaba, por más escala que traiga', () => {
    expect(cajaDeIcono(null, 100)).toEqual({ ancho: 22, alto: 22 });
    expect(cajaDeIcono(null, 384)).toEqual({ ancho: 22, alto: 22 });
    expect(cajaDeIcono(undefined, 5)).toEqual({ ancho: 22, alto: 22 });
  });

  it('así el tamaño significa «acá hay una foto de verdad»', () => {
    const sinFoto = cajaDeIcono(null, 100);
    const conFoto = cajaDeIcono('images/CCR1036-8G-2Splus.png', 100, { ancho: 628, alto: 397 });
    expect(conFoto.ancho).toBeGreaterThan(sinFoto.ancho * 2);
  });
});
