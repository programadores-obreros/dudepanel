import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BOM_UTF8,
  COBERTURAS,
  aCsv,
  aFechaISP,
  agruparPorMapa,
  campoCsv,
  clasificarCobertura,
  construirFilas,
  finDelDia,
  formatearDisponibilidad,
  inicioDelDia,
  metricas,
  nivel,
  nombreArchivoCsv,
  numeroCsv,
  ordenar,
  recortar,
  recortarAlHorizonte,
  reporteCsv,
  resolverPeriodo,
  resumir,
  segundosCubiertos,
  unirIntervalos,
  type Ventana,
} from '@/lib/disponibilidad';
import type { CrudoDisponibilidad } from '@/lib/consultas';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  Disponibilidad. La suite que decide si el reporte se puede facturar.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Está partida en dos a propósito y la división no es de comodidad:
 *
 *  · La primera mitad NO toca la base. Prueba las cinco trampas con números
 *    escritos a mano, porque las cinco son decisiones de aritmética y de
 *    clasificación, no de SQL. Un test que necesita Docker para verificar que
 *    99,9996 % no se redondea a 100 % es un test que un día se saltea.
 *
 *  · La segunda levanta PostgreSQL y arma un escenario controlado, porque
 *    `range_agg` no se puede probar de mentira: o corre, o no sabés si une los
 *    intervalos. Ahí van las trampas que viven en la consulta —solapamiento,
 *    caídas abiertas, recorte a la ventana— con las cuentas hechas a mano.
 *
 * Y las dos mitades comparten los MISMOS casos de solapamiento, contra
 * `unirIntervalos` de un lado y contra `range_agg` del otro. Si alguna de las
 * dos implementaciones se desvía, el rojo aparece en una sola de ellas.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sin base: las cinco trampas, con números a mano
// ─────────────────────────────────────────────────────────────────────────────

/** Un instante fijo, para que ningún test dependa de qué hora es. */
const AHORA = new Date('2026-08-01T20:00:00.000Z');
/** El horizonte real de la base, medido: cuando se rearmó tras el techo de 2 GB. */
const HORIZONTE = new Date('2026-06-12T14:54:07.000Z');

describe('fechas en la zona del ISP', () => {
  it('interpreta aaaa-mm-dd como el día de Buenos Aires, no de UTC', () => {
    // Medianoche del 1 de julio en Argentina son las 03:00 UTC.
    expect(inicioDelDia('2026-07-01')!.toISOString()).toBe('2026-07-01T03:00:00.000Z');
    expect(finDelDia('2026-07-31')!.toISOString()).toBe('2026-08-01T02:59:59.999Z');
  });

  it('un instante de la madrugada UTC todavía es el día anterior acá', () => {
    // 01:30 UTC del 1 de agosto = 22:30 del 31 de julio en Buenos Aires. Si esto
    // fallara, un reporte de julio perdería su última noche.
    expect(aFechaISP(new Date('2026-08-01T01:30:00Z'))).toBe('2026-07-31');
    expect(aFechaISP(new Date('2026-08-01T03:00:00Z'))).toBe('2026-08-01');
  });

  it('rechaza lo que no es una fecha en vez de corregirlo solo', () => {
    // `new Date('2026-02-31')` da el 3 de marzo. Un período que se movió solo es
    // peor que un período que no se pudo calcular.
    expect(inicioDelDia('2026-02-31')).toBeNull();
    expect(inicioDelDia('2026-13-01')).toBeNull();
    expect(inicioDelDia('01/07/2026')).toBeNull();
    expect(inicioDelDia('')).toBeNull();
  });
});

describe('resolverPeriodo', () => {
  it('las fechas explícitas le ganan al atajo: son las que viajan en el enlace', () => {
    const r = resolverPeriodo(
      { periodo: '7d', desde: '2026-07-01', hasta: '2026-07-31' },
      AHORA,
    );
    expect(r.clave).toBe('custom');
    expect(aFechaISP(r.desde)).toBe('2026-07-01');
    expect(aFechaISP(r.hasta)).toBe('2026-07-31');
  });

  it('«mes anterior» cubre el mes cerrado entero, que es el que se factura', () => {
    const r = resolverPeriodo({ periodo: 'mes-ant' }, AHORA);
    expect(aFechaISP(r.desde)).toBe('2026-07-01');
    expect(aFechaISP(r.hasta)).toBe('2026-07-31');
    // El fin es el último milisegundo de julio, no el arranque de agosto: un
    // milisegundo de más le mete a julio la primera caída de agosto.
    expect(r.hasta.toISOString()).toBe('2026-08-01T02:59:59.999Z');
  });

  it('«mes anterior» en enero cruza el año sin ayuda', () => {
    const r = resolverPeriodo({ periodo: 'mes-ant' }, new Date('2027-01-15T12:00:00Z'));
    expect(aFechaISP(r.desde)).toBe('2026-12-01');
    expect(aFechaISP(r.hasta)).toBe('2026-12-31');
  });

  it('un rango invertido no se acepta: se cae al atajo por defecto', () => {
    const r = resolverPeriodo({ desde: '2026-07-31', hasta: '2026-07-01' }, AHORA);
    expect(r.clave).toBe('30d');
  });

  it('un atajo inventado no explota, cae en 30 días', () => {
    expect(resolverPeriodo({ periodo: 'DROP TABLE' }, AHORA).clave).toBe('30d');
  });
});

describe('🔴 trampa 1 — el horizonte: «sin datos» no es «arriba»', () => {
  it('recorta el arranque al primer registro y dice cuántos días perdió', () => {
    const v = recortarAlHorizonte(
      { desde: inicioDelDia('2026-06-01')!, hasta: finDelDia('2026-07-31')! },
      HORIZONTE,
      AHORA,
    );
    expect(v.desde).toEqual(HORIZONTE);
    expect(v.dias_recortados).toBe(11);
    expect(v.vacia).toBe(false);
    // Lo pedido se conserva para poder explicarle al lector qué se recortó.
    expect(aFechaISP(v.pedido_desde)).toBe('2026-06-01');
  });

  it('un equipo sin caídas en esos 11 días NO obtiene crédito por ellos', () => {
    // La cuenta que importa: con la ventana recortada el denominador son 49,5
    // días, no 60. Sin el recorte, el mismo equipo con la misma caída de 12 h
    // saldría con MEJOR porcentaje del que le corresponde.
    const conRecorte = recortarAlHorizonte(
      { desde: inicioDelDia('2026-06-01')!, hasta: AHORA },
      HORIZONTE,
      AHORA,
    );
    const sinRecorte = recortarAlHorizonte(
      { desde: inicioDelDia('2026-06-01')!, hasta: AHORA },
      null,
      AHORA,
    );
    const caido = 12 * 3600;
    const bien = metricas(conRecorte.segundos, caido, 1).disponibilidad!;
    const inflado = metricas(sinRecorte.segundos, caido, 1).disponibilidad!;
    expect(inflado).toBeGreaterThan(bien);
    // 50,21 días observados contra 61,71 «disponibles» si se cuenta el agujero.
    expect(conRecorte.segundos / 86_400).toBeCloseTo(50.212, 3);
    expect(sinRecorte.segundos / 86_400).toBeCloseTo(61.708, 3);
    expect(formatearDisponibilidad(bien)).toBe('99,004 %');
    expect(formatearDisponibilidad(inflado)).toBe('99,189 %');
  });

  it('no cuenta el futuro: pedir todo julio un 15 de julio da media ventana', () => {
    const mediados = new Date('2026-07-15T15:00:00Z');
    const v = recortarAlHorizonte(
      { desde: inicioDelDia('2026-07-01')!, hasta: finDelDia('2026-07-31')! },
      HORIZONTE,
      mediados,
    );
    expect(v.hasta).toEqual(mediados);
    expect(v.segundos / 86_400).toBeCloseTo(14.5, 1);
  });

  it('un período entero anterior al horizonte queda vacío, no en 100 %', () => {
    const v = recortarAlHorizonte(
      { desde: inicioDelDia('2026-01-01')!, hasta: finDelDia('2026-03-31')! },
      HORIZONTE,
      AHORA,
    );
    expect(v.vacia).toBe(true);
    expect(v.segundos).toBe(0);
    expect(metricas(v.segundos, 0, 0).disponibilidad).toBeNull();
  });
});

describe('🔴 trampa 5 — el solapamiento: no contar el mismo minuto dos veces', () => {
  const h = (n: number) => n * 3600;

  it('dos caídas que se pisan son UN corte, no dos', () => {
    const unidos = unirIntervalos([
      { inicio: h(10), fin: h(12) },
      { inicio: h(11), fin: h(13) },
    ]);
    expect(unidos).toEqual([{ inicio: h(10), fin: h(13) }]);
    // La suma ingenua daría 4 h para un corte de reloj de 3 h.
    expect(segundosCubiertos(unidos)).toBe(h(3));
  });

  it('dos caídas que se TOCAN también son un corte', () => {
    // Cayó el ping 10:00–10:05 y el winbox 10:05–10:10: el cliente estuvo diez
    // minutos sin servicio, no dos veces cinco.
    expect(unirIntervalos([{ inicio: 600, fin: 900 }, { inicio: 900, fin: 1200 }])).toEqual([
      { inicio: 600, fin: 1200 },
    ]);
  });

  it('una caída contenida en otra desaparece dentro de la grande', () => {
    expect(
      unirIntervalos([
        { inicio: h(1), fin: h(9) },
        { inicio: h(3), fin: h(4) },
      ]),
    ).toEqual([{ inicio: h(1), fin: h(9) }]);
  });

  it('las que no se tocan siguen siendo dos, y el orden de entrada no importa', () => {
    const desordenado = unirIntervalos([
      { inicio: h(20), fin: h(21) },
      { inicio: h(1), fin: h(2) },
    ]);
    expect(desordenado).toHaveLength(2);
    expect(desordenado[0].inicio).toBe(h(1));
    expect(segundosCubiertos(desordenado)).toBe(h(2));
  });

  it('descarta lo vacío y lo invertido en vez de restar tiempo', () => {
    expect(
      unirIntervalos([
        { inicio: 100, fin: 100 },
        { inicio: 500, fin: 200 },
        { inicio: Number.NaN, fin: 10 },
      ]),
    ).toEqual([]);
  });
});

describe('🔴 trampa 2 — las caídas abiertas', () => {
  const ventana = { desde: 1000, hasta: 2000 };

  it('una caída sin cerrar se mide contra ahora', () => {
    expect(recortar({ inicio: 1200, fin: null }, ventana, 1500)).toEqual({
      inicio: 1200,
      fin: 1500,
    });
  });

  it('una abierta no puede pasarse del fin de la ventana', () => {
    // Un reporte de julio no puede cargarle a julio lo que sigue cayéndose hoy.
    expect(recortar({ inicio: 1800, fin: null }, ventana, 9999)).toEqual({
      inicio: 1800,
      fin: 2000,
    });
  });

  it('una caída que empezó antes del período aporta sólo su parte del período', () => {
    expect(recortar({ inicio: 0, fin: 1300 }, ventana, 5000)).toEqual({
      inicio: 1000,
      fin: 1300,
    });
  });

  it('una caída entera afuera de la ventana no aporta nada', () => {
    expect(recortar({ inicio: 10, fin: 900 }, ventana, 5000)).toBeNull();
    expect(recortar({ inicio: 2500, fin: 2800 }, ventana, 5000)).toBeNull();
  });
});

describe('🔴 trampas 3 y 4 — cobertura: qué lleva porcentaje y qué no', () => {
  const desde = HORIZONTE;

  it('sin servicios habilitados y sin caídas: no monitoreado, jamás 100 %', () => {
    const c = clasificarCobertura({
      serviciosHabilitados: 0,
      eventos: 0,
      vistoDesde: null,
      ventanaDesde: desde,
    });
    expect(c).toBe('sin-monitoreo');
    expect(COBERTURAS[c].conPorcentaje).toBe(false);
    expect(COBERTURAS[c].enLugarDelNumero).toBe('no monitoreado');
  });

  it('sin servicios pero CON caídas en el período: historia sí, porcentaje no', () => {
    // Medido: 21 de los 168 sin servicios habilitados registraron caídas dentro
    // de la ventana. Se les dio de baja el monitoreo DESPUÉS. Tirarlos perdería
    // caídas reales; darles porcentaje afirmaría que se los miró todo el mes.
    const c = clasificarCobertura({
      serviciosHabilitados: 0,
      eventos: 4,
      vistoDesde: null,
      ventanaDesde: desde,
    });
    expect(c).toBe('historica');
    expect(COBERTURAS[c].conPorcentaje).toBe(false);
  });

  it('con constancia anterior al arranque de la ventana: confirmada', () => {
    expect(
      clasificarCobertura({
        serviciosHabilitados: 2,
        eventos: 0,
        vistoDesde: new Date('2024-01-01T00:00:00Z'),
        ventanaDesde: desde,
      }),
    ).toBe('confirmada');
  });

  it('sin constancia previa: se calcula pero queda marcada', () => {
    // The Dude no guarda cuándo se dio de alta un equipo. No se inventa la
    // fecha ni se lo esconde: se marca.
    const c = clasificarCobertura({
      serviciosHabilitados: 1,
      eventos: 3,
      vistoDesde: new Date('2026-07-20T00:00:00Z'),
      ventanaDesde: desde,
    });
    expect(c).toBe('supuesta');
    expect(COBERTURAS[c].conPorcentaje).toBe(true);
    expect(COBERTURAS[c].etiqueta).toBe('Sin verificar');
  });

  it('las cuatro etiquetas son distintas: ninguna se lee como otra', () => {
    const etiquetas = Object.values(COBERTURAS).map((c) => c.etiqueta);
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
  });
});

describe('las cuatro métricas', () => {
  const SEMANA = 7 * 86_400;

  it('sin caídas: 100 %, y MTBF/MTTR en null porque no hay nada que promediar', () => {
    const m = metricas(SEMANA, 0, 0);
    expect(m.disponibilidad).toBe(100);
    expect(m.mtbf_s).toBeNull();
    expect(m.mttr_s).toBeNull();
  });

  it('🔴 con cero eventos NO devuelve 0: un 0 en MTBF se lee «se cae siempre»', () => {
    // Medido: 436 de los 717 equipos monitoreados no tuvieron ni una caída en
    // siete semanas. Es el 61 % de la tabla: la columna que se resuelve mal acá
    // es la mayoría del reporte.
    expect(metricas(SEMANA, 0, 0).mtbf_s).not.toBe(0);
    expect(metricas(SEMANA, 0, 0).mttr_s).not.toBe(0);
  });

  it('cuatro caídas de una hora: el porcentaje y los dos promedios cierran', () => {
    const m = metricas(SEMANA, 4 * 3600, 4);
    expect(m.caido_s).toBe(14_400);
    expect(m.arriba_s).toBe(SEMANA - 14_400);
    expect(m.mttr_s).toBe(3600);
    expect(m.mtbf_s).toBe((SEMANA - 14_400) / 4);
    // La identidad clásica: disponibilidad = MTBF / (MTBF + MTTR).
    expect(m.mtbf_s! / (m.mtbf_s! + m.mttr_s!)).toBeCloseTo(m.disponibilidad! / 100, 10);
  });

  it('40 min en una caída y 40 min en cuarenta caídas dan el MISMO porcentaje', () => {
    // 🔴 Este es el motivo por el que la columna «eventos» no es decorativa.
    const mes = 30 * 86_400;
    const una = metricas(mes, 2400, 1);
    const cuarenta = metricas(mes, 2400, 40);
    expect(formatearDisponibilidad(una.disponibilidad)).toBe(
      formatearDisponibilidad(cuarenta.disponibilidad),
    );
    // Y sin embargo son redes distintas: una tarda 40 min en volver, la otra 1.
    expect(una.mttr_s).toBe(2400);
    expect(cuarenta.mttr_s).toBe(60);
  });

  it('una ventana vacía no divide por cero', () => {
    expect(metricas(0, 0, 0).disponibilidad).toBeNull();
    expect(metricas(-5, 100, 2).disponibilidad).toBeNull();
  });

  it('no deja pasar más tiempo caído que ventana: el reloj del origen no es de fiar', () => {
    const m = metricas(100, 500, 1);
    expect(m.caido_s).toBe(100);
    expect(m.disponibilidad).toBe(0);
  });
});

describe('formatearDisponibilidad', () => {
  it('🔴 trunca: 99,9996 % no se convierte en un 100 % que no pasó', () => {
    expect(formatearDisponibilidad(99.9996)).toBe('99,999 %');
    expect(formatearDisponibilidad(99.99999)).toBe('99,999 %');
  });

  it('el único 100 % que se imprime es el que no tuvo ni un segundo de corte', () => {
    expect(formatearDisponibilidad(100)).toBe('100 %');
  });

  it('coma decimal, que es lo que se lee en Argentina', () => {
    expect(formatearDisponibilidad(99.6675)).toBe('99,667 %');
    expect(formatearDisponibilidad(68.245)).toBe('68,245 %');
  });

  it('sin dato es una raya, nunca un cero', () => {
    expect(formatearDisponibilidad(null)).toBe('—');
    expect(formatearDisponibilidad(Number.NaN)).toBe('—');
  });

  it('los niveles siguen los cortes que se usan en contratos', () => {
    expect(nivel(99.95)).toBe('excelente');
    expect(nivel(99.5)).toBe('bueno');
    expect(nivel(97)).toBe('flojo');
    expect(nivel(68.2)).toBe('malo');
    expect(nivel(null)).toBe('sin-dato');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Armado de filas, orden y totales
// ─────────────────────────────────────────────────────────────────────────────

const VENTANA: Ventana = recortarAlHorizonte(
  { desde: HORIZONTE, hasta: AHORA },
  HORIZONTE,
  AHORA,
);

function crudo(p: Partial<CrudoDisponibilidad> & { device_id: number }): CrudoDisponibilidad {
  return {
    equipo: `equipo-${p.device_id}`,
    mapa_id: 1,
    mapa: 'Mapa A',
    servicios: 1,
    reconocidos: 0,
    visto_desde: new Date('2024-01-01T00:00:00Z'),
    eventos: 0,
    caidas_servicio: 0,
    abiertas: 0,
    caido_s: 0,
    primera: null,
    ultima: null,
    ...p,
  };
}

describe('construirFilas', () => {
  it('lo que no lleva porcentaje sale en null, no en cero ni en cien', () => {
    const [sinMonitoreo, historico] = construirFilas(
      [
        crudo({ device_id: 1, servicios: 0, visto_desde: null }),
        crudo({ device_id: 2, servicios: 0, visto_desde: null, eventos: 3, caido_s: 9000 }),
      ],
      VENTANA,
    );

    expect(sinMonitoreo.cobertura).toBe('sin-monitoreo');
    expect(sinMonitoreo.disponibilidad).toBeNull();
    expect(sinMonitoreo.mtbf_s).toBeNull();
    expect(sinMonitoreo.mttr_s).toBeNull();

    expect(historico.cobertura).toBe('historica');
    expect(historico.disponibilidad).toBeNull();
    // Pero el tiempo caído SÍ se conserva: es historia real y se puede informar.
    expect(historico.caido_s).toBe(9000);
    expect(historico.eventos).toBe(3);
  });

  it('un equipo monitoreado y sin caídas llega a 100 %', () => {
    const [f] = construirFilas([crudo({ device_id: 3 })], VENTANA);
    expect(f.cobertura).toBe('confirmada');
    expect(f.disponibilidad).toBe(100);
    expect(f.nivel).toBe('excelente');
  });

  it('conserva las dos cuentas de caídas cuando difieren por solapamiento', () => {
    const [f] = construirFilas(
      [crudo({ device_id: 4, eventos: 2, caidas_servicio: 3, caido_s: 3600 })],
      VENTANA,
    );
    expect(f.eventos).toBe(2);
    expect(f.caidas_servicio).toBe(3);
    // El MTTR se promedia sobre EPISODIOS del equipo, no sobre filas de la
    // tabla: si no, un corte visto por tres sondas se lee como tres reparaciones.
    expect(f.mttr_s).toBe(1800);
  });
});

describe('ordenar', () => {
  const filas = construirFilas(
    [
      crudo({ device_id: 1, equipo: 'parpadea', eventos: 2777, caido_s: 47_146 }),
      crudo({ device_id: 2, equipo: 'no vuelve', eventos: 2, caido_s: 1_058_158 }),
      crudo({ device_id: 3, equipo: 'sano' }),
      crudo({ device_id: 4, equipo: 'apagado', servicios: 0, visto_desde: null }),
    ],
    VENTANA,
  );

  it('«peor disponibilidad» pone primero al que menos estuvo arriba', () => {
    expect(ordenar(filas, 'peor')[0].equipo).toBe('no vuelve');
  });

  it('«más caídas» da OTRA respuesta, y esa es la razón de tener los dos', () => {
    expect(ordenar(filas, 'eventos')[0].equipo).toBe('parpadea');
  });

  it('«más tardan en volver» da una tercera', () => {
    expect(ordenar(filas, 'mttr')[0].equipo).toBe('no vuelve');
    // El que parpadea tiene MTTR de 17 s: no aparece por ningún lado en este
    // ranking, y sin embargo es el que más molesta al operador.
    expect(ordenar(filas, 'mttr')[0].mttr_s!).toBeGreaterThan(
      filas.find((f) => f.equipo === 'parpadea')!.mttr_s!,
    );
  });

  it('🔴 lo que no tiene dato NUNCA se cuela arriba de lo que sí lo tiene', () => {
    // Un `null` en el podio de «los peores» le pone en el primer puesto a un
    // equipo del que no sabemos nada. La regla es la misma para los cuatro
    // criterios, incluso donde hay varios sin dato y el desempate es el nombre.
    const claves = {
      peor: (f: (typeof filas)[number]) => f.disponibilidad,
      eventos: (f: (typeof filas)[number]) => (f.cobertura === 'sin-monitoreo' ? null : f.eventos),
      mttr: (f: (typeof filas)[number]) => f.mttr_s,
      caido: (f: (typeof filas)[number]) => (f.cobertura === 'sin-monitoreo' ? null : f.caido_s),
    } as const;

    for (const orden of ['peor', 'eventos', 'mttr', 'caido'] as const) {
      const conDato = ordenar(filas, orden).map((f) => claves[orden](f) != null);
      // Una vez que aparece el primer `false`, no puede volver a haber un `true`.
      expect(conDato.indexOf(false) === -1 || !conDato.slice(conDato.indexOf(false)).includes(true))
        .toBe(true);
      // Y el que no se monitorea nunca es el primero.
      expect(ordenar(filas, orden)[0].equipo, `orden ${orden}`).not.toBe('apagado');
    }
  });

  it('no muta la lista original', () => {
    const antes = filas.map((f) => f.equipo);
    ordenar(filas, 'peor');
    expect(filas.map((f) => f.equipo)).toEqual(antes);
  });

  it('alfabético en es-AR', () => {
    expect(ordenar(filas, 'nombre').map((f) => f.equipo)).toEqual([
      'apagado',
      'no vuelve',
      'parpadea',
      'sano',
    ]);
  });
});

describe('resumir y agrupar por mapa', () => {
  const filas = construirFilas(
    [
      crudo({ device_id: 1, mapa_id: 10, mapa: 'Norte', eventos: 1, caido_s: 86_400 }),
      crudo({ device_id: 2, mapa_id: 10, mapa: 'Norte' }),
      crudo({ device_id: 3, mapa_id: 20, mapa: 'Sur', visto_desde: AHORA }),
      crudo({ device_id: 4, mapa_id: null, mapa: null, servicios: 0, visto_desde: null }),
    ],
    VENTANA,
  );

  it('el promedio se calcula SÓLO sobre lo medible', () => {
    const r = resumir(filas);
    expect(r.equipos).toBe(4);
    expect(r.medibles).toBe(3);
    expect(r.sinMonitoreo).toBe(1);
    expect(r.supuestos).toBe(1);
    // El no monitoreado no arrastra el promedio ni para arriba ni para abajo.
    expect(r.disponibilidad).toBeGreaterThan(90);
    expect(r.disponibilidad).toBeLessThan(100);
  });

  it('cuenta los perfectos y los que no llegan a 99 %', () => {
    const r = resumir(filas);
    expect(r.perfectos).toBe(2);
    expect(r.bajo_99).toBe(1);
  });

  it('los equipos sin mapa no desaparecen: caen en su propio grupo', () => {
    const grupos = agruparPorMapa(filas);
    const sinMapa = grupos.find((g) => g.mapa_id === null)!;
    expect(sinMapa.mapa).toBe('Sin mapa');
    expect(sinMapa.equipos).toBe(1);
    expect(sinMapa.disponibilidad).toBeNull();
  });

  it('la suma de los grupos es el total: ningún equipo se cuenta dos veces', () => {
    const grupos = agruparPorMapa(filas);
    expect(grupos.reduce((t, g) => t + g.equipos, 0)).toBe(filas.length);
  });

  it('el peor mapa va primero, y el que no tiene nada medible va último', () => {
    const grupos = agruparPorMapa(filas);
    expect(grupos[0].mapa).toBe('Norte');
    expect(grupos.at(-1)!.mapa).toBe('Sin mapa');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El CSV
// ─────────────────────────────────────────────────────────────────────────────

describe('CSV', () => {
  it('🔴 desactiva las fórmulas: un nombre de equipo no puede ejecutar nada', () => {
    // Los nombres los escribe una persona en The Dude. Un `=` inicial lo
    // interpreta Excel como fórmula al abrir el archivo.
    expect(campoCsv('=1+1')).toBe("'=1+1");
    expect(campoCsv('-2')).toBe("'-2");
    expect(campoCsv('@SUM(A1)')).toBe("'@SUM(A1)");
    // Con comillas adentro se aplican las dos cosas: apóstrofo y entrecomillado.
    expect(campoCsv('+HYPERLINK("x")')).toBe('"\'+HYPERLINK(""x"")"');
  });

  it('entrecomilla lo que llevaría el separador adentro', () => {
    expect(campoCsv('Torre; Norte')).toBe('"Torre; Norte"');
    expect(campoCsv('dice "hola"')).toBe('"dice ""hola"""');
    expect(campoCsv('dos\nlíneas')).toBe('"dos\nlíneas"');
  });

  it('un nombre común pasa sin adornos', () => {
    expect(campoCsv('BR_Core_01')).toBe('BR_Core_01');
    expect(campoCsv(null)).toBe('');
  });

  it('números con coma decimal y sin dato en blanco, nunca en cero', () => {
    expect(numeroCsv(99.6675)).toBe('99,668');
    expect(numeroCsv(3600, 0)).toBe('3600');
    expect(numeroCsv(null)).toBe('');
    expect(numeroCsv(undefined)).toBe('');
  });

  it('arranca con BOM y separa con punto y coma: es lo que abre bien Excel es-AR', () => {
    const csv = aCsv([['a', 'b'], [1, 2]]);
    expect(csv.startsWith(BOM_UTF8)).toBe(true);
    expect(csv).toContain('a;b\r\n');
  });

  it('el archivo lleva su propio contexto: período, horizonte y el aviso', () => {
    const ventana = recortarAlHorizonte(
      { desde: inicioDelDia('2026-06-01')!, hasta: AHORA },
      HORIZONTE,
      AHORA,
    );
    const csv = reporteCsv(
      construirFilas([crudo({ device_id: 7, equipo: 'RT_Borde' })], ventana),
      ventana,
      AHORA,
    );

    expect(csv).toContain('Reporte de disponibilidad');
    expect(csv).toContain('2026-06-12');
    expect(csv).toContain('AVISO');
    expect(csv).toContain('11 días');
    // Y las columnas que hacen defendible el número.
    expect(csv).toContain('Cobertura');
    expect(csv).toContain('Días observados');
    expect(csv).toContain('RT_Borde');
  });

  it('el nombre del archivo lleva la ventana REAL, no la pedida', () => {
    const ventana = recortarAlHorizonte(
      { desde: inicioDelDia('2026-01-01')!, hasta: finDelDia('2026-07-31')! },
      HORIZONTE,
      AHORA,
    );
    expect(nombreArchivoCsv(ventana)).toBe('disponibilidad-2026-06-12_2026-07-31.csv');
  });

  it('un equipo sin porcentaje deja la celda vacía, no un cero', () => {
    const csv = reporteCsv(
      construirFilas(
        [crudo({ device_id: 8, equipo: 'apagado', servicios: 0, visto_desde: null })],
        VENTANA,
      ),
      VENTANA,
      AHORA,
    );
    const fila = csv.split('\r\n').find((l) => l.startsWith('apagado'))!;
    const celdas = fila.split(';');
    expect(celdas[2]).toBe('');
    expect(celdas[3]).toBe('No se monitorea');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Con base: lo que sólo se puede probar ejecutando la SQL
// ─────────────────────────────────────────────────────────────────────────────

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();
const conBase = describe.skipIf(!hayBase);

/**
 * En CI saltear no es una opción: un verde que no ejecutó nada se ve igual que
 * un verde que ejecutó todo. Mismo criterio que `consultas.test.ts`.
 */
const EN_CI = !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0';

describe('entorno de los tests de base de datos', () => {
  it.runIf(EN_CI)('en CI la base es obligatoria', () => {
    expect({
      hay_TEST_DATABASE_URL_o_DATABASE_URL: Boolean(URL_BASE),
      hay_psql_en_el_PATH: tienePsql(),
    }).toEqual({ hay_TEST_DATABASE_URL_o_DATABASE_URL: true, hay_psql_en_el_PATH: true });
  });
});

let q: typeof import('@/lib/consultas');
let db: typeof import('@/lib/db');

/**
 * El escenario. Ventana de referencia: 100 h que arrancan en `T0`.
 *
 * Se arma a mano y no se reusa el de `seed-dev.sql` porque acá hacen falta
 * casos EXACTOS —una caída que se solapa con otra por 30 min, otra que cruza el
 * borde de la ventana— y el seed está pensado para que la pantalla se vea bien,
 * no para que las cuentas den redondas.
 *
 * Las direcciones son de RFC 5737 y las MAC de RFC 7042: ver `seed.test.ts`,
 * que barre el repositorio buscando cualquier cosa con forma de dirección real.
 */
const T0 = '2026-05-01 00:00:00+00';
const T_FIN = '2026-05-05 04:00:00+00'; // T0 + 100 h
const VENTANA_S = 100 * 3600;

const FIXTURE = `
INSERT INTO devices (id, name, addresses, dns_names, macs, type_id, snmp_profile_id,
                     router_os, probe_enabled, probe_interval, probe_timeout,
                     probe_down_count, dude_server, status)
VALUES
  (990001, 'ZZTEST solape',     '{192.0.2.101}', NULL, '{00:00:5E:00:53:A1}', NULL, NULL, false, true, 60, 2000, 3, false, 1),
  (990002, 'ZZTEST borde',      '{192.0.2.102}', NULL, '{00:00:5E:00:53:A2}', NULL, NULL, false, true, 60, 2000, 3, false, 1),
  (990003, 'ZZTEST abierta',    '{192.0.2.103}', NULL, '{00:00:5E:00:53:A3}', NULL, NULL, false, true, 60, 2000, 3, false, 3),
  (990004, 'ZZTEST debaja',     '{192.0.2.104}', NULL, '{00:00:5E:00:53:A4}', NULL, NULL, false, false, 60, 2000, 3, false, NULL),
  (990005, 'ZZTEST nomonitor',  '{192.0.2.105}', NULL, '{00:00:5E:00:53:A5}', NULL, NULL, false, false, 60, 2000, 3, false, NULL),
  (990006, 'ZZTEST nuevo',      '{192.0.2.106}', NULL, '{00:00:5E:00:53:A6}', NULL, NULL, false, true, 60, 2000, 3, false, 1),
  (990007, 'ZZTEST perfecto',   '{192.0.2.107}', NULL, '{00:00:5E:00:53:A7}', NULL, NULL, false, true, 60, 2000, 3, false, 1);

-- Servicios. \`time_since_changed\` es el único instante real de la tabla, y es
-- la constancia de monitoreo: los que vienen de 2024 prueban que ya se los
-- miraba antes de la ventana; 'ZZTEST nuevo' cambió DENTRO y no prueba nada.
INSERT INTO services (id, device_id, probe_id, status, enabled, acked, probes_down,
                      probe_interval, probe_timeout, probe_port,
                      time_last_up, time_last_down, time_since_changed)
VALUES
  (990101, 990001, 701, 1, true,  false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint),
  (990102, 990001, 701, 1, true,  false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint),
  (990103, 990002, 701, 1, true,  false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint),
  -- Reconocida (silenciada). Su caída tiene que contar IGUAL.
  (990104, 990003, 701, 3, true,  true,  9, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint),
  -- Deshabilitado: el equipo tuvo caídas y después le sacaron el monitoreo.
  (990105, 990004, 701, 1, false, false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint),
  (990106, 990006, 701, 1, true,  false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2026-05-03 00:00:00+00')::bigint),
  (990107, 990007, 701, 1, true,  false, 0, 60, 2000, NULL, 0, 0, extract(epoch FROM timestamptz '2024-01-01 00:00:00+00')::bigint);

INSERT INTO outages (service_id, device_id, started_at, ended_at, duration_s) VALUES
  -- 990001: dos sondas, dos caídas que se pisan 30 min.
  --   10:00–12:00 y 11:30–13:00  →  UN episodio de 3 h, no dos de 2 h y 1,5 h.
  (990101, 990001, '2026-05-01 10:00:00+00', '2026-05-01 12:00:00+00', 7200),
  (990102, 990001, '2026-05-01 11:30:00+00', '2026-05-01 13:00:00+00', 5400),
  -- 990002: una caída que empieza ANTES de la ventana y otra que la termina
  -- después. Sólo tienen que aportar su parte de adentro: 1 h + 1 h.
  (990103, 990002, '2026-04-30 23:00:00+00', '2026-05-01 01:00:00+00', 7200),
  (990103, 990002, '2026-05-05 03:00:00+00', '2026-05-05 06:00:00+00', 10800),
  -- 990003: sin cerrar. Se mide contra el fin de la ventana: 4 h.
  (990104, 990003, '2026-05-05 00:00:00+00', NULL, NULL),
  -- 990004: caída real, pero hoy ya no se lo monitorea.
  (990105, 990004, '2026-05-02 00:00:00+00', '2026-05-02 02:00:00+00', 7200),
  -- 990006: dado de alta en el medio; una caída de 1 h.
  (990106, 990006, '2026-05-03 06:00:00+00', '2026-05-03 07:00:00+00', 3600);
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

conBase('crudoDisponibilidad contra PostgreSQL', () => {
  let porNombre: Map<string, CrudoDisponibilidad>;

  beforeAll(async () => {
    const filas = await q.crudoDisponibilidad({
      desde: new Date(T0),
      hasta: new Date(T_FIN),
      q: 'ZZTEST',
    });
    porNombre = new Map(filas.map((f) => [f.equipo, f]));
  });

  it('devuelve los siete equipos del escenario y ninguno más', () => {
    expect([...porNombre.keys()].sort()).toEqual([
      'ZZTEST abierta',
      'ZZTEST borde',
      'ZZTEST debaja',
      'ZZTEST nomonitor',
      'ZZTEST nuevo',
      'ZZTEST perfecto',
      'ZZTEST solape',
    ]);
  });

  it('🔴 range_agg une las caídas solapadas: 3 h de reloj, no 3,5 h sumadas', () => {
    const f = porNombre.get('ZZTEST solape')!;
    expect(f.caidas_servicio).toBe(2);
    expect(f.eventos).toBe(1);
    expect(Number(f.caido_s)).toBe(3 * 3600);
    // La suma ingenua de `duration_s` habría dado 12.600 s.
    expect(Number(f.caido_s)).not.toBe(7200 + 5400);
  });

  it('recorta contra los dos bordes de la ventana', () => {
    const f = porNombre.get('ZZTEST borde')!;
    expect(f.eventos).toBe(2);
    // De 2 h antes del arranque entra 1 h; de 3 h después del fin, otra hora.
    expect(Number(f.caido_s)).toBe(2 * 3600);
  });

  it('una caída sin cerrar se mide hasta el fin de la ventana', () => {
    const f = porNombre.get('ZZTEST abierta')!;
    expect(f.abiertas).toBe(1);
    expect(Number(f.caido_s)).toBe(4 * 3600);
  });

  it('🔴 una caída reconocida cuenta igual que cualquier otra', () => {
    // El servicio 990104 está `acked`. Si el filtro existiera, este equipo
    // saldría con cero.
    const f = porNombre.get('ZZTEST abierta')!;
    expect(f.reconocidos).toBe(1);
    expect(f.eventos).toBe(1);
    expect(Number(f.caido_s)).toBeGreaterThan(0);
  });

  it('un equipo sin caídas viene en cero, no ausente', () => {
    const f = porNombre.get('ZZTEST perfecto')!;
    expect(f.eventos).toBe(0);
    expect(Number(f.caido_s)).toBe(0);
    expect(f.servicios).toBe(1);
  });

  it('el que perdió el monitoreo conserva su historia', () => {
    const f = porNombre.get('ZZTEST debaja')!;
    expect(f.servicios).toBe(0);
    expect(f.eventos).toBe(1);
    expect(Number(f.caido_s)).toBe(2 * 3600);
  });

  it('el que nunca tuvo servicios no inventa nada', () => {
    const f = porNombre.get('ZZTEST nomonitor')!;
    expect(f.servicios).toBe(0);
    expect(f.eventos).toBe(0);
    expect(f.visto_desde).toBeNull();
  });
});

conBase('el reporte completo, de la SQL al porcentaje', () => {
  let filas: Map<string, ReturnType<typeof construirFilas>[number]>;
  let ventana: Ventana;

  beforeAll(async () => {
    ventana = recortarAlHorizonte(
      { desde: new Date(T0), hasta: new Date(T_FIN) },
      null,
      new Date(T_FIN),
    );
    const crudas = await q.crudoDisponibilidad({
      desde: ventana.desde,
      hasta: ventana.hasta,
      q: 'ZZTEST',
    });
    filas = new Map(construirFilas(crudas, ventana).map((f) => [f.equipo, f]));
  });

  it('la ventana es la que dice ser', () => {
    expect(ventana.segundos).toBe(VENTANA_S);
  });

  it('3 h caído sobre 100 h son 97 % exactos', () => {
    const f = filas.get('ZZTEST solape')!;
    expect(f.disponibilidad).toBeCloseTo(97, 10);
    expect(f.mttr_s).toBe(3 * 3600);
    expect(f.mtbf_s).toBe(97 * 3600);
    expect(f.cobertura).toBe('confirmada');
  });

  it('el perfecto llega a 100 % y no tiene MTBF que informar', () => {
    const f = filas.get('ZZTEST perfecto')!;
    expect(f.disponibilidad).toBe(100);
    expect(f.mtbf_s).toBeNull();
    expect(f.mttr_s).toBeNull();
  });

  it('🔴 el que se dio de alta en el medio queda marcado «sin verificar»', () => {
    // Su porcentaje sale —99 %— pero la fila avisa que la constancia de
    // monitoreo empieza el 3 de mayo, no el 1.
    const f = filas.get('ZZTEST nuevo')!;
    expect(f.cobertura).toBe('supuesta');
    expect(f.disponibilidad).toBeCloseTo(99, 10);
    expect(COBERTURAS[f.cobertura].conPorcentaje).toBe(true);
  });

  it('🔴 el que no se monitorea NO figura con 100 %', () => {
    const f = filas.get('ZZTEST nomonitor')!;
    expect(f.cobertura).toBe('sin-monitoreo');
    expect(f.disponibilidad).toBeNull();
  });

  it('🔴 el dado de baja informa sus caídas y NINGÚN porcentaje', () => {
    const f = filas.get('ZZTEST debaja')!;
    expect(f.cobertura).toBe('historica');
    expect(f.disponibilidad).toBeNull();
    expect(f.eventos).toBe(1);
    expect(f.caido_s).toBe(2 * 3600);
  });

  it('el resumen del escenario cierra a mano', () => {
    const r = resumir([...filas.values()]);
    expect(r.equipos).toBe(7);
    // Cinco con porcentaje: solape, borde, abierta, nuevo y perfecto.
    expect(r.medibles).toBe(5);
    expect(r.historicos).toBe(1);
    expect(r.sinMonitoreo).toBe(1);
    // 3 h + 2 h + 4 h (medibles) + 1 h (nuevo) + 2 h (dado de baja) = 12 h.
    expect(r.caido_s).toBe(12 * 3600);
    expect(r.abiertas).toBe(1);
  });
});

conBase('horizonteDatos', () => {
  it('sale de la base y no de una constante escrita a mano', async () => {
    const h = await q.horizonteDatos();
    expect(h).toBeInstanceOf(Date);
    // El seed genera historia relativa a `now()`; lo que importa es que haya un
    // instante real y que sea anterior a lo que se pueda pedir hoy.
    expect(h!.getTime()).toBeLessThanOrEqual(Date.now());
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

describe('«Todo» arranca en el primer dato, no en una fecha inventada', () => {
  it('con el horizonte a mano no queda nada que recortar', () => {
    const r = resolverPeriodo({ periodo: 'todo' }, AHORA, HORIZONTE);
    expect(r.desde).toEqual(HORIZONTE);
    const v = recortarAlHorizonte(r, HORIZONTE, AHORA);
    // 🔴 Sin esto el aviso del reporte decía «se recortaron 9.659 días», que es
    //    cierto contra el centinela del año 2000 y no significa nada para quien
    //    lo lee: nadie pidió el año 2000, pidió «todo lo que haya».
    expect(v.dias_recortados).toBe(0);
    expect(reporteCsv([], v, AHORA)).not.toContain('AVISO');
  });

  it('sin horizonte igual da la ventana correcta, sólo con el aviso feo', () => {
    const r = resolverPeriodo({ periodo: 'todo' }, AHORA);
    expect(recortarAlHorizonte(r, HORIZONTE, AHORA).desde).toEqual(HORIZONTE);
  });
});

describe('el separador manda sobre el entrecomillado', () => {
  it('un decimal con coma NO se entrecomilla: el separador es punto y coma', () => {
    expect(campoCsv('99,667')).toBe('99,667');
    expect(numeroCsv(50.23, 2)).toBe('50,23');
  });

  it('pero un punto y coma adentro del nombre sí', () => {
    expect(campoCsv('Torre; Norte')).toBe('"Torre; Norte"');
  });
});
