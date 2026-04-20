import * as THREE from 'three'

export const STAT_CHART_MAX_POINTS = 64

export const gameState = {
  money: 600_000,
  stakeholderAppreciation: 100,
  moneyHistory: /** @type {number[]} */ ([1_000_000]),
  stakeholderAppreciationHistory: /** @type {number[]} */ ([100]),
  currentPlanet: null,
  repeatingAngle: 0,
  travel: {
    active: false,
    startTime: 0,
    duration: 0,
    t: 0.0,
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
  },
}

/** Full orbit duration (seconds); used with `repeatingAngle` for clip ETA in the audio UI. */
export const ORBIT_PERIOD_SECONDS = 36.0

export const planetNameToKey = {
  'Blue Sky Country Road': 'country',
  'Rock and Roll Planet': 'rock',
  'Afro Planet': 'afro',
  'Disco Ball Planet': 'disco',
  'Earth': 'earth',
}

export const planetScoring = {
  country: -5,
  rock: 5,
  disco: 6,
  earth: -10,
}
export const urlSpecificScoring = {
  'assets/audio/country/banjo.mp3': 10,
  'assets/audio/disco/707kick_160BPM.mp3': 10,
  'assets/audio/rock/hithat3sec_160BPM.mp3': 10,
  'assets/audio/disco/hype.mp3': 10,
}


export function planetKeyFromName(name) {
  return planetNameToKey[name] ?? name
}

export const travelCosts = {
  earth: {
    country: 130_000,
    rock: 400_000,
    disco: 400_000,
  },
  rock: {
    earth: 200_000,
    country: 150_000,
    disco: 500_000,
  },

  country: {
    earth: 100_000,
    rock: 200_000,
    disco: 400_000,
  },
  disco: {
    earth: 100_000,
    rock: 200_000,
    country: 400_000,
  },
}
export const colorGreen='#32CD32'