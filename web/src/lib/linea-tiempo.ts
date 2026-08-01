/**
 * La línea de tiempo del equipo: latencia, tráfico y caídas sobre un mismo eje.
 *
 * ── Qué pregunta contesta ────────────────────────────────────────────────────
 *
 * «¿La latencia venía subiendo ANTES de que se cayera?». Es la diferencia entre
 * reaccionar y prevenir, y para contestarla no alcanza con ver los dos gráficos
 * uno al lado del otro: hay que poder apoyar el dedo en el instante de la caída
 * y mirar qué venía haciendo la línea a la izquierda de ese instante.
 *
 * Por eso todo comparte UN eje temporal y las caídas se dibujan como bandas
 * verticales detrás de la línea, no como una lista aparte.
 *
 * ── Por qué este módulo es puro ──────────────────────────────────────────────
 *
 * Acá no hay SQL ni Astro: sólo aritmética sobre números. Es a propósito. Las
 * decisiones difíciles de esta pantalla —qué banda se dibuja, cuál se descarta,
 * dónde se recorta— son exactamente las que hay que poder probar con casos
 * exactos, y probarlas contra la base convertiría cada caso en una fixture.
 *
 * Ver `test/linea-tiempo.test.ts`: cada regla de acá tiene su caso.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Lo medido — 01/08/2026, base real (885 equipos, sync #1 de 2026-08-01 20:01)
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EL DATO QUE DEFINE ESTE DISEÑO: **la latencia dura dos horas.**
//
//    `chart_values` en este volcado tiene 250.373 filas y TODAS son del cajón
//    `raw`. Los agregados (`10min`, `2hour`, `1day`) tienen CERO filas: no es
//    que estén casi vacíos como decía la medición del 31/07 sobre un volcado
//    más gordo, es que no existen.
//
//    Y `raw` en The Dude es un buffer circular. Medido sobre las 170 fuentes
//    que tienen algún valor:
//
//      | qué                                  | cuánto      |
//      |--------------------------------------|-------------|
//      | fuentes con al menos un valor        | 170         |
//      | span mediano de una fuente           | **2 h 04 m**|
//      | fuentes con span de 24 h o más       | **0**       |
//      | fuentes con span menor a 6 h         | **170**     |
//      | puntos medianos por fuente           | 746         |
//      | separación mediana entre puntos      | 2 s         |
//
//    Consecuencia dura: **un gráfico de latencia de «7 días» es imposible con
//    estos datos.** La serie ocuparía el 1,2 % del ancho y el resto sería
//    blanco. Dibujarlo así no es un gráfico pobre: es una afirmación falsa,
//    porque el ojo lee «acá no hubo tráfico / no hubo mediciones / estuvo
//    plano» y ninguna de las tres es cierta.
//
//    Por eso existe la ventana `medido`, que es la de por defecto: la ventana
//    se ajusta A LOS DATOS y no al revés. Sobre esas dos horas, con 2 s de
//    resolución, la pregunta de arriba SÍ se contesta.
//
// 🔴 SEGUNDO DATO: el volcado está viejo, y hay que decirlo.
//
//    `sync_runs.source_mtime` = 2026-07-31 04:15 UTC. La última medición de
//    `chart_values` es de 2026-07-31 01:55 UTC. Contra `now()` del 01/08 a las
//    22:46 son **casi 45 horas**. La ventana «últimas 24 h» de la ficha da CERO
//    equipos con serie — los 885. Un recuadro vacío ahí no dice «el volcado
//    tiene dos días»: dice «este equipo no se mide». Hay que escribirlo.
//
// 🔴 TERCERO: el tráfico es de UN equipo.
//
//    | unidad | fuentes | con algún valor | equipos |
//    |--------|--------:|----------------:|--------:|
//    | s      |     734 |         **167** |     167 |
//    | bit/s  |     348 |           **2** |   **1** |
//    | %      |       1 |               1 |       0 |
//
//    Las 346 fuentes de `bit/s` restantes tienen la fila creada y `value` en
//    NULL. Un panel de tráfico vacío se lee como «este enlace no pasa tráfico»,
//    que es una afirmación sobre la red y es falsa. Así que el panel de tráfico
//    **no se dibuja si no hay números**: se dice con palabras.
//
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde salió una caída. Las dos fuentes NO son intercambiables. */
export type FuenteCaida = 'dude' | 'syslog';

/**
 * Una caída tal como sale de la base, sin interpretar.
 *
 * `inicio` y `fin` en epoch de segundos, y cualquiera de los dos puede faltar:
 * `syslog_outages` tiene 272 filas con `closure = 'no_start'` (se vio la
 * recuperación, nunca la caída) y 26 con `closure = 'open'` (se vio la caída y
 * nunca la recuperación). Medido el 01/08/2026.
 */
export interface CaidaCruda {
  id: number;
  fuente: FuenteCaida;
  inicio: number | null;
  fin: number | null;
  /**
   * La reconstrucción del syslog marcó que esta caída cruza un tramo sin
   * registro. Ver `descartarPorHueco` más abajo: no se dibuja.
   */
  cruza_hueco: boolean;
}

/** Una banda lista para dibujar: ya recortada, ya fusionada, con bordes ciertos. */
export interface Banda {
  inicio: number;
  fin: number;
  fuente: FuenteCaida;
  /** Sin recuperación registrada. El borde derecho es el de la ventana, no un dato. */
  abierta: boolean;
  /** La caída empezó antes de la ventana: el borde izquierdo es un recorte. */
  recortada_inicio: boolean;
  /** Cuántas caídas se fusionaron acá. Distintas sondas del mismo equipo caen juntas. */
  cantidad: number;
}

/**
 * Una recuperación sin caída conocida.
 *
 * 🔴 Esto NO puede ser una banda. `closure = 'no_start'` significa que en el
 *    syslog apareció el «up» y nunca el «down» correspondiente: sabemos el
 *    instante en que volvió y no sabemos hace cuánto se había ido. Una banda
 *    necesita dos bordes y acá hay uno solo; el otro habría que inventarlo.
 *
 *    Se dibuja como una marca vertical fina, que es lo que el dato es.
 */
export interface MarcaRecuperacion {
  t: number;
  fuente: FuenteCaida;
  cantidad: number;
}

/** Lo que se tiró, y por qué. Va a la letra chica: un descarte silencioso miente. */
export interface Descartes {
  /** `spans_gap`: cruzan un tramo sin registro del syslog. */
  cruzan_hueco: number;
  /** `no_start`: sin inicio conocido. Van a `marcas`, no a `bandas`. */
  sin_inicio: number;
  /** Enteramente fuera de la ventana pedida. */
  fuera_de_ventana: number;
  /** Segundos de syslog tapados por la cobertura de The Dude. Ver `RECORTE`. */
  segundos_syslog_solapados: number;
}

export interface Ventana {
  /** epoch en segundos. */
  desde: number;
  hasta: number;
}

/**
 * Hasta dónde llega lo que The Dude sabe.
 *
 * `desde` es la primera caída de `outages` (12/06/2026 en la base real: la base
 * se rearmó de cero ese día tras chocar el techo de 2 GB). `hasta` es el
 * `source_mtime` del volcado, NO la última caída: si en los últimos tres días
 * no hubo ninguna, eso es información —no hubo caídas—, no falta de cobertura.
 */
export interface CoberturaDude {
  desde: number | null;
  hasta: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bandas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 LA REGLA DE ORO: UNA sola fuente manda en cada tramo de tiempo.
 *
 * Las dos tablas de caídas SE SOLAPAN. Medido el 01/08/2026 sobre el tramo que
 * The Dude cubre (12/06/2026 en adelante): de **4.673** caídas del syslog en
 * ese tramo, **4.408 — el 94,3 %** tienen una caída del Dude del mismo equipo
 * arrancando dentro de ±5 minutos. Son el mismo evento contado dos veces.
 *
 * Dibujar las dos pintaría cada caída con dos bandas casi superpuestas y de
 * bordes distintos, y el que mira contaría el doble de incidentes.
 *
 * La solución NO es emparejar de a una. Emparejar deja afuera el 5,7 % que no
 * matchea —el mismo evento con los bordes corridos, o una sonda que la tabla
 * `outages` no trae— y esas quedarían dibujadas AL LADO de su gemela, que es
 * exactamente el fantasma que se quería evitar.
 *
 * La solución es territorial: **The Dude manda en su ventana de cobertura y el
 * syslog manda afuera.** El syslog se recorta al complemento. Así ni un segundo
 * de tiempo queda contado dos veces, y cada banda tiene una única procedencia
 * que se puede escribir en la leyenda.
 */
function recortarAlComplemento(
  inicio: number,
  fin: number,
  cobertura: CoberturaDude,
): { tramos: [number, number][]; solapado: number } {
  const a = cobertura.desde;
  const b = cobertura.hasta;
  if (a == null || b == null || b <= a) return { tramos: [[inicio, fin]], solapado: 0 };

  const solapado = Math.max(0, Math.min(fin, b) - Math.max(inicio, a));
  if (solapado <= 0) return { tramos: [[inicio, fin]], solapado: 0 };

  const tramos: [number, number][] = [];
  if (inicio < a) tramos.push([inicio, Math.min(fin, a)]);
  if (fin > b) tramos.push([Math.max(inicio, b), fin]);
  return { tramos, solapado };
}

interface Trozo {
  inicio: number;
  fin: number;
  fuente: FuenteCaida;
  abierta: boolean;
  recortada_inicio: boolean;
}

/**
 * De caídas crudas a bandas dibujables.
 *
 * El orden de las reglas importa y es este:
 *
 *   1. `cruza_hueco` → afuera. Antes que nada, porque una de estas envenena
 *      todo lo que venga después.
 *   2. sin inicio → marca, no banda.
 *   3. sin fin → banda abierta, con el borde derecho en el fin de la ventana.
 *   4. syslog → recortado al complemento de la cobertura de The Dude.
 *   5. recorte a la ventana pedida.
 *   6. fusión de las que se solapan, POR FUENTE.
 */
export function armarBandas(
  caidas: readonly CaidaCruda[],
  ventana: Ventana,
  cobertura: CoberturaDude,
): { bandas: Banda[]; marcas: MarcaRecuperacion[]; descartes: Descartes } {
  const descartes: Descartes = {
    cruzan_hueco: 0,
    sin_inicio: 0,
    fuera_de_ventana: 0,
    segundos_syslog_solapados: 0,
  };
  const trozos: Trozo[] = [];
  const marcasCrudas: { t: number; fuente: FuenteCaida }[] = [];

  for (const c of caidas) {
    // 1 · El hueco de registro.
    //
    // 🔴 Medido el 01/08/2026: `syslog_outages` tiene UNA fila con
    //    `spans_gap = true`, del 23/11/2025 al 12/06/2026. Son **201 días**.
    //    No es una caída de siete meses: es que entre esas dos fechas no hay
    //    archivos de syslog, y la reconstrucción unió el último «down» que vio
    //    con el primer «up» del otro lado del pozo.
    //
    //    Los pozos del syslog, medidos: 403 días (2020-06 → 2021-07), 1.128
    //    días (2021-07 → 2024-08), 462 días (2024-08 → 2025-11) y 83 días
    //    (2025-12 → 2026-03). Una banda que cruce cualquiera de esos pinta de
    //    rojo años en los que la red probablemente estuvo bien.
    if (c.cruza_hueco) {
      descartes.cruzan_hueco++;
      continue;
    }

    // 2 · La recuperación huérfana. Un solo borde no hace una banda.
    if (c.inicio == null) {
      if (c.fin != null && c.fin >= ventana.desde && c.fin <= ventana.hasta) {
        marcasCrudas.push({ t: c.fin, fuente: c.fuente });
      }
      descartes.sin_inicio++;
      continue;
    }

    // 3 · La caída abierta. El borde derecho es el borde de la ventana, y la
    //     banda se marca `abierta` para que el dibujo NO prometa un final.
    const abierta = c.fin == null;
    const fin = c.fin ?? ventana.hasta;
    if (fin < c.inicio) continue; // dato imposible: fin antes del inicio.

    // 4 · El reparto territorial entre las dos fuentes.
    let tramos: [number, number][] = [[c.inicio, fin]];
    if (c.fuente === 'syslog') {
      const r = recortarAlComplemento(c.inicio, fin, cobertura);
      tramos = r.tramos;
      descartes.segundos_syslog_solapados += r.solapado;
    }

    for (const [ti, tf] of tramos) {
      // 5 · Recorte a la ventana.
      const i = Math.max(ti, ventana.desde);
      const f = Math.min(tf, ventana.hasta);
      if (f <= i) {
        descartes.fuera_de_ventana++;
        continue;
      }
      trozos.push({
        inicio: i,
        fin: f,
        fuente: c.fuente,
        // Sólo sigue «abierta» si el trozo llega hasta el borde derecho.
        abierta: abierta && f >= Math.min(fin, ventana.hasta),
        recortada_inicio: ti < ventana.desde,
      });
    }
  }

  return {
    bandas: fusionar(trozos),
    marcas: fusionarMarcas(marcasCrudas),
    descartes,
  };
}

/**
 * Une los trozos que se pisan, dentro de cada fuente.
 *
 * 🔴 Hace falta porque un equipo tiene VARIAS sondas y cuando el equipo se cae
 *    caen todas: en la base real hay equipos con 47 caídas en 7 días y 259 en
 *    30. Dibujarlas de a una da una pared roja con los bordes serruchados que
 *    no deja ver nada, y además exagera: dos sondas caídas a la vez son UN
 *    incidente, no dos. Es el mismo criterio que usa `lib/disponibilidad.ts`
 *    para no contar el mismo minuto dos veces.
 *
 *    `cantidad` guarda cuántas se fusionaron, para poder decirlo en el `<title>`.
 *
 * No se unen las de fuentes distintas: la leyenda tiene que poder decir de
 * dónde salió cada banda, y una banda mitad Dude y mitad syslog no es de nadie.
 */
function fusionar(trozos: Trozo[]): Banda[] {
  const salida: Banda[] = [];
  for (const fuente of ['dude', 'syslog'] as const) {
    const propias = trozos
      .filter((t) => t.fuente === fuente)
      .sort((a, b) => a.inicio - b.inicio || a.fin - b.fin);

    for (const t of propias) {
      const ultima = salida[salida.length - 1];
      if (ultima && ultima.fuente === fuente && t.inicio <= ultima.fin) {
        ultima.fin = Math.max(ultima.fin, t.fin);
        ultima.abierta ||= t.abierta;
        ultima.cantidad++;
        continue;
      }
      salida.push({
        inicio: t.inicio,
        fin: t.fin,
        fuente,
        abierta: t.abierta,
        recortada_inicio: t.recortada_inicio,
        cantidad: 1,
      });
    }
  }
  return salida.sort((a, b) => a.inicio - b.inicio);
}

/** Marcas en el mismo instante son la misma recuperación vista por varias sondas. */
function fusionarMarcas(
  crudas: { t: number; fuente: FuenteCaida }[],
): MarcaRecuperacion[] {
  const mapa = new Map<string, MarcaRecuperacion>();
  for (const m of crudas) {
    const clave = `${m.fuente}:${m.t}`;
    const ya = mapa.get(clave);
    if (ya) ya.cantidad++;
    else mapa.set(clave, { t: m.t, fuente: m.fuente, cantidad: 1 });
  }
  return [...mapa.values()].sort((a, b) => a.t - b.t);
}

// ─────────────────────────────────────────────────────────────────────────────
// Series
// ─────────────────────────────────────────────────────────────────────────────

export type Punto = [number, number];

/**
 * Parte una serie en tramos donde el muestreo se cortó.
 *
 * 🔴 Sin esto la línea CRUZA la caída de lado a lado, plana y sana. Y es la
 *    mentira más grave que puede decir esta pantalla, porque el equipo caído no
 *    contesta el ping: durante la caída NO HAY MEDICIÓN. Un segmento recto
 *    sobre la banda roja dice «la latencia estuvo estable mientras estaba
 *    caído», que es literalmente lo contrario de lo que pasó.
 *
 * El umbral no está clavado: sale de la propia serie. Medido el 01/08/2026, la
 * separación entre puntos consecutivos es de 2 s de mediana y 10 s en el
 * percentil 99, así que un múltiplo de la mediana separa un hueco real del
 * jitter normal del sondeo. Se usa el factor 8 y un piso de 60 s para que una
 * serie muy regular no se parta por una demora de nada.
 */
export function partirEnTramos(
  puntos: readonly Punto[],
  factor = 8,
  pisoS = 60,
): Punto[][] {
  if (puntos.length < 2) return puntos.length ? [[...puntos]] : [];

  const saltos: number[] = [];
  for (let i = 1; i < puntos.length; i++) saltos.push(puntos[i][0] - puntos[i - 1][0]);
  const orden = [...saltos].sort((a, b) => a - b);
  const mediana = orden[Math.floor(orden.length / 2)];
  const umbral = Math.max(mediana * factor, pisoS);

  const tramos: Punto[][] = [[puntos[0]]];
  for (let i = 1; i < puntos.length; i++) {
    if (saltos[i - 1] > umbral) tramos.push([]);
    tramos[tramos.length - 1].push(puntos[i]);
  }
  // Un tramo de un punto no dibuja línea, pero sí un punto: se conserva.
  return tramos;
}

/**
 * El dominio vertical, con aire.
 *
 * Mismo criterio que `Grafico.astro`, y por el mismo motivo: para la latencia,
 * cero es un valor imposible y arrancar ahí aplasta la variación contra el
 * borde. Lo que se mira en un ping es el CAMBIO. El mínimo y el máximo van
 * escritos con número en el eje, que es lo que hace honesto un eje sin cero.
 */
export function dominioY(
  valores: readonly number[],
  aireFrac = 0.1,
  /**
   * 🔴 Para el TRÁFICO el eje sí arranca en cero, y es la decisión contraria
   *    a la de la latencia. No es una inconsistencia: es que las dos unidades
   *    responden preguntas distintas.
   *
   *    En un ping, cero es imposible y lo que importa es el cambio. En un
   *    caudal, cero es un valor real y perfectamente alcanzable —el enlace
   *    dejó de pasar tráfico— y con la base flotando, una caída de 100 a
   *    98 Mbit/s se dibuja igual que una de 100 a 0. Una de las dos es un
   *    incidente y la otra es el martes.
   */
  desdeCero = false,
): { min: number; max: number } {
  if (valores.length === 0) return { min: 0, max: 1 };
  const min = desdeCero ? 0 : Math.min(...valores);
  const max = Math.max(...valores);
  const aire = (max - min) * aireFrac || Math.abs(max) * aireFrac || 1;
  return { min: desdeCero ? 0 : min - aire, max: max + aire };
}

/** Interpolación lineal de un rango a otro, con el caso degenerado al medio. */
export function escala(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** Un `d` de SVG para un tramo. Vacío si no hay con qué. */
export function caminoDe(
  tramo: readonly Punto[],
  fx: (t: number) => number,
  fy: (v: number) => number,
): string {
  return tramo
    .map((p, i) => `${i ? 'L' : 'M'}${fx(p[0]).toFixed(1)} ${fy(p[1]).toFixed(1)}`)
    .join(' ');
}

/**
 * Ancho mínimo visible de una banda.
 *
 * 🔴 Una caída de 30 segundos en una ventana de 30 días mide 0,01 unidades del
 *    viewBox: no se ve. Y «no se ve» y «no pasó» son la misma imagen.
 *
 * Se ensancha SÓLO al dibujar y sólo hasta el mínimo. El dato no se toca: la
 * duración real va en el `<title>` y en el resumen. Efecto lateral conocido y
 * aceptado: en ventanas largas, caídas muy seguidas se pegan visualmente en un
 * bloque — que es una lectura correcta, «acá hubo una racha».
 */
export function anchoVisible(x1: number, x2: number, minimo: number): [number, number] {
  const ancho = x2 - x1;
  if (ancho >= minimo) return [x1, x2];
  const centro = (x1 + x2) / 2;
  return [centro - minimo / 2, centro + minimo / 2];
}

/** Una banda ya preparada para el `<rect>`, con lo que hace falta para el título. */
export interface BandaDibujo extends Banda {
  /**
   * Suma de la duración REAL de las caídas que quedaron adentro, sin contar
   * los huecos que se tragó el pegado visual. Es el número que se muestra.
   */
  segundos_reales: number;
  /** Se pegó con otras por resolución, no porque el corte fuera continuo. */
  pegada: boolean;
}

/**
 * Pega las bandas que el dibujo no puede separar.
 *
 * 🔴 Medido el 01/08/2026: el equipo peor parado tiene **16.296 caídas en un
 *    año** entre las dos fuentes (`2003274954`), y hay otro con 16.233. Con la
 *    ventana de «1 a» eso son dieciséis mil `<rect>` en el HTML. Se probó: la
 *    página de un equipo con 2.777 caídas pesaba **870 kB**, contra 102 kB en
 *    las otras ventanas. El destinatario típico es un celular en 4G a las tres
 *    de la mañana.
 *
 *    Y lo peor no es el peso: es que NO APORTAN NADA. El eje tiene 950 unidades
 *    de viewBox útiles y una banda no puede medir menos de 2 para verse, así
 *    que **caben unas 475 bandas distinguibles**. Las otras 15.800 se pintan
 *    unas encima de otras.
 *
 * Así que se pegan las que caen a menos de un mínimo de distancia, y la banda
 * resultante DECLARA que es un pegado (`pegada`) y cuánto tiempo caído suma de
 * verdad (`segundos_reales`, sin los huecos). El total que se muestra en la
 * letra chica se calcula sobre las bandas SIN pegar: el pegado es una decisión
 * de píxeles y no puede tocar las cuentas.
 */
export function coalescerParaDibujo(
  bandas: readonly Banda[],
  fx: (t: number) => number,
  minimo = 2,
): BandaDibujo[] {
  const salida: BandaDibujo[] = [];
  for (const b of bandas) {
    const ultima = salida[salida.length - 1];
    if (
      ultima &&
      ultima.fuente === b.fuente &&
      // Se pega sólo si el hueco entre las dos no se vería igual.
      fx(b.inicio) - fx(ultima.fin) < minimo
    ) {
      ultima.fin = Math.max(ultima.fin, b.fin);
      ultima.abierta ||= b.abierta;
      ultima.cantidad += b.cantidad;
      ultima.segundos_reales += b.fin - b.inicio;
      ultima.pegada = true;
      continue;
    }
    salida.push({ ...b, segundos_reales: b.fin - b.inicio, pegada: false });
  }
  return salida;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eje del tiempo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escalones «redondos» para el eje. Nada de dividir el rango en cinco: un eje
 * que dice 14:07, 14:31, 14:55 obliga a leer cada etiqueta. Uno que dice 14:00,
 * 14:30, 15:00 se lee de un vistazo.
 */
const ESCALONES = [
  30, 60, 120, 300, 600, 900, 1800,
  3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600,
  86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400, 90 * 86400, 365 * 86400,
];

export interface Tick {
  t: number;
  texto: string;
}

/**
 * Un instante escrito para que se pueda leer al lado de otro.
 *
 * 🔴 Dos problemas medidos, los dos del mismo lado:
 *
 *    1. `Intl` con `es-AR` escribe **«1/8, 20:10»**, no «01/08, 20:10», aunque
 *       se le pidan los dos campos en `2-digit`. En una etiqueta suelta da
 *       igual; en un encabezado que compara dos instantes, las cifras no
 *       alinean y el ojo tiene que releer.
 *
 *    2. Y el grave: **sin el año, una ventana de doce meses se lee
 *       «1/8, 20:10 → 1/8, 20:10»**, o sea un rango de duración cero. Se vio
 *       tal cual en la pantalla con la ventana de «1 a».
 *
 * Por eso el año se agrega cuando los dos extremos caen en años distintos, y
 * la fecha se rellena a mano con `formatToParts`.
 */
export function instante(t: number, conAnio = false, zona?: string): string {
  const p = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zona,
  }).formatToParts(new Date(t * 1000));
  const v = (tipo: string) => p.find((x) => x.type === tipo)?.value ?? '';
  const dm = `${v('day').padStart(2, '0')}/${v('month').padStart(2, '0')}`;
  const hm = `${v('hour').padStart(2, '0')}:${v('minute').padStart(2, '0')}`;
  return conAnio ? `${dm}/${v('year')} ${hm}` : `${dm} ${hm}`;
}

/** ¿Hace falta el año para que los dos extremos no se lean iguales? */
export function necesitaAnio(v: Ventana, zona?: string): boolean {
  const anio = (t: number) =>
    new Intl.DateTimeFormat('es-AR', { year: 'numeric', timeZone: zona }).format(
      new Date(t * 1000),
    );
  return anio(v.desde) !== anio(v.hasta);
}

/**
 * Marcas del eje temporal, alineadas a horas/días redondos.
 *
 * `zona` existe para las pruebas: sin fijarla, las etiquetas dependen del huso
 * de la máquina y el test pasa o falla según dónde corra. En producción va sin
 * argumento y usa el huso del servidor, como el resto del panel.
 */
export function ticksTiempo(v: Ventana, objetivo = 5, zona?: string): Tick[] {
  const rango = v.hasta - v.desde;
  if (rango <= 0 || objetivo < 2) return [];

  const ideal = rango / (objetivo - 1);
  const paso = ESCALONES.find((e) => e >= ideal) ?? ESCALONES[ESCALONES.length - 1];
  const conDia = paso >= 86400;

  /**
   * 🔴 El día NO se arma con `format`, y no es un capricho.
   *
   *    Medido: `Intl.DateTimeFormat('es-AR', {day:'2-digit', month:'2-digit'})`
   *    devuelve **«7/5»**, no «07/05». Con sólo día y mes, el locale cae en su
   *    propio patrón corto y se come el `2-digit`.
   *
   *    En un eje eso importa: las etiquetas quedan de ancho distinto («7/5» al
   *    lado de «13/05»), bailan al centrarlas y rompen la alineación tabular
   *    que el panel usa en todas partes. Se arma con `formatToParts`, que sí
   *    respeta el huso, y se rellena a mano.
   */
  const partes = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: zona,
  });
  const horaFmt = new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: zona,
  });
  const fmt = (d: Date) => {
    if (!conDia) return horaFmt.format(d);
    const p = partes.formatToParts(d);
    const val = (t: string) => p.find((x) => x.type === t)?.value.padStart(2, '0') ?? '??';
    return `${val('day')}/${val('month')}`;
  };

  const ticks: Tick[] = [];
  // Se alinea contra el epoch, que para pasos de hasta un día cae en horas en
  // punto UTC. Para pasos de días o más el corte no es medianoche local, y se
  // acepta: con un tick cada 7 días, media hora de corrimiento no se ve.
  const primero = Math.ceil(v.desde / paso) * paso;
  for (let t = primero; t <= v.hasta; t += paso) {
    ticks.push({ t, texto: fmt(new Date(t * 1000)) });
  }
  return ticks;
}

// ─────────────────────────────────────────────────────────────────────────────
// La ventana
// ─────────────────────────────────────────────────────────────────────────────

export type OpcionVentana = 'medido' | '24h' | '7d' | '30d' | '1a';

export const OPCIONES_VENTANA: { valor: OpcionVentana; texto: string; ayuda: string }[] = [
  {
    valor: 'medido',
    texto: 'medido',
    ayuda:
      'La ventana se ajusta al tramo que tiene mediciones. Es la única en la que se puede comparar latencia contra caídas.',
  },
  { valor: '24h', texto: '24 h', ayuda: 'Últimas 24 horas.' },
  { valor: '7d', texto: '7 d', ayuda: 'Últimos 7 días.' },
  { valor: '30d', texto: '30 d', ayuda: 'Últimos 30 días.' },
  { valor: '1a', texto: '1 a', ayuda: 'Último año. Sólo caídas: no hay latencia de tan atrás.' },
];

const HORAS_DE: Record<Exclude<OpcionVentana, 'medido'>, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '1a': 24 * 365,
};

export function esOpcionVentana(v: string | null): v is OpcionVentana {
  return v === 'medido' || v === '24h' || v === '7d' || v === '30d' || v === '1a';
}

/**
 * La ventana que se va a dibujar.
 *
 * 🔴 `medido` NO es un capricho: es la consecuencia directa de que la latencia
 *    dure dos horas y el volcado tenga 45 horas de atraso. Con «últimas 24 h»
 *    —el criterio del resto de la ficha— hoy no hay UN SOLO equipo con serie
 *    dibujable, sobre 885. Medido el 01/08/2026.
 *
 *    Anclar la ventana al dato en vez de a `now()` es lo que hace que esta
 *    pantalla exista. Y no es tramposo mientras se diga en qué instante empieza
 *    y en cuál termina, que es lo que hace la etiqueta del eje.
 *
 * Si no hay serie, `medido` no tiene a qué anclarse y cae a los últimos 7 días,
 * donde al menos las caídas tienen algo que mostrar.
 */
export function resolverVentana(
  opcion: OpcionVentana,
  ahora: number,
  spanSerie: { desde: number; hasta: number } | null,
): Ventana & { opcion: OpcionVentana; anclada: boolean } {
  if (opcion === 'medido') {
    if (!spanSerie || spanSerie.hasta <= spanSerie.desde) {
      const h = 24 * 7;
      return { desde: ahora - h * 3600, hasta: ahora, opcion: '7d', anclada: false };
    }
    // Un 4 % de aire a cada lado: sirve para ver si la caída empezó justo en el
    // borde del tramo medido, que es información y no un detalle estético.
    const aire = Math.max((spanSerie.hasta - spanSerie.desde) * 0.04, 60);
    return {
      desde: Math.floor(spanSerie.desde - aire),
      hasta: Math.ceil(spanSerie.hasta + aire),
      opcion: 'medido',
      anclada: true,
    };
  }
  return {
    desde: ahora - HORAS_DE[opcion] * 3600,
    hasta: ahora,
    opcion,
    anclada: false,
  };
}
