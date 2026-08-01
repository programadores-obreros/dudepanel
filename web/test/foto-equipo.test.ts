import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 *  La imagen del equipo en la ficha.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Nada de esto necesita PostgreSQL: la decisión de qué imagen mostrar se toma
 * con dos rutas de archivo y el contenido de un directorio. La consulta que
 * saca esas dos rutas de la base (`iconosDeDispositivo`) es un SELECT sin
 * lógica; lo que puede equivocarse es todo lo demás, y eso corre siempre.
 *
 * Los nombres de archivo que aparecen acá NO son inventados: son los que están
 * de verdad en la base del ISP, los mismos que ya audita `iconos.test.ts`.
 */

// ── Andamio: un directorio de fotos propias de mentira ──────────────────────
//
// 🔴 Los módulos se importan DINÁMICAMENTE, y no es capricho de estilo.
//
//    `lib/iconos` resuelve `DUDE_FILES_DIR` una sola vez, al cargarse el
//    módulo. Con un `import` normal —que ESM iza arriba de todo— esa
//    resolución pasa ANTES del `beforeAll` que arma los directorios
//    temporales, así que la raíz apunta al valor de producción y todo lo que
//    dependa del disco falla sin decir por qué. Cargándolos después de fijar
//    el entorno, la raíz es la del andamio.

let dirFotos: string;
let dirFiles: string;
let fe: typeof import('@/lib/foto-equipo');
let iconos: typeof import('@/lib/iconos');

/** Deja un archivo con contenido plausible en el directorio de fotos. */
function ponerFoto(nombre: string, bytes: Buffer = Buffer.alloc(8)): void {
  writeFileSync(join(dirFotos, nombre), bytes);
  fe.limpiarCacheFotos();
}

/**
 * Un PNG mínimo pero VÁLIDO para `medirEncabezado`: firma de 8 bytes, largo del
 * chunk, `IHDR`, ancho y alto en big-endian. No dibuja nada; sólo tiene que
 * poder medirse.
 */
function pngDe(ancho: number, alto: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(ancho, 16);
  b.writeUInt32BE(alto, 20);
  return b;
}

beforeAll(async () => {
  dirFotos = mkdtempSync(join(tmpdir(), 'dudepanel-fotos-'));
  dirFiles = mkdtempSync(join(tmpdir(), 'dudepanel-files-'));
  mkdirSync(join(dirFiles, 'images'), { recursive: true });
  process.env.FOTOS_EQUIPOS_DIR = dirFotos;
  process.env.DUDE_FILES_DIR = dirFiles;

  fe = await import('@/lib/foto-equipo');
  iconos = await import('@/lib/iconos');
});

afterEach(() => {
  fe.limpiarCacheFotos();
  iconos.limpiarCacheIconos();
});

afterAll(() => {
  rmSync(dirFotos, { recursive: true, force: true });
  rmSync(dirFiles, { recursive: true, force: true });
  delete process.env.FOTOS_EQUIPOS_DIR;
  delete process.env.DUDE_FILES_DIR;
});

// ════════════════════════════════════════════════════════════════════════════
//  1 · El modelo que se lee en el nombre del archivo
// ════════════════════════════════════════════════════════════════════════════

describe('modeloDeArchivo', () => {
  it('lee los códigos de MikroTik del catálogo REAL del ISP', () => {
    const esperado: Record<string, string> = {
      'images/rb2011.png': 'RB2011',
      'images/rb1100.png': 'RB1100',
      'images/rb751.png': 'RB751',
      'images/crs305.png': 'CRS305',
      'images/crs317.png': 'CRS317',
      // El sufijo del modelo se corta: ver la nota de `CODIGO_MODELO`.
      'images/crs326-24g-2s.png': 'CRS326',
      'images/CCR1036-8G-2Splus.png': 'CCR1036',
      'images/ccr2116-01.png': 'CCR2116',
      // Las letras pegadas a los dígitos SÍ son del modelo, y van con el case
      // que trae el archivo: corregirlo sería volver a inventar.
      'images/RB3011UiAS-RM.png': 'RB3011UiAS',
      'images/RB2011iL-rack.png': 'RB2011iL',
    };
    for (const [archivo, codigo] of Object.entries(esperado)) {
      expect(`${archivo} → ${fe.modeloDeArchivo(archivo)?.codigo}`).toBe(`${archivo} → ${codigo}`);
    }
  });

  it('🔴 NO inventa modelo para los nombres que sólo dicen una familia', () => {
    // Éstos también están en la base real. `nanomder` es casi seguro una
    // NanoStation M — y «casi seguro» no se pone en la ficha de un equipo.
    for (const archivo of [
      'images/nanomder.png',
      'images/nanomizq.png',
      'images/nanoloco5m_izq.png',
      'images/nanobridge5m_der.png',
      'images/basestation.png',
      'images/airfiber-izq.png',
      'images/dish.png',
      'images/panel 5m.jpg',
      'images/olt-tplink.png',
      'files/router.svg',
      'files/client.svg',
    ]) {
      expect(`${archivo} → ${fe.modeloDeArchivo(archivo)?.codigo ?? 'sin modelo'}`).toBe(
        `${archivo} → sin modelo`,
      );
    }
  });

  it('antes que el modelo de al lado, ninguno', () => {
    // Cinco dígitos no es ningún RB1100 conocido: prefiero no decir nada.
    expect(fe.modeloDeArchivo('rb11000.png')).toBeNull();
    // Menos de tres dígitos tampoco es un código de producto.
    expect(fe.modeloDeArchivo('rb75.png')).toBeNull();
    // El prefijo tiene que estar al principio, no en cualquier lado.
    expect(fe.modeloDeArchivo('foto-rb2011.png')).toBeNull();
  });

  it('dice a qué familia pertenece el prefijo', () => {
    expect(fe.modeloDeArchivo('rb2011.png')?.familia).toContain('MikroTik');
    expect(fe.modeloDeArchivo('crs305.png')?.familia).toContain('Switch');
  });

  it('aguanta lo que no es una ruta', () => {
    expect(fe.modeloDeArchivo(null)).toBeNull();
    expect(fe.modeloDeArchivo('')).toBeNull();
    expect(fe.modeloDeArchivo('.png')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  2 · Nombres y claves
// ════════════════════════════════════════════════════════════════════════════

describe('baseDeIcono y claveDeIcono', () => {
  it('saca directorio y extensión', () => {
    expect(fe.baseDeIcono('images/rb2011.png')).toBe('rb2011');
    expect(fe.baseDeIcono('rb2011.png')).toBe('rb2011');
  });

  it('entiende la barra de Windows, que es la que guarda The Dude', () => {
    expect(fe.baseDeIcono('images\\rb2011.png')).toBe('rb2011');
  });

  it('la clave va en minúsculas y la base conserva el case', () => {
    expect(fe.baseDeIcono('images/RB3011UiAS-RM.PNG')).toBe('RB3011UiAS-RM');
    expect(fe.claveDeIcono('images/RB3011UiAS-RM.PNG')).toBe('rb3011uias-rm');
  });

  it('la clave de un equipo puntual no se puede confundir con la de un icono', () => {
    expect(fe.claveDeDispositivo(3417)).toBe('dispositivo-3417');
  });
});

describe('esRasterizada', () => {
  it('los SVG no cuentan como imagen del equipo', () => {
    // Son line art de 24 px: ampliarlos no muestra el equipo, muestra el
    // dibujo. Y por `<img>` no heredan currentColor: negro sobre negro.
    expect(fe.esRasterizada('files/router.svg')).toBe(false);
    expect(fe.esRasterizada('files/router.svgz')).toBe(false);
  });

  it('los formatos reales del directorio sí', () => {
    expect(fe.esRasterizada('images/rb2011.png')).toBe(true);
    expect(fe.esRasterizada('images/panel 5m.jpg')).toBe(true);
    expect(fe.esRasterizada('images/nanomder.PNG')).toBe(true);
  });

  it('🔴 la lista blanca no se atraviesa por el prototipo', () => {
    // `TIPOS_IMAGEN['constructor']` es truthy. Es el mismo agujero que ya se
    // corrigió dos veces en este proyecto.
    expect(fe.esRasterizada('algo.constructor')).toBe(false);
    expect(fe.esRasterizada('algo.toString')).toBe(false);
    expect(fe.esRasterizada('sin-extension')).toBe(false);
    expect(fe.esRasterizada(null)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  3 · La decisión completa
// ════════════════════════════════════════════════════════════════════════════

describe('resolverFoto · sin nada cargado', () => {
  it('sin icono de elemento ni de tipo, lo dice y ofrece la clave del equipo', async () => {
    const f = await fe.resolverFoto({ id: 3417, iconoElemento: null, iconoTipo: null });
    expect(f.clase).toBe('sin-imagen');
    expect(f.motivo).toBe('sin-icono');
    expect(f.url).toBeNull();
    expect(f.nombreSugerido).toBe('dispositivo-3417.webp');
  });

  it('con un pictograma vectorial, distingue el caso', async () => {
    const f = await fe.resolverFoto({
      id: 7,
      iconoElemento: 'files/router.svg',
      iconoTipo: null,
    });
    expect(f.motivo).toBe('pictograma');
    // No se sugiere `router.webp`: ese nombre se le aplicaría a cientos de
    // equipos que comparten el pictograma genérico.
    expect(f.nombreSugerido).toBe('dispositivo-7.webp');
  });

  it('🔴 con el icono asignado pero el archivo ausente, NO dice "no hay icono"', async () => {
    // Son dos cosas distintas: una es trabajo de carga y la otra es que el
    // directorio `files/` no se montó. Decirlas igual manda a buscar al lugar
    // equivocado.
    const f = await fe.resolverFoto({
      id: 9,
      iconoElemento: 'images/rb2011.png',
      iconoTipo: null,
    });
    expect(f.motivo).toBe('archivo-ausente');
    expect(f.archivo).toBe('images/rb2011.png');
    // Y aunque no haya imagen, el modelo se puede leer igual del nombre.
    expect(f.modelo?.codigo).toBe('RB2011');
    expect(f.nombreSugerido).toBe('rb2011.webp');
  });
});

describe('resolverFoto · el icono de The Dude', () => {
  it('lo usa cuando el archivo está de verdad en el disco', async () => {
    writeFileSync(join(dirFiles, 'images', 'rb2011.png'), pngDe(680, 310));
    const f = await fe.resolverFoto({
      id: 9,
      iconoElemento: 'images/rb2011.png',
      iconoTipo: null,
    });
    expect(f.clase).toBe('dude');
    expect(f.url).toBe('/iconos/images/rb2011.png');
    expect(f.medida).toEqual({ ancho: 680, alto: 310 });
  });

  it('🔴 prefiere la imagen del TIPO antes que el pictograma del elemento', async () => {
    // The Dude resuelve elemento→tipo siempre, y el visor de mapas lo copia
    // porque su trabajo es dibujar el mapa como lo dibuja The Dude. Acá el
    // trabajo es otro: mostrar cómo es el equipo. Entre un `router.svg` y un
    // `crs305.png`, la respuesta útil es la foto.
    writeFileSync(join(dirFiles, 'images', 'crs305.png'), pngDe(500, 200));
    const f = await fe.resolverFoto({
      id: 11,
      iconoElemento: 'files/router.svg',
      iconoTipo: 'images/crs305.png',
    });
    expect(f.clase).toBe('dude');
    expect(f.url).toBe('/iconos/images/crs305.png');
    expect(f.modelo?.codigo).toBe('CRS305');
  });

  it('escapa el nombre: hay iconos reales con espacios', async () => {
    writeFileSync(join(dirFiles, 'images', 'panel 5m.jpg'), Buffer.alloc(8));
    const f = await fe.resolverFoto({
      id: 12,
      iconoElemento: 'images/panel 5m.jpg',
      iconoTipo: null,
    });
    expect(f.url).toBe('/iconos/images/panel%205m.jpg');
  });
});

describe('resolverFoto · la foto propia', () => {
  it('le gana al icono de The Dude', async () => {
    writeFileSync(join(dirFiles, 'images', 'rb2011.png'), pngDe(680, 310));
    ponerFoto('rb2011.webp');
    const f = await fe.resolverFoto({
      id: 9,
      iconoElemento: 'images/rb2011.png',
      iconoTipo: null,
    });
    expect(f.clase).toBe('propia');
    expect(f.url).toBe('/equipos/rb2011.webp');
  });

  it('🔴 el modelo recuerda de QUÉ archivo se dedujo, no de la foto que gana', async () => {
    // La ficha dice «deducido del nombre del archivo del icono». Con una foto
    // propia cargada, ese archivo no es el que se está mirando: si el aviso
    // nombrara `rb2011.webp` estaría respaldando el dato con el archivo
    // equivocado — y el nombre de la foto propia lo elige una persona.
    ponerFoto('rb2011.webp');
    const f = await fe.resolverFoto({
      id: 20,
      iconoElemento: 'images/rb2011.png',
      iconoTipo: null,
    });
    expect(f.archivo).toBe('rb2011.webp');
    expect(f.modelo?.archivo).toBe('images/rb2011.png');
  });

  it('la del equipo puntual le gana a la del modelo', async () => {
    ponerFoto('rb2011.webp');
    ponerFoto('dispositivo-9.webp');
    const f = await fe.resolverFoto({
      id: 9,
      iconoElemento: 'images/rb2011.png',
      iconoTipo: null,
    });
    expect(f.url).toBe('/equipos/dispositivo-9.webp');
  });

  it('la clave no distingue mayúsculas: `RB2011.PNG` encuentra `rb2011.webp`', async () => {
    ponerFoto('rb2011.webp');
    const f = await fe.resolverFoto({
      id: 13,
      iconoElemento: 'images/RB2011.PNG',
      iconoTipo: null,
    });
    expect(f.clase).toBe('propia');
  });

  it('entre dos formatos del mismo equipo gana el mejor, no el último leído', async () => {
    ponerFoto('crs317.png', pngDe(800, 400));
    ponerFoto('crs317.webp');
    const f = await fe.resolverFoto({
      id: 14,
      iconoElemento: 'images/crs317.png',
      iconoTipo: null,
    });
    expect(f.url).toBe('/equipos/crs317.webp');
    expect(fe.EXTENSIONES_FOTO.indexOf('webp')).toBeLessThan(fe.EXTENSIONES_FOTO.indexOf('png'));
  });

  it('mide el archivo propio cuando el formato lo permite', async () => {
    ponerFoto('rb1100.png', pngDe(1024, 300));
    const f = await fe.resolverFoto({
      id: 15,
      iconoElemento: 'images/rb1100.png',
      iconoTipo: null,
    });
    expect(f.medida).toEqual({ ancho: 1024, alto: 300 });
  });

  it('un formato que no se sabe medir no rompe nada', async () => {
    // `webp` y `avif` no los lee `medirEncabezado`, y no pasa nada: el hueco lo
    // reserva el contenedor con aspect-ratio, no los atributos de la imagen.
    ponerFoto('rb751.webp');
    const f = await fe.resolverFoto({
      id: 16,
      iconoElemento: 'images/rb751.png',
      iconoTipo: null,
    });
    expect(f.clase).toBe('propia');
    expect(f.medida).toBeNull();
  });

  it('ignora lo que no es una imagen, empezando por su propio LEEME', async () => {
    ponerFoto('LEEME.md', Buffer.from('# no soy una foto'));
    ponerFoto('notas.txt');
    const f = await fe.resolverFoto({
      id: 17,
      iconoElemento: 'images/LEEME.png',
      iconoTipo: null,
    });
    expect(f.clase).toBe('sin-imagen');
  });

  it('🔴 no sirve un enlace simbólico', async () => {
    // Es el mismo agujero que ya se explotó en `files/`: un enlace con nombre
    // de imagen sirviendo cualquier archivo que alcance el usuario del proceso.
    // Acá no hay ningún motivo legítimo para tener uno.
    const destino = join(dirFiles, 'secreto.png');
    writeFileSync(destino, pngDe(10, 10));
    try {
      symlinkSync(destino, join(dirFotos, 'rb1100.png'));
    } catch {
      return; // sin permiso para crear enlaces: no hay nada que verificar
    }
    fe.limpiarCacheFotos();
    const f = await fe.resolverFoto({
      id: 18,
      iconoElemento: 'images/rb1100.png',
      iconoTipo: null,
    });
    expect(f.url).not.toBe('/equipos/rb1100.png');
  });

  it('un directorio de fotos que no existe no es un error', async () => {
    process.env.FOTOS_EQUIPOS_DIR = join(dirFotos, 'no-existe');
    fe.limpiarCacheFotos();
    try {
      const f = await fe.resolverFoto({ id: 19, iconoElemento: null, iconoTipo: null });
      expect(f.clase).toBe('sin-imagen');
    } finally {
      // En `finally` y no al final: si la aserción falla, el resto del archivo
      // seguiría apuntando a un directorio que no existe y el fallo se
      // multiplicaría en pruebas que no tienen nada que ver.
      process.env.FOTOS_EQUIPOS_DIR = dirFotos;
      fe.limpiarCacheFotos();
    }
  });
});

describe('directorioDeFotos', () => {
  it('la variable de entorno manda sobre los valores por defecto', () => {
    expect(fe.directorioDeFotos()).toBe(resolve(dirFotos));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  4 · Lo que de verdad sale a la pantalla
// ════════════════════════════════════════════════════════════════════════════
//
// Lo de arriba verifica que la DECISIÓN sea correcta. Nada de eso ve el defecto
// que este componente puede tener de verdad: un aviso que no dice cuál archivo
// falta, o un script en línea que la CSP tira sin avisar. Ver la nota larga de
// `test/legibilidad.test.ts` — cuatro defectos seguidos pasaron una suite entera
// porque la suite miraba estructuras y el defecto estaba en el dibujo.

describe('el HTML que sale', () => {
  /**
   * Directorio de fotos propio y vacío.
   *
   * Los casos de arriba dejaron `rb2011.webp` y compañía en el compartido, y
   * con eso la rama «icono de The Dude» no se dibujaría nunca: la foto propia
   * le gana siempre. Cada rama se dibuja con el disco que le corresponde.
   */
  let dirLimpio: string;

  beforeAll(() => {
    dirLimpio = mkdtempSync(join(tmpdir(), 'dudepanel-fotos-html-'));
    process.env.FOTOS_EQUIPOS_DIR = dirLimpio;
    fe.limpiarCacheFotos();
  });

  afterAll(() => {
    rmSync(dirLimpio, { recursive: true, force: true });
    process.env.FOTOS_EQUIPOS_DIR = dirFotos;
    fe.limpiarCacheFotos();
  });

  async function dibujar(props: Record<string, unknown>): Promise<string> {
    const { experimental_AstroContainer } = await import('astro/container');
    const contenedor = await experimental_AstroContainer.create();
    const FotoEquipo = (await import('@/components/FotoEquipo.astro')).default;
    return contenedor.renderToString(FotoEquipo, { props });
  }

  it('🔴 NO emite ningún script', async () => {
    // La CSP del panel es `script-src 'self' <hash-del-tema>`. Un script en
    // línea acá lo bloquea el navegador EN SILENCIO: compila, se sirve, se ve
    // bien y no hace nada. Ya pasó con la página de cierre de sesión.
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      foto: await fe.resolverFoto({ id: 9, iconoElemento: null, iconoTipo: null }),
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('el hueco se reserva aunque no haya imagen', async () => {
    // Sin esto la ficha pega un salto cuando la foto termina de bajar, y el
    // salto se lo come justo la sección de acceso que está arriba.
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      foto: await fe.resolverFoto({ id: 9, iconoElemento: null, iconoTipo: null }),
    });
    expect(html).toContain('aspect-[4/3]');
  });

  it('🔴 el estado vacío dice QUÉ falta y CÓMO se arregla', async () => {
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      tipo: 'Algun dispositivo',
      // `rb751.png` no está en el disco del andamio: es justamente el caso.
      foto: await fe.resolverFoto({
        id: 901,
        iconoElemento: 'images/rb751.png',
        iconoTipo: null,
      }),
    });
    // Nombra dónde hay que ir a mirar…
    expect(html).toContain('DUDE_FILES_DIR');
    // …y la ruta exacta que hay que crear para llenarlo.
    expect(html).toContain('web/public/equipos/');
    expect(html).toContain('rb751.webp');
    expect(html).toContain('docs/IMAGENES.md');
  });

  it('con imagen, dibuja la etiqueta y dice de dónde salió', async () => {
    writeFileSync(join(dirFiles, 'images', 'rb2011.png'), pngDe(680, 310));
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      foto: await fe.resolverFoto({
        id: 9,
        iconoElemento: 'images/rb2011.png',
        iconoTipo: null,
      }),
    });
    expect(html).toContain('/iconos/images/rb2011.png');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('width="680"');
    expect(html).toContain('height="310"');
    // El modelo, y de dónde se dedujo. Nunca el dato solo.
    expect(html).toContain('RB2011');
    expect(html).toContain('por el nombre del icono');
    expect(html).toContain('The Dude tiene asignada');
  });

  it('toda imagen lleva texto alternativo con el nombre del equipo', async () => {
    writeFileSync(join(dirFiles, 'images', 'rb2011.png'), pngDe(680, 310));
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      foto: await fe.resolverFoto({
        id: 9,
        iconoElemento: 'images/rb2011.png',
        iconoTipo: null,
      }),
    });
    const alt = /<img[^>]*\salt="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(alt).toContain('Equipo de prueba');
    expect(alt).toContain('RB2011');
  });

  it('el pictograma del hueco no es un emoji: es un SVG', async () => {
    const html = await dibujar({
      id: 9,
      nombre: 'Equipo de prueba',
      foto: await fe.resolverFoto({ id: 9, iconoElemento: null, iconoTipo: null }),
    });
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});
