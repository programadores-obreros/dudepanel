import { describe, expect, it } from 'vitest';
import { origenAjeno } from '@/middleware';

/**
 * 🔴 Esto es la protección CSRF del panel. Con autenticación básica, el
 *    navegador manda las credenciales también en un formulario disparado desde
 *    otro sitio: sin esta comprobación, una página maliciosa puede hacer que un
 *    editor logueado dé equipos de baja sin enterarse.
 *
 *    Existe porque la de Astro no funciona detrás de un proxy — compara contra
 *    una URL reconstruida que dice `http://localhost`. Ver `middleware.ts`.
 */

const pedido = (
  metodo: string,
  cabeceras: Record<string, string> = {},
  cuerpo?: string,
) => new Request('http://interno/x', { method: metodo, headers: cabeceras, body: cuerpo });

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('origenAjeno', () => {
  it('deja pasar lo que no cambia nada', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(origenAjeno(pedido(m)), m).toBe(false);
    }
  });

  it('acepta el formulario del propio panel', () => {
    expect(
      origenAjeno(pedido('POST', { ...FORM, origin: 'http://panel.local', host: 'panel.local' }, 'a=1')),
    ).toBe(false);
  });

  it('🔴 rechaza el formulario de otro sitio', () => {
    expect(
      origenAjeno(
        pedido('POST', { ...FORM, origin: 'https://malicioso.com', host: 'panel.local' }, 'a=1'),
      ),
    ).toBe(true);
  });

  it('🔴 rechaza si no viene Origin: los navegadores actuales siempre la mandan', () => {
    expect(origenAjeno(pedido('POST', { ...FORM, host: 'panel.local' }, 'a=1'))).toBe(true);
  });

  describe('detrás de un proxy que termina el TLS', () => {
    it('gana x-forwarded-host sobre host, y el esquema NO se compara', () => {
      // El caso real: el navegador pide por HTTPS, Caddy le habla HTTP al panel.
      // Comparar el esquema es exactamente lo que rompía la versión de Astro.
      expect(
        origenAjeno(
          pedido('POST', {
            ...FORM,
            origin: 'https://panel.ejemplo.tld',
            'x-forwarded-host': 'panel.ejemplo.tld',
            host: 'web:4321',
          }, 'a=1'),
        ),
      ).toBe(false);
    });

    it('🔴 y aun así rechaza un origen ajeno', () => {
      expect(
        origenAjeno(
          pedido('POST', {
            ...FORM,
            origin: 'https://malicioso.com',
            'x-forwarded-host': 'panel.ejemplo.tld',
            host: 'web:4321',
          }, 'a=1'),
        ),
      ).toBe(true);
    });
  });

  it('el puerto forma parte del host: no se ignora', () => {
    expect(
      origenAjeno(pedido('POST', { ...FORM, origin: 'http://panel.local:8080', host: 'panel.local' }, 'a=1')),
    ).toBe(true);
  });

  it('un Origin que no es una URL se rechaza en vez de reventar', () => {
    expect(origenAjeno(pedido('POST', { ...FORM, origin: 'null', host: 'panel.local' }, 'a=1'))).toBe(true);
    expect(origenAjeno(pedido('POST', { ...FORM, origin: '@@@', host: 'panel.local' }, 'a=1'))).toBe(true);
  });

  it('los tres tipos de formulario se comprueban, y sólo esos', () => {
    const ajeno = { origin: 'https://malicioso.com', host: 'panel.local' };
    for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      expect(origenAjeno(pedido('POST', { ...ajeno, 'content-type': t }, 'a=1')), t).toBe(true);
    }
    // 🔴 JSON NO pasa por acá, y es correcto: un `content-type` de JSON obliga
    //    al navegador a pedir permiso por CORS antes de mandar nada, y sin
    //    cabeceras de CORS ese permiso no llega. La protección la da el
    //    navegador; duplicarla acá rompería a los clientes legítimos de la API.
    expect(
      origenAjeno(pedido('POST', { ...ajeno, 'content-type': 'application/json' }, '{}')),
    ).toBe(false);
  });

  it('sin content-type se trata como formulario: ante la duda, se comprueba', () => {
    expect(origenAjeno(pedido('DELETE', { origin: 'https://malicioso.com', host: 'panel.local' }))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 EL CASO QUE ROMPIÓ PRODUCCIÓN
//
// La primera versión comparaba `Origin` contra el host y rechazaba al navegador
// de verdad con «este formulario no se envió desde el panel». Andaba con
// `curl -H Origin:…` —así lo probé— y fallaba con un navegador.
//
// La causa: `Origin` NO está garantizado en un POST de formulario de navegación
// de nivel superior al MISMO origen. Varios navegadores lo omiten justamente
// porque no aporta nada, y el código leía esa ausencia como «vino de afuera».
//
// Estos tests fijan el comportamiento con las combinaciones que manda un
// navegador de verdad, no las que yo fabricaba con curl.
// ─────────────────────────────────────────────────────────────────────────────

describe('🔴 Sec-Fetch-Site: la señal que sí mandan los navegadores', () => {
  const nav = (extra: Record<string, string>) =>
    pedido('POST', { ...FORM, host: 'panel.local', ...extra }, 'a=1');

  it('un formulario del propio panel pasa AUNQUE NO VENGA Origin', () => {
    // Éste es exactamente el pedido que rechazaba producción.
    expect(origenAjeno(nav({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });

  it('escrito a mano o desde un favorito también pasa', () => {
    expect(origenAjeno(nav({ 'sec-fetch-site': 'none' }))).toBe(false);
  });

  it('🔴 desde otro sitio se rechaza', () => {
    expect(origenAjeno(nav({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('🔴 desde otro subdominio también: same-site NO es same-origin', () => {
    expect(origenAjeno(nav({ 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('gana sobre Origin: es la señal más confiable de las tres', () => {
    // Si las dos vinieran y se contradijeran, manda la que el navegador
    // calcula solo y una página no puede falsificar.
    expect(
      origenAjeno(nav({ 'sec-fetch-site': 'same-origin', origin: 'https://malicioso.com' })),
    ).toBe(false);
  });
});

describe('respaldo para navegadores sin Sec-Fetch-Site', () => {
  it('cae a Origin', () => {
    expect(origenAjeno(pedido('POST', { ...FORM, origin: 'http://panel.local', host: 'panel.local' }, 'a=1'))).toBe(false);
    expect(origenAjeno(pedido('POST', { ...FORM, origin: 'https://malicioso.com', host: 'panel.local' }, 'a=1'))).toBe(true);
  });

  it('y después a Referer, que es lo que queda en un navegador viejo', () => {
    expect(
      origenAjeno(pedido('POST', { ...FORM, referer: 'https://panel.local/equipos', host: 'panel.local' }, 'a=1')),
    ).toBe(false);
    expect(
      origenAjeno(pedido('POST', { ...FORM, referer: 'https://malicioso.com/x', host: 'panel.local' }, 'a=1')),
    ).toBe(true);
  });

  it('🔴 sin ninguna de las tres se rechaza: eso ya no es un navegador', () => {
    expect(origenAjeno(pedido('POST', { ...FORM, host: 'panel.local' }, 'a=1'))).toBe(true);
  });
});

describe('el rechazo se explica', () => {
  it('dice con qué señal y con qué valor, para poder diagnosticarlo', async () => {
    const { comprobarOrigen } = await import('@/middleware');
    const v = comprobarOrigen(
      pedido('POST', { ...FORM, 'sec-fetch-site': 'cross-site', host: 'panel.local' }, 'a=1'),
    );
    expect(v.ajeno).toBe(true);
    expect(v.senal).toBe('sec-fetch-site');
    expect(v.detalle).toBe('cross-site');
  });

  it('y cuando pasa, también: un permiso mudo no se puede auditar', async () => {
    const { comprobarOrigen } = await import('@/middleware');
    const v = comprobarOrigen(pedido('POST', { ...FORM, 'sec-fetch-site': 'same-origin' }, 'a=1'));
    expect(v).toMatchObject({ ajeno: false, senal: 'sec-fetch-site', detalle: 'same-origin' });
  });
});
