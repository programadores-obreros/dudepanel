import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

  it('ignora lo que no sea svg', async () => {
    await writeFile(join(raiz, 'files', 'clave.pem'), 'ESTO NO SE SIRVE');
    expect(await iconos.leerIcono('files/clave.pem')).toBeNull();
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

describe('claveRepuesto', () => {
  it('reconoce por nombre de archivo de The Dude', () => {
    expect(iconos.claveRepuesto('router.svg')).toBe('router');
    expect(iconos.claveRepuesto('ap.svg')).toBe('ap');
    expect(iconos.claveRepuesto('switch.svg')).toBe('switch');
    expect(iconos.claveRepuesto('client.svg')).toBe('cliente');
    expect(iconos.claveRepuesto('globe.svg')).toBe('globo');
  });

  it('reconoce por la convención de nombres de el ISP', () => {
    expect(iconos.claveRepuesto('Vega_P_Ponte_AC2')).toBe('ap');
    expect(iconos.claveRepuesto('CPE_Alvear_0031')).toBe('cliente');
    expect(iconos.claveRepuesto('RT_Core_A')).toBe('router');
    expect(iconos.claveRepuesto('SW_DC_01')).toBe('switch');
    expect(iconos.claveRepuesto('SRV_Radius')).toBe('server');
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

describe('juegoDeIconos', () => {
  it('emite un símbolo por icono distinto, no uno por nodo', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: null, pista: 'CPE_Ponte_0142' },
      { id: 2, icono: null, pista: 'CPE_Ponte_0187' },
      { id: 3, icono: null, pista: 'CPE_Ponte_0203' },
      { id: 4, icono: null, pista: 'RT_Core_A' },
    ]);
    expect(porNodo.size).toBe(4);
    expect(simbolos.size).toBe(2); // cliente y router
    expect(porNodo.get(1)).toBe(porNodo.get(2));
    expect(porNodo.get(1)).not.toBe(porNodo.get(4));
  });

  it('prefiere el archivo real sobre el de repuesto', async () => {
    const { simbolos, porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/router.svg', pista: 'RT_Core_A' },
    ]);
    expect(porNodo.get(1)).toBe('f-router-svg');
    expect(simbolos.get('f-router-svg')!.monocromo).toBe(false);
  });

  it('si el archivo no está, el nombre del archivo igual guía el repuesto', async () => {
    const { porNodo } = await iconos.juegoDeIconos([
      { id: 1, icono: 'files/ap.svg', pista: 'nombre_que_no_dice_nada' },
    ]);
    expect(porNodo.get(1)).toBe('r-ap');
  });
});
