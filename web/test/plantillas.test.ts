import { describe, expect, it } from 'vitest';
import {
  DESCONOCIDA,
  huecosOrdenados,
  resolverRotulo,
  SEPARADOR,
  SIN_VALOR,
  type Hueco,
} from '@/lib/plantillas';

/**
 * El resolvedor de plantillas, sin base y sin render.
 *
 * Los casos NO son inventados: cada uno es una de las 22 plantillas distintas
 * que hay en `map_elements` de la base real, con su frecuencia al lado. Un
 * test que prueba una cadena que nadie escribió no prueba nada.
 */

describe('resolverRotulo · lo que sí sabemos poner', () => {
  it('el rótulo más común de un equipo (610 elementos)', () => {
    const t = resolverRotulo('[Device.Name]\r\n[device_performance()][Device.ServicesDown]', {
      nombre: 'Vega_P_Aurora_AC2',
      serviciosCaidos: 2,
    });
    // `device_performance()` no se replica y desaparece; el número sí está, así
    // que la línea se queda. Y con la unidad puesta: un `2` suelto bajo el
    // nombre de un equipo no dice si son servicios, interfaces o vecinos.
    expect(t).toBe('Vega_P_Aurora_AC2\n2 caídos');
  });

  it('y en singular dice «1 caído», que es como se habla', () => {
    expect(resolverRotulo('[Device.ServicesDown]', { serviciosCaidos: 1 })).toBe('1 caído');
  });

  it('nombre y primera dirección (60 elementos)', () => {
    expect(
      resolverRotulo('[Device.Name]\r\n[Device.FirstAddress]', {
        nombre: 'Vega_P_Aurora_AC2',
        direcciones: ['192.0.2.13', '198.51.100.1'],
      }),
    ).toBe('Vega_P_Aurora_AC2\n192.0.2.13');
  });

  it('la columna de direcciones abre un renglón por cada una (180 elementos)', () => {
    expect(
      resolverRotulo('[Device.AddressesColumn]', {
        direcciones: ['192.0.2.1', '192.0.2.2', '192.0.2.3'],
      }),
    ).toBe('192.0.2.1\n192.0.2.2\n192.0.2.3');
  });

  it('el recuento de un submapa (145 elementos)', () => {
    expect(
      resolverRotulo(
        '[NetMap.Name]\r\n[NetMap.DevicesCount] / [NetMap.DevicesPartiallyDownCount] / [NetMap.DevicesDownCount]',
        {
          nombre: 'MGomez',
          submapa: { total: 48, arriba: 19, parciales: 12, caidos: 11 },
        },
      ),
    ).toBe('MGomez\n48 / 12 / 11');
  });

  it('respeta el texto suelto que el operador escribió a mano', () => {
    // `[Device.Name]\r\n[Device.FirstAddress]\r\nWD: 203.0.113.17`, 6 elementos.
    expect(
      resolverRotulo('[Device.Name]\r\n[Device.FirstAddress]\r\nWD: 203.0.113.17', {
        nombre: 'Vega_P_Aurora',
        direcciones: ['203.0.113.20'],
      }),
    ).toBe('Vega_P_Aurora\n203.0.113.20\nWD: 203.0.113.17');
  });

  it('y el texto mezclado en el medio de una línea', () => {
    expect(
      resolverRotulo('VLAN2703 - [Device.FirstAddress]', { direcciones: ['192.0.2.31'] }),
    ).toBe('VLAN2703 - 192.0.2.31');
  });

  it('un rótulo sin corchetes vuelve tal cual, sin recorrer nada', () => {
    const bruto = 'bndn-SW16-Primero\r\nv2703, v2701\r\nTagged';
    expect(resolverRotulo(bruto)).toBe(bruto);
  });

  it('vacío es vacío, no la cadena "null"', () => {
    expect(resolverRotulo(null)).toBe('');
    expect(resolverRotulo(undefined)).toBe('');
    expect(resolverRotulo('')).toBe('');
  });
});

describe('resolverRotulo · lo que no sabemos poner', () => {
  it('un campo conocido sin valor deja un guion, no un renglón fantasma', () => {
    expect(resolverRotulo('[Device.Name]\r\n[Device.FirstAddress]', { nombre: 'RT' })).toBe(
      `RT\n${SIN_VALOR}`,
    );
  });

  it('el recuento de un submapa que no vino tampoco se inventa', () => {
    expect(resolverRotulo('[NetMap.DevicesCount]', {})).toBe(SIN_VALOR);
  });

  it('una plantilla desconocida se marca en pantalla', () => {
    expect(resolverRotulo('[Device.LoQueVenga]', {})).toBe(DESCONOCIDA);
  });

  it('🔴 nunca, jamás, la plantilla cruda', () => {
    const rotulos = [
      '[Device.Name]',
      '[NetMap.Name]',
      '[Interface.InBitRate]',
      '[Network.SubnetsColumn]',
      '[device_performance()]',
      '[Loquesea]',
      '[]',
      '[ Device.Name ]',
    ];
    for (const r of rotulos) {
      expect(resolverRotulo(r, {})).not.toContain('[');
    }
  });

  it('la línea que se queda sin ningún dato se descarta entera', () => {
    // El rótulo de 1.168 de los 1.170 enlaces del mapa real. Sin el tráfico ni
    // las tasas SNMP lo único que queda es «Rx: » y «Tx: »: andamio.
    const t = resolverRotulo(
      '[snmp_wireless_link_info()]Rx: [Interface.InBitRate][snmp_wireless_link_rx_rate()]\r\nTx: [Interface.OutBitRate][snmp_wireless_link_tx_rate()]',
    );
    expect(t).toBe('');
  });

  it('pero si algo de la línea sí se resolvió, la línea se queda', () => {
    expect(
      resolverRotulo('Rx: [Interface.InBitRate] · [Device.Name]', { nombre: 'RT_Core' }),
    ).toBe('Rx:  · RT_Core');
  });

  it('y una línea de puro texto nunca se cae, aunque las de abajo sí', () => {
    expect(
      resolverRotulo('Oso1-e-Brucks-eth1\r\nRx: [Interface.InBitRate]\r\nTx: [Interface.OutBitRate]'),
    ).toBe('Oso1-e-Brucks-eth1');
  });
});

describe('resolverRotulo · el cero que no informa', () => {
  // De los 761 elementos con `[Device.ServicesDown]`, 522 tienen cero. Un mapa
  // decorado con 522 ceros no dice nada: el estado normal no se anuncia.
  it('cero servicios caídos no escribe nada', () => {
    expect(resolverRotulo('[Device.ServicesDown]', { serviciosCaidos: 0 })).toBe('');
  });

  it('y arrastra consigo la línea entera si era lo único que había', () => {
    // El rótulo más usado del mapa: 610 elementos. Antes dejaba un `0` suelto
    // bajo cada nombre de equipo sano.
    expect(
      resolverRotulo('[Device.Name]\r\n[device_performance()][Device.ServicesDown]', {
        nombre: 'Vega_P_Aurora_AC2',
        serviciosCaidos: 0,
      }),
    ).toBe('Vega_P_Aurora_AC2');
  });

  it('pero «no tengo el dato» sigue siendo un guion, no silencio', () => {
    // Callar y no tener son cosas distintas y tienen que verse distintas.
    expect(resolverRotulo('[Device.ServicesDown]', { serviciosCaidos: null })).toBe(SIN_VALOR);
  });

  it('🔴 los contadores de submapa SÍ escriben el cero', () => {
    // Acá el cero está posicionado entre barras y ES la información. Medido:
    // 31 de los 33 submapas tienen un 0 en el medio. Callarlo daría «24 /  / 5»
    // y, peor, «24 / 5» se leería como si los 5 fueran parciales.
    expect(
      resolverRotulo(
        '[NetMap.DevicesCount] / [NetMap.DevicesPartiallyDownCount] / [NetMap.DevicesDownCount]',
        { submapa: { total: 24, arriba: 19, parciales: 0, caidos: 5 } },
      ),
    ).toBe('24 / 0 / 5');
  });
});

describe('resolverRotulo · 🔴 dos campos pegados nunca se concatenan', () => {
  // The Dude deja escribir campos sin nada en el medio y en la base hay 3.259
  // adyacencias así. Concatenar sus valores FABRICA un dato que no existe.
  const CASO_REAL = '[Device.Name]\r\n[device_performance()][Device.ServicesDown][Device.AddressesColumn]';

  it('el caso visto en pantalla: el cero se pegaba adelante de la IP', () => {
    // Antes: «Mimosa a Oso» / «0192.0.2.104». El equipo está sano, así que
    // ahora el contador se calla y la dirección queda sola.
    expect(
      resolverRotulo(CASO_REAL, {
        nombre: 'Mimosa a Oso',
        serviciosCaidos: 0,
        direcciones: ['192.0.2.104'],
      }),
    ).toBe('Mimosa a Oso\n192.0.2.104');
  });

  it('y el caso PEOR: un contador distinto de cero fabricaba una IP falsa', () => {
    // Antes esto daba «3192.0.2.104», que no es un número ni una dirección:
    // es basura con forma de dato. La columna abre su propio renglón.
    expect(
      resolverRotulo(CASO_REAL, {
        nombre: 'Mimosa a Oso',
        serviciosCaidos: 3,
        direcciones: ['192.0.2.104'],
      }),
    ).toBe('Mimosa a Oso\n3 caídos\n192.0.2.104');
  });

  it('dos campos inline pegados se separan con un punto medio', () => {
    // `[Device.ServicesDown][Device.FirstAddress]`, 1 elemento en la base.
    expect(
      resolverRotulo('[Device.ServicesDown][Device.FirstAddress]', {
        serviciosCaidos: 2,
        direcciones: ['192.0.2.1'],
      }),
    ).toBe(`2 caídos${SEPARADOR}192.0.2.1`);
  });

  it('la columna abre renglón aunque lo de adelante sea texto escrito a mano', () => {
    expect(
      resolverRotulo('IPs: [Device.AddressesColumn]', { direcciones: ['192.0.2.1', '192.0.2.2'] }),
    ).toBe('IPs: \n192.0.2.1\n192.0.2.2');
  });

  it('y lo que venga DESPUÉS de una columna tampoco se le pega', () => {
    expect(
      resolverRotulo('[Device.AddressesColumn][Device.Name]', {
        nombre: 'RT_Core',
        direcciones: ['192.0.2.1'],
      }),
    ).toBe('192.0.2.1\nRT_Core');
  });

  it('un literal en el medio ya separa: no se agrega nada de más', () => {
    // Es el caso de los contadores de submapa, y de `Rx: [...]`.
    expect(
      resolverRotulo('[NetMap.DevicesCount] / [NetMap.DevicesDownCount]', {
        submapa: { total: 24, arriba: 19, parciales: 0, caidos: 5 },
      }),
    ).toBe('24 / 5');
  });

  it('un campo que se calla no deja separador colgando', () => {
    expect(
      resolverRotulo('[Device.ServicesDown][Device.FirstAddress]', {
        serviciosCaidos: 0,
        direcciones: ['192.0.2.1'],
      }),
    ).toBe('192.0.2.1');
  });
});

describe('resolverRotulo · el registro de huecos', () => {
  it('cuenta cada plantilla que no se pudo resolver, acumulando entre rótulos', () => {
    const huecos = new Map<string, Hueco>();
    for (let i = 0; i < 3; i++) {
      resolverRotulo('Rx: [Interface.InBitRate] · [Device.Name]', { nombre: 'x' }, huecos);
    }
    resolverRotulo('[Device.Inventada]', {}, huecos);

    expect(huecosOrdenados(huecos)).toEqual([
      {
        plantilla: '[Interface.InBitRate]',
        como: 'tráfico de entrada del enlace',
        // El campo se sabe leer; lo que falta es el dato de este enlace.
        motivo: 'sin-dato',
        veces: 3,
        resueltos: 0,
      },
      {
        plantilla: '[Device.Inventada]',
        como: 'plantilla [Device.Inventada]',
        motivo: 'desconocida',
        veces: 1,
        resueltos: 0,
      },
    ]);
  });

  it('separa «conozco el campo y no lo tengo» de «no sé qué es esto»', () => {
    const huecos = new Map<string, Hueco>();
    resolverRotulo('[device_performance()][Nada.DeNada]', {}, huecos);
    expect([...huecos.values()].map((h) => h.motivo)).toEqual(['sin-replicar', 'desconocida']);
    // Una función de script se nombra como lo que es: no hay que investigarla.
    expect(huecos.get('[device_performance()]')!.como).toContain('device_performance()');
  });

  it('un campo vacío para ESTE objeto no es un hueco del panel', () => {
    // El equipo no tiene dirección cargada en The Dude. Eso no es algo que el
    // panel deba «agregar después»: no hay nada que agregar.
    //
    // Se mira `huecosOrdenados` y no el tamaño crudo del acumulador: desde que
    // el pie del mapa declara la cobertura, el mismo Map guarda también los
    // ACIERTOS de cada plantilla. Lo que es contrato es lo que sale a
    // declararse, y ahí un `—` no aparece.
    const huecos = new Map<string, Hueco>();
    resolverRotulo('[Device.FirstAddress]', { direcciones: [] }, huecos);
    expect(huecosOrdenados(huecos)).toEqual([]);
  });

  it('sin acumulador no rompe: el resolvedor se puede usar suelto', () => {
    expect(() => resolverRotulo('[Interface.InBitRate]')).not.toThrow();
  });
});
