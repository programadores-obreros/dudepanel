import { describe, expect, it } from 'vitest';
import { esMacFalsa, fabricante, macsReales, oui, OUI_CONOCIDOS } from '@/lib/oui';

/**
 * Todos los casos de acá salieron de medir la base real de producción el
 * 31/07/2026, no de inventar ejemplos.
 */

describe('la MAC que no es una MAC', () => {
  const FALSA = '00:64:75:64:65:2d';

  it('reconoce el centinela \\x00dude-', () => {
    // 00 64 75 64 65 2d, leído como texto, es «\0dude-». The Dude lo guarda en
    // el campo `macs` de 112 equipos de esta instalación.
    expect(esMacFalsa(FALSA)).toBe(true);
    expect(esMacFalsa(FALSA.toUpperCase())).toBe(true);
  });

  it('no la devuelve como dirección', () => {
    expect(macsReales([FALSA])).toEqual([]);
    expect(macsReales([FALSA, 'd4:ca:6d:00:00:00'])).toEqual(['d4:ca:6d:00:00:00']);
  });

  it('no le atribuye fabricante', () => {
    // 🔴 Es lo que la delató: `006475` salía como el OUI MÁS COMÚN de la red,
    //    y con iconos de MikroTik Y de Ubiquiti a la vez. Un fabricante no
    //    hace eso. Si alguien la vuelve a dejar pasar, esto avisa.
    expect(oui(FALSA)).toBeNull();
    expect(fabricante([FALSA])).toBeNull();
  });

  it('no toca las MACs de verdad', () => {
    for (const m of ['d4:ca:6d:00:00:00', '00:0c:42:00:00:00', '00:27:22:00:00:00']) {
      expect(esMacFalsa(m)).toBe(false);
      expect(macsReales([m])).toEqual([m]);
    }
  });
});

describe('el bit U/L', () => {
  it('lo enmascara: 82:2A:A8 es 80:2A:A8', () => {
    // 🔴 Los radios Ubiquiti prenden el bit «administrada localmente» en las
    //    MAC virtuales de sus interfaces. Medido: 45 direcciones de la base lo
    //    tienen. Sin apagarlo, esos equipos quedan sin fabricante Y se
    //    inventan prefijos que no existen en ningún registro.
    expect(oui('82:2a:a8:00:00:00')).toBe('802AA8');
    expect(oui('80:2a:a8:00:00:00')).toBe('802AA8');
  });

  it('lo enmascara: 06:18:D6 es 04:18:D6', () => {
    expect(oui('06:18:d6:00:00:00')).toBe('0418D6');
    expect(oui('04:18:d6:00:00:00')).toBe('0418D6');
  });

  it('una MAC local resuelve al mismo fabricante que la real', () => {
    expect(fabricante(['82:2a:a8:00:00:00'])?.nombre).toBe('Ubiquiti');
    expect(fabricante(['06:18:d6:00:00:00'])?.nombre).toBe('Ubiquiti');
  });

  it('no toca el resto de los bits del primer byte', () => {
    // Sólo se apaga el segundo bit. Si se enmascarara de más, `D4:CA:6D`
    // (MikroTik) se convertiría en otra cosa y perderíamos 31 equipos.
    expect(oui('d4:ca:6d:00:00:00')).toBe('D4CA6D');
    expect(oui('fc:ec:da:00:00:00')).toBe('FCECDA');
  });
});

describe('fabricante por OUI', () => {
  it.each([
    ['00:15:6d:00:00:00', 'Ubiquiti'],
    ['fc:ec:da:00:00:00', 'Ubiquiti'],
    ['44:d9:e7:00:00:00', 'Ubiquiti'],
    ['00:27:22:00:00:00', 'Ubiquiti'],
    ['d4:ca:6d:00:00:00', 'MikroTik'],
    ['00:0c:42:00:00:00', 'MikroTik'],
    ['48:8f:5a:00:00:00', 'MikroTik'],
    ['98:48:27:00:00:00', 'TP-Link'],
    ['00:04:56:00:00:00', 'Cambium Networks'],
  ])('%s → %s', (mac, esperado) => {
    expect(fabricante([mac])?.nombre).toBe(esperado);
  });

  it('🔴 devuelve null en vez de adivinar', () => {
    // Un fabricante inventado en la ficha es el mismo daño que la MAC falsa
    // que este archivo vino a tapar. Si no se sabe, no se dice.
    expect(fabricante(['aa:bb:cc:00:00:00'])).toBeNull();
    expect(fabricante([])).toBeNull();
    expect(fabricante(null)).toBeNull();
    expect(fabricante(undefined)).toBeNull();
  });

  it('toma la primera dirección que sepa atribuir', () => {
    expect(fabricante(['aa:bb:cc:00:00:00', 'd4:ca:6d:00:00:00'])?.nombre).toBe('MikroTik');
  });

  it('aguanta basura sin explotar', () => {
    for (const m of ['', 'x', '::', 'no-es-una-mac', 'zz:zz:zz:zz:zz:zz']) {
      expect(() => fabricante([m])).not.toThrow();
      expect(fabricante([m])).toBeNull();
    }
  });
});

describe('la tabla', () => {
  it('todas las claves están normalizadas: 6 hex en mayúsculas', () => {
    for (const k of Object.keys(OUI_CONOCIDOS)) {
      expect(k).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it('ninguna clave tiene el bit U/L prendido', () => {
    // Si una entrada lo tuviera, `oui()` nunca la encontraría: normaliza antes
    // de buscar. Sería una línea muerta que parece funcionar.
    for (const k of Object.keys(OUI_CONOCIDOS)) {
      const primero = Number.parseInt(k.slice(0, 2), 16);
      expect(primero & 0x02).toBe(0);
    }
  });

  it('cada entrada declara de dónde salió', () => {
    // La procedencia se muestra en la interfaz. Una marca sin fuente sería una
    // afirmación sin respaldo, que es justo lo que este trabajo evita.
    for (const [k, v] of Object.entries(OUI_CONOCIDOS)) {
      expect(v.nombre.length, k).toBeGreaterThan(2);
      expect(['ieee', 'ieee+iconos', 'iconos']).toContain(v.fuente);
    }
  });

  it('cubre los prefijos más frecuentes de la instalación', () => {
    // Los diez OUI con más equipos en la base real (ya sin la MAC falsa).
    // Si alguien borra una entrada de la tabla, esto lo dice con nombre.
    const TOP = [
      '000456', '00156D', 'FCECDA', '44D9E7', 'CC2DE0',
      '802AA8', 'F09FC2', '002722', 'D4CA6D', '0418D6',
    ];
    const faltan = TOP.filter((o) => !OUI_CONOCIDOS[o]);
    expect(faltan).toEqual([]);
  });
});
