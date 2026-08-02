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
