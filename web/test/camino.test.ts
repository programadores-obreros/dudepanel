import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  agruparTramos,
  etiquetaDueno,
  frontera,
  reparto,
  textoCambio,
  textoMotivo,
  textoRtt,
  type SaltoCamino,
} from '@/lib/camino';

/**
 * La capa de presentación del camino de red.
 *
 * 🔴 Acá NO se prueba ninguna clasificación de rangos IP, y no es un olvido: en
 *    `web/` no hay ninguna. Quién es interno y quién es público lo decide
 *    `etl/camino.py` —el único lugar del sistema que puede mandar una dirección
 *    a un servicio externo— y `etl/test_camino.py` lo prueba con un espía sobre
 *    el resolutor DNS. Duplicar esa lógica acá crearía una segunda verdad que
 *    tarde o temprano diría otra cosa.
 *
 *    Lo que sí se prueba acá es que la pantalla no MIENTA sobre lo que recibió:
 *    que un salto mudo se muestre, que no se renumere el camino y que «primera
 *    traza» no se disfrace de «sin cambios».
 *
 * Las direcciones son de los rangos de documentación de la RFC 5737, que es lo
 * único que `test/seed.test.ts` permite escribir en `web/`.
 */

function salto(p: Partial<SaltoCamino> & { ttl: number }): SaltoCamino {
  return {
    direccion: null,
    rtt_ms: null,
    clase: 'mudo',
    asn: null,
    asn_org: null,
    asn_prefijo: null,
    asn_pais: null,
    icmp_tipo: null,
    icmp_codigo: null,
    ...p,
  };
}

const interno = (ttl: number, n: number) =>
  salto({ ttl, direccion: `192.0.2.${n}`, clase: 'interna', rtt_ms: 1.5 });

const publico = (ttl: number, n: number, asn: number | null, org: string | null = null) =>
  salto({
    ttl,
    direccion: `198.51.100.${n}`,
    clase: 'publica',
    rtt_ms: 12.5,
    asn,
    asn_org: org,
  });

const mudo = (ttl: number) => salto({ ttl });

describe('etiquetaDueno', () => {
  it('un salto que no contestó lo dice, no queda en blanco', () => {
    expect(etiquetaDueno(mudo(3))).toBe('no contestó');
  });

  it('un público sin ASN publicado NO se muestra como si no lo hubiéramos mirado', () => {
    // 🔴 Medido el 01/08/2026: de los 4 saltos públicos de una traza real, uno
    //    no tenía origen publicado. Es un caso legítimo y hay que nombrarlo.
    expect(etiquetaDueno(publico(6, 1, null))).toBe('público, sin ASN publicado');
  });

  it('con ASN y organización muestra los dos', () => {
    expect(etiquetaDueno(publico(7, 2, 64500, 'EJEMPLO - Nadie'))).toBe(
      'AS64500 · EJEMPLO - Nadie',
    );
  });

  it('con ASN pero sin nombre no inventa el nombre', () => {
    expect(etiquetaDueno(publico(7, 2, 64500))).toBe('AS64500');
  });

  it('una dirección especial no se disfraza de red interna', () => {
    expect(etiquetaDueno(salto({ ttl: 1, direccion: '203.0.113.1', clase: 'especial' })))
      .toBe('dirección especial');
  });
});

describe('agruparTramos', () => {
  it('junta los saltos internos consecutivos en un solo tramo', () => {
    const t = agruparTramos([interno(1, 1), interno(2, 2), interno(3, 3)]);
    expect(t).toHaveLength(1);
    expect(t[0]!.titulo).toBe('Red del ISP');
    expect(t[0]!.propio).toBe(true);
    expect(t[0]!.saltos).toHaveLength(3);
  });

  it('dos operadores distintos son dos tramos', () => {
    const t = agruparTramos([
      publico(1, 1, 64500, 'Uno'),
      publico(2, 2, 64500, 'Uno'),
      publico(3, 3, 64501, 'Otro'),
    ]);
    expect(t.map((x) => x.asn)).toEqual([64500, 64501]);
    expect(t.map((x) => x.saltos.length)).toEqual([2, 1]);
  });

  it('🔴 no pierde ni un salto: los tramos suman exactamente la entrada', () => {
    const entrada = [interno(1, 1), mudo(2), interno(3, 3), mudo(4), publico(5, 1, 64500)];
    const t = agruparTramos(entrada);
    expect(t.flatMap((x) => x.saltos.map((s) => s.ttl))).toEqual([1, 2, 3, 4, 5]);
  });

  it('el tramo mudo se muestra como tal y no se atribuye a nadie', () => {
    const t = agruparTramos([interno(1, 1), mudo(2), publico(3, 1, 64500, 'Uno')]);
    expect(t.map((x) => x.titulo)).toEqual(['Red del ISP', 'sin respuesta', 'Uno']);
    // 🔴 Un mudo NO es «propio»: no sabemos de quién es.
    expect(t[1]!.propio).toBe(false);
  });

  it('una lista vacía no explota', () => {
    expect(agruparTramos([])).toEqual([]);
  });
});

describe('frontera', () => {
  it('es el primer salto que contestó y no es nuestro', () => {
    expect(frontera([interno(1, 1), interno(2, 2), publico(3, 1, 64500)])).toBe(3);
  });

  it('🔴 un salto mudo NO marca la frontera', () => {
    // No sabemos de quién es. Poner la línea ahí sería inventar justo el dato
    // que el operador va a usar para decidir a quién llamar.
    expect(frontera([interno(1, 1), mudo(2), publico(3, 1, 64500)])).toBe(3);
  });

  it('si nunca salimos de la red, no hay frontera', () => {
    expect(frontera([interno(1, 1), interno(2, 2)])).toBeNull();
  });

  it('un camino entero de mudos no tiene frontera', () => {
    expect(frontera([mudo(1), mudo(2)])).toBeNull();
  });
});

describe('reparto', () => {
  it('cuenta propios, ajenos y mudos por separado', () => {
    const r = reparto([interno(1, 1), interno(2, 2), mudo(3), publico(4, 1, 64500)]);
    expect(r).toEqual({ propios: 2, ajenos: 1, mudos: 1 });
  });

  it('los mudos se cuentan aunque no se sepa de qué lado caen', () => {
    expect(reparto([mudo(1), mudo(2)])).toEqual({ propios: 0, ajenos: 0, mudos: 2 });
  });
});

describe('textoCambio', () => {
  it('🔴 la primera traza NO dice «sin cambios»', () => {
    // «No cambió» y «no hay con qué comparar» son afirmaciones distintas. Un
    // tablero que las mezcle dice «todo estable» justo el día que menos se sabe.
    const r = textoCambio({ cambio_asn: null, cambio_saltos: null });
    expect(r.nivel).toBe('nuevo');
    expect(r.texto).toBe('primera traza de este destino');
  });

  it('cambiar de operador es la alarma', () => {
    const r = textoCambio({ cambio_asn: true, cambio_saltos: true });
    expect(r.nivel).toBe('alerta');
  });

  it('mismos operadores con distintos saltos es un aviso, no una alarma', () => {
    // Casi siempre es un router que esta vez no contestó. Si eso disparara la
    // alarma, en dos semanas nadie la miraría.
    const r = textoCambio({ cambio_asn: false, cambio_saltos: true });
    expect(r.nivel).toBe('aviso');
  });

  it('sin cambios es estable', () => {
    expect(textoCambio({ cambio_asn: false, cambio_saltos: false }).nivel).toBe('estable');
  });
});

describe('textoMotivo', () => {
  it('🔴 quedarse sin TTL no se cuenta como «el camino tiene N saltos»', () => {
    expect(textoMotivo({ motivo_fin: 'ttl_max', saltos: 20 })).toBe(
      'no llegó: se agotaron los 20 saltos',
    );
  });

  it('llegar al destino se dice claro', () => {
    expect(textoMotivo({ motivo_fin: 'destino', saltos: 8 })).toBe('llegó al destino');
  });

  it('cortar por silencio no es lo mismo que llegar', () => {
    expect(textoMotivo({ motivo_fin: 'mudos', saltos: 12 })).toContain('se cortó');
  });
});

describe('textoRtt', () => {
  it('sin medición muestra una raya, no un cero', () => {
    // Un 0 ms se lee como «instantáneo» y es mentira: es «no se midió».
    expect(textoRtt(null)).toBe('—');
  });

  it('bajo 10 ms lleva dos decimales, que es donde se ve la diferencia', () => {
    expect(textoRtt(0.12)).toBe('0.12 ms');
  });

  it('arriba de 10 ms alcanza con uno', () => {
    expect(textoRtt(18.53)).toBe('18.5 ms');
  });
});

// ── Contra PostgreSQL de verdad ─────────────────────────────────────────────
//
// Las funciones de `lib/consultas.ts` no se pueden probar con dobles: lo único
// que hay que verificar es que la SQL corra y devuelva lo que dice. Un mock de
// `pg` comprobaría que escribimos la cadena que escribimos.
//
// ⚠️ Necesita `TEST_DATABASE_URL` apuntando a una base DESECHABLE.
//    NUNCA a la base de medición: estas pruebas escriben.

const URL_BASE = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hayBase = Boolean(URL_BASE) && tienePsql();
const conBase = describe.skipIf(!hayBase);

conBase('consultas del camino contra la base', () => {
  let q: typeof import('@/lib/consultas');
  let db: typeof import('@/lib/db');
  let trazaId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_BASE;
    const esquema = resolve(__dirname, '../../etl/schema.sql');
    execFileSync('psql', [URL_BASE!, '-v', 'ON_ERROR_STOP=1', '-q', '-f', esquema], {
      stdio: 'pipe',
    });

    q = await import('@/lib/consultas');
    db = await import('@/lib/db');

    await db.consultar('TRUNCATE camino_trazas, camino_destinos CASCADE');
    await db.consultar(
      `INSERT INTO camino_destinos (destino, nota) VALUES ('ejemplo.example', 'prueba')`,
    );
    const filas = await db.consultar<{ id: number }>(
      `INSERT INTO camino_trazas
         (destino, destino_ip, duracion_ms, ttl_max, saltos, saltos_mudos,
          saltos_publicos, alcanzado, motivo_fin, huella_saltos, huella_asn)
       VALUES ('ejemplo.example', '198.51.100.9', 400, 20, 3, 1, 1, true,
               'destino', 'h1', 'h2')
       RETURNING id`,
    );
    trazaId = filas[0]!.id;
    // Salto 2 MUDO a propósito: es lo que estas pruebas vienen a defender.
    await db.consultar(
      `INSERT INTO camino_saltos (traza_id, ttl, direccion, rtt_ms, clase, asn, asn_org)
       VALUES ($1, 1, '192.0.2.1', 1.5, 'interna', NULL, NULL),
              ($1, 2, NULL, NULL, 'mudo', NULL, NULL),
              ($1, 3, '198.51.100.9', 12.5, 'publica', 64500, 'EJEMPLO - Nadie')`,
      [trazaId],
    );
  }, 60_000);

  afterAll(async () => {
    await db?.cerrarPool();
  });

  it('lista los destinos con el resumen de la última traza', async () => {
    const d = await q.destinosCamino();
    expect(d).toHaveLength(1);
    expect(d[0]!.destino).toBe('ejemplo.example');
    expect(d[0]!.saltos).toBe(3);
  });

  it('trae la última traza por destino', async () => {
    const t = await q.trazaCamino({ destino: 'ejemplo.example' });
    expect(t?.id).toBe(trazaId);
    // `host()` saca la máscara: si esto viniera como `198.51.100.9/32` la
    // pantalla mostraría una IP con barra y quedaría feo sin que nadie lo note.
    expect(t?.destino_ip).toBe('198.51.100.9');
    expect(t?.alcanzado).toBe(true);
  });

  it('🔴 devuelve el salto mudo, no lo filtra', async () => {
    const s = await q.saltosCamino(trazaId);
    expect(s.map((x) => x.ttl)).toEqual([1, 2, 3]);
    expect(s[1]!.direccion).toBeNull();
    expect(s[1]!.clase).toBe('mudo');
  });

  it('el ASN llega junto al salto público', async () => {
    const s = await q.saltosCamino(trazaId);
    expect(s[2]!.asn).toBe(64500);
    expect(s[2]!.asn_org).toBe('EJEMPLO - Nadie');
  });

  it('un destino sin trazar aparece igual en la lista', async () => {
    await db.consultar(
      `INSERT INTO camino_destinos (destino) VALUES ('sintrazar.example')`,
    );
    const d = await q.destinosCamino();
    const sin = d.find((x) => x.destino === 'sintrazar.example');
    expect(sin).toBeDefined();
    expect(sin!.traza_id).toBeNull();
  });

  it('el historial ordena de lo más nuevo a lo más viejo', async () => {
    const h = await q.historialCamino('ejemplo.example');
    expect(h.length).toBeGreaterThanOrEqual(1);
    expect(h[0]!.id).toBe(trazaId);
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
