/**
 * Zoom, paneo y refresco del visor de mapas.
 *
 * Todo el dibujo lo hace el servidor: este script sólo mueve una matriz y
 * cambia atributos `data-estado`. Consecuencias buscadas:
 *
 *  · El mapa se ve completo aunque el JavaScript no cargue nunca. Los nodos son
 *    `<a>` de verdad, así que también se navegan con teclado sin este archivo.
 *  · Con 401 elementos, mover el mapa es UNA escritura de atributo en un
 *    `<g>`, no 401 recálculos de posición.
 */
import { estadoAgregado, metaEstado, type Estado } from '@/lib/estado';

const peor = (a: unknown, b: unknown): Estado => estadoAgregado([a, b].filter((x) => x != null));

const ESCALA_MIN = 0.15;
const ESCALA_MAX = 8;
const INTERVALO_MS = 30_000;

for (const visor of document.querySelectorAll<HTMLElement>('[data-visor]')) {
  iniciar(visor);
}

function iniciar(visor: HTMLElement) {
  const svg = visor.querySelector<SVGSVGElement>('[data-svg-mapa]');
  const capa = visor.querySelector<SVGGElement>('[data-capa]');
  if (!svg || !capa) return;

  let k = 1;
  let tx = 0;
  let ty = 0;
  let pendiente = false;

  // ── Transformación ────────────────────────────────────────────────────────

  function aplicar() {
    if (pendiente) return;
    pendiente = true;
    // Una sola escritura por cuadro: la rueda del mouse dispara decenas de
    // eventos por segundo y sin esto el navegador recompone el SVG en cada uno.
    requestAnimationFrame(() => {
      pendiente = false;
      capa!.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
      const nivel = visor.querySelector<HTMLElement>('[data-nivel-zoom]');
      if (nivel) nivel.textContent = `${Math.round(k * 100)} %`;
      // La tarjeta emergente está anclada a la posición en pantalla de un nodo
      // que se acaba de mover. Se avisa una vez por cuadro, no por evento.
      document.dispatchEvent(new CustomEvent('mapa:movido'));
    });
  }

  /** Coordenadas del evento en unidades del viewBox. */
  function enViewBox(cx: number, cy: number): { x: number; y: number } {
    const ctm = svg!.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = svg!.createSVGPoint();
    p.x = cx;
    p.y = cy;
    const v = p.matrixTransform(ctm.inverse());
    return { x: v.x, y: v.y };
  }

  /** Acerca o aleja manteniendo fijo el punto de pantalla (cx, cy). */
  function zoomEn(factor: number, cx: number, cy: number) {
    const nueva = Math.min(Math.max(k * factor, ESCALA_MIN), ESCALA_MAX);
    if (nueva === k) return;
    const v = enViewBox(cx, cy);
    // El punto del contenido bajo el cursor no se puede mover: es lo que hace
    // que acercarse se sienta como acercarse y no como saltar.
    const lx = (v.x - tx) / k;
    const ly = (v.y - ty) / k;
    k = nueva;
    tx = v.x - k * lx;
    ty = v.y - k * ly;
    aplicar();
  }

  function centroPantalla(): [number, number] {
    const r = svg!.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  function ajustar() {
    // El viewBox que emite el servidor ya encuadra el contenido, así que
    // "ajustar" es volver a la identidad. Nada de recalcular la caja.
    k = 1;
    tx = 0;
    ty = 0;
    aplicar();
  }

  // ── Rueda y pellizco ──────────────────────────────────────────────────────

  svg.addEventListener(
    'wheel',
    (ev) => {
      // El lienzo tiene alto propio y no se lleva el scroll de la página; sin
      // preventDefault el gesto natural sobre un mapa (acercar) haría scroll.
      ev.preventDefault();
      // deltaMode 1 = líneas (Firefox), 2 = páginas. Normalizar o en Firefox
      // cada muesca daría un salto enorme.
      const unidad = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
      zoomEn(Math.exp((-ev.deltaY * unidad) / 500), ev.clientX, ev.clientY);
    },
    { passive: false },
  );

  const punteros = new Map<number, { x: number; y: number }>();
  let pellizco: { dist: number; cx: number; cy: number } | null = null;

  /**
   * 🔴 EL PUNTERO SE CAPTURA RECIÉN CUANDO HAY ARRASTRE. Y esto arreglaba un
   *    defecto que llevaba mucho tiempo escondido.
   *
   *    Acá se llamaba a `setPointerCapture` en CADA `pointerdown`. Con el
   *    puntero capturado por el SVG, todos los eventos siguientes se
   *    redirigen a él — y el `click` termina disparándose en el SVG y no en
   *    el `<a>` del nodo. **Un click en un equipo nunca abría su ficha.**
   *
   *    No se notaba porque la tarjeta flotante quedaba encima del nodo y era
   *    interactiva: lo que navegaba era un enlace DE LA TARJETA. Y como la
   *    tarjeta se coloca a la derecha —sobre el nodo de al lado— y trae un
   *    enlace al PADRE CAÍDO, el resultado era «hago click en un equipo y se
   *    va a otro equipo». Reportado exactamente así.
   *
   *    Al quitarle el puntero a la tarjeta —para que dejara de robar clicks—
   *    el defecto de fondo quedó a la vista: dejó de navegar del todo.
   *
   *    Capturando sólo cuando el dedo o el mouse SE MUEVE de verdad, un click
   *    quieto es un click normal: abre la ficha, `Ctrl+clic` la abre en otra
   *    pestaña, el botón del medio también, y el menú contextual funciona.
   *    Todo eso lo daba el navegador y lo estábamos tirando.
   */
  /**
   * Registro del recorrido de un click, apagado salvo que se pida.
   *
   * 🔴 Este mapa tuvo dos defectos seguidos en la misma interacción —la
   *    tarjeta robando clicks y el puntero capturado comiéndoselos— y las dos
   *    veces hubo que deducir el mecanismo leyendo código, porque desde afuera
   *    lo único visible era «hace algo raro».
   *
   *    Se enciende desde la consola del navegador:
   *
   *        localStorage.setItem('mapa:debug', '1')   // y recargar
   *        localStorage.removeItem('mapa:debug')     // para apagarlo
   *
   *    Apagado no cuesta nada —una lectura de `localStorage` al cargar— y
   *    encendido dice exactamente qué recibió cada paso.
   */
  const DEPURAR = (() => {
    try {
      return localStorage.getItem('mapa:debug') === '1';
    } catch {
      return false; // localStorage bloqueado: no es motivo para no dibujar el mapa
    }
  })();
  const log = (...a: unknown[]) => DEPURAR && console.info('[mapa]', ...a);
  if (DEPURAR) log('depuración encendida · localStorage.removeItem("mapa:debug") para apagarla');

  const UMBRAL_ARRASTRE = 4;
  const capturados = new Set<number>();
  // Alias no nulo: `svg` ya pasó su guarda más arriba, pero TypeScript no
  // puede mantener ese estrechamiento dentro de una función declarada acá.
  const lienzo = svg;

  // Por ID y no por evento: para el pellizco hay que capturar el PRIMER dedo
  // cuando llega el segundo, y ahí no se tiene su evento a mano. Un
  // `{ ...ev, pointerId }` no sirve —`PointerEvent` expone accesores, no
  // propiedades propias, así que el spread copia un objeto vacío.
  const capturar = (id: number) => {
    if (capturados.has(id)) return;
    capturados.add(id);
    lienzo.setPointerCapture(id);
    visor.dataset.arrastrando = 'si';
  };

  svg.addEventListener('pointerdown', (ev) => {
    // Botón secundario y medio se dejan al navegador (menú contextual, pegar).
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // Con dos dedos es un pellizco desde el primer instante: ahí sí hay que
    // capturar ya, o el segundo dedo se pierde apenas sale del SVG.
    if (punteros.size === 2) {
      for (const id of punteros.keys()) capturar(id);
      pellizco = medirPellizco();
    }
    const n = (ev.target as Element | null)?.closest?.('.nodo-mapa');
    log('pointerdown', {
      tipo: ev.pointerType,
      boton: ev.button,
      sobre: n ? n.getAttribute('data-rotulo') : '(lienzo)',
      href: n?.getAttribute('href') ?? null,
    });
  });

  svg.addEventListener('pointermove', (ev) => {
    const previo = punteros.get(ev.pointerId);
    if (!previo) return;
    const dx = ev.clientX - previo.x;
    const dy = ev.clientY - previo.y;
    // Recién acá se decide que esto es un arrastre y no un click.
    if (!capturados.has(ev.pointerId)) {
      if (Math.hypot(dx, dy) < UMBRAL_ARRASTRE) return;
      log('arrastre: se captura el puntero', { dx, dy });
      capturar(ev.pointerId);
    }
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (punteros.size >= 2) {
      const ahora = medirPellizco();
      if (pellizco && ahora && pellizco.dist > 0) {
        zoomEn(ahora.dist / pellizco.dist, ahora.cx, ahora.cy);
      }
      pellizco = ahora;
      return;
    }

    // El desplazamiento se mide en píxeles de pantalla y hay que llevarlo a
    // unidades del viewBox, que dependen de cuánto se achicó el SVG al entrar
    // en el contenedor.
    const ctm = svg.getScreenCTM();
    const escalaPantalla = ctm?.a || 1;
    tx += dx / escalaPantalla;
    ty += dy / escalaPantalla;
    aplicar();
  });

  const soltar = (ev: PointerEvent) => {
    punteros.delete(ev.pointerId);
    capturados.delete(ev.pointerId);
    if (punteros.size < 2) pellizco = null;
    if (punteros.size === 0) delete visor.dataset.arrastrando;
  };
  svg.addEventListener('pointerup', soltar);
  svg.addEventListener('pointercancel', soltar);
  svg.addEventListener('lostpointercapture', soltar);

  function medirPellizco() {
    const [a, b] = [...punteros.values()];
    if (!a || !b) return null;
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  // Un arrastre no debe abrir el enlace del nodo que quedó debajo del dedo.
  let arrastroDe = 0;
  svg.addEventListener('pointerdown', (ev) => {
    arrastroDe = ev.clientX + ev.clientY;
  });
  svg.addEventListener(
    'click',
    (ev) => {
      const n = (ev.target as Element | null)?.closest?.('.nodo-mapa');
      const movido = Math.abs(ev.clientX + ev.clientY - arrastroDe);
      if (movido > 6) {
        log('click DESCARTADO: fue un arrastre', { movido });
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      log('click', {
        sobre: n ? n.getAttribute('data-rotulo') : '(lienzo)',
        href: n?.getAttribute('href') ?? null,
        // Si esto no es el `<a>` del nodo, el navegador NO va a navegar: es
        // exactamente el síntoma que produjo el puntero capturado de más.
        objetivo: (ev.target as Element | null)?.tagName ?? '?',
        capturados: capturados.size,
      });
    },
    true,
  );

  // ── Botones y teclado ─────────────────────────────────────────────────────

  for (const b of visor.querySelectorAll<HTMLButtonElement>('[data-zoom]')) {
    b.addEventListener('click', () => {
      const dir = Number(b.dataset.zoom) || 1;
      zoomEn(dir > 0 ? 1.35 : 1 / 1.35, ...centroPantalla());
    });
  }
  visor.querySelector('[data-ajustar]')?.addEventListener('click', ajustar);

  // ── Atenuar residuos ──────────────────────────────────────────────────────
  //
  // Una clase en el contenedor y listo: el CSS hace el resto para los N nodos
  // de una sola vez. Nada de recorrerlos.
  const atenuar = visor.querySelector<HTMLButtonElement>('[data-atenuar]');
  if (atenuar) {
    visor.dataset.atenuarResiduos = 'si';
    atenuar.addEventListener('click', () => {
      const encendido = atenuar.getAttribute('aria-pressed') === 'true';
      atenuar.setAttribute('aria-pressed', encendido ? 'false' : 'true');
      if (encendido) delete visor.dataset.atenuarResiduos;
      else visor.dataset.atenuarResiduos = 'si';
    });
  }

  svg.addEventListener('keydown', (ev) => {
    // Sólo cuando el foco está en el lienzo, no en un nodo: con el foco en un
    // nodo las flechas tienen que seguir sirviendo para leer con el lector.
    if (ev.target !== svg) return;
    const paso = (ev.shiftKey ? 200 : 60) / (svg.getScreenCTM()?.a || 1);
    const acciones: Record<string, () => void> = {
      ArrowLeft: () => (tx += paso),
      ArrowRight: () => (tx -= paso),
      ArrowUp: () => (ty += paso),
      ArrowDown: () => (ty -= paso),
      '+': () => zoomEn(1.35, ...centroPantalla()),
      '=': () => zoomEn(1.35, ...centroPantalla()),
      '-': () => zoomEn(1 / 1.35, ...centroPantalla()),
      '0': ajustar,
    };
    const fn = acciones[ev.key];
    if (!fn) return;
    ev.preventDefault();
    fn();
    aplicar();
  });

  // Al llegar el foco a un nodo por Tab, traerlo a la vista si quedó fuera.
  // Sin esto, tabular por un mapa grande con zoom es navegar a ciegas.
  //
  // 🔴 Delegado, no una escucha por nodo. Antes eran 401 `addEventListener` en
  //    el arranque del mapa más grande; ahora es uno. `focus` no burbujea, pero
  //    `focusin` sí, que es exactamente para esto.
  svg.addEventListener('focusin', (ev) => {
    const objetivo = ev.target;
    if (!(objetivo instanceof Element)) return;
    const nodo = objetivo.closest('.nodo-mapa[tabindex]');
    if (nodo) acercarA(nodo as unknown as SVGGraphicsElement);
  });

  function acercarA(nodo: SVGGraphicsElement) {
    const caja = nodo.getBoundingClientRect();
    const vista = svg!.getBoundingClientRect();
    const margen = 40;
    let dx = 0;
    let dy = 0;
    if (caja.left < vista.left + margen) dx = vista.left + margen - caja.left;
    if (caja.right > vista.right - margen) dx = vista.right - margen - caja.right;
    if (caja.top < vista.top + margen) dy = vista.top + margen - caja.top;
    if (caja.bottom > vista.bottom - margen) dy = vista.bottom - margen - caja.bottom;
    if (!dx && !dy) return;
    const escala = svg!.getScreenCTM()?.a || 1;
    tx += dx / escala;
    ty += dy / escala;
    aplicar();
  }

  // ── Refresco de estados ───────────────────────────────────────────────────

  const mapaId = visor.dataset.mapaId;
  if (mapaId) refrescoPeriodico(svg, mapaId);
}

function refrescoPeriodico(svg: SVGSVGElement, mapaId: string) {
  let espera = INTERVALO_MS;
  let temporizador: number | undefined;

  const nodos = new Map<string, SVGGraphicsElement>();
  for (const n of svg.querySelectorAll<SVGGraphicsElement>('.nodo-mapa[data-id]')) {
    nodos.set(n.dataset.id!, n);
  }

  async function tick() {
    try {
      const r = await fetch(`/api/mapa/${encodeURIComponent(mapaId)}.json`, {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(String(r.status));
      const datos = (await r.json()) as { estados: [number, Estado][] };
      aplicarEstados(datos.estados ?? []);
      espera = INTERVALO_MS;
    } catch {
      // Sin datos nuevos el mapa queda como estaba. La barra de sincronización
      // del encabezado es la que avisa que la foto envejeció; duplicar el aviso
      // acá sólo agregaría ruido.
      espera = Math.min(espera * 2, 5 * 60_000);
    } finally {
      window.clearTimeout(temporizador);
      if (!document.hidden) temporizador = window.setTimeout(tick, espera);
    }
  }

  function aplicarEstados(pares: [number, Estado][]) {
    const porNodo = new Map<string, Estado>();
    for (const [id, s] of pares) porNodo.set(String(id), s);

    for (const [id, estado] of porNodo) {
      const nodo = nodos.get(id);
      if (!nodo || nodo.dataset.estado === String(estado)) continue;
      nodo.dataset.estado = String(estado);
      const m = metaEstado(estado);
      const glifo = nodo.querySelector('[data-glifo]');
      if (glifo) glifo.textContent = m.glifo;

      // 🔴 El estado ACABA de cambiar, así que su antigüedad es cero. Sin esta
      //    línea, un residuo de 2022 que revive —o un equipo sano que se cae—
      //    conservaría el `data-antiguedad` con el que llegó la página, y el
      //    mapa seguiría atenuando la única novedad de la noche. Es el peor
      //    error posible en este eje y por eso se corrige acá y no al recargar.
      if (estado === 1) delete nodo.dataset.antiguedad;
      else nodo.dataset.antiguedad = 'reciente';
      nodo.dataset.edad = '0';

      // La etiqueta accesible tiene que seguir al color; si no, el lector de
      // pantalla anuncia un estado que ya no es. Se rearma de las partes en vez
      // de parchear la cadena, que con nombres que traen guiones se rompe.
      const base = nodo.dataset.rotulo;
      const texto = `${base} — ${m.etiqueta}${nodo.dataset.ips ?? ''} — cambió recién`;
      if (base) nodo.setAttribute('aria-label', texto);

      const titulo = nodo.querySelector('title');
      if (titulo && base) titulo.textContent = texto;
    }

    // Un enlace vale lo que valen sus puntas: se recalcula con el peor de las
    // dos, igual que lo hizo el servidor al dibujarlo.
    for (const linea of svg.querySelectorAll<SVGLineElement>('.enlace-mapa[data-de]')) {
      const a = nodos.get(linea.dataset.de!)?.dataset.estado;
      const b = nodos.get(linea.dataset.a ?? '')?.dataset.estado;
      linea.dataset.estado = String(peor(a, b));
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      espera = INTERVALO_MS;
      tick();
    }
  });

  temporizador = window.setTimeout(tick, espera);
}
