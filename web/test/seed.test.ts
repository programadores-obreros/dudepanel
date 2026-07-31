import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
 * Higiene de datos: en `web/` no puede haber un identificador real de la red.
 *
 * Esto existe porque el encabezado de `seed-dev.sql` afirmaba que sus datos
 * eran inventados y no lo eran: traía la IP interna, la MAC y el hostname del
 * servidor que corre The Dude, más los rangos de gestión y el dominio del ISP.
 *
 * 🔴 Y la AFIRMACIÓN era peor que el dato, porque desactivaba la revisión: el
 *    que abría el archivo leía «son inventados» y no miraba. Una promesa que
 *    nadie verifica se pudre sola. Esta es la verificación.
 *
 * La regla es POSITIVA a propósito —«toda dirección tiene que estar en un rango
 * de documentación»— y no una lista negra de valores prohibidos. Dos razones:
 *
 *  1. Una lista negra sólo atrapa las fugas que ya conocemos. Esta atrapa la
 *     próxima, que va a ser una dirección que todavía nadie escribió.
 *  2. Para escribir la lista negra habría que poner los valores reales ACÁ
 *     ADENTRO. El test que prohíbe el secreto no puede contener el secreto.
 *
 * Los tests de este archivo NO necesitan base: corren siempre, incluso donde
 * `consultas.test.ts` se saltea. La garantía no puede depender de que alguien
 * haya levantado Docker.
 */

const RAIZ = resolve(__dirname, '..');

/** Los tres bloques que RFC 5737 reserva para documentación. */
const DOCUMENTACION = [/^192\.0\.2\.\d{1,3}$/, /^198\.51\.100\.\d{1,3}$/, /^203\.0\.113\.\d{1,3}$/];

/**
 * Direcciones que no identifican nada de nadie.
 *
 * `0.0.0.0` es el relleno del ORDER BY por IP y `127.0.0.1` sale en los
 * ejemplos de conexión de los comentarios. Ninguna apunta a un equipo.
 */
const EXENTAS = new Set(['0.0.0.0', '127.0.0.1', '255.255.255.255']);

/** RFC 7042 §2.1.2: el rango que IEEE reservó para documentar. */
const MAC_DOCUMENTACION = /^00:00:5E:00:53:[0-9A-F]{2}$/i;

const CUADRA = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const MAC = /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g;

const EXTENSIONES = new Set(['.ts', '.astro', '.sql', '.md', '.mjs', '.json', '.css', '.yml']);
const SALTEAR = new Set(['node_modules', 'dist', '.astro', '.git', 'pnpm-lock.yaml']);

function archivos(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    if (SALTEAR.has(entrada)) continue;
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) archivos(ruta, acc);
    else if (EXTENSIONES.has(extname(entrada))) acc.push(ruta);
  }
  return acc;
}

/** Todos los octetos ≤ 255. Descarta versiones y datos de trazado SVG. */
function esIPv4(s: string): boolean {
  return s.split('.').every((o) => Number(o) <= 255);
}

/**
 * Saca las barras de escape antes de buscar.
 *
 * 🔴 Sin esto el test tiene un agujero, y no es hipotético: en el primer
 *    barrido sobrevivió una dirección real escondida en un regex literal, con
 *    los puntos escapados. Escrita así, el texto del archivo NO contiene la
 *    dirección —tiene una barra entre cada octeto— y no la ve ni `rg` ni este
 *    test. Sacando las barras, las dos formas quedan iguales.
 *
 *    (El ejemplo concreto no va acá a propósito: sería volver a escribir el
 *    valor que este archivo existe para prohibir.)
 */
function sinEscapes(s: string): string {
  return s.replace(/\\/g, '');
}

const FUENTES = archivos(RAIZ);

describe('higiene de datos en web/', () => {
  it('encuentra archivos que revisar', () => {
    // Si el recorrido se rompe, los demás tests pasarían por vacíos.
    expect(FUENTES.length).toBeGreaterThan(20);
  });

  it('toda dirección IPv4 está en un rango de documentación', () => {
    const fugas: string[] = [];

    for (const ruta of FUENTES) {
      const texto = sinEscapes(readFileSync(ruta, 'utf8'));
      for (const bruto of texto.match(CUADRA) ?? []) {
        if (!esIPv4(bruto)) continue;
        if (EXENTAS.has(bruto)) continue;
        if (DOCUMENTACION.some((re) => re.test(bruto))) continue;
        fugas.push(`${relative(RAIZ, ruta)}: ${bruto}`);
      }
    }

    // El mensaje va en el propio valor comparado: así el fallo dice QUÉ y DÓNDE
    // en vez de «expected 3 to be 0», que obliga a ir a buscarlo.
    expect(fugas).toEqual([]);
  });

  it('toda MAC está en el rango de documentación de IEEE', () => {
    const fugas: string[] = [];

    for (const ruta of FUENTES) {
      const texto = sinEscapes(readFileSync(ruta, 'utf8'));
      for (const bruto of texto.match(MAC) ?? []) {
        if (MAC_DOCUMENTACION.test(bruto)) continue;
        fugas.push(`${relative(RAIZ, ruta)}: ${bruto}`);
      }
    }

    expect(fugas).toEqual([]);
  });

  it('el seed no nombra ningún dominio fuera de example.*', () => {
    const seed = sinEscapes(readFileSync(join(RAIZ, 'seed-dev.sql'), 'utf8'));
    // TLD de país y los genéricos que aparecerían en un nombre DNS de verdad.
    const dominios = seed.match(/\b[a-z0-9][a-z0-9-]*\.(?:ar|cl|br|uy|py|bo|com|net|org|io)\b/gi);

    const ajenos = (dominios ?? []).filter((d) => !/^example\./i.test(d));
    expect(ajenos).toEqual([]);
  });

  it('el encabezado del seed sigue declarando de dónde salen los rangos', () => {
    // Si alguien reescribe el encabezado y se lleva puesta la explicación, el
    // próximo que agregue una fila no va a saber qué rango le toca usar.
    const seed = readFileSync(join(RAIZ, 'seed-dev.sql'), 'utf8');
    expect(seed).toContain('RFC 5737');
    expect(seed).toContain('RFC 7042');
  });
});
