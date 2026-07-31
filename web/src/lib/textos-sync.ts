import type { SaludSync } from './consultas';

/**
 * Los textos del indicador de sincronización, en un módulo aparte.
 *
 * Los usan el componente (render en el servidor) y el script de refresco (en el
 * navegador). Si vivieran en el componente habría que repetirlos en el cliente
 * y tarde o temprano dirían cosas distintas.
 */
export const TEXTOS_SYNC: Record<SaludSync, { corto: string; largo: string }> = {
  fresca: { corto: 'Datos al día', largo: '' },
  demorada: {
    corto: 'Sincronización demorada',
    largo: 'El ETL viene atrasado. Lo que ves puede no ser lo que está pasando ahora.',
  },
  vieja: {
    corto: 'Sin datos frescos',
    largo:
      'Hace rato que no llegan datos nuevos de The Dude. El tablero puede estar mostrando una ' +
      'red que ya cambió: no tomes esto como que todo está bien.',
  },
  fallida: {
    corto: 'La sincronización falló',
    largo: 'La última corrida del ETL terminó con error. Lo que se ve es la foto anterior.',
  },
  'sin-datos': {
    corto: 'Nunca sincronizó',
    largo: 'No hay ninguna corrida del ETL registrada. El tablero está vacío o desactualizado.',
  },
};
