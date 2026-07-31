/**
 * Fabricante de un equipo, a partir de su dirección MAC.
 *
 * Los primeros tres bytes de una MAC son el **OUI**, que el IEEE le asigna a
 * un fabricante. Con eso se sabe la marca de un equipo sin preguntarle nada:
 * sin red, sin credenciales, sin SNMP y sin tocar la configuración.
 *
 * ── Por qué esto y no SNMP ───────────────────────────────────────────────────
 *
 * Se midió primero el camino «correcto», `sysDescr` por SNMP, sobre 80 equipos
 * que estaban ARRIBA en la red real:
 *
 *   · **10 contestaron** con la comunidad `public`. Doce y medio por ciento.
 *   · Y de esos, la mitad devolvió modelo (`P1201-08`) y la otra mitad
 *     `Linux <hostname> <kernel 2.6> … mips` — firmware airOS, **sin modelo**.
 *   · Las MIB privadas de Ubiquiti (41112) y MikroTik (14988) no contestaron.
 *
 * La MAC, en cambio, la tienen **796 de 885 equipos: el 90 %**. Peor
 * resolución —da la marca, no el modelo— pero siete veces más cobertura y
 * cero dependencia de la red.
 *
 * ── De dónde salió cada línea de la tabla ────────────────────────────────────
 *
 * No de la memoria de nadie. Se cruzó cada OUI presente contra **los iconos
 * que la gente de Telwinet asignó a mano** durante años: si los equipos de un
 * prefijo tienen todos iconos `nanostation`/`airfiber`, ese prefijo es
 * Ubiquiti. Donde la evidencia fue unánime se tomó; donde se contradijo —hay
 * iconos mal puestos— manda el registro del IEEE.
 *
 * 🔴 Y donde no hay ninguna de las dos cosas, **se devuelve `null`**. Nunca se
 *    adivina. Un fabricante inventado en la ficha de un equipo es la misma
 *    clase de daño que la MAC falsa que este trabajo vino a tapar.
 */

export type Fabricante = {
  nombre: string;
  /** Cómo se sabe. Va a la interfaz: el operador merece saber qué es medido. */
  fuente: 'ieee' | 'ieee+iconos' | 'iconos';
};

/**
 * OUI (6 dígitos hex, en mayúsculas, con el bit U/L ya enmascarado) → marca.
 *
 * `ieee+iconos`  el registro del IEEE Y la curaduría de Telwinet coinciden.
 * `ieee`         asignación conocida del IEEE, sin iconos que la corroboren.
 * `iconos`       sin certeza del registro, pero los equipos de ese prefijo
 *                tienen iconos unánimes de esa marca en esta instalación.
 */
const TABLA: Record<string, Fabricante> = {
  // ── Ubiquiti ──────────────────────────────────────────────────────────────
  '00156D': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  FCECDA: { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '44D9E7': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '802AA8': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  F09FC2: { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '002722': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '0418D6': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '788A20': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '245A4C': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  '24A43C': { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  DC9FDB: { nombre: 'Ubiquiti', fuente: 'ieee+iconos' },
  B4FBE4: { nombre: 'Ubiquiti', fuente: 'ieee' },

  // ── MikroTik (el OUI está a nombre de Routerboard.com) ────────────────────
  D4CA6D: { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  B869F4: { nombre: 'MikroTik', fuente: 'ieee' },
  E48D8C: { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '744D28': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '4C5E0C': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '488F5A': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '6C3B6B': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '2CC81B': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '000C42': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  DC2C6E: { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '085531': { nombre: 'MikroTik', fuente: 'ieee+iconos' },
  '64D154': { nombre: 'MikroTik', fuente: 'ieee' },
  // 37 equipos, 13 con icono de MikroTik y ninguno de otra marca. No pude
  // confirmar la asignación del IEEE, así que la fuente lo dice.
  CC2DE0: { nombre: 'MikroTik', fuente: 'iconos' },

  // ── TP-Link ───────────────────────────────────────────────────────────────
  // 21 de 21 con el icono `olt-tplink`. Unanimidad total.
  '984827': { nombre: 'TP-Link', fuente: 'ieee+iconos' },
  A86E84: { nombre: 'TP-Link', fuente: 'ieee+iconos' },
  '34E894': { nombre: 'TP-Link', fuente: 'ieee+iconos' },
  '9CA2F4': { nombre: 'TP-Link', fuente: 'ieee+iconos' },

  // ── Cambium (antes Motorola Canopy) ───────────────────────────────────────
  // 62 equipos y CERO iconos asignados: son parte de los que hoy se dibujan
  // con la cajita gris. Por eso justamente vale identificarlos.
  '000456': { nombre: 'Cambium Networks', fuente: 'ieee' },
};

/** El centinela que The Dude guarda en `macs` y no es una dirección. */
const MAC_FALSA = '00:64:75:64:65:2d';

/**
 * Normaliza una MAC a su OUI de 6 dígitos, **enmascarando el bit U/L**.
 *
 * 🔴 Ese enmascarado no es un detalle: el segundo bit del primer byte marca
 *    «administrada localmente», y los radios Ubiquiti lo prenden en las MAC
 *    virtuales de sus interfaces WDS. Así `80:2A:A8` aparece como `82:2A:A8` y
 *    `04:18:D6` como `06:18:D6`.
 *
 *    Medido sobre la base real: **45 direcciones** lo tienen prendido. Sin
 *    apagarlo, esos 45 equipos quedarían sin fabricante — y peor, inventarían
 *    prefijos que no existen en ningún registro.
 */
export function oui(mac: string): string | null {
  if (!mac || mac.toLowerCase() === MAC_FALSA) return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 6) return null;
  const primero = Number.parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(primero)) return null;
  // & 0b11111101 apaga el bit U/L y deja todo lo demás como está.
  const normalizado = (primero & 0xfd).toString(16).padStart(2, '0');
  return (normalizado + hex.slice(2, 6)).toUpperCase();
}

/**
 * El fabricante de un equipo a partir de sus direcciones.
 *
 * Devuelve `null` si ninguna se puede atribuir. **No adivina nunca.**
 */
export function fabricante(macs: readonly string[] | null | undefined): Fabricante | null {
  for (const m of macs ?? []) {
    const o = oui(m);
    if (o && TABLA[o]) return TABLA[o];
  }
  return null;
}

/** ¿Es el centinela que hay que ocultar? Para no mostrarlo como dirección. */
export function esMacFalsa(mac: string): boolean {
  return mac.toLowerCase() === MAC_FALSA;
}

/** Sólo las direcciones que de verdad lo son. */
export function macsReales(macs: readonly string[] | null | undefined): string[] {
  return (macs ?? []).filter((m) => m && !esMacFalsa(m));
}

/** Para los tests y para poder auditar la cobertura desde afuera. */
export const OUI_CONOCIDOS = TABLA;
