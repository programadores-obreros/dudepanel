import { entero } from './entorno';

/**
 * ¿Este equipo sigue en servicio, o es arrastre de un mapa que nadie actualizó?
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * De los 885 equipos de la instalación medida, sólo 465 dieron alguna señal de
 * vida en 30 días. Los otros 420 son bajas: la red cambió y los mapas no. Y no
 * es un detalle estético — **325 de ellos siguen con el sondeo habilitado**, o
 * sea que se los mide, se cuentan sus caídas y se avisa por ellos.
 *
 * Una alarma que suena por algo que ya no está no es una alarma: es ruido que
 * entrena a la gente a ignorar las alarmas de verdad. Ese es el daño real, y es
 * acumulativo.
 *
 * ── 🔴 La trampa, que es el corazón de este módulo ──────────────────────────
 *
 * **LA AUSENCIA DE EVIDENCIA NO ES EVIDENCIA DE BAJA.**
 *
 * Un equipo impecable durante 30 días y uno desmantelado en 2021 son IGUAL de
 * silenciosos si la pregunta es «¿tuvo caídas?». El primero no tuvo ninguna
 * porque anduvo bien; el segundo, porque no existe. Contestar esa pregunta con
 * «no tuvo caídas → está bien» los confunde a los dos.
 *
 * Por eso `ultima_senal` se construye con evidencia POSITIVA: una medición
 * mayor que cero, una caída que empezó, una caída que terminó, o estar arriba
 * ahora mismo. Cosas que sólo pueden haber pasado si el equipo estaba ahí.
 *
 * ── Por qué tres estados y no dos ───────────────────────────────────────────
 *
 * «Activo o basura» es la simplificación que arruina esto. Una escuela apagada
 * en receso se ve exactamente igual que un equipo desmantelado, y la diferencia
 * no está en los datos: está en la cabeza de alguien. El estado del medio
 * —`dudoso`— existe para que esa persona tenga dónde mirar antes de que el
 * panel decida por ella.
 */

export type Vida = 'activo' | 'dudoso' | 'baja';

/**
 * Hasta acá, el equipo está en servicio.
 *
 * 30 días y no 7: un enlace de respaldo que se prueba una vez por mes es un
 * equipo perfectamente vivo, y con una ventana de una semana desaparecería del
 * mapa entre prueba y prueba.
 */
export const DIAS_ACTIVO = entero('VIDA_DIAS_ACTIVO', 30);

/**
 * A partir de acá se lo da de baja.
 *
 * 🔴 Y el número tiene un techo que no depende de nosotros: la base viva se
 *    rearmó de cero el 12/06/2026 tras chocar el límite de 2 GB, así que la
 *    historia de The Dude arranca ahí. Poner 180 días en una base de 50 no
 *    clasificaría a nadie como baja: todos caerían en `dudoso` para siempre.
 *
 *    Por eso `clasificar` recibe el ALCANCE real de la historia y se niega a
 *    declarar una baja que la ventana no puede sostener. Ver `alcanceDias`.
 */
export const DIAS_BAJA = entero('VIDA_DIAS_BAJA', 90);

export interface MetaVida {
  clave: Vida;
  etiqueta: string;
  explica: string;
  /** Qué hace el mapa con él por defecto. */
  enMapa: 'visible' | 'atenuado' | 'oculto';
}

const META: Record<Vida, MetaVida> = {
  activo: {
    clave: 'activo',
    etiqueta: 'Activo',
    explica: `Dio señales de vida en los últimos ${DIAS_ACTIVO} días. Está en servicio y sus alarmas cuentan.`,
    enMapa: 'visible',
  },
  dudoso: {
    clave: 'dudoso',
    etiqueta: 'Dudoso',
    explica: `Callado hace más de ${DIAS_ACTIVO} días, pero no lo suficiente para darlo de baja. Puede ser un equipo apagado a propósito.`,
    enMapa: 'atenuado',
  },
  baja: {
    clave: 'baja',
    etiqueta: 'De baja',
    explica: `Sin una sola señal en más de ${DIAS_BAJA} días. Casi seguro ya no existe: se oculta del mapa y no genera alarmas.`,
    enMapa: 'oculto',
  },
};

/** En el orden en que se muestran: primero lo que importa. */
export const VIDAS: MetaVida[] = [META.activo, META.dudoso, META.baja];

export function metaVida(v: Vida): MetaVida {
  return META[v];
}

/** Lo que la vista `v_device_estado` sabe de un equipo. */
export interface SenalDeVida {
  /** Días desde la última evidencia positiva. `null` = nunca hubo ninguna. */
  dias_sin_senal: number | null;
  /** Está arriba en este momento: prueba de vida que no admite discusión. */
  arriba_ahora: boolean;
  /** Veredicto humano, si alguien lo firmó. Gana siempre. */
  estado_manual: 'activo' | 'baja' | null;
}

export interface Veredicto {
  vida: Vida;
  /** `true` si lo decidió una persona y no el cálculo. */
  manual: boolean;
  /**
   * Por qué dio eso, en una línea, para mostrárselo a quien pregunte.
   * Una clasificación que esconde equipos del mapa tiene que poder explicarse.
   */
  motivo: string;
}

/**
 * @param s        lo que sabemos del equipo
 * @param alcanceDias  cuántos días de historia hay REALMENTE disponibles.
 *
 * 🔴 `alcanceDias` no es un adorno defensivo: sin él, un equipo vivo en una
 *    base recién rearmada se clasifica como baja.
 *
 *    Con 50 días de historia y un corte de 90, ningún silencio puede superar
 *    el corte, así que nadie debería salir de baja. Pero un equipo SIN NINGUNA
 *    señal (`dias_sin_senal === null`) parecería infinitamente viejo y caería
 *    en `baja` — cuando la verdad es «no sé, no tengo con qué mirar».
 *
 *    Con la base rearmada el 12/06/2026, eso son cientos de equipos ocultados
 *    del mapa por una respuesta que los datos no pueden dar.
 */
export function clasificar(s: SenalDeVida, alcanceDias: number): Veredicto {
  if (s.estado_manual === 'baja') {
    return { vida: 'baja', manual: true, motivo: 'Dado de baja por una persona.' };
  }
  if (s.estado_manual === 'activo') {
    return {
      vida: 'activo',
      manual: true,
      motivo: 'Marcado como en servicio por una persona, aunque esté callado.',
    };
  }

  if (s.arriba_ahora) {
    return { vida: 'activo', manual: false, motivo: 'Está respondiendo ahora mismo.' };
  }

  if (s.dias_sin_senal === null) {
    // Nunca hubo evidencia. Si la historia disponible ya es más larga que el
    // corte de baja, el silencio ES la respuesta. Si no, seguimos sin saber, y
    // «no sé» se dice `dudoso`, nunca `baja`.
    return alcanceDias >= DIAS_BAJA
      ? {
          vida: 'baja',
          manual: false,
          motivo: `Ni una señal en los ${alcanceDias} días de historia que hay.`,
        }
      : {
          vida: 'dudoso',
          manual: false,
          motivo: `Sin señales, pero sólo hay ${alcanceDias} días de historia: no alcanza para darlo de baja.`,
        };
  }

  if (s.dias_sin_senal <= DIAS_ACTIVO) {
    return {
      vida: 'activo',
      manual: false,
      motivo:
        s.dias_sin_senal === 0
          ? 'Dio señales hoy.'
          : `Dio señales hace ${s.dias_sin_senal} ${s.dias_sin_senal === 1 ? 'día' : 'días'}.`,
    };
  }

  if (s.dias_sin_senal >= DIAS_BAJA) {
    return {
      vida: 'baja',
      manual: false,
      motivo: `Callado hace ${s.dias_sin_senal} días.`,
    };
  }

  return {
    vida: 'dudoso',
    manual: false,
    motivo: `Callado hace ${s.dias_sin_senal} días. Todavía no alcanza para darlo de baja.`,
  };
}

/**
 * ¿Este equipo debe generar alarmas?
 *
 * 🔴 Sólo los activos. Es el punto de todo esto.
 *
 *    Un `dudoso` tampoco alarma — y esa es una decisión con costo: si estaba
 *    apagado a propósito y alguien lo enciende, la primera caída no va a sonar.
 *    Se elige igual, porque el error opuesto —cientos de alarmas por equipos
 *    que no existen— es el que hace que la gente deje de mirar el panel. Y un
 *    panel que nadie mira no avisa de nada.
 *
 *    El rescate es explícito: marcar el equipo como `activo` a mano.
 */
export function alarma(v: Vida): boolean {
  return v === 'activo';
}

/**
 * El mismo criterio de «activo», escrito en SQL.
 *
 * 🔴 Una regla escrita dos veces es una regla que algún día va a decir dos
 *    cosas distintas. Esto existe igual, y hay que saber por qué.
 *
 *    El historial de caídas se PAGINA: no se pueden traer 12.000 filas para
 *    clasificarlas en JavaScript y quedarse con la primera página. El filtro
 *    tiene que estar en el `WHERE`, y punto.
 *
 *    La contención es `test/vida.test.ts`, que corre este predicado contra
 *    Postgres sobre una matriz de casos y lo compara fila por fila con
 *    `clasificar()`. Si alguien toca una de las dos y no la otra, el test se
 *    pone rojo. Es el mismo trato que se usó para la lista de rangos privados
 *    en `camino`: dos expresiones, un solo significado, y una prueba que las
 *    ata.
 *
 * Ojo con lo que NO aparece acá: `alcanceDias`. No es un olvido — el alcance
 * sólo decide entre `dudoso` y `baja` cuando no hay ninguna señal, y ninguno
 * de esos dos es «activo». Para esta pregunta no cambia nada.
 *
 * @param alias  alias de la tabla o vista con las columnas de `v_device_estado`
 * @param dias   marcador de parámetro para el umbral, p. ej. `'$4'`
 */
export function sqlEsActivo(alias: string, dias: string): string {
  // 🔴 El COALESCE de afuera no es adorno, y lo encontró el test.
  //
  //    Con `estado_manual` en NULL —el caso NORMAL, la mayoría de los equipos—
  //    `estado_manual = 'activo'` no vale `false`: vale NULL. Y `NULL OR false`
  //    en SQL es NULL, no false.
  //
  //    Dentro de un WHERE no se nota, porque NULL filtra igual que false. Se
  //    nota el día que alguien escriba `NOT (…)` esperando «los que no están
  //    activos» y reciba cero filas, o lo meta en un CASE y caiga siempre al
  //    ELSE. Un predicado que a veces contesta «no sé» no es un booleano.
  return `COALESCE(${alias}.estado_manual = 'activo'
        OR (${alias}.estado_manual IS DISTINCT FROM 'baja'
            AND (${alias}.arriba_ahora OR ${alias}.dias_sin_senal <= ${dias})), false)`;
}
