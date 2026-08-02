/**
 * Cliente del servicio de sondeo en vivo. Ver `etl/sonda.py`.
 *
 * 🔴 El panel NO manda paquetes. Se los pide a `sonda`, que vive en otro
 *    contenedor con su propio perfil de privilegios y sus propios frenos.
 *
 *    No es ceremonia: hacer ICMP o traceroute desde Node pide `CAP_NET_RAW`, y
 *    eso significaría darle esa capacidad al contenedor que sirve HTTP a
 *    internet. La técnica sin privilegios ya estaba escrita y medida en
 *    Python, y el contenedor web se queda sin una sola línea de código de red.
 *
 * Y todos los frenos —qué destinos, qué puertos, cuántas veces— están del lado
 * del servicio, NO acá. Un control que vive sólo en el que llama es un control
 * que se saltea llamando de otra forma.
 */

const URL_SONDA = (import.meta.env.SONDA_URL ?? process.env.SONDA_URL ?? '').replace(/\/+$/, '');

/**
 * ¿Hay servicio de sondeo configurado?
 *
 * Si no lo hay, la ficha del equipo no dibuja los botones. Ofrecer una acción
 * que no se puede hacer es peor que no ofrecerla: el operador aprieta, no pasa
 * nada, y a partir de ahí desconfía también de lo que sí funciona.
 */
export const haySonda = URL_SONDA.length > 0;

export type Accion = 'ping' | 'puertos' | 'traza' | 'snmp';

export interface Interfaz {
  indice: string;
  nombre: string;
  /** Cómo está de verdad. */
  operativa: string | null;
  /**
   * 🔴 Cómo la dejó una persona. NO es lo mismo que `operativa`, y confundirlas
   *    es el error caro: un puerto `admin=arriba, oper=abajo` es una falla —
   *    debería andar y no anda—; uno `admin=abajo` está apagado a propósito y
   *    no hay nada que arreglar. Las dos se ven igual en un panel que sólo
   *    mira el estado operativo. Medido en producción sobre una OLT real.
   */
  administrativa: string | null;
  velocidad_bps: number | null;
  /** Lo que escribió una persona. En esta red hay puertos «ether2-L2-OLT8». */
  alias: string | null;
  /** Bytes acumulados desde el último arranque del equipo, entrada + salida. */
  trafico_bytes: number;
  /**
   * 🔴 Hace cuánto que está en este estado. El dato que desarma la falsa alarma.
   *
   *    Medido: 20 puertos «caídos con tráfico» que parecían una emergencia. Con
   *    la fecha, el más NUEVO llevaba 26 días y el más viejo 423. Cero
   *    incidentes activos. Sin esto, la lista mandaba un técnico a arreglar
   *    enlaces dados de baja hace catorce meses.
   */
  cambio_hace_s: number | null;
  /** Está así desde que arrancó el equipo: nunca cambió, no «cambió recién». */
  desde_el_arranque: boolean;
  /** `ok` · `apagado` · `libre` · `caido`. Sólo el último pide acción. */
  veredicto: 'ok' | 'apagado' | 'libre' | 'caido';
  explica: string;
  /**
   * Marca de agrupación: dos puertos con el MISMO valor cayeron en el mismo
   * instante, y eso es UN evento, no dos. Tres coincidencias no existen.
   */
  evento: number | null;
}

export interface Snmp {
  destino: string;
  version: string;
  responde: boolean;
  /** Por qué no contestó. `undefined` cuando sí. */
  motivo?: string;
  descripcion?: string | null;
  nombre?: string | null;
  contacto?: string | null;
  ubicacion?: string | null;
  uptime_s?: number | null;
  interfaces?: Interfaz[];
  ms_total?: number;
}

export interface Ping {
  destino: string;
  /** Con qué se midió. Un «no contestó» por UDP no vale lo mismo que por ICMP. */
  tecnica: 'icmp' | 'udp-recverr';
  explica: string;
  sondas: number;
  respondieron: number;
  perdida_pct: number;
  ms_min: number | null;
  ms_prom: number | null;
  ms_max: number | null;
  jitter_ms: number | null;
  muestras_ms: (number | null)[];
  ms_total: number;
}

export interface Puerto {
  puerto: number;
  etiqueta: string;
  estado: 'abierto' | 'cerrado' | 'sin respuesta' | 'error';
  detalle: string | null;
  ms: number | null;
}

export interface Puertos {
  destino: string;
  puertos: Puerto[];
  ms_total: number;
}

export interface SaltoVivo {
  ttl: number;
  direccion: string | null;
  ms: number | null;
  clase: string;
}

export interface Traza {
  destino: string;
  alcanzado: boolean;
  /**
   * Si el camino NO se completó: ¿el equipo responde igual?
   *
   * 🔴 `true` acá cambia el diagnóstico por completo. Medido en producción: un
   *    traceroute que termina en «no contestó» contra un equipo que responde
   *    ping en 0,44 ms. No es contradictorio — el traceroute manda UDP a un
   *    puerto cerrado y hay equipos que nunca contestan eso. `null` cuando el
   *    camino sí llegó y la pregunta no aplica.
   */
  responde_igual: boolean | null;
  motivo_fin: string;
  saltos: SaltoVivo[];
  ms_total: number;
}

export type Resultado =
  | { ok: true; accion: 'ping'; datos: Ping }
  | { ok: true; accion: 'puertos'; datos: Puertos }
  | { ok: true; accion: 'traza'; datos: Traza }
  | { ok: true; accion: 'snmp'; datos: Snmp }
  | { ok: false; error: string; motivo?: string; estado: number };

/**
 * @param timeoutMs  tope de espera. Un traceroute de 20 saltos con timeout de
 *   2 s puede tardar 40 s en el peor caso, y una página que se cuelga 40 s es
 *   una página rota. Se corta y se dice que se cortó.
 */
export async function sondear(
  accion: Accion,
  destino: string,
  timeoutMs = 45_000,
): Promise<Resultado> {
  if (!haySonda) {
    return { ok: false, error: 'No hay servicio de sondeo configurado', estado: 501 };
  }

  const corte = AbortSignal.timeout(timeoutMs);
  try {
    const r = await fetch(`${URL_SONDA}/${accion}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destino }),
      signal: corte,
    });
    const cuerpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      return {
        ok: false,
        estado: r.status,
        error: String(cuerpo.error ?? `el servicio de sondeo contestó ${r.status}`),
        motivo: typeof cuerpo.motivo === 'string' ? cuerpo.motivo : undefined,
      };
    }
    // 🔴 Se comprueba la forma antes de afirmarla.
    //
    //    Esto viene de OTRO proceso. Un `as Resultado` a secas es una promesa
    //    que TypeScript cree y el navegador desmiente: si falta `muestras_ms`,
    //    el `.map()` de la plantilla revienta la página entera con un error que
    //    apunta al componente y no al servicio, que es donde está el problema.
    //
    //    No es una validación completa —para eso habría que arrastrar un
    //    esquema— pero comprueba la clave que cada vista realmente recorre, que
    //    es exactamente donde duele.
    const clave = { ping: 'muestras_ms', puertos: 'puertos', traza: 'saltos',
                    snmp: 'responde' }[accion];
    if (!(clave in cuerpo)) {
      return {
        ok: false,
        estado: 502,
        error: 'El servicio de sondeo contestó algo que no entiendo',
        motivo: `falta «${clave}» en la respuesta de ${accion}`,
      };
    }
    return { ok: true, accion, datos: cuerpo } as unknown as Resultado;
  } catch (e) {
    // Se distingue «tardó demasiado» de «no está»: son dos problemas distintos
    // y llevan a revisar dos cosas distintas.
    const corto = e instanceof Error && e.name === 'TimeoutError';
    return {
      ok: false,
      estado: corto ? 504 : 503,
      error: corto
        ? `El sondeo tardó más de ${Math.round(timeoutMs / 1000)} s y se cortó`
        : 'No se pudo hablar con el servicio de sondeo',
      motivo: corto ? undefined : e instanceof Error ? e.message : String(e),
    };
  }
}
