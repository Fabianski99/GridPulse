/*
  Ajustes puramente VISUALES.

  No cambian los datos del circuito.
  Permiten rotar o escalar un trazado si quieres
  que se parezca más a la orientación habitual
  de los mapas oficiales.

  rotation:
    grados de rotación.

  scale:
    escala dentro del viewBox.

  markerOffset:
    distancia de los números de curva
    respecto al trazado.
*/

export const CIRCUIT_VISUAL_OVERRIDES = Object.freeze({
  /*
    Circuitos que en la versión generada
    aparecen demasiado verticales.

    Si alguno queda girado hacia el lado
    contrario, cambia 90 por -90.
  */

  monza: {
    rotation: 90,
    scale: 0.78,
    markerOffset: 46,
  },

  madring: {
    rotation: 90,
    scale: 0.8,
    markerOffset: 45,
  },

  losail: {
    rotation: 90,
    scale: 0.8,
    markerOffset: 45,
  },

  /*
    Estos no necesitan una rotación fuerte,
    pero dejamos configuración individual
    para controlar escala y separación
    de los números de curva.
  */

  silverstone: {
    rotation: 0,
    scale: 0.94,
    markerOffset: 45,
  },

  spa: {
    rotation: 0,
    scale: 0.92,
    markerOffset: 46,
  },

  americas: {
    rotation: 0,
    scale: 0.94,
    markerOffset: 45,
  },

  yas_marina: {
    rotation: 0,
    scale: 0.94,
    markerOffset: 45,
  },
});