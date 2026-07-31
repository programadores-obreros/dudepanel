/**
 * Quién es el que pide, y qué puede hacer.
 *
 * El panel NO tiene login propio: la autenticación vive en el proxy inverso
 * (`basic_auth` en el `Caddyfile`), que es el único que toca internet. Eso es
 * a propósito — una contraseña menos que guardar acá es una contraseña menos
 * que se puede filtrar desde acá.
 *
 * Pero «quién sos» y «qué podés hacer» son dos preguntas distintas, y
 * `basic_auth` sólo contesta la primera. La segunda se contesta acá.
 *
 * 🔴 EL PANEL ES DE SÓLO LECTURA PARA TODOS, MENOS EN UNA COSA.
 *
 *    No hay ninguna operación que modifique la red ni la base de The Dude. La
 *    única escritura que existe en todo el proyecto es dónde se dibuja un nodo
 *    en un mapa (`map_element_positions`), que es cosmética y reversible.
 *
 *    Aun así se controla, porque un mapa acomodado es trabajo de alguien y
 *    porque «sólo puede ver» tiene que significar exactamente eso.
 */
import { texto } from './entorno';

/**
 * 🔴 El nombre lo pone CADDY, no el cliente.
 *
 * En el `Caddyfile`, `reverse_proxy` lleva:
 *
 *     header_up X-Panel-Usuario {http.auth.user.id}
 *
 * `header_up` REEMPLAZA la cabecera, así que un curioso que mande la suya
 * propia la ve pisada antes de llegar acá. Y el servicio `web` no publica
 * puerto: la única ruta hasta él pasa por Caddy. Las dos cosas hacen falta —
 * con el puerto publicado, un túnel SSH esquivaría la autenticación entera.
 */
const CABECERA_USUARIO = 'x-panel-usuario';

/** Quiénes pueden mover nodos. Coma como separador, en `.env.prod`. */
function editores(): Set<string> {
  return new Set(
    texto('PANEL_EDITORES', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type Quien = {
  /** Como lo identificó el proxy. `null` si no vino nadie (desarrollo). */
  usuario: string | null;
  /** ¿Puede mover nodos y guardar la posición? */
  puedeEditar: boolean;
  /** Para explicarle a la persona POR QUÉ no puede, que no es lo mismo que ocultarlo. */
  motivo: string | null;
};

/**
 * En desarrollo no hay proxy, así que no hay cabecera y no habría nadie que
 * pueda mover nada — trabajar en la funcionalidad sería imposible. Con
 * `PANEL_EDICION_LIBRE=1` se abre, y **sólo** ahí.
 *
 * No alcanza con «si no hay cabecera, dejá pasar»: ese es exactamente el
 * agujero que convierte un descuido de configuración en acceso de escritura.
 * Si mañana alguien saca el `header_up` del `Caddyfile` sin darse cuenta, esto
 * tiene que cerrarse, no abrirse. Falla cerrado.
 */
export function quien(peticion: Request): Quien {
  const bruto = peticion.headers.get(CABECERA_USUARIO)?.trim() ?? '';
  const usuario = bruto ? bruto.slice(0, 120) : null;

  if (texto('PANEL_EDICION_LIBRE') === '1') {
    return { usuario: usuario ?? 'desarrollo', puedeEditar: true, motivo: null };
  }

  if (!usuario) {
    return {
      usuario: null,
      puedeEditar: false,
      motivo: 'el proxy no informó quién sos',
    };
  }

  const permitidos = editores();
  if (permitidos.size === 0) {
    return {
      usuario,
      puedeEditar: false,
      motivo: 'no hay ningún editor configurado (PANEL_EDITORES está vacío)',
    };
  }

  if (!permitidos.has(usuario.toLowerCase())) {
    return { usuario, puedeEditar: false, motivo: 'tu cuenta es de sólo lectura' };
  }

  return { usuario, puedeEditar: true, motivo: null };
}
