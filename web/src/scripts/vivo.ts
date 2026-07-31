/**
 * Refresco en vivo, sin recargar la página.
 *
 * El ETL escribe cada 30 s. El panel encuesta un JSON chico y parchea sólo las
 * cifras y la barra de sincronización. Nada de `location.reload()`: eso tira el
 * desplazamiento, el zoom del mapa y lo que estabas leyendo — es justamente lo
 * que hace la interfaz de 2011 que venimos a reemplazar.
 */
import { TEXTOS_SYNC } from '@/lib/textos-sync';
import type { SaludSync } from '@/lib/consultas';
import { duracion, numero, porcentaje } from '@/lib/formato';

interface Conteo {
  total: number;
  arriba: number;
  parcial: number;
  caidos: number;
  desconocidos: number;
}

interface ConteoEdad {
  reciente: number;
  arrastre: number;
  residuo: number;
  sinFecha: number;
}

interface Pulso {
  ts: string;
  salud: SaludSync;
  umbrales?: { demorada: number; vieja: number };
  sync: { salud: SaludSync; edad_s: number; ok: boolean | null; error: string | null } | null;
  resumen: {
    equipos: Conteo;
    servicios: Conteo;
    mapas: number;
    enlaces: number;
    caidas_abiertas: number;
    caidas_24h: number;
    caidos_por_antiguedad: ConteoEdad;
    desconocidos_por_antiguedad: ConteoEdad;
  };
  caidas: { id: number; abierta: boolean }[];
}

const INTERVALO_MS = 30_000;
/** Tope del retroceso exponencial cuando el servidor no contesta. */
const ESPERA_MAX_MS = 5 * 60_000;

let umbrales = { demorada: 180, vieja: 600 };
/** Antigüedad del último dato conocido y cuándo la supimos. */
let edadBase: number | null = null;
let medidaEn = Date.now();
let firmaCaidas = '';
let espera = INTERVALO_MS;
let temporizador: number | undefined;

// ── Reloj local ─────────────────────────────────────────────────────────────
// Corre aunque el servidor no responda. Es lo que convierte "no pude
// actualizar" en "no tengo datos frescos", que es lo que el operador necesita
// saber. Un panel que se congela mostrando verde miente.
setInterval(pintarSync, 5_000);

// ── Encuesta ────────────────────────────────────────────────────────────────

async function encuestar() {
  try {
    const r = await fetch('/api/estado.json', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(String(r.status));
    const p = (await r.json()) as Pulso;

    espera = INTERVALO_MS;
    if (p.umbrales) umbrales = p.umbrales;
    edadBase = p.sync?.edad_s ?? null;
    medidaEn = Date.now();

    pintarCifras(p);
    pintarSync(p.sync?.ok === false ? 'fallida' : undefined);
    await refrescarCaidas(p);
    marcarConexion(true);
  } catch {
    // Sin datos nuevos no se toca ninguna cifra: dejar la última buena y que
    // el reloj local muestre que envejece es más honesto que poner ceros.
    marcarConexion(false);
    espera = Math.min(espera * 2, ESPERA_MAX_MS);
  } finally {
    programar();
  }
}

function programar() {
  window.clearTimeout(temporizador);
  // Con la pestaña oculta el navegador estrangula los timers igual; mejor
  // pausar explícito y recuperar al volver, así no se acumulan pedidos.
  if (document.hidden) return;
  temporizador = window.setTimeout(encuestar, espera);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Volver a la pestaña tiene que sentirse instantáneo: si estuvo minimizada
    // media hora, lo primero que hace el operador es mirar si sigue todo bien.
    espera = INTERVALO_MS;
    encuestar();
  }
});
window.addEventListener('online', () => {
  espera = INTERVALO_MS;
  encuestar();
});

// ── Pintado ─────────────────────────────────────────────────────────────────

const CLAVES: Record<string, (p: Pulso) => number> = {
  'eq-total': (p) => p.resumen.equipos.total,
  'eq-arriba': (p) => p.resumen.equipos.arriba,
  'eq-parcial': (p) => p.resumen.equipos.parcial,
  'eq-caidos': (p) => p.resumen.equipos.caidos,
  'eq-desc': (p) => p.resumen.equipos.desconocidos,
  'sv-total': (p) => p.resumen.servicios.total,
  'sv-arriba': (p) => p.resumen.servicios.arriba,
  'sv-parcial': (p) => p.resumen.servicios.parcial,
  'sv-caidos': (p) => p.resumen.servicios.caidos,
  'sv-desc': (p) => p.resumen.servicios.desconocidos,
  // 🔴 El reparto por antigüedad también se refresca. Si no, el bloque «Qué
  //    mirar ahora» se quedaría congelado con la foto de cuando se abrió la
  //    pestaña, y es justamente el que tiene que moverse cuando algo se cae:
  //    un equipo nuevo caído entra en «reciente», no en «residuo».
  'eq-caidos-reciente': (p) => p.resumen.caidos_por_antiguedad?.reciente ?? 0,
  'eq-caidos-arrastre': (p) => p.resumen.caidos_por_antiguedad?.arrastre ?? 0,
  'eq-caidos-residuo': (p) => p.resumen.caidos_por_antiguedad?.residuo ?? 0,
  mapas: (p) => p.resumen.mapas,
  enlaces: (p) => p.resumen.enlaces,
  'caidas-abiertas': (p) => p.resumen.caidas_abiertas,
  'caidas-24h': (p) => p.resumen.caidas_24h,
};

function pintarCifras(p: Pulso) {
  for (const el of document.querySelectorAll<HTMLElement>('[data-vivo]')) {
    const clave = el.dataset.vivo!;
    const pct = clave.endsWith('-pct');
    const base = pct ? clave.slice(0, -4) : clave;
    const fn = CLAVES[base];
    if (!fn) continue;

    const total = base.startsWith('eq-')
      ? p.resumen.equipos.total
      : base.startsWith('sv-')
        ? p.resumen.servicios.total
        : 0;

    const texto = pct ? porcentaje(fn(p), total) : numero(fn(p));
    if (el.textContent === texto) continue;
    el.textContent = texto;
    // Marca de "esto acaba de cambiar". Se quita sola para que la próxima
    // vuelta pueda volver a marcarla.
    el.classList.remove('late');
    void el.offsetWidth;
    el.classList.add('late');
  }
}

/** Salud calculada localmente: la del servidor más el tiempo que pasó. */
function saludActual(forzada?: SaludSync): SaludSync {
  if (forzada) return forzada;
  if (edadBase == null) return 'sin-datos';
  const edad = edadBase + (Date.now() - medidaEn) / 1000;
  if (edad > umbrales.vieja) return 'vieja';
  if (edad > umbrales.demorada) return 'demorada';
  return 'fresca';
}

function pintarSync(forzada?: SaludSync) {
  const salud = saludActual(forzada);
  const t = TEXTOS_SYNC[salud];
  const edad = edadBase == null ? null : edadBase + (Date.now() - medidaEn) / 1000;

  for (const chip of document.querySelectorAll<HTMLElement>('#chip-sync')) {
    chip.dataset.salud = salud;
    const txt = chip.querySelector<HTMLElement>('[data-sync-texto]');
    if (txt) {
      txt.textContent = salud === 'fresca' && edad != null ? `Sincronizado hace ${duracion(edad)}` : t.corto;
    }
  }

  const aviso = document.querySelector<HTMLElement>('#aviso-sync');
  if (aviso) {
    aviso.dataset.salud = salud;
    aviso.hidden = salud === 'fresca';
    const titulo = aviso.querySelector<HTMLElement>('[data-aviso-titulo]');
    if (titulo) {
      titulo.textContent =
        edad != null && salud !== 'sin-datos' ? `${t.corto} · hace ${duracion(edad)}` : t.corto;
    }
    const detalle = aviso.querySelector<HTMLElement>('[data-aviso-detalle]');
    if (detalle) detalle.textContent = t.largo;
  }
}

function marcarConexion(ok: boolean) {
  document.documentElement.dataset.conexion = ok ? 'ok' : 'caida';
}

/**
 * La lista de caídas se vuelve a pedir al servidor como HTML.
 *
 * Se podría armar en el cliente, pero entonces habría dos plantillas para lo
 * mismo y en tres meses dirían cosas distintas. El servidor ya sabe dibujarla:
 * que la dibuje él. Sólo se pide cuando el conjunto de caídas cambió.
 */
async function refrescarCaidas(p: Pulso) {
  const destino = document.querySelector<HTMLElement>('#lista-caidas');
  if (!destino) return;

  const firma = p.caidas.map((c) => `${c.id}:${c.abierta ? 1 : 0}`).join(',');
  if (firma === firmaCaidas) return;

  try {
    const r = await fetch('/parciales/caidas', { headers: { accept: 'text/html' } });
    // 🔴 El servidor contesta 503 cuando no pudo LEER las caídas, y ahí no hay
    //    que pintar nada: la lista anterior es vieja pero verdadera, y el
    //    fragmento de error diría «no sé» donde antes decía algo cierto.
    //    Antes esto no existía porque el servidor devolvía 200 con la lista
    //    vacía, que el operador lee como «no hay caídas».
    if (!r.ok) return;
    destino.innerHTML = await r.text();

    // 🔴 La firma se guarda DESPUÉS de pintar, no antes.
    //
    //    Antes se guardaba arriba de todo: si el fetch fallaba, la firma ya
    //    estaba anotada como si se hubiera pintado, así que la vuelta
    //    siguiente la veía igual y NO reintentaba. La lista se quedaba
    //    congelada hasta que cambiara el conjunto de caídas — o sea, hasta que
    //    pasara justo lo que hay que mostrar.
    firmaCaidas = firma;
  } catch {
    /* Se reintenta en la próxima vuelta; la lista anterior sigue siendo válida. */
  }
}

// Primera encuesta enseguida: el HTML llegó con datos del servidor, pero si el
// operador dejó la pestaña abierta desde ayer, esos datos ya son de ayer.
programar();
