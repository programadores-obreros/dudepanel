/**
 * Acomodar los nodos de un mapa arrastrándolos, con guardado automático.
 *
 * ─── Por qué existe ──────────────────────────────────────────────────────────
 *
 * The Dude guarda coordenadas apretadas. Medido sobre los 1.146 nodos de la
 * base real: la mediana entre vecinos es de 128 unidades, pero el décimo
 * percentil está en 58 y **62 nodos quedan a menos de 40**. Con el icono
 * —que puede llegar a 88 unidades— y el rótulo debajo, esos se pisan.
 *
 * 🔴 Y el solapamiento NO está en los datos: **no hay ni un solo par de
 *    elementos en la misma coordenada.** Cero, medido. Los encimamos nosotros
 *    al dibujar más grande de lo que el original separaba. Por eso la solución
 *    no es "desapilar" nada automáticamente: es dejar que quien conoce la red
 *    la acomode como la entiende, y recordarlo.
 *
 * ─── Cómo se comporta ────────────────────────────────────────────────────────
 *
 *  · Arrastre con umbral: hasta 4 píxeles es un clic, no un movimiento. Sin
 *    esto, abrir la ficha de un equipo con un pulso poco firme lo movería.
 *  · Mientras se arrastra, los enlaces que salen del nodo siguen la punta. Un
 *    nodo que se despega de sus cables no se entiende.
 *  · Al soltar, se guarda solo. Con espera: mover cinco nodos seguidos es UN
 *    pedido, no cinco.
 *  · Ctrl/⌘ + Z deshace el último movimiento, también contra el servidor.
 *
 * ─── Y para quien no puede editar ────────────────────────────────────────────
 *
 * Este archivo ni se importa si la persona es de sólo lectura: el componente
 * decide en el servidor. La comprobación de verdad está en el endpoint, que
 * contesta 403 — ocultar el botón es cortesía, rechazar el POST es seguridad.
 */

// Este archivo se carga por su efecto, no por lo que exporta. El `export {}`
// es para que TypeScript lo trate como módulo: sin él, `import()` falla con
// «is not a module» y —peor— sus `const` de arriba caerían en el ámbito global,
// donde pueden chocar con los de cualquier otro script de la página.
export {};

const UMBRAL_PX = 4;
const ESPERA_GUARDADO_MS = 700;
const MAX_DESHACER = 50;

type Movimiento = { id: number; x: number; y: number };
type Paso = { id: number; de: [number, number]; a: [number, number] };

for (const visor of document.querySelectorAll<HTMLElement>('[data-visor][data-editable]')) {
  habilitarMovimiento(visor);
}

function habilitarMovimiento(visor: HTMLElement) {
  const svg = visor.querySelector<SVGSVGElement>('[data-svg-mapa]');
  if (!svg) return;

  /**
   * 🔴 LO QUE SE DIBUJA NO ES LO QUE SE GUARDA, Y HAY QUE RESTAR LA DIFERENCIA.
   *
   *    The Dude guarda la **esquina superior izquierda** del recuadro de un
   *    nodo. El visor lo centra: `cx = x + TAMANIO_NODO / 2`, hoy 18 unidades.
   *
   *    Si se manda al servidor la coordenada dibujada, el nodo se corre 18
   *    unidades en cada guardado y **se aleja un poco más cada vez que alguien
   *    lo toca**. No se nota en el momento —18 unidades sobre un lienzo de
   *    4.500 es nada— y por eso es peor: aparece semanas después como «el mapa
   *    se fue desarmando solo».
   *
   *    Se detectó guardando 777,888 por la API y viendo que el mapa dibujaba
   *    795,906. Arrastrando en pantalla no se habría visto nunca.
   *
   *    El número lo pasa el servidor en `data-offset-nodo` en vez de estar
   *    escrito acá: si mañana cambia `TAMANIO_NODO`, hay un solo lugar donde
   *    cambiarlo y esto lo sigue.
   */
  const OFFSET = Number(visor.dataset.offsetNodo ?? 0) || 0;

  const pendientes = new Map<number, Movimiento>();
  const historia: Paso[] = [];
  let temporizador: number | undefined;
  let arrastre: {
    nodo: SVGGraphicsElement;
    id: number;
    inicio: [number, number];   // coordenada del nodo al empezar
    origen: [number, number];   // puntero en unidades del lienzo
    movido: boolean;
    puntero: number;
  } | null = null;

  const estado = visor.querySelector<HTMLElement>('[data-estado-guardado]');

  // ── Utilidades de coordenadas ─────────────────────────────────────────────

  /** Punto del evento en las unidades en las que están las coordenadas. */
  function enLienzo(ev: PointerEvent): [number, number] {
    const capa = visor.querySelector<SVGGElement>('[data-capa]');
    const ctm = capa?.getScreenCTM();
    if (!ctm) return [0, 0];
    const p = svg!.createSVGPoint();
    p.x = ev.clientX;
    p.y = ev.clientY;
    const v = p.matrixTransform(ctm.inverse());
    return [v.x, v.y];
  }

  function posicionDe(nodo: SVGGraphicsElement): [number, number] {
    const m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(
      nodo.getAttribute('transform') ?? '',
    );
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  }

  function ubicar(nodo: SVGGraphicsElement, x: number, y: number) {
    nodo.setAttribute('transform', `translate(${x} ${y})`);
    moverEnlacesDe(nodo.dataset.id!, x, y);
  }

  /**
   * Los enlaces se dibujan como `<line>` con las cuatro coordenadas puestas
   * por el servidor. Al mover un nodo hay que reescribir la punta que le
   * corresponde a cada uno, o el cable queda flotando en el aire.
   */
  function moverEnlacesDe(id: string, x: number, y: number) {
    for (const l of svg!.querySelectorAll<SVGLineElement>(`.enlace-mapa[data-de="${id}"]`)) {
      l.setAttribute('x1', String(x));
      l.setAttribute('y1', String(y));
    }
    for (const l of svg!.querySelectorAll<SVGLineElement>(`.enlace-mapa[data-a="${id}"]`)) {
      l.setAttribute('x2', String(x));
      l.setAttribute('y2', String(y));
    }
  }

  // ── Guardado ──────────────────────────────────────────────────────────────

  function avisar(texto: string, clase: 'guardando' | 'guardado' | 'error') {
    if (!estado) return;
    estado.textContent = texto;
    estado.dataset.tono = clase;
    // `polite`: que el lector de pantalla lo lea cuando termine lo que está
    // diciendo, no que interrumpa. Un "guardado" no es una urgencia.
    estado.setAttribute('aria-live', 'polite');
  }

  function programarGuardado() {
    window.clearTimeout(temporizador);
    avisar('sin guardar', 'guardando');
    temporizador = window.setTimeout(guardar, ESPERA_GUARDADO_MS);
  }

  async function guardar() {
    if (pendientes.size === 0) return;
    const lote = [...pendientes.values()];
    pendientes.clear();
    avisar('guardando…', 'guardando');
    try {
      const r = await fetch('/api/posiciones.json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ movimientos: lote }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { motivo?: string; error?: string };
        // 403 es distinto de "se cayó la red": no sirve reintentar y hay que
        // decir por qué. Es el caso de una cuenta de sólo lectura que llegó
        // acá porque el permiso cambió mientras la página estaba abierta.
        throw new Error(r.status === 403 ? (d.motivo ?? 'no tenés permiso') : (d.error ?? `error ${r.status}`));
      }
      avisar(`guardado · ${lote.length} ${lote.length === 1 ? 'nodo' : 'nodos'}`, 'guardado');
      window.setTimeout(() => {
        if (pendientes.size === 0 && estado?.dataset.tono === 'guardado') avisar('', 'guardado');
      }, 2500);
      for (const m of lote) {
        svg!.querySelector(`.nodo-mapa[data-id="${m.id}"]`)?.setAttribute('data-movido', 'si');
      }
    } catch (e) {
      // 🔴 Se devuelven a la cola. Si no, el nodo queda movido en pantalla y
      //    sin guardar: al recargar vuelve solo a su lugar y parece que el
      //    trabajo se perdió por arte de magia. Con esto, el próximo
      //    movimiento —o el botón— reintenta todo junto.
      for (const m of lote) pendientes.set(m.id, m);
      avisar(`no se guardó: ${(e as Error).message}`, 'error');
    }
  }

  // ── Arrastre ──────────────────────────────────────────────────────────────
  //
  // 🔴 HAY QUE PEDIR PERMISO PARA MOVER: Ctrl (o ⌘) con el mouse, mantener
  //    apretado con el dedo. Un arrastre suelto NO mueve nada.
  //
  //    El motivo es que sobre un nodo conviven tres gestos que el navegador no
  //    distingue solo: abrir su ficha (clic), pasear el mapa (arrastrar el
  //    lienzo) y acomodarlo (arrastrar el nodo). Con umbral de píxeles nomás,
  //    el que quiere abrir una ficha con el pulso poco firme la mueve, y el
  //    que quiere pasear el mapa arranca desde un nodo y se lo lleva puesto.
  //
  //    El modificador convierte «casi un clic» en «esto lo hice a propósito».
  //
  //    ⚠️ En macOS `Ctrl+clic` ES el clic derecho: dispara `contextmenu` y
  //       abre el menú del navegador. Por eso se acepta también ⌘ —que ahí no
  //       choca con nada— y se cancela el `contextmenu` mientras haya un
  //       arrastre en curso. Sin esas dos líneas, en una Mac esto no anda.
  //
  //    Y en pantalla táctil no existe ningún modificador, así que el permiso
  //    lo da el tiempo: mantener el dedo quieto sobre el nodo. Es el mismo
  //    trato —«demostrá intención»— con el idioma de cada dispositivo.

  /** ms que hay que mantener el dedo quieto sobre un nodo para poder moverlo. */
  const PULSACION_LARGA_MS = 450;
  /** Cuánto se le permite temblar al dedo durante la espera, en píxeles. */
  const TEMBLOR_PX = 10;

  let esperaTactil: { temporizador: number; x: number; y: number } | null = null;

  function cancelarEsperaTactil() {
    if (!esperaTactil) return;
    window.clearTimeout(esperaTactil.temporizador);
    esperaTactil = null;
  }

  function empezarArrastre(nodo: SVGGraphicsElement, id: number, ev: PointerEvent) {
    arrastre = {
      nodo, id,
      inicio: posicionDe(nodo),
      origen: enLienzo(ev),
      movido: false,
      puntero: ev.pointerId,
    };
    try {
      nodo.setPointerCapture(ev.pointerId);
    } catch {
      // El puntero puede haberse soltado entre el toque y el disparo del
      // temporizador. No es un error: simplemente no hay nada que capturar.
    }
  }

  svg.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      const objetivo = ev.target;
      if (!(objetivo instanceof Element)) return;
      const nodo = objetivo.closest<SVGGraphicsElement>('.nodo-mapa[data-id]');
      if (!nodo) return;   // el lienzo vacío sigue siendo para el paneo

      const id = Number(nodo.dataset.id);
      if (!Number.isInteger(id)) return;

      if (ev.pointerType === 'touch') {
        // Se deja pasar el evento: si el dedo se va antes de tiempo, el mapa
        // tiene que poder pasear como siempre. El arrastre arranca recién
        // cuando vence el temporizador.
        cancelarEsperaTactil();
        esperaTactil = {
          x: ev.clientX,
          y: ev.clientY,
          temporizador: window.setTimeout(() => {
            esperaTactil = null;
            empezarArrastre(nodo, id, ev);
            visor.dataset.moviendoNodo = 'si';
            nodo.classList.add('nodo-arrastrado');
            // Un golpecito háptico avisa que el nodo quedó «en la mano». Sin
            // esto, el modo se activa sin que nada lo diga.
            navigator.vibrate?.(12);
          }, PULSACION_LARGA_MS),
        };
        return;
      }

      // Mouse y lápiz: el permiso es el modificador.
      if (!ev.ctrlKey && !ev.metaKey) return;

      // 🔴 Se frena la propagación para que el paneo del visor no arranque a
      //    la vez. Sin esto, arrastrar un nodo movería también el mapa entero
      //    y el nodo se iría al doble de velocidad que el dedo.
      ev.stopPropagation();
      ev.preventDefault();
      empezarArrastre(nodo, id, ev);
    },
    true,   // captura: antes que el paneo, que escucha en burbujeo
  );

  // macOS: `Ctrl+clic` dispara el menú contextual. Se cancela sólo mientras
  // hay un arrastre en curso, para no romper el clic derecho normal del mapa.
  svg.addEventListener('contextmenu', (ev) => {
    if (arrastre || esperaTactil) ev.preventDefault();
  });

  // ── La mano sólo cuando de verdad se puede agarrar ────────────────────────
  //
  // 🔴 El cursor es la única señal de que un nodo se puede mover. Dejarlo en
  //    `grab` permanente, ahora que hace falta Ctrl, sería prometer algo que
  //    no pasa: se ve la manito, se arrastra, no se mueve nada. Es exactamente
  //    el desconcierto que hay que evitar.
  //
  //    Así que la clase sigue a la tecla, y el CSS pinta la mano sólo mientras
  //    está apretada.
  const seguirTecla = (ev: KeyboardEvent | MouseEvent) => {
    if (ev.ctrlKey || ev.metaKey) visor.dataset.listoMover = 'si';
    else delete visor.dataset.listoMover;
  };
  document.addEventListener('keydown', seguirTecla);
  document.addEventListener('keyup', seguirTecla);
  // Al volver a la pestaña con la tecla ya suelta, `keyup` nunca llegó: el
  // primer movimiento del mouse trae el estado real de los modificadores.
  svg.addEventListener('pointermove', seguirTecla);
  window.addEventListener('blur', () => delete visor.dataset.listoMover);

  svg.addEventListener('pointermove', (ev) => {
    // Si el dedo se movió más que un temblor antes de que venciera la espera,
    // era un paseo del mapa y no una intención de acomodar. Se cancela.
    if (esperaTactil) {
      if (Math.hypot(ev.clientX - esperaTactil.x, ev.clientY - esperaTactil.y) > TEMBLOR_PX) {
        cancelarEsperaTactil();
      }
      return;
    }
    if (!arrastre || ev.pointerId !== arrastre.puntero) return;
    const [px, py] = enLienzo(ev);
    const dx = px - arrastre.origen[0];
    const dy = py - arrastre.origen[1];

    if (!arrastre.movido) {
      // El umbral se mide en PÍXELES DE PANTALLA, no en unidades del lienzo:
      // con el mapa alejado, 4 unidades pueden ser medio píxel y el umbral no
      // filtraría nada; con el mapa acercado serían dos centímetros.
      const escala = svg.getScreenCTM()?.a ?? 1;
      if (Math.hypot(dx, dy) * escala < UMBRAL_PX) return;
      arrastre.movido = true;
      visor.dataset.moviendoNodo = 'si';
      arrastre.nodo.classList.add('nodo-arrastrado');
    }

    ubicar(arrastre.nodo, Math.round(arrastre.inicio[0] + dx), Math.round(arrastre.inicio[1] + dy));
  });

  function terminar(ev: PointerEvent) {
    // Soltar antes de que venza la pulsación larga es un toque normal: abre la
    // ficha. Hay que apagar el temporizador o el nodo se «agarraría» solo
    // medio segundo después de que el dedo ya se fue.
    cancelarEsperaTactil();
    if (!arrastre || ev.pointerId !== arrastre.puntero) return;
    const a = arrastre;
    arrastre = null;
    delete visor.dataset.moviendoNodo;
    a.nodo.classList.remove('nodo-arrastrado');
    if (!a.movido) return;   // fue un clic: que abra la ficha

    const fin = posicionDe(a.nodo);
    if (fin[0] === a.inicio[0] && fin[1] === a.inicio[1]) return;

    historia.push({ id: a.id, de: a.inicio, a: fin });
    if (historia.length > MAX_DESHACER) historia.shift();
    // Dibujado → guardado: se descuenta el centrado. Ver `OFFSET`.
    pendientes.set(a.id, { id: a.id, x: fin[0] - OFFSET, y: fin[1] - OFFSET });
    programarGuardado();
  }

  svg.addEventListener('pointerup', terminar);
  svg.addEventListener('pointercancel', terminar);

  // Un arrastre no tiene que abrir la ficha del equipo.
  //
  // 🔴 LA MARCA SE LIMPIA AL EMPEZAR CADA INTERACCIÓN, no sólo al comerse un
  //    click. Antes se borraba únicamente dentro del `if`, así que si un
  //    arrastre terminaba SIN que llegara un click después —soltar fuera de un
  //    nodo, un `pointercancel`, el navegador que no sintetiza el click— la
  //    marca quedaba puesta y se comía el PRÓXIMO click legítimo.
  //
  //    El síntoma: acomodás un nodo, después hacés click en otro para abrir su
  //    ficha, y no pasa nada. Sin nada en pantalla que lo explique.
  //
  //    Una marca que dice «lo que acaba de pasar» tiene que morir cuando
  //    empieza lo siguiente. Si depende de que llegue un evento que puede no
  //    llegar, no es una marca: es una fuga de estado.
  svg.addEventListener('pointerdown', () => {
    delete visor.dataset.recienMovido;
  }, true);
  svg.addEventListener(
    'click',
    (ev) => {
      if (visor.dataset.recienMovido === 'si') {
        ev.preventDefault();
        ev.stopPropagation();
        delete visor.dataset.recienMovido;
      }
    },
    true,
  );
  svg.addEventListener('pointerup', () => {
    if (arrastre?.movido) visor.dataset.recienMovido = 'si';
  }, true);

  // ── Deshacer ──────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (ev) => {
    if (!(ev.key === 'z' && (ev.ctrlKey || ev.metaKey)) || ev.shiftKey) return;
    const paso = historia.pop();
    if (!paso) return;
    ev.preventDefault();
    const nodo = svg.querySelector<SVGGraphicsElement>(`.nodo-mapa[data-id="${paso.id}"]`);
    if (!nodo) return;
    ubicar(nodo, paso.de[0], paso.de[1]);
    pendientes.set(paso.id, { id: paso.id, x: paso.de[0] - OFFSET, y: paso.de[1] - OFFSET });
    programarGuardado();
  });

  // ── Volver todo a como lo dejó The Dude ───────────────────────────────────

  visor.querySelector<HTMLButtonElement>('[data-restablecer]')?.addEventListener('click', async (ev) => {
    const boton = ev.currentTarget as HTMLButtonElement;
    // Es destructivo —tira el acomodado de todo el mapa— así que se confirma.
    if (!window.confirm('¿Volver todos los nodos de este mapa a la posición original de The Dude?')) return;
    boton.disabled = true;
    try {
      const r = await fetch('/api/posiciones.json', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mapa: Number(visor.dataset.mapaId) }),
      });
      if (!r.ok) throw new Error(String(r.status));
      // Recargar y no recolocar a mano: las posiciones originales las tiene el
      // servidor, y pedírselas de nuevo es más simple y más difícil de
      // equivocar que reconstruirlas acá.
      window.location.reload();
    } catch {
      avisar('no se pudo restablecer', 'error');
      boton.disabled = false;
    }
  });

  // Si alguien cierra la pestaña con algo sin guardar, que no se pierda en
  // silencio. `keepalive` permite que el pedido sobreviva a la navegación.
  window.addEventListener('pagehide', () => {
    if (pendientes.size === 0) return;
    navigator.sendBeacon?.(
      '/api/posiciones.json',
      new Blob([JSON.stringify({ movimientos: [...pendientes.values()] })], {
        type: 'application/json',
      }),
    );
  });
}
