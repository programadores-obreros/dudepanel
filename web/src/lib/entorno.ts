/**
 * Lectura de variables de entorno.
 *
 * Hay dos fuentes y no son la misma:
 *
 *  · `process.env` — lo que existe de verdad al ejecutar. Es lo que va a haber
 *    en el contenedor y en systemd.
 *  · `import.meta.env` — lo que Vite inyecta desde los archivos `.env`. Sólo
 *    existe en desarrollo y durante el build.
 *
 * Si se lee una sola, o falla en desarrollo o falla en producción. Por eso se
 * consultan las dos, con `process.env` primero: lo real le gana a lo compilado.
 */
function leer(clave: string): string | undefined {
  const deProceso = typeof process !== 'undefined' ? process.env?.[clave] : undefined;
  if (deProceso != null && deProceso !== '') return deProceso;

  const deVite = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.[clave];
  return deVite != null && deVite !== '' ? deVite : undefined;
}

export function texto(clave: string, porDefecto: string): string;
export function texto(clave: string): string | undefined;
export function texto(clave: string, porDefecto?: string): string | undefined {
  return leer(clave) ?? porDefecto;
}

export function entero(clave: string, porDefecto: number): number {
  const v = Number(leer(clave));
  return Number.isFinite(v) ? v : porDefecto;
}
