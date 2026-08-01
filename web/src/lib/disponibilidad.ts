/**
 * ════════════════════════════════════════════════════════════════════════════
 *  Disponibilidad: convertir 11.988 caídas en un número que se pueda facturar.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 La pregunta que un ISP tiene que poder contestar es «¿cuánto tiempo estuvo
 *    arriba el equipo X en julio?», y hasta acá el panel no la contestaba. Sabía
 *    listar caídas —`/caidas`— pero listar no es medir: nadie factura una lista.
 *
 * Este módulo es la parte PURA del cálculo: recorte de la ventana, unión de
 * intervalos, las cuatro métricas y el armado del CSV. La SQL vive en
 * `consultas.ts`. La separación no es estética — el 90 % de las decisiones que
 * hacen que este número sirva o no son aritmética y clasificación, y eso se
 * prueba sin base de datos, con números escritos a mano.
 *
 * ── Las cinco decisiones, medidas contra la base real el 01/08/2026 ──────────
 *
 *  1 · EL HORIZONTE. La base de The Dude se rearmó desde cero el 12/06/2026 al
 *      chocar contra el techo de 2 GB. El primer registro es del
 *      **12/06/2026 14:54:07**. Todo lo anterior NO es «tiempo arriba»: es
 *      tiempo del que no hay nada escrito. La ventana se recorta al horizonte y
 *      la página dice cuántos días se recortaron. Ver `recortarAlHorizonte`.
 *
 *  2 · LAS CAÍDAS ABIERTAS (`ended_at IS NULL`) se cierran contra `now()` para
 *      contarlas, y contra el fin de la ventana si la ventana termina antes.
 *      Medido: hoy hay **0 abiertas** en esta base, pero el seed de desarrollo
 *      genera varias y el ETL las crea todo el tiempo. Que hoy no haya no es
 *      una razón para no manejarlas — es una razón para que el test las tenga.
 *
 *  3 · LOS 168 SIN SERVICIOS HABILITADOS no reciben porcentaje. Nunca. Ver
 *      `COBERTURAS`: «no monitoreado» y «disponible» son cosas distintas y el
 *      día que se confundan, el reporte deja de valer.
 *
 *  4 · LOS 495 SERVICIOS RECONOCIDOS (`acked`) CUENTAN IGUAL. La justificación
 *      completa está en `COBERTURAS.confirmada` y en el comentario de
 *      `disponibilidadPorEquipo`, pero el argumento que cierra la discusión es
 *      medible: `acked` es el estado de HOY del servicio, no del incidente.
 *      `outages` no tiene columna de reconocimiento. Filtrar por `acked`
 *      silenciaría retroactivamente siete semanas de historia según lo que
 *      alguien haya tildado esta mañana.
 *
 *  5 · EL SOLAPAMIENTO. Un equipo con tres servicios puede tener tres caídas a
 *      la misma hora. Sumar `duration_s` cuenta el mismo minuto tres veces y
 *      puede dar más de 100 % de indisponibilidad. Se unen los intervalos.
 *      Medido: 6 equipos tienen más de un servicio y hay **3 pares de caídas
 *      solapadas** — 11.908 filas colapsan a 11.905 episodios. Es poco, y por
 *      eso mismo es peligroso: un error del 0,03 % no se nota mirando, sólo se
 *      nota cuando un cliente reclama.
 */

/**
 * Argentina está en UTC−03:00 y **no cambia de hora desde 2009**.
 *
 * Se fija el desplazamiento en vez de usar `Intl` con zona horaria porque acá
 * hay que hacer el camino inverso —de «2026-07-01» a un instante— y para eso
 * `Intl` no sirve: formatea, no parsea. Con horario de verano habría que
 * resolverlo bien; sin él, esto es exacto y es una línea.
 *
 * Si algún gobierno vuelve a mover las agujas, este es el lugar.
 */
export const DESPLAZAMIENTO_ISP = '-03:00';

/** Un día, en segundos. Se repite lo suficiente como para tener nombre. */
const DIA_S = 86_400;

// ─────────────────────────────────────────────────────────────────────────────
// Períodos
// ─────────────────────────────────────────────────────────────────────────────

export type ClavePeriodo = '7d' | '30d' | 'mes' | 'mes-ant' | 'todo' | 'custom';

export interface Periodo {
  clave: ClavePeriodo;
  etiqueta: string;
}

/**
 * Los atajos de la barra de filtros.
 *
 * «Mes anterior» está primero de los dos meses a propósito: el reporte que se
 * le manda a un cliente es el del mes CERRADO. El mes en curso sirve para
 * mirar cómo viene, no para facturar.
 */
export const PERIODOS: readonly Periodo[] = [
  { clave: '7d', etiqueta: '7 días' },
  { clave: '30d', etiqueta: '30 días' },
  { clave: 'mes-ant', etiqueta: 'Mes anterior' },
  { clave: 'mes', etiqueta: 'Mes en curso' },
  { clave: 'todo', etiqueta: 'Todo' },
] as const;

export function aClavePeriodo(v: unknown): ClavePeriodo | null {
  return PERIODOS.some((p) => p.clave === v) ? (v as ClavePeriodo) : null;
}

/**
 * `2026-07-01` → el instante en que empieza ese día en Buenos Aires.
 *
 * Devuelve `null` ante cualquier cosa que no sea exactamente `aaaa-mm-dd`
 * válido. **No se normaliza lo dudoso**: `2026-02-31` lo aceptaría `Date` y lo
 * correría al 3 de marzo, y un reporte cuyo período se movió solo es peor que
 * un reporte que no salió.
 */
export function inicioDelDia(fecha: string): Date | null {
  return instante(fecha, '00:00:00.000');
}

/** El instante en que TERMINA ese día: el último milisegundo, no el siguiente. */
export function finDelDia(fecha: string): Date | null {
  return instante(fecha, '23:59:59.999');
}

function instante(fecha: string, hora: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const d = new Date(`${fecha}T${hora}${DESPLAZAMIENTO_ISP}`);
  if (Number.isNaN(d.getTime())) return null;
  // `Date` acepta 2026-02-31 y lo corre al 3 de marzo. Se compara la fecha
  // resultante contra la pedida —en la zona del ISP— y si no coincide, se
  // rechaza en vez de reportar sobre un período que nadie pidió.
  return aFechaISP(d) === fecha ? d : null;
}

/** `aaaa-mm-dd` de un instante, en la zona del ISP. Para URLs y `<input type=date>`. */
export function aFechaISP(d: Date): string {
  // El desplazamiento es fijo, así que correr el reloj y leer en UTC da la
  // fecha local sin depender de la zona horaria del proceso —que en el
  // contenedor es Buenos Aires, pero en la máquina de quien desarrolla puede
  // ser cualquiera, y un reporte no puede cambiar según dónde se compiló.
  const corrido = new Date(d.getTime() - 3 * 3_600_000);
  return corrido.toISOString().slice(0, 10);
}

/**
 * Qué instantes pidió el usuario, antes de saber si hay datos ahí.
 *
 * `desde`/`hasta` explícitos ganan sobre el atajo: son los que viajan en el
 * enlace que alguien pegó en un chat para pedir «el reporte de este período».
 */
export function resolverPeriodo(
  params: { periodo?: string | null; desde?: string | null; hasta?: string | null },
  ahora: Date = new Date(),
  /**
   * El primer dato de la base, si ya se lo consultó. Sólo lo usa «Todo»: sin
   * él ese atajo tendría que arrancar en una fecha inventada, y el recorte
   * después informaría «se recortaron 9.659 días», que es ruido — nadie pidió
   * el año 2000, pidió «todo lo que haya».
   */
  horizonte: Date | null = null,
): { clave: ClavePeriodo; desde: Date; hasta: Date } {
  const d = params.desde ? inicioDelDia(params.desde) : null;
  const h = params.hasta ? finDelDia(params.hasta) : null;
  if (d && h && d < h) return { clave: 'custom', desde: d, hasta: h };

  const clave = aClavePeriodo(params.periodo) ?? '30d';
  const hoy = aFechaISP(ahora);
  const [anio, mes] = hoy.split('-').map(Number) as [number, number, number];

  switch (clave) {
    case '7d':
      return { clave, desde: new Date(ahora.getTime() - 7 * DIA_S * 1000), hasta: ahora };
    case 'mes':
      return { clave, desde: inicioDeMes(anio, mes)!, hasta: ahora };
    case 'mes-ant': {
      const anteriorAnio = mes === 1 ? anio - 1 : anio;
      const anteriorMes = mes === 1 ? 12 : mes - 1;
      return {
        clave,
        desde: inicioDeMes(anteriorAnio, anteriorMes)!,
        // El fin del mes anterior es el arranque del actual: no hay que saber
        // cuántos días tiene febrero ni si el año es bisiesto.
        hasta: new Date(inicioDeMes(anio, mes)!.getTime() - 1),
      };
    }
    case 'todo':
      // Con el horizonte a mano, «todo» arranca exactamente ahí y no hay nada
      // que recortar. Sin él —el recorte lo hace después de todos modos— se
      // usa una fecha vieja y el aviso queda feo, pero el número sale bien.
      return { clave, desde: horizonte ?? new Date('2000-01-01T00:00:00Z'), hasta: ahora };
    default:
      return { clave: '30d', desde: new Date(ahora.getTime() - 30 * DIA_S * 1000), hasta: ahora };
  }
}

function inicioDeMes(anio: number, mes: number): Date | null {
  return inicioDelDia(`${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-01`);
}

// ─────────────────────────────────────────────────────────────────────────────
// La ventana observada
// ─────────────────────────────────────────────────────────────────────────────

export interface Ventana {
  /** Arranque efectivo: lo pedido o el horizonte, lo que sea más tarde. */
  desde: Date;
  /** Fin efectivo: lo pedido o ahora, lo que sea más temprano. */
  hasta: Date;
  segundos: number;
  /** Lo que se pidió, para poder decir cuánto se recortó. */
  pedido_desde: Date;
  pedido_hasta: Date;
  /** Días del período pedido que quedan afuera por falta de datos. */
  dias_recortados: number;
  /** El primer registro de la base. `null` si la base está vacía. */
  horizonte: Date | null;
  /** ¿La ventana quedó vacía? Entonces no hay nada que informar. */
  vacia: boolean;
}

/**
 * 🔴 La función que decide si el reporte miente o no.
 *
 *    Un período que empieza antes del 12/06/2026 no tiene datos en su primera
 *    parte. Tratar «no hay caídas registradas» como «estuvo arriba» convierte
 *    un agujero de información en un 100 % de disponibilidad, y ese es
 *    exactamente el número que un cliente va a usar para no reclamar algo que
 *    sí pasó. Se recorta, y se informa cuánto se recortó.
 *
 *    Lo mismo con el futuro: pedir «julio» un 15 de julio no da un mes de
 *    ventana, da quince días. Un mes con quince días de nada da 50 % de
 *    indisponibilidad para toda la red.
 */
export function recortarAlHorizonte(
  pedido: { desde: Date; hasta: Date },
  horizonte: Date | null,
  ahora: Date = new Date(),
): Ventana {
  const tope = pedido.hasta.getTime() < ahora.getTime() ? pedido.hasta : ahora;
  const piso =
    horizonte && horizonte.getTime() > pedido.desde.getTime() ? horizonte : pedido.desde;

  const desde = new Date(piso.getTime());
  const hasta = new Date(Math.max(tope.getTime(), piso.getTime()));
  const segundos = Math.max(0, (hasta.getTime() - desde.getTime()) / 1000);

  const recortadoS = Math.max(0, (piso.getTime() - pedido.desde.getTime()) / 1000);

  return {
    desde,
    hasta,
    segundos,
    pedido_desde: pedido.desde,
    pedido_hasta: pedido.hasta,
    // Se redondea para abajo: «faltan 11 días» es un dato que alguien copia a
    // un correo, y decir 12 cuando son 11 y pico es inventar medio día.
    dias_recortados: Math.floor(recortadoS / DIA_S),
    horizonte,
    vacia: segundos <= 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cobertura: qué tan en serio hay que tomarse cada fila
// ─────────────────────────────────────────────────────────────────────────────

export type Cobertura = 'confirmada' | 'supuesta' | 'historica' | 'sin-monitoreo';

export interface MetaCobertura {
  clave: Cobertura;
  etiqueta: string;
  /** Una línea, la que va en el `title` y en la referencia de la página. */
  explica: string;
  /** ¿Esta fila lleva porcentaje? */
  conPorcentaje: boolean;
  /** Qué se muestra en la columna de disponibilidad cuando no lleva número. */
  enLugarDelNumero: string;
}

/**
 * 🔴 Los cuatro estados salen de lo que la base PUEDE probar, no de lo que
 *    sería cómodo mostrar.
 *
 *    The Dude **no guarda cuándo se dio de alta un equipo**. Se buscó: `devices`
 *    no tiene fecha de creación, `chart_values` sólo cubre 168 de los 885 (los
 *    que tienen gráficos SNMP) y arranca el 19/06, y `services.time_last_up` /
 *    `time_last_down` no son fechas sino DURACIONES en segundos — medido: el
 *    máximo de `time_last_up` es 4.294.967.284, que es 2³²−12, un centinela de
 *    «nunca», y leerlo como epoch daba equipos vistos por última vez en 1890.
 *
 *    Lo único que sí es un instante es `services.status_changed_at`
 *    (`to_timestamp(time_since_changed)`), y con eso alcanza para una prueba
 *    POSITIVA: si un servicio del equipo viene en el mismo estado desde ANTES
 *    del arranque de la ventana, ese equipo estaba bajo monitoreo entonces.
 *    Medido: **265 de los 717 monitoreados** tienen esa prueba.
 *
 *    Los otros 452 no prueban nada en ninguna dirección: pudieron haberse dado
 *    de alta el 20 de julio, o simplemente haber parpadeado la semana pasada.
 *    Se les calcula el porcentaje igual —para un servicio monitoreado, que no
 *    haya fila en `outages` SIGNIFICA que estuvo arriba— pero la fila queda
 *    marcada y la página lo dice con todas las letras. Inventar la fecha de
 *    alta sería peor que no tenerla.
 */
export const COBERTURAS: Record<Cobertura, MetaCobertura> = {
  confirmada: {
    clave: 'confirmada',
    etiqueta: 'Confirmada',
    explica:
      'Hay constancia de que el equipo estaba bajo monitoreo desde el arranque del período: el porcentaje cubre la ventana entera.',
    conPorcentaje: true,
    enLugarDelNumero: '',
  },
  supuesta: {
    clave: 'supuesta',
    etiqueta: 'Sin verificar',
    explica:
      'The Dude no guarda cuándo se dio de alta un equipo. Este monitorea hoy, pero no hay constancia de que lo hiciera al empezar el período: si se agregó en el medio, el porcentaje está inflado.',
    conPorcentaje: true,
    enLugarDelNumero: '',
  },
  historica: {
    clave: 'historica',
    etiqueta: 'Baja de monitoreo',
    explica:
      'Hoy no tiene ningún servicio habilitado, pero registró caídas dentro del período. Se sabe cuántas y cuánto duraron; no se sabe cuándo se dejó de mirar, así que no hay porcentaje posible.',
    conPorcentaje: false,
    enLugarDelNumero: 'sin porcentaje',
  },
  'sin-monitoreo': {
    clave: 'sin-monitoreo',
    etiqueta: 'No se monitorea',
    explica:
      'No tiene ningún servicio habilitado ni registró caídas. No hay nada medido: no está disponible ni indisponible, está afuera del monitoreo.',
    conPorcentaje: false,
    enLugarDelNumero: 'no monitoreado',
  },
};

export function aCobertura(v: unknown): Cobertura | null {
  return v === 'confirmada' || v === 'supuesta' || v === 'historica' || v === 'sin-monitoreo'
    ? v
    : null;
}

/**
 * La clasificación, en un solo lugar y sin base de datos.
 *
 * La SQL de `consultas.ts` produce exactamente estas cuatro salidas; tenerla
 * también acá permite probar los cuatro caminos con números escritos a mano y
 * deja la regla escrita en castellano al lado de su justificación.
 */
export function clasificarCobertura(e: {
  serviciosHabilitados: number;
  eventos: number;
  /** Desde cuándo hay constancia de monitoreo. `null` si no hay ninguna. */
  vistoDesde: Date | null;
  ventanaDesde: Date;
}): Cobertura {
  if (e.serviciosHabilitados <= 0) return e.eventos > 0 ? 'historica' : 'sin-monitoreo';
  if (e.vistoDesde && e.vistoDesde.getTime() <= e.ventanaDesde.getTime()) return 'confirmada';
  return 'supuesta';
}

// ─────────────────────────────────────────────────────────────────────────────
// Las cuatro métricas
// ─────────────────────────────────────────────────────────────────────────────

export interface Metricas {
  /** 0 a 100. `null` cuando no se puede calcular; NUNCA 100 por defecto. */
  disponibilidad: number | null;
  arriba_s: number;
  caido_s: number;
  /** Tiempo medio entre fallas: operación acumulada ÷ fallas. */
  mtbf_s: number | null;
  /** Tiempo medio de reparación: indisponibilidad acumulada ÷ fallas. */
  mttr_s: number | null;
}

/**
 * 🔴 MTBF y MTTR devuelven `null` con cero eventos, y eso NO es un detalle.
 *
 *    Con cero fallas, el tiempo medio entre fallas es una división por cero.
 *    La tentación es poner 0 —y 0 en una columna de MTBF se lee como «se cae
 *    todo el tiempo», que es lo contrario de lo que pasó— o poner la ventana
 *    entera, que afirma que la próxima falla llega justo al final del período.
 *    Ninguna de las dos es un dato. La página escribe «sin fallas».
 *
 *    Medido: **436 de los 717 equipos monitoreados** no tuvieron ni una caída
 *    en las siete semanas. Es el 61 %: la columna que se resuelve mal acá es la
 *    mayoría de la tabla.
 */
export function metricas(ventana_s: number, caido_s: number, eventos: number): Metricas {
  if (!(ventana_s > 0)) {
    return { disponibilidad: null, arriba_s: 0, caido_s: 0, mtbf_s: null, mttr_s: null };
  }
  // El recorte de intervalos ya garantiza que nada exceda la ventana; el clamp
  // es contra el reloj del origen, que en The Dude corre en un Windows de 2011
  // sin NTP confiable y puede cerrar una caída un segundo después de `now()`.
  const caido = Math.min(Math.max(caido_s, 0), ventana_s);
  const arriba = ventana_s - caido;

  return {
    disponibilidad: (arriba / ventana_s) * 100,
    arriba_s: arriba,
    caido_s: caido,
    mtbf_s: eventos > 0 ? arriba / eventos : null,
    mttr_s: eventos > 0 ? caido / eventos : null,
  };
}

/**
 * `99,667 %`. Tres decimales y **truncado, nunca redondeado hacia arriba**.
 *
 * 99,9996 % redondeado da `100,000 %`, y un 100 % en un reporte de SLA es una
 * afirmación fuerte: dice que no hubo ni un segundo de corte. Truncar hace que
 * el único 100 % que se imprime sea el que de verdad no tuvo caídas.
 */
export function formatearDisponibilidad(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 100) return '100 %';
  const truncado = Math.floor(v * 1000) / 1000;
  return `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(truncado)} %`;
}

/**
 * A qué "nueve" llega. Para pintar la fila y para ordenar la lectura.
 *
 * Los cortes son los que se usan en contratos: 99,9 % son 43 min por mes,
 * 99 % son 7 h 18 min, 95 % son un día y medio.
 */
export type Nivel = 'excelente' | 'bueno' | 'flojo' | 'malo' | 'sin-dato';

export function nivel(disponibilidad: number | null | undefined): Nivel {
  if (disponibilidad == null || !Number.isFinite(disponibilidad)) return 'sin-dato';
  if (disponibilidad >= 99.9) return 'excelente';
  if (disponibilidad >= 99) return 'bueno';
  if (disponibilidad >= 95) return 'flojo';
  return 'malo';
}

// ─────────────────────────────────────────────────────────────────────────────
// Unión de intervalos — la trampa del solapamiento, escrita en TypeScript
// ─────────────────────────────────────────────────────────────────────────────

export interface Intervalo {
  /** Epoch en segundos. */
  inicio: number;
  fin: number;
}

/**
 * Une intervalos que se tocan o se pisan. Semántica `[inicio, fin)`.
 *
 * 🔴 Esto es la MISMA regla que aplica `range_agg` en la SQL, escrita acá para
 *    poder probarla con números a mano y para que quede documentada en
 *    castellano. No la ejecuta la página —sería traer 11.988 filas al proceso
 *    para hacer en JavaScript lo que Postgres hace en el índice— pero el test
 *    la corre contra los mismos casos que la SQL, y si alguna de las dos se
 *    desvía, el rojo aparece.
 *
 * Dos intervalos que se TOCAN exactamente (uno termina donde arranca el otro)
 * se unen: para un equipo con dos servicios, «cayó el ping 10:00–10:05 y el
 * winbox 10:05–10:10» es un corte de diez minutos, no dos de cinco.
 */
export function unirIntervalos(intervalos: readonly Intervalo[]): Intervalo[] {
  const validos = intervalos
    .filter((i) => Number.isFinite(i.inicio) && Number.isFinite(i.fin) && i.fin > i.inicio)
    .sort((a, b) => a.inicio - b.inicio || a.fin - b.fin);

  const salida: Intervalo[] = [];
  for (const i of validos) {
    const ultimo = salida[salida.length - 1];
    if (ultimo && i.inicio <= ultimo.fin) {
      if (i.fin > ultimo.fin) ultimo.fin = i.fin;
    } else {
      salida.push({ inicio: i.inicio, fin: i.fin });
    }
  }
  return salida;
}

/** Segundos cubiertos por una lista ya unida. */
export function segundosCubiertos(intervalos: readonly Intervalo[]): number {
  return intervalos.reduce((t, i) => t + (i.fin - i.inicio), 0);
}

/**
 * Recorta un intervalo a la ventana. `null` si queda afuera o vacío.
 *
 * Una caída abierta (`fin == null`) se cierra contra `ahora`. Una que empezó
 * antes de la ventana cuenta sólo desde el arranque: si no, el reporte de
 * julio cargaría contra julio un corte de junio.
 */
export function recortar(
  i: { inicio: number; fin: number | null },
  ventana: { desde: number; hasta: number },
  ahora: number,
): Intervalo | null {
  const fin = Math.min(i.fin ?? ahora, ventana.hasta);
  const inicio = Math.max(i.inicio, ventana.desde);
  return fin > inicio ? { inicio, fin } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 Punto y coma, coma decimal y BOM. Las tres cosas por el mismo motivo.
 *
 *    El destino de este archivo no es un script: es el Excel de una gerencia,
 *    en una máquina con Windows en español. Ahí el separador de listas es `;`
 *    y el decimal es la coma. Un CSV «canónico» —comas y puntos— se abre en esa
 *    máquina como UNA sola columna con los porcentajes partidos al medio, y la
 *    persona que lo recibe concluye que el panel exporta mal.
 *
 *    El BOM es por la misma razón: sin él, Excel lee UTF-8 como Latin-1 y
 *    «Caídas» sale «CaÃ­das». No es cosmético — un reporte que se ve roto no se
 *    manda a un cliente.
 */
export const BOM_UTF8 = '﻿';
export const SEPARADOR_CSV = ';';

/**
 * Escapa un campo. Comillas dobladas, y comillas alrededor si hace falta.
 *
 * 🔴 El `=` inicial no es paranoia de manual: los nombres de equipo salen de
 *    The Dude, donde los escribe una persona. Un nombre que empiece con `=`,
 *    `+`, `-` o `@` lo interpreta Excel como FÓRMULA al abrir el archivo. Se le
 *    antepone un apóstrofo, que Excel consume como marca de texto. Sin esto, un
 *    CSV exportado desde el panel es un vector de inyección hacia la máquina de
 *    quien lo abre.
 */
export function campoCsv(v: string | number | null | undefined): string {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Se entrecomilla por el separador REAL, no por la coma: con `;` de por medio
  // la coma es un decimal y nada más, y entrecomillar cada `99,667` llenaría el
  // archivo de comillas que después alguien tiene que explicar.
  const peligroso = s.includes(SEPARADOR_CSV) || /["\n\r]/.test(s);
  return peligroso ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Arma el CSV completo. CRLF porque es lo que espera Excel. */
export function aCsv(filas: readonly (readonly (string | number | null | undefined)[])[]): string {
  return BOM_UTF8 + filas.map((f) => f.map(campoCsv).join(SEPARADOR_CSV)).join('\r\n') + '\r\n';
}

/** Número con coma decimal para el CSV. `''` si no hay dato: nunca un cero falso. */
export function numeroCsv(v: number | null | undefined, decimales = 3): string {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(decimales).replace('.', ',');
}

/** `disponibilidad-2026-06-12_2026-08-01.csv`. Se ordena solo en una carpeta. */
export function nombreArchivoCsv(v: { desde: Date; hasta: Date }): string {
  return `disponibilidad-${aFechaISP(v.desde)}_${aFechaISP(v.hasta)}.csv`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Armado de las filas del reporte
//
// Sólo tipo: se borra al compilar, así que este módulo sigue sin depender de
// `pg` y los tests lo importan sin levantar una base.
// ─────────────────────────────────────────────────────────────────────────────

import type { CrudoDisponibilidad } from './consultas';

export interface FilaDisponibilidad extends Metricas {
  device_id: number;
  equipo: string;
  mapa_id: number | null;
  mapa: string | null;
  cobertura: Cobertura;
  /** Episodios del equipo, con los intervalos solapados ya unidos. */
  eventos: number;
  /** Filas crudas de `outages`. Mayor que `eventos` si hubo solapamiento. */
  caidas_servicio: number;
  abiertas: number;
  servicios: number;
  reconocidos: number;
  ventana_s: number;
  primera: Date | null;
  ultima: Date | null;
  nivel: Nivel;
}

/**
 * De contadores crudos a filas de reporte.
 *
 * 🔴 Acá se aplica la regla que hace que el número no mienta: si la cobertura
 *    no admite porcentaje, `disponibilidad`, `mtbf_s` y `mttr_s` quedan en
 *    `null`. No en cero, no en 100 — en `null`, que la página traduce a
 *    palabras. Un `0` en la columna de disponibilidad de un equipo que
 *    simplemente no se monitorea es una acusación falsa; un `100` es una
 *    absolución falsa. Las dos rompen el reporte, en direcciones opuestas.
 */
export function construirFilas(
  crudas: readonly CrudoDisponibilidad[],
  ventana: Ventana,
): FilaDisponibilidad[] {
  return crudas.map((c) => {
    const cobertura = clasificarCobertura({
      serviciosHabilitados: c.servicios,
      eventos: c.eventos,
      vistoDesde: aFecha(c.visto_desde),
      ventanaDesde: ventana.desde,
    });

    const m = metricas(ventana.segundos, Number(c.caido_s), c.eventos);
    const medible = COBERTURAS[cobertura].conPorcentaje;

    return {
      device_id: c.device_id,
      equipo: c.equipo,
      mapa_id: c.mapa_id,
      mapa: c.mapa,
      cobertura,
      eventos: c.eventos,
      caidas_servicio: c.caidas_servicio,
      abiertas: c.abiertas,
      servicios: c.servicios,
      reconocidos: c.reconocidos,
      ventana_s: ventana.segundos,
      primera: aFecha(c.primera),
      ultima: aFecha(c.ultima),
      arriba_s: m.arriba_s,
      caido_s: m.caido_s,
      disponibilidad: medible ? m.disponibilidad : null,
      mtbf_s: medible ? m.mtbf_s : null,
      mttr_s: medible ? m.mttr_s : null,
      nivel: nivel(medible ? m.disponibilidad : null),
    };
  });
}

function aFecha(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Orden ───────────────────────────────────────────────────────────────────

export type Orden = 'peor' | 'eventos' | 'mttr' | 'caido' | 'nombre';

export interface MetaOrden {
  clave: Orden;
  etiqueta: string;
  /** Qué pregunta contesta este ranking. Va bajo el título de la tabla. */
  explica: string;
}

/**
 * 🔴 Tres rankings y no uno, porque «el peor» tiene tres respuestas distintas
 *    y las tres son verdad al mismo tiempo. Medido el 01/08/2026:
 *
 *      · por disponibilidad → `FabricaCanos_E_Oso`, 68,2 % (102 caídas)
 *      · por cantidad       → `OLT 20 - Peniel - SRouter1`, 2.777 caídas y
 *                             98,9 % de disponibilidad
 *      · por MTTR           → `C_MG_P_Libertad`, 2 caídas de 6 días cada una
 *
 *    El segundo aprueba cualquier contrato de 98 % y es el que tiene al
 *    operador levantándose de noche. El tercero pasa desapercibido en un
 *    conteo de eventos y es el que deja a un cliente una semana sin servicio.
 *    Un solo ranking esconde dos de los tres problemas.
 */
export const ORDENES: readonly MetaOrden[] = [
  {
    clave: 'peor',
    etiqueta: 'Peor disponibilidad',
    explica: 'Los que menos tiempo estuvieron arriba. Es la cifra del contrato.',
  },
  {
    clave: 'eventos',
    etiqueta: 'Más caídas',
    explica:
      'Los que más veces se cayeron. Un equipo que parpadea puede tener buen porcentaje y ser el que más molesta.',
  },
  {
    clave: 'mttr',
    etiqueta: 'Más tardan en volver',
    explica:
      'Mayor tiempo medio de reparación. Pocas caídas pero largas: son las que el cliente recuerda.',
  },
  {
    clave: 'caido',
    etiqueta: 'Más tiempo caído',
    explica: 'Tiempo fuera de servicio acumulado, sin promediar.',
  },
  { clave: 'nombre', etiqueta: 'Nombre', explica: 'Alfabético, para buscar un equipo puntual.' },
] as const;

export function aOrden(v: unknown): Orden | null {
  return ORDENES.some((o) => o.clave === v) ? (v as Orden) : null;
}

/**
 * Ordena una copia. Lo que no tiene dato va SIEMPRE al final, cualquiera sea el
 * criterio: un `null` que se cuela arriba de un ranking de «los peores» le pone
 * en el podio a un equipo del que no sabemos nada.
 */
export function ordenar(filas: readonly FilaDisponibilidad[], orden: Orden): FilaDisponibilidad[] {
  const porNombre = (a: FilaDisponibilidad, b: FilaDisponibilidad) =>
    a.equipo.localeCompare(b.equipo, 'es-AR');

  const copia = [...filas];
  if (orden === 'nombre') return copia.sort(porNombre);

  const clave = (f: FilaDisponibilidad): number | null => {
    switch (orden) {
      case 'peor':
        // Se invierte para que «menor disponibilidad» comparta el mismo
        // «más grande primero» que los otros tres criterios.
        return f.disponibilidad == null ? null : -f.disponibilidad;
      case 'eventos':
        return f.cobertura === 'sin-monitoreo' ? null : f.eventos;
      case 'mttr':
        return f.mttr_s;
      case 'caido':
        return f.cobertura === 'sin-monitoreo' ? null : f.caido_s;
    }
  };

  return copia.sort((a, b) => {
    const ka = clave(a);
    const kb = clave(b);
    if (ka == null && kb == null) return porNombre(a, b);
    if (ka == null) return 1;
    if (kb == null) return -1;
    return kb - ka || porNombre(a, b);
  });
}

// ── Totales ─────────────────────────────────────────────────────────────────

export interface Resumen {
  equipos: number;
  /** Cuántos llevan porcentaje: los otros no entran en el promedio. */
  medibles: number;
  confirmados: number;
  supuestos: number;
  historicos: number;
  sinMonitoreo: number;
  eventos: number;
  caidas_servicio: number;
  abiertas: number;
  caido_s: number;
  /** Tiempo arriba ÷ tiempo observado, sobre el conjunto. `null` si no hay nada medible. */
  disponibilidad: number | null;
  /** Promedio simple de los porcentajes. Ver el comentario: no es lo mismo. */
  disponibilidad_promedio: number | null;
  perfectos: number;
  bajo_99: number;
}

/**
 * 🔴 Dos promedios, y hay que mostrar los dos.
 *
 *    `disponibilidad` es tiempo arriba total ÷ tiempo observado total: la
 *    disponibilidad de la flota como una sola cosa. `disponibilidad_promedio`
 *    es el promedio de los porcentajes de cada equipo, que le da el mismo peso
 *    a una antena de barrio que a un enlace troncal.
 *
 *    Con una ventana igual para todos los equipos los dos números coinciden
 *    —medido el 01/08/2026: 99,6675 % los dos— y ahí la distinción parece
 *    pedante. Deja de serlo en cuanto un equipo tenga ventana propia, que es
 *    justo lo que pasa cuando alguien pide un período que empieza antes del
 *    horizonte de datos.
 */
export function resumir(filas: readonly FilaDisponibilidad[]): Resumen {
  const medibles = filas.filter((f) => f.disponibilidad != null);
  const ventanaTotal = medibles.reduce((t, f) => t + f.ventana_s, 0);
  const arribaTotal = medibles.reduce((t, f) => t + f.arriba_s, 0);

  return {
    equipos: filas.length,
    medibles: medibles.length,
    confirmados: filas.filter((f) => f.cobertura === 'confirmada').length,
    supuestos: filas.filter((f) => f.cobertura === 'supuesta').length,
    historicos: filas.filter((f) => f.cobertura === 'historica').length,
    sinMonitoreo: filas.filter((f) => f.cobertura === 'sin-monitoreo').length,
    eventos: filas.reduce((t, f) => t + f.eventos, 0),
    caidas_servicio: filas.reduce((t, f) => t + f.caidas_servicio, 0),
    abiertas: filas.reduce((t, f) => t + f.abiertas, 0),
    caido_s: filas.reduce((t, f) => t + f.caido_s, 0),
    disponibilidad: ventanaTotal > 0 ? (arribaTotal / ventanaTotal) * 100 : null,
    disponibilidad_promedio: medibles.length
      ? medibles.reduce((t, f) => t + (f.disponibilidad ?? 0), 0) / medibles.length
      : null,
    perfectos: medibles.filter((f) => f.eventos === 0).length,
    bajo_99: medibles.filter((f) => (f.disponibilidad ?? 100) < 99).length,
  };
}

export interface FilaMapa extends Resumen {
  mapa_id: number | null;
  mapa: string;
}

/**
 * Rollup por mapa. Los equipos que no están dibujado en ninguno caen en un
 * grupo propio en vez de desaparecer: son 1 de los 885 y son justamente los que
 * nadie mira.
 */
export function agruparPorMapa(filas: readonly FilaDisponibilidad[]): FilaMapa[] {
  const grupos = new Map<string, FilaDisponibilidad[]>();
  for (const f of filas) {
    const clave = f.mapa_id == null ? '' : String(f.mapa_id);
    const g = grupos.get(clave);
    if (g) g.push(f);
    else grupos.set(clave, [f]);
  }

  const salida: FilaMapa[] = [];
  for (const [clave, g] of grupos) {
    salida.push({
      mapa_id: clave === '' ? null : Number(clave),
      mapa: clave === '' ? 'Sin mapa' : (g[0].mapa ?? 'Sin mapa'),
      ...resumir(g),
    });
  }
  // Peor disponibilidad primero; los mapas sin nada medible, al final.
  return salida.sort(
    (a, b) =>
      (a.disponibilidad ?? Infinity) - (b.disponibilidad ?? Infinity) ||
      a.mapa.localeCompare(b.mapa, 'es-AR'),
  );
}

// ── El CSV ──────────────────────────────────────────────────────────────────

/**
 * Las columnas del reporte, en el orden en que se leen.
 *
 * 🔴 `Cobertura` y `Días observados` NO son adorno: son lo que hace que este
 *    archivo se pueda defender frente a un cliente. Un CSV con un 99,8 % suelto
 *    no dice sobre cuánto tiempo se midió ni si el equipo estaba dado de alta,
 *    y en cuanto alguien pregunte, el reporte entero se cae. Van en el archivo,
 *    no en un pie de página que se pierde al copiar y pegar.
 */
export const COLUMNAS_CSV = [
  'Equipo',
  'Mapa',
  'Disponibilidad %',
  'Cobertura',
  'Caídas (equipo)',
  'Caídas (servicio)',
  'Sin cerrar',
  'Tiempo caído (s)',
  'Tiempo arriba (s)',
  'MTBF (s)',
  'MTTR (s)',
  'Días observados',
  'Servicios habilitados',
  'Servicios reconocidos',
  'Primera caída',
  'Última recuperación',
  'ID',
] as const;

/**
 * El encabezado explicativo del archivo, antes de la tabla.
 *
 * Va adentro del CSV a propósito. El archivo se reenvía, se adjunta y se abre
 * seis meses después sin el contexto de la pantalla donde se generó: si el
 * período y el horizonte de datos no viajan con él, el número queda huérfano.
 */
export function cabeceraCsv(v: Ventana, ahora: Date = new Date()): (string | number)[][] {
  const filas: (string | number)[][] = [
    ['Reporte de disponibilidad'],
    ['Período observado', `${aFechaISP(v.desde)} a ${aFechaISP(v.hasta)}`],
    ['Días observados', (v.segundos / DIA_S).toFixed(2).replace('.', ',')],
    ['Generado', `${aFechaISP(ahora)} (hora de Argentina, UTC${DESPLAZAMIENTO_ISP})`],
  ];

  if (v.horizonte) {
    filas.push(['Primer dato en la base', aFechaISP(v.horizonte)]);
  }
  if (v.dias_recortados > 0) {
    filas.push([
      'AVISO',
      `Se pidió desde ${aFechaISP(v.pedido_desde)}, pero no hay datos anteriores al ${
        v.horizonte ? aFechaISP(v.horizonte) : '—'
      }. Se recortaron ${v.dias_recortados} días, que NO se cuentan como tiempo arriba.`,
    ]);
  }
  filas.push([
    'Caídas reconocidas',
    'Cuentan igual: "reconocido" es el estado de hoy del servicio, no del incidente.',
  ]);
  filas.push([]);
  return filas;
}

/** Una fila de datos, ya formateada para es-AR. */
export function filaCsv(f: FilaDisponibilidad): (string | number)[] {
  return [
    f.equipo,
    f.mapa ?? '',
    numeroCsv(f.disponibilidad),
    COBERTURAS[f.cobertura].etiqueta,
    f.cobertura === 'sin-monitoreo' ? '' : f.eventos,
    f.cobertura === 'sin-monitoreo' ? '' : f.caidas_servicio,
    f.abiertas,
    COBERTURAS[f.cobertura].conPorcentaje || f.cobertura === 'historica'
      ? Math.round(f.caido_s)
      : '',
    COBERTURAS[f.cobertura].conPorcentaje ? Math.round(f.arriba_s) : '',
    numeroCsv(f.mtbf_s, 0),
    numeroCsv(f.mttr_s, 0),
    numeroCsv(f.ventana_s / DIA_S, 2),
    f.servicios,
    f.reconocidos,
    f.primera ? f.primera.toISOString() : '',
    f.ultima ? f.ultima.toISOString() : '',
    f.device_id,
  ];
}

/** El archivo entero: encabezado, columnas y filas. */
export function reporteCsv(
  filas: readonly FilaDisponibilidad[],
  ventana: Ventana,
  ahora: Date = new Date(),
): string {
  return aCsv([...cabeceraCsv(ventana, ahora), [...COLUMNAS_CSV], ...filas.map(filaCsv)]);
}
