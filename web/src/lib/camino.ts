/**
 * El camino de red hacia un destino, listo para dibujar.
 *
 * Toda la lógica de esta capa es de PRESENTACIÓN: agrupar, etiquetar y decidir
 * dónde poner la línea que separa «lo nuestro» de «lo de otro». Los datos ya
 * vienen clasificados desde `etl/camino.py`, que es el único que sabe qué
 * rangos son internos.
 *
 * 🔴 Y eso NO es casualidad ni pereza: acá no hay ni una constante de rangos IP,
 *    a propósito. Si la clasificación viviera en dos lugares, tarde o temprano
 *    dirían cosas distintas, y el lugar que decide qué sale de la máquina hacia
 *    un tercero tiene que ser UNO SOLO — `camino.es_publica()`. El panel se
 *    limita a mostrar la etiqueta que le llega.
 *
 *    (Además, `web/test/seed.test.ts` prohíbe cualquier IPv4 en `web/` que no
 *    sea de los rangos de documentación de la RFC 5737. Escribir acá un rango
 *    privado hace fallar esa prueba — comprobado al escribir este archivo, con
 *    un rango que se había colado en ESTE MISMO comentario. La lista de rangos
 *    vive donde tiene que vivir: `camino.NO_PUBLICAS`, en el ETL.)
 */

/** Las cuatro clases que escribe el ETL. Espejo del CHECK de `camino_saltos`. */
export type ClaseSalto = 'interna' | 'publica' | 'especial' | 'mudo';

export interface SaltoCamino {
  ttl: number;
  /** `null` significa una sola cosa: no contestó. */
  direccion: string | null;
  rtt_ms: number | null;
  clase: ClaseSalto;
  asn: number | null;
  asn_org: string | null;
  asn_prefijo: string | null;
  asn_pais: string | null;
  icmp_tipo: number | null;
  icmp_codigo: number | null;
}

export interface TrazaCamino {
  id: number;
  destino: string;
  destino_ip: string | null;
  iniciada_at: string;
  duracion_ms: number | null;
  metodo: string;
  saltos: number;
  saltos_mudos: number;
  saltos_publicos: number;
  alcanzado: boolean;
  motivo_fin: string;
  error: string | null;
  /** `null` en la primera traza: no hay con qué comparar. Ver más abajo. */
  cambio_saltos: boolean | null;
  cambio_asn: boolean | null;
  previa_id: number | null;
  ruta_asn: string | null;
}

/**
 * Un tramo del camino: saltos consecutivos del MISMO dueño.
 *
 * Es la unidad con la que piensa el operador. Nadie pregunta «¿qué pasa en el
 * salto 7?»; se pregunta «¿hasta dónde llega lo mío?». Un tramo de cinco saltos
 * internos seguidos es una sola respuesta.
 */
export interface Tramo {
  clase: ClaseSalto;
  asn: number | null;
  /** Cómo se llama el dueño de este tramo, ya resuelto para la pantalla. */
  titulo: string;
  saltos: SaltoCamino[];
  /** ¿Es de la red del ISP? Lo que decide de qué lado cae la frontera. */
  propio: boolean;
}

/** Qué decir de un salto cuando no hay ASN. Sin inventar nada. */
export function etiquetaDueno(s: SaltoCamino): string {
  switch (s.clase) {
    case 'mudo':
      return 'no contestó';
    case 'interna':
      return 'red interna';
    case 'especial':
      return 'dirección especial';
    case 'publica':
      if (s.asn === null) return 'público, sin ASN publicado';
      return s.asn_org ? `AS${s.asn} · ${s.asn_org}` : `AS${s.asn}`;
  }
}

/**
 * Agrupa saltos consecutivos del mismo dueño.
 *
 * 🔴 Los saltos MUDOS se agrupan aparte y NO cortan el tramo que los rodea…
 *    salvo que el dueño de los dos lados sea distinto. Un router que no
 *    contesta en el medio de la red de un mayorista sigue siendo, casi con
 *    seguridad, de ese mayorista — pero eso es una suposición, así que el mudo
 *    se muestra como lo que es: un tramo propio, sin dueño conocido.
 *
 *    Lo que NO se hace es borrarlo ni atribuirlo. `etl/camino.py` se rompe el
 *    lomo en guardar una fila por cada TTL que no contestó; taparlo acá sería
 *    tirar ese trabajo a la basura en el último metro.
 */
export function agruparTramos(saltos: readonly SaltoCamino[]): Tramo[] {
  const tramos: Tramo[] = [];

  for (const s of saltos) {
    const ultimo = tramos.at(-1);
    // Dos saltos van juntos si son de la misma clase Y del mismo ASN. Para los
    // que no son públicos el ASN es null en los dos, así que alcanza con la
    // clase — y para los públicos, dos ASN distintos son dos operadores.
    const mismo = ultimo !== undefined && ultimo.clase === s.clase && ultimo.asn === s.asn;

    if (mismo) {
      ultimo.saltos.push(s);
      continue;
    }
    tramos.push({
      clase: s.clase,
      asn: s.asn,
      titulo: tituloTramo(s),
      saltos: [s],
      propio: s.clase === 'interna',
    });
  }

  return tramos;
}

function tituloTramo(s: SaltoCamino): string {
  switch (s.clase) {
    case 'mudo':
      return 'sin respuesta';
    case 'interna':
      return 'Red del ISP';
    case 'especial':
      return 'Direcciones especiales';
    case 'publica':
      if (s.asn === null) return 'Internet (sin ASN publicado)';
      return s.asn_org ?? `AS${s.asn}`;
  }
}

/**
 * El TTL del primer salto que ya no es nuestro. `null` si nunca salimos.
 *
 * Es la línea que el operador busca a las tres de la mañana: de acá para
 * arriba es problema de otro.
 *
 * 🔴 Un salto mudo NO cuenta como frontera. No sabemos de quién es, y dibujar
 *    la línea en un lugar que no sabemos sería justamente la clase de
 *    afirmación inventada que este panel evita. La frontera se pone en el
 *    primer salto que CONTESTÓ y resultó no ser nuestro.
 */
export function frontera(saltos: readonly SaltoCamino[]): number | null {
  const primero = saltos.find((s) => s.clase === 'publica' || s.clase === 'especial');
  return primero?.ttl ?? null;
}

/** Cuántos saltos hay antes de salir, y cuántos después. Para el resumen. */
export function reparto(saltos: readonly SaltoCamino[]): {
  propios: number;
  ajenos: number;
  mudos: number;
} {
  const f = frontera(saltos);
  return {
    propios: saltos.filter((s) => s.clase === 'interna').length,
    ajenos: f === null ? 0 : saltos.filter((s) => s.ttl >= f && s.clase !== 'mudo').length,
    mudos: saltos.filter((s) => s.clase === 'mudo').length,
  };
}

/**
 * Qué decirle al operador sobre el cambio de camino.
 *
 * 🔴 Los tres valores de `cambio_asn` son TRES estados, no dos.
 *
 *    `null` es «es la primera traza de este destino»: no hay con qué comparar.
 *    Mostrarlo como «sin cambios» sería decir «todo estable» justo el día que
 *    menos se sabe — la clase de mentira tranquilizadora que hace que un
 *    tablero deje de servir.
 */
export function textoCambio(traza: Pick<TrazaCamino, 'cambio_asn' | 'cambio_saltos'>): {
  texto: string;
  nivel: 'nuevo' | 'estable' | 'alerta' | 'aviso';
} {
  if (traza.cambio_asn === null) {
    return { texto: 'primera traza de este destino', nivel: 'nuevo' };
  }
  if (traza.cambio_asn) {
    return { texto: 'cambió el operador del camino', nivel: 'alerta' };
  }
  if (traza.cambio_saltos) {
    // Vale la pena decirlo, pero no es una alarma: casi siempre es un router
    // que esta vez no contestó, o uno intermedio nuevo del mismo operador.
    return { texto: 'mismos operadores, distintos saltos', nivel: 'aviso' };
  }
  return { texto: 'sin cambios', nivel: 'estable' };
}

/** Por qué terminó la traza, en castellano. */
export function textoMotivo(traza: Pick<TrazaCamino, 'motivo_fin' | 'saltos'>): string {
  switch (traza.motivo_fin) {
    case 'destino':
      return 'llegó al destino';
    case 'ttl_max':
      // 🔴 Esto NO es «el camino tiene N saltos». Es «se acabó el presupuesto».
      return `no llegó: se agotaron los ${traza.saltos} saltos`;
    case 'mudos':
      return 'se cortó: varios saltos seguidos sin respuesta';
    case 'error':
      return 'no se pudo trazar';
    default:
      return traza.motivo_fin;
  }
}

/** `1.234` ms con dos decimales, o una raya si no hay. Nunca un 0 inventado. */
export function textoRtt(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
}
