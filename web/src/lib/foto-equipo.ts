import { open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { consultarUna } from './db';
import { texto } from './entorno';
import {
  extension,
  medidaDeImagen,
  medirEncabezado,
  rutaDeArchivo,
  TIPOS_IMAGEN,
  urlDeIcono,
  type Medida,
} from './iconos';

/**
 * La imagen GRANDE de un equipo, para la ficha.
 *
 * ── Por qué esto existe ──────────────────────────────────────────────────────
 *
 * En el mapa los iconos se dibujan a 40 px y ahí una foto es una mancha. En la
 * ficha hay lugar, y el que la abre suele ser alguien que está por ir al sitio:
 * ver qué se va a encontrar —una caja de rack, un plato, una NanoStation en un
 * mástil— cambia qué herramientas mete en la camioneta.
 *
 * ── De dónde sale la imagen ──────────────────────────────────────────────────
 *
 * De ningún lado nuevo: **ya estaba en la base**. Los 494 elementos con icono
 * asignado a mano apuntan a archivos cuyos nombres son de catálogo
 * (`rb2011.png`, `crs305.png`, `nanomder.png`), y el panel ya los sirve por
 * `/iconos/…`. Lo único que faltaba era mirarlos en grande.
 *
 * La cadena de preferencia es:
 *
 *   1. **Una foto propia** del ISP, en `public/equipos/`. Ver `docs/IMAGENES.md`.
 *   2. **El icono que The Dude tiene asignado**, si es rasterizado y el archivo
 *      está de verdad en `files/`.
 *   3. **Nada** — y entonces se dice QUÉ falta y POR QUÉ. Ver `MotivoSinFoto`.
 *
 * ── 🔴 Por qué hay que mirar el disco y no alcanza con pedir la URL ──────────
 *
 *    `/iconos/…` **nunca devuelve 404**: cuando el archivo no está contesta 200
 *    con el pictograma de repuesto (está decidido así a propósito, ver el
 *    endpoint — un `<image>` de SVG no sabe reaccionar a un 404 y dejaría un
 *    hueco en el mapa). Perfecto para el mapa, inútil acá: si esta ficha
 *    confiara en el estado HTTP, con el directorio `files/` sin montar mostraría
 *    885 cajitas grises afirmando que ésa es la pinta del equipo.
 *
 *    Por eso se pregunta por el archivo con `rutaDeArchivo()`, que además es la
 *    función que ya resuelve enlaces simbólicos y revalida la contención.
 */

// ── Modelo deducido del nombre del archivo ──────────────────────────────────

export interface Modelo {
  /** El código tal como está escrito en el nombre del archivo. */
  codigo: string;
  /** La familia a la que pertenece el prefijo. */
  familia: string;
  /**
   * De qué archivo se leyó.
   *
   * 🔴 No es el mismo que la imagen que se muestra, y por eso viaja aparte. Con
   *    una foto propia cargada, la imagen es `rb2011.webp` pero el modelo puede
   *    haber salido del icono del TIPO de equipo. La ficha dice «deducido del
   *    nombre del archivo», así que tiene que poder nombrar el archivo
   *    correcto: si nombrara el otro, el dato quedaría sin respaldo.
   */
  archivo: string;
}

/**
 * Prefijos de MikroTik y qué significan.
 *
 * 🔴 Sólo MikroTik, y no es olvido: son los únicos cuyos nombres de archivo
 *    traen un CÓDIGO DE PRODUCTO literal. Los otros nombres reales del catálogo
 *    del ISP —`nanomder.png`, `basestation.png`, `dish.png`, `airfiber-izq.png`,
 *    `olt-tplink.png`— nombran una FAMILIA o directamente una forma, no un
 *    modelo. Convertir `nanomder` en «NanoStation M» es una interpretación, y
 *    una interpretación puesta en la ficha de un equipo se lee como un dato.
 *
 *    Así que acá no se traduce nada: lo que sale a pantalla está literalmente
 *    escrito en el nombre del archivo. Si no lo está, no se muestra. Es la misma
 *    regla que `lib/oui.ts` — antes ningún modelo que uno inventado.
 */
const FAMILIAS: Record<string, string> = {
  RB: 'RouterBOARD de MikroTik',
  CCR: 'Cloud Core Router de MikroTik',
  CRS: 'Cloud Router Switch de MikroTik',
  CSS: 'Cloud Smart Switch de MikroTik',
};

/**
 * El código de producto al principio del nombre del archivo.
 *
 * Se corta en el primer carácter que no es letra ni dígito, y eso es
 * deliberado. Los nombres reales llevan cosas pegadas detrás con guión que NO
 * son parte del modelo:
 *
 *   `ccr2116-01.png`        el `-01` es el número de la foto, no del producto
 *   `RB2011iL-rack.png`     `-rack` describe la foto
 *   `crs326-24g-2s.png`     acá el sufijo SÍ es del modelo… pero distinguirlo
 *                           del caso de arriba requiere saber de catálogos.
 *
 * Cortar siempre da menos información y nunca da información falsa. «CRS326» es
 * cierto; «CCR2116-01» sería un modelo que no existe.
 *
 * El `(?!\d)` evita que un `rb11000` se lea como `RB1100`: prefiero no decir
 * nada antes que decir el modelo de al lado.
 */
const CODIGO_MODELO = /^(rb|ccr|crs|css)(\d{3,4})(?!\d)([a-z]*)/i;

/**
 * El modelo que se puede leer en el nombre de un archivo de icono. `null` si no
 * hay ninguno legible, que es el caso más común.
 */
export function modeloDeArchivo(rel: string | null | undefined): Modelo | null {
  const base = baseDeIcono(rel);
  if (!base) return null;

  const m = CODIGO_MODELO.exec(base);
  if (!m) return null;

  const prefijo = m[1]!.toUpperCase();
  // El sufijo va con el case que trae el archivo (`RB3011UiAS`): corregirlo
  // sería volver a inventar. Lo único que se normaliza es el prefijo, que en
  // la base aparece de las dos formas (`rb2011.png` y `RB3011UiAS-RM.png`).
  const codigo = `${prefijo}${m[2]}${m[3] ?? ''}`;
  return { codigo, familia: FAMILIAS[prefijo]!, archivo: rel! };
}

// ── Nombres ─────────────────────────────────────────────────────────────────

/** El nombre del archivo sin directorio ni extensión, con su case original. */
export function baseDeIcono(rel: string | null | undefined): string | null {
  if (!rel) return null;
  // The Dude guarda las rutas con la barra de Windows en algunos casos.
  const limpio = rel.replace(/\\/g, '/');
  const nombre = limpio.slice(limpio.lastIndexOf('/') + 1);
  const base = nombre.replace(/\.[a-z0-9]+$/i, '').trim();
  return base || null;
}

/** La misma base, en minúsculas: es la clave con la que se busca el reemplazo. */
export function claveDeIcono(rel: string | null | undefined): string | null {
  return baseDeIcono(rel)?.toLowerCase() ?? null;
}

/**
 * La clave que le corresponde a UN equipo puntual.
 *
 * 🔴 Hace falta porque el reemplazo por nombre de icono tiene un agujero: si
 *    The Dude no le asignó ningún icono al equipo ni a su tipo, no hay nombre
 *    con el cual nombrar la foto. Sin esta clave, justamente los equipos que
 *    hoy no muestran nada serían los únicos que no se pueden arreglar.
 */
export function claveDeDispositivo(id: number): string {
  return `dispositivo-${id}`;
}

// ── El directorio de fotos propias ──────────────────────────────────────────

/**
 * Formatos aceptados como foto propia, de mejor a peor.
 *
 * El orden sólo decide desempates: si conviven `rb2011.webp` y `rb2011.png`,
 * gana el `webp`. No hay conversión ni procesamiento — lo que se deja en el
 * directorio es lo que se sirve.
 */
export const EXTENSIONES_FOTO = ['webp', 'avif', 'png', 'jpg', 'jpeg', 'gif'] as const;

/**
 * Dónde viven las fotos propias.
 *
 * 🔴 Dos valores por defecto, y no es indecisión: el directorio se MUEVE entre
 *    desarrollo y producción. `public/` es una convención de Astro que sólo
 *    existe en el árbol de fuentes; al compilar, su contenido se copia a
 *    `dist/client/` y la imagen de Docker se lleva `dist/` sin el `public/`
 *    original (ver el Dockerfile: la etapa final copia `dist`, `node_modules` y
 *    `package.json`, nada más).
 *
 *    `FOTOS_EQUIPOS_DIR` está para el caso que no cubre ninguno de los dos: una
 *    imagen ya construida a la que se le monta un volumen con las fotos, sin
 *    volver a compilar. Ver `docs/IMAGENES.md`.
 */
export function directorioDeFotos(): string {
  const propio = texto('FOTOS_EQUIPOS_DIR');
  if (propio) return resolve(propio);
  return resolve(import.meta.env.PROD ? './dist/client/equipos' : './public/equipos');
}

/**
 * El directorio se relee cada minuto.
 *
 * Ni una sola vez ni en cada petición. Una sola vez obligaría a reiniciar el
 * panel para que aparezca una foto recién copiada, que es exactamente el
 * momento en que alguien está mirando la pantalla esperando verla. En cada
 * petición sería un `readdir` por ficha abierta, para un directorio que cambia
 * cada varios meses.
 */
const TTL_INDICE_MS = 60_000;

let indice: Map<string, string> | null = null;
let indiceEn = 0;
let leyendo: Promise<Map<string, string>> | null = null;

function prioridad(nombre: string): number {
  const ext = extension(nombre);
  const i = EXTENSIONES_FOTO.indexOf(ext as (typeof EXTENSIONES_FOTO)[number]);
  return i < 0 ? EXTENSIONES_FOTO.length : i;
}

async function leerIndice(): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  let entradas;
  try {
    entradas = await readdir(directorioDeFotos(), { withFileTypes: true });
  } catch {
    // No existe el directorio, o no se puede leer. No es un error: querer decir
    // que el ISP todavía no cargó ninguna foto propia es el caso normal.
    return mapa;
  }

  for (const e of entradas) {
    // `isFile()` y no `!isDirectory()`: un enlace simbólico acá adentro serviría
    // por `/equipos/…` cualquier archivo que alcance el usuario del proceso.
    // Es el mismo agujero que ya se tapó en `rutaDeArchivo`, y no hay ningún
    // motivo legítimo para poner un enlace en un directorio de fotos.
    if (!e.isFile()) continue;
    const ext = extension(e.name);
    if (!ext || !(EXTENSIONES_FOTO as readonly string[]).includes(ext)) continue;

    const clave = claveDeIcono(e.name);
    if (!clave) continue;

    const previa = mapa.get(clave);
    if (previa && prioridad(previa) <= prioridad(e.name)) continue;
    mapa.set(clave, e.name);
  }
  return mapa;
}

async function indiceDeFotos(): Promise<Map<string, string>> {
  if (indice && Date.now() - indiceEn < TTL_INDICE_MS) return indice;
  // Sin este candado, diez fichas abiertas a la vez disparan diez `readdir`.
  leyendo ??= leerIndice()
    .then((m) => {
      indice = m;
      indiceEn = Date.now();
      return m;
    })
    .finally(() => {
      leyendo = null;
    });
  return leyendo;
}

/** Sólo para los tests: el índice es global al proceso. */
export function limpiarCacheFotos(): void {
  indice = null;
  indiceEn = 0;
  leyendo = null;
}

// ── La decisión ─────────────────────────────────────────────────────────────

/**
 * Por qué no hay imagen. Las tres son cosas distintas y piden acciones
 * distintas, así que la ficha no puede decirlas igual.
 */
export type MotivoSinFoto =
  /** The Dude no le asignó icono ni al elemento ni al tipo de equipo. */
  | 'sin-icono'
  /** El icono asignado es un pictograma vectorial genérico, no una foto. */
  | 'pictograma'
  /** El icono asignado es una imagen, pero el archivo no está en `files/`. */
  | 'archivo-ausente';

export interface Foto {
  clase: 'propia' | 'dude' | 'sin-imagen';
  /** De dónde la baja el navegador. `null` si no hay imagen. */
  url: string | null;
  /** El archivo, para poder decir de dónde salió lo que se está mirando. */
  archivo: string | null;
  modelo: Modelo | null;
  /** Tamaño natural, si se pudo leer del encabezado. Ver `medirEncabezado`. */
  medida: Medida | null;
  motivo: MotivoSinFoto | null;
  /**
   * Cómo hay que llamar a una foto propia para que reemplace a ésta. Va a la
   * pantalla: un estado vacío que no dice cómo llenarlo no sirve de nada.
   */
  nombreSugerido: string;
}

/**
 * ¿Es una imagen de verdad y no un dibujo de línea?
 *
 * Los SVG del directorio son los pictogramas genéricos de The Dude
 * (`router.svg`, `ap.svg`, `client.svg`): line art pensado para 24 px. Ampliarlo
 * a 300 no muestra el equipo, muestra un dibujo — y encima un SVG cargado por
 * `<img>` es un documento aparte que no hereda `currentColor`, así que en el
 * tema oscuro saldría negro sobre negro. Ver el comentario de `iconos.ts`.
 */
export function esRasterizada(rel: string | null | undefined): boolean {
  const ext = extension(rel);
  if (!ext || ext === 'svg' || ext === 'svgz') return false;
  // `Object.hasOwn` y no `TIPOS_IMAGEN[ext]`: la lista blanca se atraviesa por
  // el prototipo. `TIPOS_IMAGEN['constructor']` es truthy. Es el mismo error
  // que ya se corrigió en `pincelDeIcono` y en el endpoint de iconos.
  return Object.hasOwn(TIPOS_IMAGEN, ext);
}

export interface EntradaFoto {
  id: number;
  /** `map_elements.image_id → files.rel_path`. */
  iconoElemento: string | null;
  /** `device_types.image_id → files.rel_path`. */
  iconoTipo: string | null;
}

/**
 * Elige qué imagen mostrar.
 *
 * 🔴 El orden entre el icono del elemento y el del tipo NO es el de The Dude, y
 *    la diferencia es a propósito.
 *
 *    The Dude resuelve elemento primero y tipo después, siempre; el visor de
 *    mapas de este panel lo copia porque su trabajo es dibujar el mapa como lo
 *    dibuja The Dude. Acá el trabajo es otro: mostrar cómo es el equipo. Si el
 *    elemento tiene `router.svg` —un pictograma— y el tipo tiene `rb2011.png`
 *    —una foto de catálogo—, la respuesta útil es la foto. Así que entre los dos
 *    candidatos se prefiere el que sea una imagen de verdad, y el orden
 *    elemento→tipo sólo desempata.
 */
export async function resolverFoto(entrada: EntradaFoto): Promise<Foto> {
  const candidatos = [entrada.iconoElemento, entrada.iconoTipo].filter(
    (c): c is string => !!c,
  );

  const modelo = candidatos.map(modeloDeArchivo).find((m) => m !== null) ?? null;

  // La clave del equipo puntual va primera: una foto sacada de ESTE equipo le
  // gana a la del modelo. Después, el icono del elemento y el del tipo.
  const claves = [
    claveDeDispositivo(entrada.id),
    ...candidatos.map(claveDeIcono).filter((c): c is string => !!c),
  ];

  /**
   * El nombre que se le sugiere a quien quiera cargar una foto.
   *
   * Se prefiere la clave de un candidato RASTERIZADO, y el motivo es práctico:
   * una foto llamada `rb2011.webp` vale para todos los equipos que compartan
   * ese icono, que es lo que uno quiere. Una llamada `router.webp` —el nombre
   * del pictograma genérico— se le aplicaría a cientos de equipos distintos,
   * que es justo lo que no se quiere. En ese caso se cae a la clave del equipo
   * puntual, que no se le pega a nadie más.
   */
  const claveUtil = claveDeIcono(candidatos.find(esRasterizada));
  const nombreSugerido = `${claveUtil ?? claves[0]}.webp`;

  // ── 1 · Foto propia ───────────────────────────────────────────────────────
  const fotos = await indiceDeFotos();
  for (const clave of claves) {
    const archivo = fotos.get(clave);
    if (!archivo) continue;
    return {
      clase: 'propia',
      url: `/equipos/${encodeURIComponent(archivo)}`,
      archivo,
      modelo,
      medida: await medirEnDisco(resolve(directorioDeFotos(), archivo)),
      motivo: null,
      nombreSugerido,
    };
  }

  // ── 2 · El icono de The Dude, si es una imagen y está en el disco ─────────
  for (const rel of candidatos) {
    if (!esRasterizada(rel)) continue;
    if (!(await rutaDeArchivo(rel))) continue;
    return {
      clase: 'dude',
      url: urlDeIcono(rel),
      archivo: rel,
      modelo,
      medida: await medidaDeImagen(rel),
      motivo: null,
      nombreSugerido,
    };
  }

  // ── 3 · Nada, y por qué ───────────────────────────────────────────────────
  const motivo: MotivoSinFoto =
    candidatos.length === 0
      ? 'sin-icono'
      : candidatos.some(esRasterizada)
        ? 'archivo-ausente'
        : 'pictograma';

  return {
    clase: 'sin-imagen',
    url: null,
    // El archivo se conserva aunque no haya imagen: es lo que le permite al
    // aviso decir CUÁL archivo falta en vez de «no hay imagen».
    archivo: candidatos.find((c) => esRasterizada(c)) ?? candidatos[0] ?? null,
    modelo,
    medida: null,
    motivo,
    nombreSugerido,
  };
}

/**
 * Ancho y alto de un archivo propio, leídos de su encabezado.
 *
 * Se reusa `medirEncabezado` de `iconos.ts` en vez de agregar una dependencia:
 * son cuatro formatos con encabezados triviales. Devuelve `null` para `webp` y
 * `avif`, que ese lector no conoce — y no pasa nada, porque el hueco de la
 * imagen lo reserva el contenedor con `aspect-ratio`. Los `width`/`height` son
 * una precisión extra, no el mecanismo.
 */
async function medirEnDisco(abs: string): Promise<Medida | null> {
  let fd: FileHandle | null = null;
  try {
    fd = await open(abs, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return medirEncabezado(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fd?.close().catch(() => {});
  }
}

// ── La base ─────────────────────────────────────────────────────────────────

/**
 * Los dos iconos que The Dude tiene para un equipo.
 *
 * La consulta vive acá y no en `lib/consultas.ts` porque no la usa nada más:
 * es el dato que necesita este panel y nadie más lo pide. Mismo criterio que el
 * JOIN de `services_down` en `lienzoMapa`.
 *
 * Un equipo puede estar en varios mapas con iconos distintos; se toma el del
 * elemento de menor id para que la ficha no cambie de foto entre recargas.
 */
export async function iconosDeDispositivo(
  id: number,
): Promise<{ elemento: string | null; tipo: string | null }> {
  const fila = await consultarUna<{ elemento: string | null; tipo: string | null }>(
    `SELECT (SELECT f.rel_path
               FROM map_elements e
               JOIN files f ON f.id = e.image_id
              WHERE e.device_id = d.id AND f.rel_path IS NOT NULL
              ORDER BY e.id
              LIMIT 1)     AS elemento,
            ft.rel_path    AS tipo
       FROM devices d
       LEFT JOIN device_types t  ON t.id  = d.type_id
       LEFT JOIN files       ft  ON ft.id = t.image_id
      WHERE d.id = $1`,
    [id],
  );
  return { elemento: fila?.elemento ?? null, tipo: fila?.tipo ?? null };
}

/** Todo junto: la base y la decisión. Es lo que usa `FotoEquipo.astro`. */
export async function fotoDeDispositivo(id: number): Promise<Foto> {
  const { elemento, tipo } = await iconosDeDispositivo(id);
  return resolverFoto({ id, iconoElemento: elemento, iconoTipo: tipo });
}
