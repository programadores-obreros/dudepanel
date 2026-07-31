import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
    const p = await q.listarDispositivos({ texto: '192.0.2.22' });
    expect(p.filas.length).toBeGreaterThan(0);
    expect(p.filas.every((d) => d.direcciones.some((a) => a.startsWith('192.0.2.22')))).toBe(true);
  });

  it('busca por nombre parcial, sin importar mayúsculas', async () => {
    const p = await q.listarDispositivos({ texto: 'alvear' });
    expect(p.filas.length).toBeGreaterThan(0);
    expect(p.filas.every((d) => /alvear/i.test(d.nombre))).toBe(true);
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
    expect(d!.macs).toContain('02:00:00:00:00:01');
  });

  it('no expone ninguna columna de credenciales', async () => {
    // Contrato del proyecto: el ETL no las lee y el panel no las tiene. Este
    // test existe para que nadie las agregue "por conveniencia".
    const d = await q.obtenerDispositivo(105)!;
    const prohibidas = ['user', 'pwd', 'password', 'community', 'snmp_community', 'secret'];
    for (const k of Object.keys(d as object)) {
      expect(prohibidas).not.toContain(k.toLowerCase());
    }
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
    // CPE_Alvear_0031 → AC1 → SW_Alvear → RT_Alvear_Torre → RT_Core_B → BR → WAN
    const ps = await q.cadenaDePadres(122);
    expect(ps.map((p) => p.nombre)).toContain('WAN_Fibertel_Principal');
    expect(ps[0]!.nombre).toBe('Vega_P_Alvear_AC1');
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
    expect(hs.map((h) => h.nombre).sort()).toEqual(['CPE_Alvear_0031', 'CPE_Alvear_0058']);
  });
});

conBase('mapasDeDispositivo', () => {
  it('dice en qué mapas aparece', async () => {
    const ms = await q.mapasDeDispositivo(121);
    expect(ms.map((m) => m.nombre)).toContain('Zona Sur — Alvear');
  });
});

// ── Búsqueda ────────────────────────────────────────────────────────────────

conBase('buscar', () => {
  it('encuentra por nombre', async () => {
    const rs = await q.buscar('Aurora');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.every((r) => /ponte/i.test(r.nombre) || /ponte/i.test(r.detalle ?? ''))).toBe(true);
  });

  it('encuentra por IP con el MISMO campo', async () => {
    // El operador que llega con un ticket no sabe si tiene el nombre o la IP.
    const rs = await q.buscar('192.0.2.186');
    expect(rs[0]!.nombre).toBe('CPE_Alvear_0031');
  });

  it('prioriza la coincidencia de IP por prefijo', async () => {
    const rs = await q.buscar('192.0.2.11');
    expect(rs.length).toBeGreaterThan(0);
    expect(rs[0]!.detalle).toMatch(/^10\.227\.11/);
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
