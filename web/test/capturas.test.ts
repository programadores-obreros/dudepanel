import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Las capturas del README.
 *
 * 🔴 LO QUE ESTE ARCHIVO **NO** PUEDE PROBAR, Y HAY QUE DECIRLO PRIMERO.
 *
 *    No puede leer los píxeles. Si alguien saca una captura de la instalación
 *    real y la pega acá, **ningún test la va a atajar**: el nombre de un equipo
 *    y su dirección estarían dibujados, no escritos.
 *
 *    Esa garantía es de PROCEDIMIENTO, no de código, y está escrita en el
 *    README: las capturas se sacan del seed de desarrollo, que sí tiene un
 *    test que lo mantiene limpio (`seed.test.ts`). Reproducirlas es
 *    `docker compose up -d` y cargar `web/seed-dev.sql`.
 *
 * Lo que sí se puede verificar, y es donde de verdad se cuela una fuga sin que
 * nadie lo note, es el METADATO: una captura de pantalla puede traer adentro
 * la ruta del archivo, el nombre de la máquina, el usuario del sistema o —en
 * fotos— hasta coordenadas GPS. Eso es texto, y el texto se revisa.
 */

const CAPTURAS = resolve(__dirname, '../../docs/capturas');
const README = resolve(__dirname, '../../README.md');

function jpgs(): string[] {
  return readdirSync(CAPTURAS)
    .filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
    .map((n) => join(CAPTURAS, n));
}

describe('capturas del README', () => {
  it('hay capturas y el README las usa', () => {
    // Si el directorio queda vacío, los tests de abajo pasarían por no tener
    // nada que revisar. Primero se demuestra que hay algo que revisar.
    const archivos = jpgs();
    expect(archivos.length).toBeGreaterThan(0);

    const readme = readFileSync(README, 'utf8');
    const huerfanas = archivos
      .map((f) => f.split('/').pop()!)
      .filter((n) => !readme.includes(n));
    expect(huerfanas).toEqual([]);
  });

  it('🔴 ninguna trae la ruta, el usuario o la máquina de quien la sacó', () => {
    // Estos strings aparecen en los metadatos de casi cualquier captura hecha
    // con una herramienta de escritorio, y publican más de lo que parece:
    // el nombre de usuario y la estructura de directorios de una máquina.
    const PELIGROSOS = [
      '/home/', '/Users/', 'C:\\', '\\Users\\',
      'manjaro', 'admsrv', 'telwinet', 'tintadigital',
    ];
    const fugas: string[] = [];
    for (const f of jpgs()) {
      const texto = readFileSync(f).toString('latin1');
      for (const p of PELIGROSOS) {
        if (texto.toLowerCase().includes(p.toLowerCase())) {
          fugas.push(`${f.split('/').pop()}: «${p}»`);
        }
      }
    }
    expect(fugas).toEqual([]);
  });

  it('🔴 ninguna trae una dirección fuera del rango de documentación', () => {
    // Un IPv4 en los metadatos de una captura es raro, pero un comentario
    // JPEG o un bloque XMP puede llevar cualquier cosa que haya escrito la
    // herramienta. Cuesta nada revisarlo.
    const DOC = /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|127\.0\.0\.1|0\.0\.0\.0)/;
    const fugas: string[] = [];
    for (const f of jpgs()) {
      const texto = readFileSync(f).toString('latin1');
      for (const ip of texto.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        const octetos = ip.split('.').map(Number);
        if (octetos.some((o) => o > 255)) continue; // no es una IP, son bytes
        if (DOC.test(ip)) continue;
        fugas.push(`${f.split('/').pop()}: ${ip}`);
      }
    }
    expect(fugas).toEqual([]);
  });

  it('pesan poco: el repositorio no es un álbum de fotos', () => {
    // Una captura de 2 MB multiplicada por cada cambio queda en el historial
    // de git para siempre — y el historial no se borra, se reescribe.
    for (const f of jpgs()) {
      const kb = statSync(f).size / 1024;
      expect(kb, f.split('/').pop()).toBeLessThan(400);
    }
  });

  it('el README dice de dónde salieron', () => {
    // La única garantía real de que no hay datos de nadie es que se sacaron
    // del seed. Si ese párrafo desaparece, la garantía se vuelve tácita — y
    // una garantía tácita es la que nadie respeta en seis meses.
    const readme = readFileSync(README, 'utf8');
    expect(readme).toMatch(/seed de desarrollo/i);
    expect(readme).toMatch(/seed-dev\.sql/);
  });
});
