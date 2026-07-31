/**
 * Buscador global. Sin framework: es un input, una lista y un fetch.
 */
import { metaEstado } from '@/lib/estado';

interface Resultado {
  kind: 'device' | 'map';
  id: number;
  nombre: string;
  status: number | null;
  detalle: string | null;
}

const dlg = document.querySelector<HTMLDialogElement>('#dlg-buscador');
const input = document.querySelector<HTMLInputElement>('#q-buscador');
const lista = document.querySelector<HTMLUListElement>('#res-buscador');
const conteo = document.querySelector<HTMLElement>('[data-conteo]');

if (dlg && input && lista) {
  let resultados: Resultado[] = [];
  let marcado = 0;
  let ultimoPedido = 0;
  let temporizador: number | undefined;
  let controlador: AbortController | undefined;

  // ── Apertura y cierre ─────────────────────────────────────────────────────

  const abrir = () => {
    if (dlg.open) return;
    dlg.showModal();
    input.select();
  };

  for (const b of document.querySelectorAll('[data-abrir-buscador]')) {
    b.addEventListener('click', abrir);
  }

  document.addEventListener('keydown', (ev) => {
    // Ctrl+K en Windows/Linux, ⌘K en Mac. Los dos, porque el mismo panel se
    // abre desde la notebook del técnico y desde la Mac de la oficina.
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      abrir();
      return;
    }
    // "/" es el atajo de toda la vida, pero sólo si no estás tipeando en otro lado.
    if (ev.key === '/' && !dlg.open && !enCampoDeTexto(ev.target)) {
      ev.preventDefault();
      abrir();
    }
  });

  dlg.addEventListener('close', () => {
    controlador?.abort();
    lista.innerHTML = '';
    resultados = [];
    input.setAttribute('aria-expanded', 'false');
  });

  // Clic en el fondo oscuro: el <dialog> no lo hace solo.
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });

  // ── Consulta ──────────────────────────────────────────────────────────────

  input.addEventListener('input', () => {
    window.clearTimeout(temporizador);
    // 130 ms: por debajo se dispara una consulta por tecla; por encima se siente
    // pegajoso. Con 885 equipos la base responde en milisegundos, el cuello es
    // el viaje de red desde un celular en 4G.
    temporizador = window.setTimeout(consultar, 130);
  });

  async function consultar() {
    const q = input!.value.trim();
    if (q.length < 2) {
      pintar([]);
      return;
    }

    controlador?.abort();
    controlador = new AbortController();
    const pedido = ++ultimoPedido;

    try {
      const r = await fetch(`/api/buscar.json?q=${encodeURIComponent(q)}`, {
        signal: controlador.signal,
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(String(r.status));
      const datos = (await r.json()) as { resultados: Resultado[] };
      // Descartar respuestas fuera de orden: tipear rápido dispara varias y la
      // vieja puede llegar después y pisar a la nueva.
      if (pedido !== ultimoPedido) return;
      pintar(datos.resultados ?? []);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      lista!.innerHTML =
        '<li class="px-3.5 py-6 text-center text-xs text-caido-txt">No se pudo buscar. ¿Está viva la base?</li>';
    }
  }

  // ── Dibujo ────────────────────────────────────────────────────────────────

  function pintar(rs: Resultado[]) {
    resultados = rs;
    marcado = 0;
    input!.setAttribute('aria-expanded', String(rs.length > 0));
    if (conteo) conteo.textContent = rs.length ? `${rs.length} resultado${rs.length === 1 ? '' : 's'}` : '';

    if (!rs.length) {
      lista!.innerHTML = input!.value.trim().length < 2
        ? '<li class="px-3.5 py-6 text-center text-xs text-tenue">Escribí al menos dos caracteres.</li>'
        : '<li class="px-3.5 py-6 text-center text-xs text-tenue">Nada coincide con eso.</li>';
      return;
    }

    lista!.innerHTML = rs.map(fila).join('');
    marcar(0);
  }

  function fila(r: Resultado, i: number): string {
    const esEquipo = r.kind === 'device';
    const href = esEquipo ? `/dispositivos/${r.id}` : `/mapas/${r.id}`;
    const m = metaEstado(r.status);
    const insignia = esEquipo
      ? `<span class="pildora pildora-${m.clave} shrink-0"><span class="glifo" aria-hidden="true">${m.glifo}</span><span class="sr-only">${m.etiqueta}</span></span>`
      : '<span class="text-2xs font-semibold uppercase tracking-wide text-tenue shrink-0">Mapa</span>';

    return `<li role="option" id="res-${i}" aria-selected="false" data-i="${i}">
      <a href="${href}" tabindex="-1"
         class="flex items-center gap-2.5 px-3.5 py-2 no-underline aria-[current]:bg-acento-bg">
        ${insignia}
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">${escapar(r.nombre)}</span>
          ${r.detalle ? `<span class="block truncate font-mono text-2xs text-tenue">${escapar(r.detalle)}</span>` : ''}
        </span>
      </a>
    </li>`;
  }

  // ── Teclado ───────────────────────────────────────────────────────────────

  input.addEventListener('keydown', (ev) => {
    if (!resultados.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      marcar((marcado + 1) % resultados.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      marcar((marcado - 1 + resultados.length) % resultados.length);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      marcar(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      marcar(resultados.length - 1);
    } else if (ev.key === 'Enter') {
      const a = lista!.querySelector<HTMLAnchorElement>(`[data-i="${marcado}"] a`);
      if (a) {
        ev.preventDefault();
        window.location.href = a.href;
      }
    }
  });

  function marcar(i: number) {
    marcado = i;
    for (const li of lista!.querySelectorAll<HTMLLIElement>('[data-i]')) {
      const activo = Number(li.dataset.i) === i;
      li.setAttribute('aria-selected', String(activo));
      const a = li.querySelector('a');
      if (a) {
        // `aria-current` sirve de estilo y de semántica a la vez.
        if (activo) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
      if (activo) li.scrollIntoView({ block: 'nearest' });
    }
    input!.setAttribute('aria-activedescendant', `res-${i}`);
  }
}

function enCampoDeTexto(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
  );
}

/** Los nombres vienen de The Dude, no de nosotros: nunca al DOM sin escapar. */
function escapar(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
