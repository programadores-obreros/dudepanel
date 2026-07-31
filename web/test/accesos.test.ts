import { describe, expect, it } from 'vitest';
import { accesos, urlSegura, type DatosAcceso } from '@/lib/accesos';

/**
 * 🔴 La regla que este archivo custodia:
 *
 *    NINGUNA credencial puede salir del panel en una URL, ni resuelta ni como
 *    marcador sin resolver.
 *
 * La plantilla de abajo es la REAL del tipo «MikroTik Device» en la
 * instalación de producción, copiada textual de `device_types.url`. The Dude
 * la resuelve y abre el navegador con la clave del router en la barra de
 * direcciones; el panel no.
 *
 * Las direcciones son del rango de documentación (RFC 5737): la base real no
 * entra a un repositorio público.
 */
const MIKROTIK =
  'http://[Device.FirstAddress]:/cfg?user=[Device.UserName]' +
  '&password=[Device.Password]&process=login&page=start&backpage=';

const IP = '192.0.2.10';

function equipo(p: Partial<DatosAcceso> = {}): DatosAcceso {
  return {
    direcciones: [IP],
    routerOs: false,
    urlTipo: null,
    nombreTipo: null,
    servicios: [],
    ...p,
  };
}

describe('urlSegura', () => {
  it('borra usuario y contraseña de la plantilla real de MikroTik', () => {
    const u = urlSegura(MIKROTIK, IP);
    expect(u).toBe(`http://${IP}/cfg?process=login&page=start&backpage=`);
  });

  it('no deja rastro de credenciales bajo ninguna forma', () => {
    const u = urlSegura(MIKROTIK, IP) ?? '';
    for (const rastro of ['user', 'password', 'Device.UserName', 'Device.Password', '[']) {
      expect(u).not.toContain(rastro);
    }
  });

  it.each([
    ['user', 'http://X/?user=juan'],
    ['username', 'http://X/?username=juan'],
    ['pass', 'http://X/?pass=hola'],
    ['password', 'http://X/?password=hola'],
    ['pwd', 'http://X/?pwd=hola'],
    ['clave', 'http://X/?clave=hola'],
    ['secret', 'http://X/?secret=hola'],
    ['community', 'http://X/?community=public'],
    ['USUARIO en mayúsculas', 'http://X/?USUARIO=juan'],
  ])('borra el parámetro %s', (_n, plantilla) => {
    const u = urlSegura(plantilla.replace('X', '[Device.FirstAddress]'), IP) ?? '';
    expect(u).toBe(`http://${IP}/`);
  });

  it('borra las credenciales embebidas en la autoridad de la URI', () => {
    // `http://usuario:clave@equipo/` es la otra forma de meter un secreto en
    // una URL, y no pasa por `searchParams`. Hay que limpiarla aparte.
    const u = urlSegura('http://juan:hola@[Device.FirstAddress]/admin', IP) ?? '';
    expect(u).toBe(`http://${IP}/admin`);
    expect(u).not.toContain('juan');
    expect(u).not.toContain('hola');
  });

  it('rechaza esquemas que no sean http, https o ftp', () => {
    // El campo lo escribió una persona en 2011 y va a parar a un `href`.
    for (const malo of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'file:///etc/passwd',
      'vbscript:msgbox',
    ]) {
      expect(urlSegura(malo, IP)).toBeNull();
    }
  });

  it('devuelve null si queda un marcador que no sabemos resolver', () => {
    // Mejor el plan B que un enlace con `[Device.Loquesea]` a la vista.
    expect(urlSegura('http://[Device.SecondAddress]/x', IP)).toBeNull();
  });

  it('limpia el puerto vacío que deja The Dude', () => {
    expect(urlSegura('http://[Device.FirstAddress]:/cfg', IP)).toBe(`http://${IP}/cfg`);
  });

  it('conserva un puerto de verdad', () => {
    expect(urlSegura('http://[Device.FirstAddress]:22780', IP)).toBe(`http://${IP}:22780/`);
  });

  it('sin plantilla o sin dirección devuelve null, no una cadena rota', () => {
    expect(urlSegura(null, IP)).toBeNull();
    expect(urlSegura(MIKROTIK, null)).toBeNull();
  });
});

describe('accesos', () => {
  it('sin dirección no ofrece nada: no hay a dónde ir', () => {
    expect(accesos(equipo({ direcciones: [] }))).toEqual([]);
  });

  it('siempre ofrece copiar la dirección', () => {
    const a = accesos(equipo());
    expect(a.at(-1)).toMatchObject({ modo: 'copiar', valor: IP });
  });

  it('Winbox sólo en RouterOS, y como copiar', () => {
    expect(accesos(equipo()).some((a) => a.etiqueta === 'Winbox')).toBe(false);

    const w = accesos(equipo({ routerOs: true })).find((a) => a.etiqueta === 'Winbox');
    // 🔴 `copiar` y no `enlace`: no existe un esquema `winbox://` que el
    //    sistema sepa abrir. Un enlace que no hace nada es peor que no tenerlo.
    expect(w).toMatchObject({ modo: 'copiar', valor: `${IP}:8291` });
    // Y el texto tiene que aclarar que el puerto es convención, no dato.
    expect(w!.porque).toContain('no un dato de la base');
  });

  it('SSH sólo si hay un servicio SSH, y con SU puerto', () => {
    expect(accesos(equipo()).some((a) => a.etiqueta.startsWith('SSH'))).toBe(false);

    const a = accesos(
      equipo({
        servicios: [{ sonda: 'ssh', puerto: 22722, puertoSonda: 22, habilitado: true }],
      }),
    );
    expect(a.find((x) => x.etiqueta.startsWith('SSH'))).toMatchObject({
      modo: 'enlace',
      valor: `ssh://${IP}:22722`,
    });
  });

  it('un servicio DESHABILITADO no genera acceso', () => {
    // En la base real los dos servicios SSH están deshabilitados. Ofrecerlos
    // mandaría a alguien a probar un puerto que nadie está monitoreando.
    const a = accesos(
      equipo({
        servicios: [{ sonda: 'ssh', puerto: 22722, puertoSonda: 22, habilitado: false }],
      }),
    );
    expect(a.some((x) => x.etiqueta.startsWith('SSH'))).toBe(false);
  });

  it('el puerto 0 de un servicio cae al de su sonda', () => {
    // `probe_port = 0` significa «usá el de la sonda»: así está en 857 de los
    // 859 servicios de la base real.
    const a = accesos(
      equipo({
        servicios: [{ sonda: 'ftp', puerto: 0, puertoSonda: 21, habilitado: true }],
      }),
    );
    // 21 es el puerto por omisión de FTP, así que no se escribe en la URL.
    expect(a.find((x) => x.etiqueta === 'FTP')?.valor).toBe(`ftp://${IP}/`);
  });

  it('ningún acceso lleva jamás una credencial', () => {
    const todos = accesos(
      equipo({
        routerOs: true,
        urlTipo: MIKROTIK,
        nombreTipo: 'MikroTik Device',
        servicios: [
          { sonda: 'ssh', puerto: 22722, puertoSonda: 22, habilitado: true },
          { sonda: 'ftp', puerto: 0, puertoSonda: 21, habilitado: true },
          { sonda: 'telnet', puerto: 0, puertoSonda: 23, habilitado: true },
        ],
      }),
    );
    expect(todos.length).toBeGreaterThan(3);
    const fugas = todos.filter((a) =>
      /user=|password=|pass=|\[Device\.(UserName|Password)\]/i.test(a.valor),
    );
    expect(fugas).toEqual([]);
  });

  it('avisa que Telnet viaja en claro', () => {
    const t = accesos(
      equipo({ servicios: [{ sonda: 'telnet', puerto: 0, puertoSonda: 23, habilitado: true }] }),
    ).find((a) => a.etiqueta === 'Telnet');
    expect(t!.porque).toContain('en claro');
  });

  it('todo acceso explica por qué existe', () => {
    // El `title` es lo que evita que el panel parezca magia. Ninguno vacío.
    for (const a of accesos(equipo({ routerOs: true, urlTipo: MIKROTIK }))) {
      expect(a.porque.length).toBeGreaterThan(20);
    }
  });
});
