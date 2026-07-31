import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { construirLienzo } from '@/lib/mapa';

/**
 * Capa de datos contra PostgreSQL de verdad.
 *
 * No se usan dobles: el valor de estos tests está justamente en que la SQL se
 * ejecute. Un mock de `pg` verificaría que escribimos la cadena que esperamos
 * escribir, que es exactamente lo que ya sabemos.
 *
 * Necesita `TEST_DATABASE_URL` (o `DATABASE_URL`) apuntando a una base
 * DESECHABLE: el arranque le aplica el esquema y el seed, borrando lo que haya.
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=x -e POSTGRES_USER=dude \
 *     -e POSTGRES_DB=dudepanel -p 55433:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://dude:x@localhost:55433/dudepanel pnpm test
 */

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();

// `describe.skipIf` en vez de fallar: quien clona el repo y corre los tests sin
// Docker levantado merece un aviso, no un rojo que no dice nada.
const conBase = describe.skipIf(!hayBase);

/**
 * En CI, saltear NO es una opción.
 *
 * 🔴 `skipIf` hace desaparecer estos tests sin base y la corrida sale VERDE.
 *    Para el que clona el repo eso está bien. En CI es una mentira: un verde
 *    que no ejecutó nada se ve igual que un verde que ejecutó todo, y así una
 *    base mal configurada pasa por «todo en orden» durante meses.
 *
 * Vitest resuelve `runIf` al recolectar, así que si esto falla es lo único
 * rojo y el mensaje dice exactamente qué falta.
 */
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

beforeAll(async () => {
  if (!hayBase) return;
  process.env.DATABASE_URL = URL_BASE;

  const raiz = resolve(__dirname, '..');
  const esquema = resolve(raiz, '../etl/schema.sql');
  const seed = resolve(raiz, 'seed-dev.sql');
  if (!existsSync(esquema)) throw new Error(`No está ${esquema}`);

  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', esquema]);
  psql(['-v', 'ON_ERROR_STOP=1', '-q', '-f', seed]);

  q = await import('@/lib/consultas');
  db = await import('@/lib/db');
}, 60_000);

afterAll(async () => {
  await db?.cerrarPool();
});

// ── Sincronización ──────────────────────────────────────────────────────────

conBase('ultimaSincronizacion / saludSync', () => {
  it('devuelve la corrida más reciente', async () => {
    const s = await q.ultimaSincronizacion();
    expect(s).not.toBeNull();
    expect(s!.ok).toBe(true);
    expect(s!.user_version).toBe(1);
    expect(s!.edad_s).toBeLessThan(60);
  });

  it('una corrida reciente está fresca', () => {
    expect(q.saludSync({ edad_s: 10, ok: true } as never)).toBe('fresca');
  });

  // Este es el corazón del requisito: el panel tiene que poder decir
  // "no tengo datos frescos" en vez de "todo bien".
  it('el paso del tiempo escala el aviso', () => {
    expect(q.saludSync({ edad_s: q.UMBRAL_DEMORADA + 1, ok: true } as never)).toBe('demorada');
    expect(q.saludSync({ edad_s: q.UMBRAL_VIEJA + 1, ok: true } as never)).toBe('vieja');
  });

  it('una corrida fallida es fallida aunque sea de recién', () => {
    expect(q.saludSync({ edad_s: 1, ok: false } as never)).toBe('fallida');
  });

  it('sin ninguna corrida NO se reporta como sana', () => {
    expect(q.saludSync(null)).toBe('sin-datos');
  });
});

// ── Resumen ─────────────────────────────────────────────────────────────────

conBase('resumenRed', () => {
  it('los estados suman el total de equipos', async () => {
    const r = await q.resumenRed();
    const { total, arriba, parcial, caidos, desconocidos } = r.equipos;
    expect(arriba + parcial + caidos + desconocidos).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it('los estados suman el total de servicios', async () => {
    const { total, arriba, parcial, caidos, desconocidos } = (await q.resumenRed()).servicios;
    expect(arriba + parcial + caidos + desconocidos).toBe(total);
  });

  it('los contadores llegan como números, no como cadenas', async () => {
    // `count()` es bigint y node-pg lo devuelve como string si no se registra
    // el parser. Sin esto, `caidos > 0` sería siempre verdadero.
    const r = await q.resumenRed();
    expect(typeof r.equipos.total).toBe('number');
    expect(typeof r.caidas_abiertas).toBe('number');
  });

  it('hay caídas abiertas para los equipos caídos del seed', async () => {
    const r = await q.resumenRed();
    expect(r.caidas_abiertas).toBeGreaterThan(0);
  });
});

// ── Caídas ──────────────────────────────────────────────────────────────────

conBase('caidasRecientes', () => {
  it('pone las abiertas primero', async () => {
    const cs = await q.caidasRecientes(20);
    const primeraCerrada = cs.findIndex((c) => !c.abierta);
    if (primeraCerrada >= 0) {
      expect(cs.slice(primeraCerrada).every((c) => !c.abierta)).toBe(true);
    }
  });

  it('una caída abierta trae la duración calculada, no null', async () => {
    const abierta = (await q.caidasRecientes(20)).find((c) => c.abierta);
    expect(abierta).toBeDefined();
    expect(abierta!.duracion_s).toBeGreaterThan(0);
    expect(abierta!.fin).toBeNull();
  });

  it('respeta el límite', async () => {
    expect(await q.caidasRecientes(3)).toHaveLength(3);
  });

  it('trae el nombre del equipo y el de la sonda', async () => {
    const c = (await q.caidasRecientes(5))[0]!;
    expect(c.equipo).toBeTruthy();
    expect(c.sonda).toBeTruthy();
  });
});

// ── Mapas ───────────────────────────────────────────────────────────────────

conBase('listarMapas', () => {
  it('ordena los rotos primero', async () => {
    const ms = await q.listarMapas();
    expect(ms.length).toBeGreaterThan(0);
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i - 1]!.caidos).toBeGreaterThanOrEqual(ms[i]!.caidos);
    }
  });

  it('cuenta los elementos de cada mapa', async () => {
    const nucleo = (await q.listarMapas()).find((m) => m.nombre.includes('Núcleo'));
    expect(nucleo!.elementos).toBeGreaterThan(10);
    expect(nucleo!.submapas).toBe(2);
  });

  it('un mapa vacío aparece igual, con cero elementos', async () => {
    // En The Dude hay mapas sin elementos. Esconderlos haría creer que el join
    // está roto; mostrarlos en cero dice la verdad.
    const vacio = (await q.listarMapas()).find((m) => m.nombre.includes('vacío'));
    expect(vacio).toBeDefined();
    expect(vacio!.elementos).toBe(0);
  });
});

conBase('lienzoMapa', () => {
  it('trae geometría, nombre y estado en una sola consulta', async () => {
    const es = await q.lienzoMapa(1001);
    expect(es.length).toBeGreaterThan(10);
    const nodo = es.find((e) => e.kind === 'device')!;
    expect(nodo.x).toBeTypeOf('number');
    expect(nodo.name).toBeTruthy();
    expect(nodo.status).toBeTypeOf('number');
  });

  it('las direcciones vienen como texto, listas para mostrar', async () => {
    // Se piden con `host()` y no como `inet[]` crudo para no depender de cómo
    // parsee arrays de inet la versión de node-pg que esté instalada.
    const con = (await q.lienzoMapa(1001)).find((e) => (e.direcciones?.length ?? 0) > 0)!;
    expect(Array.isArray(con.direcciones)).toBe(true);
    expect(con.direcciones![0]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('los enlaces vienen antes que los nodos, para quedar debajo al dibujar', async () => {
    const es = await q.lienzoMapa(1001);
    const ultimoEnlace = es.map((e) => e.kind).lastIndexOf('link');
    const primerNodo = es.findIndex((e) => e.kind !== 'link');
    expect(ultimoEnlace).toBeLessThan(primerNodo);
  });

  it('un mapa inexistente devuelve vacío, no error', async () => {
    expect(await q.lienzoMapa(999_999)).toEqual([]);
  });
});

conBase('enlacesFueraDelMapa', () => {
  // El silencio es el peligro: si el visor dibuja 107 líneas donde hay 308
  // enlaces y no dice nada, el operador lee una red menos conectada de la que
  // tiene. Esta consulta es la que le permite decirlo, y distinguir los dos
  // motivos, que no son lo mismo.
  it('separa "está en otro mapa" de "ya no existe"', async () => {
    const f = await q.enlacesFueraDelMapa(1001);
    expect(f.otroMapa).toBe(1);
    expect(f.rotos).toBe(1);
  });

  it('dice a QUÉ mapa ir, que es lo que vuelve útil la carencia', async () => {
    const f = await q.enlacesFueraDelMapa(1001);
    expect(f.destinos).toHaveLength(1);
    expect(f.destinos[0]).toMatchObject({ id: 1002, nombre: 'Zona Norte — Aurora', enlaces: 1 });
  });

  it('un mapa con todo resuelto no reporta nada', async () => {
    const f = await q.enlacesFueraDelMapa(1003);
    expect(f).toMatchObject({ otroMapa: 0, rotos: 0, destinos: [] });
  });

  it('la cuenta cierra contra lo que el visor puede dibujar', async () => {
    // Es la invariante de la barra: total = dibujados + otroMapa + rotos.
    // Si deja de cerrar, el visor lo declara como "otro motivo" en vez de
    // esconderlo, pero acá queremos saberlo.
    const elementos = await q.lienzoMapa(1001);
    const l = construirLienzo(elementos, await q.estadoSubmapas(1001));
    const f = await q.enlacesFueraDelMapa(1001);
    expect(l.enlaces.length + f.otroMapa + f.rotos).toBe(l.enlacesTotales);
  });

  it('un mapa inexistente no explota', async () => {
    await expect(q.enlacesFueraDelMapa(999_999)).resolves.toMatchObject({
      otroMapa: 0,
      rotos: 0,
      destinos: [],
    });
  });
});

conBase('lienzoMapa + construirLienzo · las fichas anclan enlaces', () => {
  it('los enlaces que terminan en una ficha se dibujan', async () => {
    const l = construirLienzo(await q.lienzoMapa(1002));
    // 5162 y 5163 del seed van de un equipo a una ficha de anotación.
    const aFichas = l.enlaces.filter((e) => [5304, 5305].includes(e.a));
    expect(aFichas).toHaveLength(2);
  });

  it('las fichas de varias líneas llegan partidas y con el CR limpio', async () => {
    const l = construirLienzo(await q.lienzoMapa(1002));
    const ficha = l.rotulos.find((r) => r.id === 5304)!;
    expect(ficha.lineas).toEqual(['ether5', 'VLAN2211', 'Untagged']);
    expect(ficha.lineas.join('')).not.toContain('\r');
  });
});

conBase('estadoSubmapas y estadosDelMapa', () => {
  it('un submapa con un equipo caído adentro se reporta caído', async () => {
    const m = await q.estadoSubmapas(1001);
    // Zona Sur (1003) tiene varios equipos caídos en el seed.
    expect(m.get(1003)).toBe(3);
  });

  it('estadosDelMapa cubre equipos y submapas', async () => {
    const es = await q.estadosDelMapa(1001);
    const elementos = await q.lienzoMapa(1001);
    const conEstado = elementos.filter((e) => e.device_id != null || e.submap_id != null).length;
    expect(es).toHaveLength(conEstado);
    expect(es.every((e) => [0, 1, 2, 3].includes(e.s))).toBe(true);
  });
});

// ── Dispositivos ────────────────────────────────────────────────────────────

conBase('listarDispositivos', () => {
  it('sin filtros trae todo, paginado', async () => {
    const p = await q.listarDispositivos({ porPagina: 10 });
    expect(p.filas).toHaveLength(10);
    expect(p.total).toBeGreaterThan(10);
    expect(p.paginas).toBe(Math.ceil(p.total / 10));
  });

  it('filtra por estado', async () => {
    const p = await q.listarDispositivos({ estado: 3 });
    expect(p.filas.length).toBeGreaterThan(0);
    expect(p.filas.every((d) => d.status === 3)).toBe(true);
  });

  it('el orden por defecto pone los caídos arriba', async () => {
    const p = await q.listarDispositivos({ porPagina: 100 });
    expect(p.filas[0]!.status).toBe(3);
  });

  it('busca por prefijo de IP', async () => {
    const p = await q.listarDispositivos({ texto: '203.0.113' });
    expect(p.filas.length).toBeGreaterThan(0);
    expect(p.filas.every((d) => d.direcciones.some((a) => a.startsWith('203.0.113')))).toBe(true);
  });

  it('busca por nombre parcial, sin importar mayúsculas', async () => {
    const p = await q.listarDispositivos({ texto: 'bahia' });
    expect(p.filas.length).toBeGreaterThan(0);
    expect(p.filas.every((d) => /bahia/i.test(d.nombre))).toBe(true);
  });

  it('una columna de orden inventada no rompe ni inyecta', async () => {
    // El nombre de columna va concatenado en la SQL: si saliera de la entrada
    // del usuario sería una inyección. Se mapea contra una lista blanca.
    const p = await q.listarDispositivos({
      orden: 'nombre; DROP TABLE devices; --' as never,
      porPagina: 10,
    });
    expect(p.filas).toHaveLength(10);
    // Cae al orden por defecto: los caídos primero.
    expect(p.filas[0]!.status).toBe(3);
    expect((await q.resumenRed()).equipos.total).toBeGreaterThan(0);
  });

  it('una página más allá del final devuelve la última, no vacío', async () => {
    const p = await q.listarDispositivos({ pagina: 9999, porPagina: 10 });
    expect(p.pagina).toBe(p.paginas);
    expect(p.filas.length).toBeGreaterThan(0);
  });

  it('acota el tamaño de página', async () => {
    expect((await q.listarDispositivos({ porPagina: 100_000 })).porPagina).toBe(200);
    expect((await q.listarDispositivos({ porPagina: 1 })).porPagina).toBe(10);
  });

  it('combina filtros', async () => {
    const tipos = await q.tiposDeDispositivo();
    const cliente = tipos.find((t) => t.nombre === 'Cliente')!;
    const p = await q.listarDispositivos({ estado: 3, tipoId: cliente.id });
    expect(p.filas.every((d) => d.status === 3 && d.tipo === 'Cliente')).toBe(true);
  });
});

conBase('obtenerDispositivo', () => {
  it('trae la ficha completa', async () => {
    const d = await q.obtenerDispositivo(105);
    expect(d!.nombre).toBe('SRV_Dude_Monitor');
    expect(d!.direcciones).toContain('192.0.2.30');
    expect(d!.dude_server).toBe(true);
    expect(d!.macs).toContain('00:00:5E:00:53:20');
  });

  it('expone exactamente los campos acordados, ni uno más', async () => {
    // Lista CONGELADA. No está para documentar: está para que agregar un campo
    // al SELECT rompa el test y obligue a mirarlo. Si el campo nuevo
    // corresponde, se agrega acá y en la misma revisión se ve qué se sumó.
    const d = await q.obtenerDispositivo(105);
    expect(Object.keys(d!).sort()).toEqual(
      [
        'id', 'nombre', 'tipo', 'tipo_id', 'status', 'status_label',
        'direcciones', 'dns_names', 'macs', 'perfil_snmp', 'snmp_version',
        'router_os', 'probe_enabled', 'probe_interval', 'probe_timeout',
        'probe_down_count', 'dude_server', 'services_total', 'services_up',
        'services_down',
      ].sort(),
    );
  });

  it('devuelve null si no existe', async () => {
    expect(await q.obtenerDispositivo(999_999)).toBeNull();
  });
});

conBase('serviciosDe', () => {
  it('ordena los caídos primero', async () => {
    const ss = await q.serviciosDe(121);
    expect(ss.length).toBeGreaterThan(0);
    expect(ss[0]!.status).toBe(3);
  });

  it('trae el nombre de la sonda', async () => {
    expect((await q.serviciosDe(101)).some((s) => s.sonda === 'ping')).toBe(true);
  });
});

conBase('cadenaDePadres / hijosDe', () => {
  it('sube toda la cadena hasta la raíz', async () => {
    // CPE_Bahia_0031 → AC1 → SW_Bahia → RT_Bahia_Torre → RT_Core_B → BR → WAN
    const ps = await q.cadenaDePadres(122);
    expect(ps.map((p) => p.nombre)).toContain('WAN_Proveedor_Principal');
    expect(ps[0]!.nombre).toBe('Vega_P_Bahia_AC1');
    expect(ps[0]!.nivel).toBe(1);
  });

  it('los niveles crecen de forma monótona', async () => {
    const ps = await q.cadenaDePadres(122);
    for (let i = 1; i < ps.length; i++) {
      expect(ps[i]!.nivel).toBeGreaterThanOrEqual(ps[i - 1]!.nivel);
    }
  });

  it('una raíz no tiene padres', async () => {
    expect(await q.cadenaDePadres(100)).toEqual([]);
  });

  it('hijosDe devuelve los que cuelgan directamente', async () => {
    const hs = await q.hijosDe(120);
    expect(hs.map((h) => h.nombre).sort()).toEqual(['CPE_Bahia_0031', 'CPE_Bahia_0058']);
  });
});

conBase('mapasDeDispositivo', () => {
  it('dice en qué mapas aparece', async () => {
    const ms = await q.mapasDeDispositivo(121);
    expect(ms.map((m) => m.nombre)).toContain('Zona Sur — Bahia');
  });
});

// ── Búsqueda ────────────────────────────────────────────────────────────────

conBase('buscar', () => {
  it('encuentra por nombre', async () => {
    const rs = await q.buscar('Aurora');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((r) => /aurora/i.test(r.nombre) || /aurora/i.test(r.detalle ?? ''))).toBe(true);
  });

  it('encuentra por IP con el MISMO campo', async () => {
    // El operador que llega con un ticket no sabe si tiene el nombre o la IP.
    const rs = await q.buscar('203.0.113.31');
    expect(rs[0]!.nombre).toBe('CPE_Bahia_0031');
  });

  it('prioriza la coincidencia de IP por prefijo', async () => {
    const rs = await q.buscar('198.51.100');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.detalle).toMatch(/^198\.51\.100/);
  });

  it('encuentra mapas además de equipos', async () => {
    expect((await q.buscar('Zona')).some((r) => r.kind === 'map')).toBe(true);
  });

  it('con menos de dos caracteres no consulta nada', async () => {
    expect(await q.buscar('a')).toEqual([]);
    expect(await q.buscar('  ')).toEqual([]);
  });

  it('los caracteres especiales de SQL no rompen la consulta', async () => {
    await expect(q.buscar("'; DROP TABLE devices; --")).resolves.toBeInstanceOf(Array);
    await expect(q.buscar('100%')).resolves.toBeInstanceOf(Array);
    expect((await q.resumenRed()).equipos.total).toBeGreaterThan(0);
  });

  it('respeta el límite', async () => {
    expect((await q.buscar('1', 5)).length).toBeLessThanOrEqual(5);
    expect((await q.buscar('CPE', 3)).length).toBeLessThanOrEqual(3);
  });
});

// ── Fuga de datos ───────────────────────────────────────────────────────────

conBase('el panel no filtra lo que no consulta', () => {
  /**
   * Busca un VALOR, no un nombre de clave.
   *
   * 🔴 Acá había un test que comparaba las claves de la respuesta contra
   *    `['user','pwd','password','community',…]`. Las claves del panel son
   *    alias en castellano —`nombre`, `direcciones`, `perfil_snmp`— así que
   *    NUNCA iban a coincidir: el test no podía fallar. Un `sp.community AS
   *    clave_snmp` pasaba en verde.
   *
   *    El seed planta `CENTINELA-FUGA-9f3a1c7e` en `notifications.subject`,
   *    la única tabla con texto libre que el panel no consulta jamás. Si el
   *    valor aparece en alguna respuesta, alguien ensanchó un SELECT.
   */
  const CENTINELA = 'CENTINELA-FUGA-9f3a1c7e';

  it('el centinela está en la base — si no, el test no probaría nada', async () => {
    // Sin esto, borrar la fila del seed dejaría el test verde para siempre.
    const fila = await db.consultarUna<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE subject = $1`,
      [CENTINELA],
    );
    expect(fila!.n).toBe(1);
  });

  it('no sale por ninguna respuesta del panel', async () => {
    const respuestas = await Promise.all([
      q.ultimaSincronizacion(),
      q.resumenRed(),
      q.caidasRecientes(50),
      q.caidasDe(121, 50),
      q.listarMapas(),
      q.obtenerMapa(1001),
      q.lienzoMapa(1001),
      q.enlacesFueraDelMapa(1001),
      q.mapasDeDispositivo(121),
      q.listarDispositivos({ porPagina: 200 }),
      q.tiposDeDispositivo(),
      q.obtenerDispositivo(105),
      q.serviciosDe(105),
      q.cadenaDePadres(122),
      q.hijosDe(120),
      q.buscar('e', 100),
      q.buscar('CENTINELA', 100),
      q.buscar('9f3a1c7e', 100),
    ]);

    // Serializar y buscar el valor alcanza y sobra: recorre toda la estructura
    // sin importar en qué campo, a qué profundidad ni con qué nombre aparezca.
    const todo = JSON.stringify(respuestas, (_k, v) =>
      v instanceof Map ? Object.fromEntries(v) : v,
    );
    expect(todo).not.toContain(CENTINELA);
    expect(todo).not.toContain('9f3a1c7e');
  });
});

// ── Utilidades ──────────────────────────────────────────────────────────────

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
