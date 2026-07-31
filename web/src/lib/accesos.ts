/**
 * Cómo llegarle a un equipo: Winbox, web, SSH, FTP.
 *
 * Todo sale de la base de The Dude. **Nada se inventa**: si acá aparece un
 * acceso SSH es porque hay un servicio SSH configurado sobre ese equipo, con
 * ese puerto. Un botón que ofrece algo que no existe es peor que no tener el
 * botón: manda a alguien a probar a las tres de la mañana.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  🔴 LO PRIMERO, PORQUE ES LO QUE PUEDE SALIR MAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `device_types.url` es una PLANTILLA de The Dude, y la del tipo
 * «MikroTik Device» —16 equipos de esta instalación— es, textual:
 *
 *     http://[Device.FirstAddress]:/cfg?user=[Device.UserName]
 *            &password=[Device.Password]&process=login&page=start&backpage=
 *
 * The Dude resuelve eso y abre el navegador **con la contraseña del router en
 * la barra de direcciones**. Nosotros NO.
 *
 * `[Device.UserName]` y `[Device.Password]` no se resuelven —el decodificador
 * ni siquiera los lee, `dudeobj.SECRETO` los excluye— pero eso no alcanza:
 * dejar los marcadores sin resolver produciría una URL con
 * `password=[Device.Password]` a la vista, que es ruido y además le enseña a
 * cualquiera dónde mirar. Así que los parámetros que huelen a credencial **se
 * borran de la URL**, y si al hacerlo la plantilla pierde sentido, se cae a
 * `http://<ip>`, que es lo que el 96 % de los tipos ya tiene.
 *
 * Una URL de la que hay que quitar secretos es una señal, no un detalle: el
 * dato existe en el origen y va a volver a aparecer por otro lado.
 */

/** Marcadores de The Dude que jamás se resuelven. */
const CREDENCIAL = /^(user|username|usuario|pass|password|clave|pwd|secret|community)$/i;

/** Un marcador `[Device.Algo]` que no sabemos resolver. */
const MARCADOR = /\[[A-Za-z]+\.[A-Za-z]+\]/;

export type Acceso = {
  /** `enlace` se navega; `copiar` se copia al portapapeles. */
  modo: 'enlace' | 'copiar';
  /** Winbox · Interfaz web · SSH · … */
  etiqueta: string;
  /** El destino, ya resuelto. */
  valor: string;
  /** Por qué existe este acceso. Va en el `title`: nada de magia. */
  porque: string;
  /** Nombre del icono en el juego de la app. */
  icono: 'ventana' | 'terminal' | 'globo' | 'carpeta' | 'copiar';
};

type EntradaServicio = {
  sonda: string | null;
  puerto: number | null;
  puertoSonda: number | null;
  habilitado: boolean | null;
};

export type DatosAcceso = {
  direcciones: string[];
  routerOs: boolean | null;
  urlTipo: string | null;
  nombreTipo: string | null;
  servicios: EntradaServicio[];
};

/** El puerto real de un servicio: el suyo, o el de su sonda si es 0. */
function puertoDe(s: EntradaServicio): number | null {
  const p = s.puerto && s.puerto > 0 ? s.puerto : s.puertoSonda;
  return p && p > 0 ? p : null;
}

/**
 * Resuelve la plantilla de `device_types.url` SIN credenciales.
 *
 * Devuelve `null` cuando después de limpiar no queda nada usable, en vez de
 * devolver algo a medias. Quien llama ya tiene un plan B.
 */
export function urlSegura(plantilla: string | null, ip: string | null): string | null {
  if (!plantilla || !ip) return null;

  // `[Device.FirstAddress]` es el único marcador que resolvemos, y con la
  // primera dirección del equipo, que es lo que su nombre promete.
  let s = plantilla.replaceAll(/\[Device\.(FirstAddress|Address)\]/gi, ip);

  // `http://1.2.3.4:/cfg?...` — The Dude deja los dos puntos con el puerto
  // vacío. Los navegadores lo toleran; se limpia igual porque después hay que
  // parsear la URL y un puerto vacío es exactamente lo que hace fallar a `URL`.
  s = s.replace(/:(?=\/|$|\?)/, (m, ...r) => (String(r.at(-1)).includes('://') ? m : ''));
  s = s.replace(/^(\w+:\/\/[^/:?#]+):(?=[/?#]|$)/, '$1');

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }

  // Sólo esquemas que un navegador abre. Nada de `javascript:` ni `data:`
  // saliendo de un campo que, recordemos, lo escribió una persona en 2011.
  if (!['http:', 'https:', 'ftp:'].includes(u.protocol)) return null;

  // 🔴 Fuera las credenciales, en los tres lugares donde pueden estar.
  u.username = '';
  u.password = '';
  for (const clave of [...u.searchParams.keys()]) {
    if (CREDENCIAL.test(clave)) u.searchParams.delete(clave);
  }

  // Si quedó algún marcador sin resolver, la plantilla usa algo que no
  // sabemos. Mejor el plan B que un enlace roto con `[Device.Loquesea]`.
  const final = u.toString();
  return MARCADOR.test(final) ? null : final;
}

/**
 * Los accesos de un equipo, ordenados por lo que más se usa en un NOC.
 */
export function accesos(d: DatosAcceso): Acceso[] {
  const ip = d.direcciones[0] ?? null;
  if (!ip) return [];

  const salida: Acceso[] = [];
  const activos = d.servicios.filter((s) => s.habilitado !== false);
  const conSonda = (re: RegExp) => activos.find((s) => s.sonda && re.test(s.sonda));

  // ── Winbox ────────────────────────────────────────────────────────────────
  //
  // Sólo para RouterOS: 155 equipos de los 885. Va como COPIAR y no como
  // enlace porque **Winbox no registra un esquema de URL**: no existe
  // `winbox://` que el sistema sepa abrir. Ofrecer un enlace que no hace nada
  // sería mentir; copiar `ip:8291` es exactamente lo que se pega en el campo
  // «Connect To» del programa, así que le ahorra el paso real a quien lo usa.
  //
  // El 8291 es el puerto por omisión de Winbox en RouterOS. No está en la base
  // —The Dude no lo sondea acá— y por eso el texto lo dice: es una convención
  // del producto, no un dato medido. Que se note la diferencia.
  if (d.routerOs) {
    salida.push({
      modo: 'copiar',
      etiqueta: 'Winbox',
      valor: `${ip}:8291`,
      porque:
        'El equipo está marcado como RouterOS. 8291 es el puerto por omisión ' +
        'de Winbox, no un dato de la base. Copialo y pegalo en «Connect To».',
      icono: 'ventana',
    });
  }

  // ── Interfaz web ──────────────────────────────────────────────────────────
  const web = urlSegura(d.urlTipo, ip);
  if (web) {
    salida.push({
      modo: 'enlace',
      etiqueta: 'Interfaz web',
      valor: web,
      porque: `Plantilla del tipo «${d.nombreTipo ?? '—'}» de The Dude, sin credenciales.`,
      icono: 'globo',
    });
  } else {
    // Los tipos que no traen plantilla usable igual tienen una web probable.
    // Se ofrece igual, pero el texto no promete: dice que es la dirección.
    const httpS = activos.find((s) => s.sonda && /^https?/i.test(s.sonda));
    const puerto = httpS ? puertoDe(httpS) : null;
    if (httpS) {
      salida.push({
        modo: 'enlace',
        etiqueta: 'Interfaz web',
        valor: `http://${ip}${puerto && puerto !== 80 ? `:${puerto}` : ''}/`,
        porque: `Hay un servicio «${httpS.sonda}» monitoreado en este equipo.`,
        icono: 'globo',
      });
    }
  }

  // ── SSH ───────────────────────────────────────────────────────────────────
  //
  // `ssh://` sí lo entienden los sistemas (PuTTY lo registra en Windows,
  // Terminal en macOS, la mayoría de escritorios en Linux).
  const ssh = conSonda(/^ssh/i);
  if (ssh) {
    const p = puertoDe(ssh);
    salida.push({
      modo: 'enlace',
      etiqueta: p && p !== 22 ? `SSH · ${p}` : 'SSH',
      valor: `ssh://${ip}${p && p !== 22 ? `:${p}` : ''}`,
      porque: `Hay un servicio SSH monitoreado${p ? ` en el puerto ${p}` : ''}.`,
      icono: 'terminal',
    });
  }

  // ── Telnet y FTP ──────────────────────────────────────────────────────────
  const telnet = conSonda(/^telnet/i);
  if (telnet) {
    const p = puertoDe(telnet);
    salida.push({
      modo: 'enlace',
      etiqueta: 'Telnet',
      valor: `telnet://${ip}${p && p !== 23 ? `:${p}` : ''}`,
      porque:
        'Hay un servicio Telnet monitoreado. Telnet viaja en claro: ' +
        'si el equipo también habla SSH, usá SSH.',
      icono: 'terminal',
    });
  }

  const ftp = conSonda(/^ftp/i);
  if (ftp) {
    const p = puertoDe(ftp);
    salida.push({
      modo: 'enlace',
      etiqueta: 'FTP',
      valor: `ftp://${ip}${p && p !== 21 ? `:${p}` : ''}/`,
      porque: 'Hay un servicio FTP monitoreado en este equipo.',
      icono: 'carpeta',
    });
  }

  // ── La dirección, siempre ─────────────────────────────────────────────────
  //
  // El acceso que de verdad se usa todo el tiempo: copiar la IP para pegarla
  // en otra herramienta. Va último porque es el de menor jerarquía, pero no
  // falta nunca.
  salida.push({
    modo: 'copiar',
    etiqueta: 'Copiar dirección',
    valor: ip,
    porque: 'La primera dirección del equipo, tal como la tiene The Dude.',
    icono: 'copiar',
  });

  return salida;
}
