/**
 * ════════════════════════════════════════════════════════════════════════════
 *  La tarjeta que aparece al apuntar un nodo del mapa.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Lo que un operador necesita saber de un equipo SIN tener que hacer clic y sin
 * perder el mapa que venía mirando.
 *
 * ── Las tres decisiones que definen esto ────────────────────────────────────
 *
 * **1 · El contenido lo pide al servidor, no viene con la página. Está medido,
 *       y el resultado NO fue el que esperaba.**
 *
 *    Medido sobre `Ponte`, el mapa más pesado del panel (95 nodos con equipo
 *    detrás), contra el servidor de producción:
 *
 *      la página sola                    217,5 kB  →  34,1 kB con brotli
 *      la página + las 95 tarjetas       474,9 kB  →  41,7 kB con brotli
 *
 *    O sea: **el doble en crudo y apenas 7,6 kB más comprimido.** Yo esperaba
 *    que el argumento fuera el ancho de banda y no lo es — el HTML de 95
 *    tarjetas es tan repetitivo que brotli se lo come. Si la decisión
 *    dependiera de los bytes que viajan, incrustarlas ganaba.
 *
 *    Se piden igual, y por dos razones que sí se sostienen:
 *
 *    · **Una tarjeta incrustada nace vieja.** El panel refresca los estados
 *      cada 30 s sin recargar; una tarjeta escrita en el HTML inicial diría
 *      «caído hace 3 min» toda la noche, y el operador que la abre a las 5 AM
 *      leería un dato de las 22. Todo este trabajo existe justamente para que
 *      el panel no mienta sobre el tiempo.
 *    · **Son 257 kB de HTML que el teléfono tiene que analizar y sostener en el
 *      DOM** para mostrar tres o cuatro. Lo que se ahorra no es la descarga: es
 *      el trabajo del aparato más lento de la cadena.
 *
 *    Lo que SÍ viaja con la página es lo poco que hace falta para que la
 *    tarjeta aparezca llena en el mismo cuadro en que se muestra: `data-dev`,
 *    `data-antiguedad` y `data-edad`. Medido: el mapa entero creció entre 7 %
 *    y 16 % comprimido (`Ponte` 31,9 → 34,1 kB), y esos atributos ya hacían
 *    falta para atenuar los residuos.
 *
 *    El resto llega por `/parciales/nodo/<id>`: **2,7 kB, 0,93 kB comprimido,
 *    servido en 5 ms.** Y el viaje arranca al APUNTAR, no al mostrar: hay
 *    140 ms de demora deliberada antes de que la tarjeta aparezca y el pedido
 *    sale en el milisegundo cero, así que en la práctica ya llegó.
 *
 * **2 · Demora para mostrar, tolerancia para ocultar.**
 *
 *    Cruzar el mapa de una punta a la otra pasa por encima de diez nodos. Sin
 *    demora, eso son diez tarjetas parpadeando. Con 140 ms, apuntar a propósito
 *    la abre y pasar de largo no. Y al salir hay 260 ms de gracia más el camino
 *    hacia la propia tarjeta, porque el mouse no viaja en línea recta y una
 *    tarjeta que se cierra cuando vas a hacerle clic es peor que no tenerla.
 *
 * **3 · En pantalla táctil no hay «apuntar», así que la tarjeta es otra cosa.**
 *
 *    Un toque sobre un nodo de 22 unidades en un teléfono es difícil de acertar
 *    y, si acierta, hoy te saca del mapa —y lo caro de recuperar es el mapa: el
 *    zoom y el encuadre que el operador acomodó. Con dedo, el toque **siempre**
 *    abre una hoja abajo de todo, ancha y legible, con «Abrir la ficha completa»
 *    escrito adentro. Nunca navega solo.
 *
 *    Descarté el patrón clásico de «primer toque muestra, segundo navega»: un
 *    toque que a veces informa y a veces te saca de la pantalla es una ruleta.
 *    Son dos toques igual, pero el segundo dice adónde va.
 *
 *    El arrastre se distingue del toque con el mismo umbral que ya usa el visor
 *    para no abrir enlaces al mover el mapa.
 */
import { metaAntiguedad, porSegundos, type Antiguedad } from '@/lib/antiguedad';
import { metaEstado } from '@/lib/estado';
import { duracion } from '@/lib/formato';

/** Cuánto hay que apuntar a propósito para que aparezca. */
const DEMORA_MOSTRAR = 140;
/** Cuánta gracia hay al salir, para poder ir hacia la tarjeta. */
const DEMORA_OCULTAR = 260;
/** Aire entre la tarjeta y el nodo, y contra los bordes de la ventana. */
const AIRE = 12;
/** Más que esto ya es un arrastre, no un toque. Igual que en `visor-mapa`. */
const UMBRAL_TOQUE = 8;

const tarjeta = document.querySelector<HTMLElement>('[data-tarjeta]');
const cuerpo = tarjeta?.querySelector<HTMLElement>('[data-tarjeta-cuerpo]');
const resumen = document.querySelector<HTMLElement>('[data-tarjeta-resumen]');
const cerrar = tarjeta?.querySelector<HTMLElement>('[data-tarjeta-cerrar]');

if (tarjeta && cuerpo) iniciar(tarjeta, cuerpo);

function iniciar(tarjeta: HTMLElement, cuerpo: HTMLElement) {
  /** HTML ya traído, por id de equipo. Un nodo se vuelve a apuntar mucho. */
  const cache = new Map<string, string>();
  const enVuelo = new Map<string, Promise<string>>();

  let actual: SVGGraphicsElement | null = null;
  let temporizadorMostrar: number | undefined;
  let temporizadorOcultar: number | undefined;
  let sobreTarjeta = false;
  /** En modo hoja (táctil) la tarjeta se queda hasta que la cierren. */
  let fijada = false;
  let generacion = 0;

  /**
   * 🔴 Acá NO se pregunta `matchMedia('(hover: none), (pointer: coarse)')`.
   *
   *    Era lo primero que hice y estaba mal por los dos lados. Chrome sin
   *    cabeza contesta `true` —«esto es un teléfono»— y con esa respuesta la
   *    tarjeta no aparecía nunca al apuntar con el mouse; lo mismo le pasa a
   *    cualquier notebook con pantalla táctil, que tiene las dos cosas y por
   *    eso mismo no se puede clasificar de antemano.
   *
   *    Lo que decide es el `pointerType` de CADA evento: el mismo aparato puede
   *    recibir un dedo ahora y un mouse en el gesto siguiente, y cada gesto
   *    merece la respuesta que le corresponde.
   */

  // ── Traer el contenido ────────────────────────────────────────────────────

  function pedir(dev: string): Promise<string> {
    const listo = cache.get(dev);
    if (listo != null) return Promise.resolve(listo);

    const yendo = enVuelo.get(dev);
    if (yendo) return yendo;

    const p = fetch(`/parciales/nodo/${encodeURIComponent(dev)}`, {
      headers: { accept: 'text/html' },
    })
      .then(async (r) => {
        const html = await r.text();
        // 🔴 Sólo se cachea lo que salió bien. Un 503 guardado es una tarjeta
        //    que dice «no se pudo leer» para siempre, incluso después de que
        //    la base vuelva. Un 404 sí se cachea: ese equipo no va a aparecer.
        if (r.ok || r.status === 404) cache.set(dev, html);
        return html;
      })
      .catch(
        () =>
          '<p class="text-tenue px-3 py-4 text-center text-xs">Sin conexión con el panel.</p>',
      )
      .finally(() => enVuelo.delete(dev));

    enVuelo.set(dev, p);
    return p;
  }

  // ── Encabezado instantáneo ────────────────────────────────────────────────
  //
  // Lo poco que se arma en el cliente, y sólo esto: el nombre, el estado y la
  // antigüedad, que ya viajan en el nodo. Es para que la tarjeta aparezca con
  // contenido y no como un rectángulo vacío que después salta de tamaño.
  // Todo lo demás lo dibuja el servidor.

  function esqueleto(nodo: SVGGraphicsElement): string {
    const estado = Number(nodo.dataset.estado ?? 0);
    const m = metaEstado(estado);
    const rotulo = nodo.dataset.rotulo ?? 'Equipo';
    const a = nodo.dataset.antiguedad as Antiguedad | undefined;
    const edad = Number(nodo.dataset.edad ?? NaN);

    const antig =
      a && Number.isFinite(edad)
        ? `<span class="antig antig-${a}" title="${escapar(metaAntiguedad(a).explica)}">` +
          `<span class="rampa" data-antiguedad="${a}" aria-hidden="true"></span>` +
          `<span>${escapar(duracion(edad))}</span></span>`
        : '';

    return `<header class="border-borde flex items-start gap-2 border-b px-3 py-2">
        <span class="min-w-0 flex-1 truncate text-sm font-semibold">${escapar(rotulo)}</span>
        <span class="pildora pildora-${m.clave} shrink-0">
          <span class="glifo" aria-hidden="true">${m.glifo}</span><span>${m.etiqueta}</span>
        </span>
      </header>
      <p class="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span class="text-tenue">Así desde hace</span>${antig}
      </p>
      <p class="text-tenue px-3 pb-3 text-2xs" data-cargando>Buscando el resto…</p>`;
  }

  // ── Mostrar y ocultar ─────────────────────────────────────────────────────

  async function mostrar(nodo: SVGGraphicsElement, comoHoja: boolean) {
    const dev = nodo.dataset.dev;
    if (!dev) return;

    actual = nodo;
    fijada = comoHoja;
    const mia = ++generacion;

    cuerpo.innerHTML = esqueleto(nodo);
    tarjeta.hidden = false;
    tarjeta.dataset.modo = comoHoja ? 'hoja' : 'flotante';
    // 🔴 EN VISTA PREVIA LA TARJETA NO RECIBE EL PUNTERO. Un carácter, y es el
    //    defecto que se reportó como «hago click en un equipo y se va a otro».
    //
    //    Acá decía `toggle(..., false)`: le sacaba `pointer-events-none`
    //    SIEMPRE, también cuando aparece sola al pasar el mouse. Y la tarjeta
    //    se coloca A LA DERECHA del nodo — que en un mapa denso es justo encima
    //    del nodo de al lado. Entonces:
    //
    //      1. apuntás al nodo A, la tarjeta aparece tapando al nodo B
    //      2. movés hacia B y el puntero entra en la TARJETA, no en B
    //      3. `pointerenter` marca `sobreTarjeta` y la tarjeta se queda
    //      4. hacés click creyendo que tocás B, y tocás un enlace de A
    //
    //    Una VISTA PREVIA no es una superficie de control: informa y se corre.
    //    Sin puntero no puede robar un click, y `pointerout` del nodo la cierra
    //    sola porque `relatedTarget` ya no es ella.
    //
    //    En modo hoja —el toque, donde no existe el hover— SÍ es interactiva:
    //    ahí sus enlaces son la única forma de llegar a la ficha.
    tarjeta.classList.toggle('pointer-events-none', !comoHoja);
    if (cerrar) cerrar.style.display = comoHoja ? 'grid' : 'none';
    ubicar(nodo, comoHoja);
    anunciar(nodo);

    const html = await pedir(dev);
    // Otra tarjeta ganó la carrera mientras esta viajaba: la respuesta vieja no
    // se pinta. Sin esto, mover el mouse rápido deja la tarjeta de otro nodo.
    if (mia !== generacion || actual !== nodo) return;
    cuerpo.innerHTML = html;
    ubicar(nodo, comoHoja);
  }

  function ocultar() {
    window.clearTimeout(temporizadorMostrar);
    window.clearTimeout(temporizadorOcultar);
    generacion++;
    actual = null;
    fijada = false;
    sobreTarjeta = false;
    tarjeta.hidden = true;
    tarjeta.classList.add('pointer-events-none');
  }

  function programarOcultar() {
    if (fijada) return;
    window.clearTimeout(temporizadorOcultar);
    temporizadorOcultar = window.setTimeout(() => {
      if (!sobreTarjeta) ocultar();
    }, DEMORA_OCULTAR);
  }

  /** Una línea para el lector de pantalla. Ver el comentario en el componente. */
  function anunciar(nodo: SVGGraphicsElement) {
    if (!resumen) return;
    const m = metaEstado(Number(nodo.dataset.estado ?? 0));
    const edad = Number(nodo.dataset.edad ?? NaN);
    const cuanto = Number.isFinite(edad)
      ? ` — así desde hace ${duracion(edad)}${
          Number.isFinite(edad) ? ` (${metaAntiguedad(porSegundos(edad)).etiqueta.toLowerCase()})` : ''
        }`
      : '';
    resumen.textContent = `${nodo.dataset.rotulo ?? ''} — ${m.etiqueta}${cuanto}`;
  }

  // ── Dónde ponerla ─────────────────────────────────────────────────────────

  /**
   * Contra los bordes, y nunca encima del nodo que se está mirando.
   *
   * El orden de preferencia es derecha → izquierda → abajo → arriba, y en cada
   * intento se comprueba que entre entera. Tapar justo el nodo que el operador
   * está señalando es el error clásico de este tipo de tarjeta.
   */
  function ubicar(nodo: SVGGraphicsElement, comoHoja: boolean) {
    if (comoHoja) {
      tarjeta.style.left = '';
      tarjeta.style.top = '';
      return;
    }

    const n = nodo.getBoundingClientRect();
    const t = tarjeta.getBoundingClientRect();
    const w = t.width || 352;
    const h = t.height || 240;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let x: number;
    let y: number;

    if (n.right + AIRE + w <= vw) x = n.right + AIRE;
    else if (n.left - AIRE - w >= 0) x = n.left - AIRE - w;
    else x = Math.max(AIRE, Math.min(n.left + n.width / 2 - w / 2, vw - w - AIRE));

    // Alineada al nodo por arriba, y si no entra se sube hasta que entre.
    y = n.top;
    if (y + h > vh - AIRE) y = vh - h - AIRE;
    if (y < AIRE) y = AIRE;

    tarjeta.style.left = `${Math.round(x)}px`;
    tarjeta.style.top = `${Math.round(y)}px`;
  }

  // ── Escuchas, todas delegadas ─────────────────────────────────────────────
  //
  // Sobre el contenedor del visor y no sobre cada nodo: con 401 nodos, 401
  // escuchas de `mouseenter` cuestan memoria y tiempo de instalación por cada
  // carga de mapa. Delegando hay dos, y funcionan igual para los nodos que
  // aparezcan después.

  /**
   * 🔴 Sacar el `<title>` de los nodos: si no, salen DOS globitos superpuestos.
   *
   *    Cada nodo lleva un `<title>` en el SVG. El navegador lo dibuja como
   *    globito nativo al segundo de estar encima — y para entonces la tarjeta
   *    ya está abierta, así que el globito cae ARRIBA de ella, tapándola, con
   *    exactamente la misma información y con el estilo del sistema operativo.
   *    Reportado con captura: «aparecen los dos y se solapan».
   *
   *    🔴 Y NO se saca del HTML que manda el servidor, a propósito.
   *
   *       Ese `<title>` es el respaldo para cuando este script no corre: sin
   *       JavaScript, sin la tarjeta, el globito nativo es lo ÚNICO que dice
   *       qué es cada nodo. Borrarlo en el servidor dejaría un mapa de cuadritos
   *       mudos para quien tenga el JS bloqueado.
   *
   *       Se saca acá, en el arranque del script: en ese momento ya está
   *       garantizado que la tarjeta lo reemplaza.
   *
   *    No se pierde accesibilidad: el nodo tiene además `aria-label` con el
   *    mismo texto, y en SVG el `aria-label` gana sobre el `<title>` para el
   *    nombre accesible. Los lectores de pantalla siguen leyendo lo mismo.
   */
  //    🔴 Y SÓLO a los que tienen `data-dev`. Un nodo de SUBMAPA también es
  //       `.nodo-mapa`, pero la tarjeta no lo cubre —sólo aparece si hay
  //       equipo detrás—: sacarle el `<title>` lo dejaría mudo a cambio de
  //       nada. Se quita únicamente donde hay algo mejor que lo reemplace.
  for (const t of document.querySelectorAll('[data-visor] .nodo-mapa[data-dev] > title')) {
    t.remove();
  }

  for (const visor of document.querySelectorAll<HTMLElement>('[data-visor]')) {
    const svg = visor.querySelector<SVGSVGElement>('[data-svg-mapa]');
    if (!svg) continue;

    svg.addEventListener('pointerover', (ev) => {
      if (ev.pointerType === 'touch') return;
      const nodo = nodoDe(ev.target);
      if (!nodo || nodo === actual) return;

      // El pedido sale YA, la tarjeta espera. Ver el comentario de arriba.
      if (nodo.dataset.dev) void pedir(nodo.dataset.dev);

      window.clearTimeout(temporizadorOcultar);
      window.clearTimeout(temporizadorMostrar);
      temporizadorMostrar = window.setTimeout(() => void mostrar(nodo, false), DEMORA_MOSTRAR);
    });

    svg.addEventListener('pointerout', (ev) => {
      if (ev.pointerType === 'touch') return;
      const nodo = nodoDe(ev.target);
      if (!nodo) return;
      // Yendo hacia la propia tarjeta: no se cierra.
      if (tarjeta.contains(ev.relatedTarget as Node | null)) return;
      window.clearTimeout(temporizadorMostrar);
      programarOcultar();
    });

    // ── Teclado ─────────────────────────────────────────────────────────────
    // Sin demora: llegar con Tab a un nodo ya es apuntarlo a propósito. La
    // demora existe para distinguir la intención del paseo, y con el teclado
    // no hay paseo.
    // 🔴 Los dos salen si la hoja está fijada, y eso NO es una precaución
    //    teórica: en un teléfono, tocar un nodo le da el foco al `<a>`. La
    //    secuencia real medida era «pointerup abre la hoja → focusin la vuelve
    //    a abrir en modo flotante → focusout la cierra», o sea que el toque
    //    terminaba sin tarjeta. Con la guarda, el que abrió la hoja manda.
    svg.addEventListener('focusin', (ev) => {
      if (fijada) return;
      const nodo = nodoDe(ev.target);
      if (!nodo) return;
      window.clearTimeout(temporizadorOcultar);
      void mostrar(nodo, false);
    });

    svg.addEventListener('focusout', (ev) => {
      if (fijada) return;
      if (tarjeta.contains(ev.relatedTarget as Node | null)) return;
      if (!nodoDe(ev.relatedTarget)) ocultar();
      else programarOcultar();
    });

    // ── Táctil ──────────────────────────────────────────────────────────────
    let toqueEn: { x: number; y: number } | null = null;
    /**
     * 🔴 El nodo se anota en el `pointerdown`, NO se busca en el `click`.
     *
     *    Medido con emulación táctil: el visor llama a `setPointerCapture` en su
     *    propio `pointerdown` para poder seguir el arrastre fuera del SVG, y con
     *    el puntero capturado el `click` que genera el navegador llega con
     *    `target` apuntando al `<svg>`, no al nodo. O sea que buscar el nodo
     *    desde el click devolvía `null` SIEMPRE y en un teléfono la tarjeta no
     *    aparecía nunca. Anotándolo antes de que exista la captura, funciona
     *    igual con o sin ella.
     */
    let nodoTocado: SVGGraphicsElement | null = null;
    /** Hubo un toque que abrió la hoja: el `click` que venga atrás no navega. */
    let comerClick = false;

    svg.addEventListener(
      'pointerdown',
      (ev) => {
        comerClick = false;
        if (ev.pointerType !== 'touch') return;
        toqueEn = { x: ev.clientX, y: ev.clientY };
        nodoTocado = nodoDe(ev.target);
      },
      true,
    );

    /**
     * 🔴 El toque se resuelve en `pointerup`, no en `click`.
     *
     *    Medido con emulación táctil sobre este mismo visor: la secuencia real
     *    es `pointerdown → touchstart → pointerup → touchend` y **no llega
     *    ningún `click`**. El visor captura el puntero en su `pointerdown` para
     *    poder seguir el arrastre fuera del SVG, y con eso el navegador no
     *    sintetiza el click. Un manejador colgado de `click` no se ejecutaba
     *    nunca: en un teléfono la tarjeta no aparecía y encima tampoco navegaba.
     *
     *    `pointerup` siempre llega. Y si el `click` igual aparece —en otro
     *    navegador, o sin captura— se lo come el manejador de abajo, así que el
     *    toque hace UNA cosa sola en todos los casos.
     */
    svg.addEventListener('pointerup', (ev) => {
      if (ev.pointerType !== 'touch') return;
      const nodo = nodoTocado;
      nodoTocado = null;
      if (!nodo?.dataset.dev) return;

      // Si el dedo se movió, era un arrastre del mapa: no es un toque.
      if (toqueEn && Math.hypot(ev.clientX - toqueEn.x, ev.clientY - toqueEn.y) > UMBRAL_TOQUE) {
        return;
      }

      // 🔴 El toque SIEMPRE abre la hoja; nunca navega.
      //
      //    La alternativa clásica —primer toque muestra, segundo navega— la
      //    probé y la descarté: un toque que a veces informa y a veces te saca
      //    del mapa es una ruleta, y el mapa es lo caro de recuperar (el zoom y
      //    el encuadre que el operador acomodó). La hoja trae «Abrir la ficha
      //    completa →» con todas las letras: dos toques igual, pero el segundo
      //    dice adónde va.
      comerClick = true;
      void mostrar(nodo, true);
    });

    svg.addEventListener(
      'click',
      (ev) => {
        if (!comerClick) return;
        comerClick = false;
        ev.preventDefault();
        ev.stopPropagation();
      },
      // En captura: hay que ganarle al `<a>` antes de que navegue.
      true,
    );
  }

  tarjeta.addEventListener('pointerenter', () => {
    sobreTarjeta = true;
    window.clearTimeout(temporizadorOcultar);
  });
  tarjeta.addEventListener('pointerleave', () => {
    sobreTarjeta = false;
    programarOcultar();
  });
  cerrar?.addEventListener('click', () => {
    ocultar();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || tarjeta.hidden) return;
    const volverA = actual;
    ocultar();
    // El foco vuelve al nodo: si no, Escape deja al que navega con teclado
    // parado en el principio del documento.
    volverA?.focus?.();
  });

  // El mapa se mueve y la tarjeta se quedaría flotando al lado de nada.
  // `capture` para enterarse también del desplazamiento de contenedores.
  window.addEventListener('scroll', () => !fijada && ocultar(), { capture: true, passive: true });
  window.addEventListener('resize', () => ocultar(), { passive: true });
  document.addEventListener('mapa:movido', () => !fijada && ocultar());
}

/** El nodo del mapa que hay debajo de este objetivo, si es que hay uno. */
function nodoDe(objetivo: EventTarget | null): SVGGraphicsElement | null {
  if (!(objetivo instanceof Element)) return null;
  const n = objetivo.closest('.nodo-mapa[data-dev]');
  return n ? (n as unknown as SVGGraphicsElement) : null;
}

/** El único HTML que arma el cliente sale de acá. Que salga escapado. */
function escapar(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
