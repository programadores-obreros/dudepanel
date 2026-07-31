/**
 * Pisar la credencial guardada del navegador.
 *
 * 🔴 ESTO TIENE QUE SER UN MÓDULO APARTE, NO UN `<script>` EN LA PÁGINA.
 *
 *    La CSP de este panel es `script-src 'self' 'sha256-…'` con **un solo
 *    hash**: el del guioncito del tema, calculado sobre su texto exacto en
 *    `lib/cabeceras.ts`. Cualquier OTRO script en línea tiene un hash distinto
 *    y el navegador lo bloquea — que es precisamente para lo que está la CSP.
 *
 *    La primera versión de esta lógica vivía en un `<script>` dentro de
 *    `salir.astro`. Astro lo dejó en línea, la CSP lo cortó, y la página se
 *    quedaba en «Cerrando…» **para siempre, sin ningún error visible**.
 *    Compilaba, se servía, se veía bien, y no hacía nada.
 *
 *    Como módulo se sirve desde `/_astro/…`, que es `'self'`, y pasa.
 *
 * ── Y por qué el cierre de sesión necesita este rodeo ────────────────────────
 *
 * La autenticación básica no tiene cierre de sesión: no existe en el
 * protocolo. La credencial la guarda el navegador y la reenvía sola; no hay
 * cabecera con la que el servidor pueda pedirle que la olvide.
 *
 * Lo único que funciona es PISARLA: mandar un pedido a una ruta protegida con
 * una credencial inválida, para que el navegador reemplace la buena por esa.
 */
export {};

const caja = document.querySelector<HTMLElement>('[data-estado-salida]');
const msg = caja?.querySelector<HTMLElement>('[data-mensaje]');

function decir(texto: string, tono: 'ok' | 'aviso') {
  if (!msg || !caja) return;
  msg.textContent = texto;
  caja.dataset.tono = tono;
}

if (caja) {
  void (async () => {
    try {
      const r = await fetch('/api/estado.json', {
        // Credenciales inválidas A PROPÓSITO: son el mecanismo, no un descuido.
        headers: { Authorization: `Basic ${btoa('salir:salir')}` },
        cache: 'no-store',
      });
      // 🔴 Acá el 401 es el ÉXITO: quiere decir que el navegador mandó lo que
      //    le dimos y el proxy lo rechazó. Un 200 significa que ignoró nuestra
      //    cabecera y siguió usando la credencial buena — o sea, NO cerró, y
      //    hay que decirlo en vez de poner «listo» y que la persona se vaya
      //    creyendo que dejó la máquina segura.
      if (r.status === 401) {
        decir('Listo. La próxima vez que entres te va a pedir usuario y contraseña.', 'ok');
      } else {
        decir(
          `Tu navegador conservó la sesión (respondió ${r.status}). ` +
            'Cerralo por completo para salir del todo.',
          'aviso',
        );
      }
    } catch {
      decir('No se pudo confirmar. Cerrá el navegador por completo para salir del todo.', 'aviso');
    }
  })();
}
