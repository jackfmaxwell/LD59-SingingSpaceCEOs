import { planetScoring, urlSpecificScoring } from './gameState.js'

function planetScoreForKey(planetKey) {
  const k = String(planetKey ?? '').trim().toLowerCase()
  if (!k) return 0
  const v = planetScoring[k]
  return Number.isFinite(Number(v)) ? Number(v) : 0
}

function pathnameTail(url) {
  try {
    const u = new URL(String(url), typeof location !== 'undefined' ? location.href : 'http://local/')
    return decodeURIComponent(u.pathname.replace(/^\/+/, '')).replace(/\\/g, '/').toLowerCase()
  } catch {
    return String(url ?? '')
      .replace(/\\/g, '/')
      .toLowerCase()
  }
}

function fileNameFromUrl(url) {
  const p = pathnameTail(url)
  const seg = p.split('/').pop() || ''
  return seg
}

/** Strip Vite content hash before extension, e.g. `banjo-CPlyTrmY.mp3` → `banjo`. */
function logicalAssetStem(filename) {
  const base = String(filename ?? '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(mp3|wav|ogg|webm)$/i, '')
  if (!base) return ''
  return base.replace(/-[a-z0-9]{4,}$/i, '')
}

/**
 * Match Vite-resolved URLs and relative registry keys in `urlSpecificScoring`.
 * @param {string | null | undefined} url
 * @param {string | null | undefined} [dominantSoundFile] basename from recording metadata
 */
export function lookupUrlSpecificScore(url, dominantSoundFile) {
  const file = fileNameFromUrl(url)
  const stemFromMeta = logicalAssetStem(dominantSoundFile || file || '')
  const s = pathnameTail(url)
  if(!url) return -3;
  for (const [key, val] of Object.entries(urlSpecificScoring)) {
    const nk = String(key).replace(/\\/g, '/').toLowerCase()
    const keyFile = nk.split('/').pop() || ''
    const keyStem = logicalAssetStem(keyFile)
    if (stemFromMeta && keyStem && stemFromMeta === keyStem) {
      return Number(val) || 0
    }
    if (file && keyFile && file === keyFile) {
      return Number(val) || 0
    }
    const tailFromAssets = nk.includes('assets/audio/') ? nk.slice(nk.indexOf('assets/audio/')) : nk
    const stripped = nk.replace(/^src\//, '')
    if (
      (nk && s.includes(nk)) ||
      (stripped && s.includes(stripped)) ||
      (tailFromAssets && s.includes(tailFromAssets))
    ) {
      return Number(val) || 0
    }
  }
  return 0
}

/**
 * Map baked-in FX choices to a roughly symmetric contribution (CEO taste).
 */
export function scoreFilterSnapshot(filters) {
  if (!filters) return 0
  let s = 0

  if (filters.bandEnabled) {
    const lo = Number(filters.bandLoHz)
    const hi = Number(filters.bandHiHz)
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const span = Math.max(0, hi - lo)
      if (span > 400 && span < 12000) s += 2.25
      else s += 0.35
    }
  }

  if (filters.reverbEnabled) {
    const mix = Math.max(0, Math.min(1, Number(filters.reverbMix) || 0))
    const sec = Math.max(0, Number(filters.reverbSeconds) || 0)
    const wetness = mix * Math.min(1.2, sec / 2.5)
    s += 2.8 * (1 - wetness)
    if (mix < 0.12) s += 0.4
  } else {
    s += 0.9
  }

  if (filters.pitchEnabled) {
    const depth = Math.max(0, Number(filters.pitchDepth) || 0)
    const harsh = Math.min(1, depth / 0.01)
    s -= harsh * 5.5
  }

  const og = Number(filters.outputGain)
  if (Number.isFinite(og)) {
    if (og > 1.4) s -= (og - 1.4) * 5
    if (og < 0.5) s -= (0.5 - og) * 4
  }

  const ig = Number(filters.inputGain)
  if (Number.isFinite(ig) && ig < 0.12) s -= 1.1

  return s
}

function notePitchContribution(semitones) {
  const st = Math.abs(Number(semitones) || 0)
  // Optimal positive contribution for modest pitch shift, less for too small and too high
  if (st <= 1) return 0.9    // low pitch shift, small positive
  if (st <= 5) return 1.65   // ideal range, highest contribution
  if (st <= 8) return 1.2    // still good, slightly less
  return 0.6                 // large shifts get lower, but still positive
}

export function computeVcSongVerdict(contexts, opts) {
  const random = opts?.random ?? Math.random
  const list = contexts?.length ? contexts : [{}]
  const n = Math.max(1, list.length)

  let planetSum = 0
  let urlSum = 0
  let filterSum = 0
  let noteSum = 0

  for (const c of list) {
    console.log('c', c)
    if(c.dominantUrl){
      planetSum += planetScoreForKey(c.planetKey)
    }
    urlSum += lookupUrlSpecificScore(c.dominantUrl, c.dominantSoundFile)
    filterSum += scoreFilterSnapshot(c.filters)
    noteSum += notePitchContribution(c.notePitchSemitones)
  }

  const planet = planetSum / n
  const url = urlSum / n
  const filter = filterSum / n
  const note = noteSum / n
  const jitter = (random() - 0.5) * 7

  const score = planet + url + filter + note + jitter
  const songGood = score >= 0
  console.log('score', score, planet, url, filter, note, jitter)
  return {
    songGood,
    score,
    parts: { planet, url, filter, note, jitter },
  }
}
