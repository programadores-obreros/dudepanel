/**
 * Cambio de tema.
 *
 * La resolución inicial la hace un script inline en el `<head>` (ver Base.astro)
 * para que no haya flash. Acá sólo vive el botón, que puede cargarse diferido.
 */
const raiz = document.documentElement;

for (const boton of document.querySelectorAll<HTMLButtonElement>('[data-cambiar-tema]')) {
  boton.addEventListener('click', () => {
    const oscuro = raiz.classList.toggle('dark');
    try {
      // Se guarda la elección explícita, no la del sistema: si el operador
      // eligió claro a mediodía, no queremos que el sistema se lo pise de noche.
      localStorage.setItem('tema', oscuro ? 'oscuro' : 'claro');
    } catch {
      /* Modo privado o almacenamiento bloqueado: el cambio vale para esta sesión. */
    }
    boton.setAttribute('aria-pressed', String(oscuro));
  });
}
