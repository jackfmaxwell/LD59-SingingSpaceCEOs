import { gameState, ORBIT_PERIOD_SECONDS, planetKeyFromName, colorGreen } from '../gameState.js'
import { createAudioFilters } from './AudioFilters'

const soundCanvas = document.querySelector('#soundVisualizer')
const soundVisualizer = soundCanvas.getContext('2d')

const MAX_LAYERS = 3 //for recording

//3 clips per planet; orbit is split into 3 segments
const MAX_PLANET_CLIPS = 3
const DEG_PER_CLIP_SEGMENT = 360 / MAX_PLANET_CLIPS
//this stores the clips and swaps between them when the segment changes
const crossfade = {
  planetKey: null,
  clipsPlanetKey: null,
  mode: 'buffer',
  clips: [],
  active: null,
  lastClipIndex: -1,
}

let planetClipsLoad = null
let planetClipsLoadKey = null

//the note pitch is the playback rate
let notePitchSemitones = 0

function semitonesToPlaybackRate(semitones) {
  return Math.pow(2, Number(semitones) / 12)
}

//Catch resize
function syncSoundCanvas() {
  const w = soundCanvas.clientWidth
  const h = soundCanvas.clientHeight
  if (w > 0 && h > 0 && (soundCanvas.width !== w || soundCanvas.height !== h)) {
    soundCanvas.width = w
    soundCanvas.height = h
  }
}
syncSoundCanvas()
const sizeObserver = new ResizeObserver(syncSoundCanvas)
sizeObserver.observe(soundCanvas)


const context = new AudioContext({ sampleRate: 1000 * 10 })

const filters = createAudioFilters(context, {
  fftSize: 256,
  masterGain: 0.5,
  band: { enabled: false, loHz: 200, hiHz: 2200 },
  reverb: { enabled: false, mix: 0.25, seconds: 1.2, decay: 2.0 },
})
const { analyser, recordDestination, getFilterSnapshot, outputGain, recordingsBus, voiceCallBus } =
  filters

const frequencyBufferLength = analyser.frequencyBinCount
const frequencyData = new Uint8Array(frequencyBufferLength)

//Space noise
const noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
const noiseData = noiseBuffer.getChannelData(0)
for (let i = 0; i < noiseData.length; i++) {
  noiseData[i] = (Math.random() * 2 - 1) * 0.01
}
const noiseSource = context.createBufferSource()
noiseSource.buffer = noiseBuffer
noiseSource.loop = true
noiseSource.start(0)

//keep noise on its own gain so travel can fade it
const noiseGain = context.createGain()
noiseGain.gain.value = 0.1
noiseSource.connect(noiseGain)
noiseGain.connect(filters.input)

//recording / layering (post-FX, post-output-gain)
//MediaRecorder taps recordDestination, fed from the same outputGain as the speakers.
const recordButton = document.querySelector('#recordButton')
const listenModeButton = document.querySelector('#listenModeButton')

//Planet + space noise should not compete with CEO video call or the beam-song UI
function isPlanetBackgroundSuppressed() {
  const vc = document.querySelector('#videoCallOverlay')
  if (vc && !vc.hidden) return true
  const beam = document.querySelector('#beamSongConfirmOverlay')
  if (beam && !beam.hidden) return true
  return false
}

const layers = []
let isRecording = false
let listenMode = 'live'
let listenModeBeforeBeam = null //Save the state before beam playback because we force record mode

function applyListenMode() {
  const suppressed = isPlanetBackgroundSuppressed()
  const isLive = listenMode === 'live'

  // Mute/unmute recorded layers by setting their per-layer gains.
  for (const layer of layers) {
    if (!layer?.gain?.gain) continue
    setGainSmooth(layer.gain.gain, isLive ? 0 : 1)
  }

  // Immediately mute/unmute the live mix (planet + noise). Without this, the noise
  // (and/or planet) can linger until the next crossfade tick runs.
  const livePlanet = isLive && !suppressed
  if (crossfade?.active?.gain?.gain)
    setGainSmooth(crossfade.active.gain.gain, livePlanet ? 1 : 0)
  if (noiseGain?.gain)
    setGainSmooth(noiseGain.gain, isLive && !suppressed ? noiseGain.gain.value : 0)

  if (listenModeButton) {
    listenModeButton.textContent = isLive ? 'Listen: Live' : 'Listen: Recordings'
  }
}
//Setup button to toggle listen mode
if (listenModeButton) {
  applyListenMode()
  listenModeButton.addEventListener('click', () => {
    listenMode = listenMode === 'live' ? 'recordings' : 'live'
    applyListenMode()
  })
}

//Setup beam playback to force record mode
window.addEventListener('beamplayback:start', () => {
  listenModeBeforeBeam = listenMode
  listenMode = 'recordings'
  ensureAudioRunning()
  applyListenMode()
})
window.addEventListener('beamplayback:end', () => {
  if (listenModeBeforeBeam == null) return
  listenMode = listenModeBeforeBeam
  listenModeBeforeBeam = null
  applyListenMode()
})

//Setup record button display 
function setRecordUiState() {
  if (!recordButton) return
  const count = layers.length
  if (isRecording) {
    recordButton.textContent = 'Recording…'
    recordButton.disabled = true
    return
  }
  recordButton.disabled = false
  recordButton.textContent = count >= MAX_LAYERS ? `Record (full)` : `Record (${count}/${MAX_LAYERS})`
}

export function clearRecordedLayers() {
  for (const layer of layers) {
    try {
      layer?.source?.stop?.()
    } catch (_) {}
    try {
      layer?.source?.disconnect?.()
    } catch (_) {}
    try {
      layer?.gain?.disconnect?.()
    } catch (_) {}
  }
  layers.length = 0
  setRecordUiState()
}

async function addLayerFromBlob(blob, recordedFrom = null) {
  if(layers.length >= MAX_LAYERS) {
    console.error('Max layers reached')
    return
  }
  const arr = await blob.arrayBuffer()
  const buffer = await context.decodeAudioData(arr.slice(0))

  const gain = context.createGain()
  // Respect current listen mode immediately.
  gain.gain.value = listenMode === 'live' ? 0 : 1
  // Recorded layers already include FX “baked in”, so do NOT run them through the live FX chain again.
  // `recordingsBus` sums into master after the analyser tap (see AudioFilters.js).
  gain.connect(recordingsBus)

  const source = context.createBufferSource()
  source.buffer = buffer
  source.loop = true
  // Baked takes already include note-pitch at capture time; 1.0 replays the file as recorded.
  source.playbackRate.value = recordedFrom ? 1 : semitonesToPlaybackRate(notePitchSemitones)
  source.connect(gain)
  source.start(0)

  const layer = { buffer, source, gain, ...(recordedFrom ? { recordedFrom } : {}) }
  layers.push(layer)

  applyListenMode()
}

function pickMimeType() {
  // Prefer common types; fall back to browser default if none supported.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ]
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(t)) return t
  }
  return ''
}

async function recordToLayer() {
  //Capture metadata about the recording for CEOs to grade
  if(layers.length >= MAX_LAYERS) {
    console.error('Max layers reached')
    return
  }
  const recordedFrom = {
    ...getRecordingSourceMetadata(gameState.currentPlanet?.name, gameState.repeatingAngle),
    filters: getFilterSnapshot(),
    notePitchSemitones,
  }
  
  if (!recordDestination?.stream) throw new Error('Record destination not available')
  if (!window.MediaRecorder) throw new Error('MediaRecorder not supported in this browser')
  ensureAudioRunning()

  isRecording = true
  setRecordUiState()

  const chunks = []
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(recordDestination.stream, mimeType ? { mimeType } : undefined)

  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', resolve, { once: true })
    recorder.addEventListener('error', (e) => reject(e?.error ?? e), { once: true })
  })

  recorder.addEventListener('dataavailable', (ev) => {
    if (ev?.data && ev.data.size > 0) chunks.push(ev.data)
  })

  recorder.start()

  await new Promise((r) => setTimeout(r, 6000))
  try {
    recorder.stop()
  } catch (_) {}

  await stopped

  const blob = new Blob(chunks, { type: mimeType || undefined })
  await addLayerFromBlob(blob, recordedFrom)
}

if (recordButton) {
  setRecordUiState()
  recordButton.addEventListener('click', async () => {
    if (isRecording) return
    try {
      await recordToLayer()
    } catch (err) {
      console.error('Recording failed', err)
    } finally {
      isRecording = false
      setRecordUiState()
    }
  })
}

const bandFrequencyLow = document.querySelector('#bandFrequencyLow')
const bandFrequencyHigh = document.querySelector('#bandFrequencyHigh')
const bandFrequencyCheckbox = document.querySelector('#bandFrequencyCheckbox')
if (bandFrequencyCheckbox) {
  filters.setBandEnabled(Boolean(bandFrequencyCheckbox.checked))
  if (bandFrequencyLow) bandFrequencyLow.disabled = !bandFrequencyCheckbox.checked
  if (bandFrequencyHigh) bandFrequencyHigh.disabled = !bandFrequencyCheckbox.checked

  bandFrequencyCheckbox.addEventListener('change', () => {
    const enabled = Boolean(bandFrequencyCheckbox.checked)
    filters.setBandEnabled(enabled)
    if (bandFrequencyLow) bandFrequencyLow.disabled = !enabled
    if (bandFrequencyHigh) bandFrequencyHigh.disabled = !enabled
  })
}

const bandFrequencyValue = document.querySelector('#bandFrequencyValue')

function normalizeBandSliders(lastMovedId) {
  if (!bandFrequencyLow || !bandFrequencyHigh) return { lo: 200, hi: 2200 }
  const min = Number(bandFrequencyLow.min)
  const max = Number(bandFrequencyLow.max)
  const step = Number(bandFrequencyLow.step) || 50
  const gap = step

  let lo = Math.max(min, Math.min(max, Number(bandFrequencyLow.value)))
  let hi = Math.max(min, Math.min(max, Number(bandFrequencyHigh.value)))

  if (hi < lo + gap) {
    if (lastMovedId === 'bandFrequencyLow') {
      hi = lo + gap
      if (hi > max) {
        hi = max
        lo = max - gap
      }
    } else if (lastMovedId === 'bandFrequencyHigh') {
      lo = hi - gap
      if (lo < min) {
        lo = min
        hi = min + gap
      }
    } else {
      hi = lo + gap
      if (hi > max) {
        hi = max
        lo = max - gap
      }
    }
  }

  bandFrequencyLow.value = String(lo)
  bandFrequencyHigh.value = String(hi)
  return { lo, hi }
}

function syncBandFrequencyRange(lastMovedId) {
  if (!bandFrequencyLow || !bandFrequencyHigh || !bandFrequencyValue) return
  const { lo, hi } = normalizeBandSliders(lastMovedId ?? '')
  bandFrequencyValue.textContent = `${Math.round(lo)} – ${Math.round(hi)} Hz`
  const min = Number(bandFrequencyLow?.min ?? 50)
  const max = Number(bandFrequencyLow?.max ?? 4400)
  const span = max - min
  const pctLo = span > 0 ? ((lo - min) / span) * 100 : 0
  const pctHi = span > 0 ? ((hi - min) / span) * 100 : 0
  bandFrequencyLow?.style.setProperty('--wf-range-pct', `${pctLo}%`)
  bandFrequencyHigh?.style.setProperty('--wf-range-pct', `${pctHi}%`)
  filters.setBandFrequencies(lo, hi)
}

function onBandSliderInput(ev) {
  syncBandFrequencyRange(ev?.target?.id)
}

if (bandFrequencyLow && bandFrequencyHigh) {
  bandFrequencyLow.addEventListener('input', onBandSliderInput)
  bandFrequencyHigh.addEventListener('input', onBandSliderInput)
  syncBandFrequencyRange()
}

// --- Reverb UI ---
const reverbEnabledCheckbox = document.querySelector('#reverbEnabledCheckbox')
const reverbMix = document.querySelector('#reverbMix')
const reverbTime = document.querySelector('#reverbTime')
const reverbValue = document.querySelector('#reverbValue')

function syncReverbUi() {
  if (!reverbValue) return
  const mix = reverbMix ? Number(reverbMix.value) : 0
  const secs = reverbTime ? Number(reverbTime.value) : 1.2
  reverbValue.textContent = `${Math.round(mix * 100)}% / ${secs.toFixed(1)}s`
}

if (reverbEnabledCheckbox) {
  const enabled = Boolean(reverbEnabledCheckbox.checked)
  filters.setReverbEnabled(enabled)
  if (reverbMix) reverbMix.disabled = !enabled
  if (reverbTime) reverbTime.disabled = !enabled

  reverbEnabledCheckbox.addEventListener('change', () => {
    const on = Boolean(reverbEnabledCheckbox.checked)
    filters.setReverbEnabled(on)
    if (reverbMix) reverbMix.disabled = !on
    if (reverbTime) reverbTime.disabled = !on
  })
}

function onReverbInput() {
  const mix = reverbMix ? Number(reverbMix.value) : 0.25
  const secs = reverbTime ? Number(reverbTime.value) : 1.2
  filters.setReverbParams({ mix, seconds: secs })
  syncReverbUi()
}

if (reverbMix) reverbMix.addEventListener('input', onReverbInput)
if (reverbTime) reverbTime.addEventListener('input', onReverbInput)
syncReverbUi()

// --- Pitch UI (single slider controls depth; 0 disables) ---
const pitchDepth = document.querySelector('#pitchDepth')
const pitchDepthValue = document.querySelector('#pitchDepthValue')

function syncPitchUi() {
  if (!pitchDepth || !pitchDepthValue) return
  const v01 = Math.max(0, Math.min(1, Number(pitchDepth.value)))
  pitchDepthValue.textContent = `${Math.round(v01 * 100)}%`

  // Map slider 0..1 -> depth seconds (0..8ms).
  const depthSec = v01 * 0.008
  filters.setPitchEnabled(depthSec > 0)
  filters.setPitchParams({
    depth: depthSec,
    rateHz: 6.0,
    baseDelayMs: 8.0,
  })
}

if (pitchDepth) {
  syncPitchUi()
  pitchDepth.addEventListener('input', syncPitchUi)
}

// --- Note pitch (playbackRate on sources; transposes pitch + speed) ---
const notePitchSemitonesEl = document.querySelector('#notePitchSemitones')
const notePitchSemitonesValue = document.querySelector('#notePitchSemitonesValue')

function syncAllPlaybackRatesFromNotePitch() {
  const rate = semitonesToPlaybackRate(notePitchSemitones)
  if (crossfade.active) {
    const pair = crossfade.active
    if (pair.kind === 'buffer') pair.source.playbackRate.value = rate
    else if (pair.kind === 'media') pair.el.playbackRate = rate
  }
}

function syncNotePitchSemitonesUi() {
  if (!notePitchSemitonesEl || !notePitchSemitonesValue) return
  notePitchSemitones = Math.round(
    Math.max(-12, Math.min(12, Number(notePitchSemitonesEl.value))),
  )
  notePitchSemitonesValue.textContent = `${notePitchSemitones >= 0 ? '+' : ''}${notePitchSemitones} st`
  syncAllPlaybackRatesFromNotePitch()
}

if (notePitchSemitonesEl) {
  syncNotePitchSemitonesUi()
  notePitchSemitonesEl.addEventListener('input', syncNotePitchSemitonesUi)
}

// --- Master output gain (post FX; affects hear + record) ---
const masterOutputGain = document.querySelector('#masterOutputGain')
const masterOutputGainValue = document.querySelector('#masterOutputGainValue')

function syncMasterOutputGainUi() {
  if (!masterOutputGain || !masterOutputGainValue) return
  const g = Number(masterOutputGain.value)
  masterOutputGainValue.textContent = `${Math.round(g * 100)}%`
  filters.setOutputGain(g)
}

if (masterOutputGain) {
  syncMasterOutputGainUi()
  masterOutputGain.addEventListener('input', syncMasterOutputGainUi)
}

const PUBLIC_AUDIO_RELATIVE_PATHS = [
  'assets/audio/ceos/adlibs/NerdAdlib_Thatsright.wav',
  'assets/audio/ceos/adlibs/NerdAdlib_Thatsright2.wav',
  'assets/audio/ceos/adlibs/NerdAdlib_Thatsright3.wav',
  'assets/audio/ceos/adlibs/NerdAdlib_YesBoss1.wav',
  'assets/audio/ceos/adlibs/NerdAdlib_YesBoss2.wav',
  'assets/audio/ceos/adlibs/NerdAdlib_YesBoss3.wav',
  'assets/audio/ceos/bad/BAD.wav',
  'assets/audio/ceos/bad/BADBADBAD.wav',
  'assets/audio/ceos/bad/PoorPeformance.wav',
  'assets/audio/ceos/bad/TakeALookChart.wav',
  'assets/audio/ceos/decisionIs/StakeholdersTalking.wav',
  'assets/audio/ceos/decisionIs/TheSongWas.wav',
  'assets/audio/ceos/decisionIs/TheyThink.wav',
  'assets/audio/ceos/fired/FIRED.wav',
  'assets/audio/ceos/good/WeLikedWhatWeHearing.wav',
  'assets/audio/ceos/good/WeLikeWhatwerehearing2.wav',
  'assets/audio/ceos/hello/CanYouHearUs.wav',
  'assets/audio/ceos/hello/IsThisOn.wav',
  'assets/audio/ceos/welcome/TUTORIAL.wav',
  'assets/audio/country/banjo.mp3',
  'assets/audio/country/MyBootsFreedom.wav',
  'assets/audio/disco/707kick_160BPM.mp3',
  'assets/audio/disco/DISCOPLANETYA.wav',
  'assets/audio/disco/hype.mp3',
  'assets/audio/disco/piano.mp3',
  'assets/audio/earth/EarthNews.wav',
  'assets/audio/earth/Spokenword.wav',
  'assets/audio/rock/ELECTRICGUITAR_160bpm.mp3',
  'assets/audio/rock/hithat3sec_160BPM.mp3',
]

function publicAssetUrl(relFromSiteRoot) {
  const rel = String(relFromSiteRoot).replace(/^\/+/, '')
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? `${base}${rel}` : `${base}/${rel}`
}

const audioUrlsByPath = Object.fromEntries(
  PUBLIC_AUDIO_RELATIVE_PATHS.map((p) => [p, publicAssetUrl(p)]),
)

function normalizeAudioGlobPath(p) {
  return String(p).replace(/\\/g, '/')
}

export function listCeoVoiceUrlsInFolder(folderName) {
  const safe = String(folderName ?? '').trim().toLowerCase()
  if (!safe) return []
  const needle = `/ceos/${safe}/`
  const urls = []
  for (const [p, url] of Object.entries(audioUrlsByPath)) {
    if (normalizeAudioGlobPath(p).toLowerCase().includes(needle)) urls.push(url)
  }
  return urls
}

export function pickRandomFromUrls(urls) {
  const list = (urls ?? []).filter(Boolean)
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

export function pickRandomDistinctUrls(urls, count) {
  const list = [...new Set((urls ?? []).filter(Boolean))].sort(() => Math.random() - 0.5)
  return list.slice(0, Math.min(count, list.length))
}

/** Plain objects for VC / beam grading (planet registry, URL registry, per-take FX). */
export function getSongScoringContexts() {
  const out = []
  for (const layer of layers) {
    const rf = layer?.recordedFrom
    if (!rf) continue
    out.push({
      planetKey: rf.planetKey,
      dominantUrl: rf.dominantUrl ?? null,
      dominantSoundFile: rf.dominantSoundFile ?? null,
      filters: rf.filters ?? null,
      notePitchSemitones: Number(rf.notePitchSemitones) || 0,
    })
  }
  if (!out.length) {
    out.push({
      planetKey: planetKeyFromName(gameState.currentPlanet?.name) || 'earth',
      dominantUrl: null,
      filters: getFilterSnapshot(),
      notePitchSemitones,
    })
  }
  return out
}

function getPlanetClipUrls(planetName) {
  const key = planetKeyFromName(planetName)
  const prefix = `assets/audio/${key}/`
  const urls = []
  for (const [p, url] of Object.entries(audioUrlsByPath)) {
    if (p.toLowerCase().startsWith(prefix)) urls.push(url)
  }
  // Stable ordering so segment 0..2 maps to files deterministically.
  urls.sort((a, b) => String(a).localeCompare(String(b)))
  return urls.slice(0, MAX_PLANET_CLIPS)
}

async function loadAudioBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch audio (${res.status}) ${url}`)
  const arr = await res.arrayBuffer()
  return await context.decodeAudioData(arr)
}

const planetClipsCache = new Map() // planetKey -> Promise<{ mode: 'buffer', clips: any[] }>
async function getPlanetClips(planetName) {
  const key = planetKeyFromName(planetName)
  if (!key) return { mode: 'buffer', clips: [] }

  if (!planetClipsCache.has(key)) {
    const urls = getPlanetClipUrls(key) //Get the URLS for the planet
    //Set the audio buffers for the planet
    planetClipsCache.set(
      key,
      (async () => {
        if (!urls.length) return { mode: 'buffer', clips: [] }

        try {
          const buffers = await Promise.all(urls.map(loadAudioBuffer))
          return {
            mode: 'buffer',
            clips: buffers.filter(Boolean).map((buffer) => ({ kind: 'buffer', buffer })),
          }
        } catch (err) {
          console.warn('Falling back to MediaElement audio for planet', key, err)
          return {
            mode: 'media',
            clips: urls.map((url) => ({ kind: 'media', url })),
          }
        }
      })(),
    )
  }

  //Return the audio buffers for the planet
  try {
    return await planetClipsCache.get(key)
  } catch (err) {
    console.error('Failed to load planet clips', key, err)
    planetClipsCache.delete(key)
    return { mode: 'buffer', clips: [] }
  }
}

function createLoopingNodeForClip(clip) {
  const gain = context.createGain()
  gain.gain.value = 0
  gain.connect(filters.input)

  const rate = semitonesToPlaybackRate(notePitchSemitones)

  if (clip?.kind === 'media') {
    const el = new Audio()
    el.src = clip.url
    el.loop = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    el.playbackRate = rate

    const source = context.createMediaElementSource(el)
    source.connect(gain)

    // Start is subject to autoplay policies; we also resume context on pointerdown.
    el.play().catch(() => {})
    return { kind: 'media', el, source, gain, clip }
  }

  const source = context.createBufferSource()
  source.buffer = clip?.buffer
  source.loop = true
  source.playbackRate.value = rate
  source.connect(gain)

  return { kind: 'buffer', source, gain, clip }
}



function stopNodePair(nodePair) {
  if (!nodePair) return
  try {
    if (nodePair.kind === 'buffer') nodePair.source.stop()
  } catch (_) {}
  try {
    nodePair.source.disconnect()
  } catch (_) {}
  try {
    nodePair.gain.disconnect()
  } catch (_) {}
  try {
    if (nodePair.kind === 'media') {
      nodePair.el.pause()
      nodePair.el.src = ''
    }
  } catch (_) {}
}

function setGainSmooth(param, value) {
  const now = context.currentTime
  const v = Math.max(0, Math.min(1, value))
  // Small constant-time smoothing to avoid zipper noise.
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(v, now + 0.06)
}

/** Which third of the orbit (0..2), 120° per segment — 3 clip swaps per full rotation. */
function angleToThirdIndex(angleDeg) {
  const a = ((Number(angleDeg) % 360) + 360) % 360
  return Math.floor(a / DEG_PER_CLIP_SEGMENT)
}

/** Degrees until the next 120° boundary (next clip swap). */
function degreesUntilNextThirdBoundary(angleDeg) {
  const a = ((Number(angleDeg) % 360) + 360) % 360
  const seg = Math.floor(a / DEG_PER_CLIP_SEGMENT)
  const nextBoundary = (seg + 1) * DEG_PER_CLIP_SEGMENT
  return nextBoundary - a
}

function secondsUntilNextClipBoundary(angleDeg, orbitPeriodSec) {
  const degLeft = degreesUntilNextThirdBoundary(angleDeg)
  const period = Math.max(1e-6, Number(orbitPeriodSec) || 36)
  const degPerSec = 360 / period
  return degLeft / degPerSec
}

function fileNameFromAudioUrl(url) {
  if (!url) return ''
  try {
    const path = new URL(String(url), location.href).pathname
    return path.split('/').pop() || String(url)
  } catch {
    return String(url).split('/').pop() || ''
  }
}

/** Matches live playback: one clip per 120° segment, index = segmentIndex % clipCount. */
function getRecordingSourceMetadata(planetName, angleDeg) {
  const planetKey = planetKeyFromName(planetName)
  const urls = getPlanetClipUrls(planetName)
  const n = urls.length
  const segmentIndex = angleToThirdIndex(angleDeg)

  if (n === 0) {
    return {
      planetName: String(planetName ?? ''),
      planetKey,
      angleDeg: Number(angleDeg),
      segmentIndex,
      clipCount: 0,
      clipIndex: null,
      clipUrl: null,
      dominantSoundFile: null,
      dominantUrl: null,
    }
  }

  const clipIndex = segmentIndex % n
  const clipUrl = urls[clipIndex]

  return {
    planetName: String(planetName ?? ''),
    planetKey,
    angleDeg: Number(angleDeg),
    segmentIndex,
    clipCount: n,
    clipIndex,
    clipUrl,
    dominantSoundFile: fileNameFromAudioUrl(clipUrl),
    dominantUrl: clipUrl,
  }
}

async function ensurePlanetCrossfade(planetName) {
  const key = planetKeyFromName(planetName)
  if (!key) return
  if (crossfade.clipsPlanetKey === key) return

  if (planetClipsLoadKey !== key || !planetClipsLoad) {
    planetClipsLoadKey = key
    planetClipsLoad = (async () => {
      stopNodePair(crossfade.active)
      crossfade.active = null
      crossfade.lastClipIndex = -1
      crossfade.clips = []

      const result = await getPlanetClips(key)
      if (planetKeyFromName(gameState.currentPlanet?.name) !== key) return

      crossfade.mode = result.mode
      crossfade.planetKey = key
      crossfade.clips = result.clips.slice(0, MAX_PLANET_CLIPS)
      crossfade.clipsPlanetKey = key
      // Clips array changed; same segment index must still rebuild the graph (was old buffers).
      crossfade.lastClipIndex = -1
    })()
  }

  await planetClipsLoad
}

function tickPlanetAudio() {
  if (!gameState.currentPlanet) return
  if (!crossfade.clips.length) return

  const n = crossfade.clips.length
  const segmentIndex = angleToThirdIndex(gameState.repeatingAngle)
  const clipIndex = segmentIndex % n

  if (clipIndex !== crossfade.lastClipIndex || !crossfade.active) {
    stopNodePair(crossfade.active)
    crossfade.active = createLoopingNodeForClip(crossfade.clips[clipIndex])
    if (crossfade.active.kind === 'buffer') crossfade.active.source.start(0)
    crossfade.lastClipIndex = clipIndex
  }

  // If we're listening to recordings, fully mute planet/noise and do NOT let
  // travel logic reintroduce it.
  let fadeAmt = 1
  const bgSuppressed = isPlanetBackgroundSuppressed()
  if (listenMode !== 'live') {
    fadeAmt = 0
  } else if (gameState.travel.active) {
    fadeAmt = Math.max(0, Math.min(1, gameState.travel.t))
    fadeAmt = 0.05 + 0.95 * fadeAmt
  }
  if (bgSuppressed) {
    fadeAmt = 0
  }
  if (crossfade.active?.gain?.gain) setGainSmooth(crossfade.active.gain.gain, fadeAmt)
  let noiseAmt = 0
  if (listenMode === 'live' && gameState.travel.active && !bgSuppressed) {
    noiseAmt = 1 - Math.max(0, Math.min(1, gameState.travel.t))
  }
  setGainSmooth(noiseGain.gain, 1.0 * noiseAmt)
}

// Browsers often require a user gesture to start audio.
function ensureAudioRunning() {
  if (context.state !== 'running') {
    context.resume().catch(() => {})
  }
}
window.addEventListener('pointerdown', ensureAudioRunning, { passive: true })

// --- Video call CEO voice (same AudioContext; dry `voiceCallBus` — no band/reverb/pitch FX) ---
const videoCallBufferCache = new Map()
let videoCallGeneration = 0
/** @type {Set<AudioBufferSourceNode>} */
const videoCallActiveSources = new Set()

function stopAllVideoCallSources() {
  for (const src of videoCallActiveSources) {
    try {
      src.stop()
    } catch {
      /* already stopped */
    }
  }
  videoCallActiveSources.clear()
}

export function stopVideoCallVoice() {
  videoCallGeneration++
  stopAllVideoCallSources()
}


/**
 * Plays a CEO voice line on the video-call bus (may overlap other concurrent lines).
 * Resolves when this clip finishes playback (including after `stopVideoCallVoice`, which still fires `ended`).
 */
export async function playVideoCallVoiceConcurrent(url, gainValue = 1) {
  console.log('playing video call voice', url)
  if (!url) return Promise.resolve()
  const gen = videoCallGeneration
  ensureAudioRunning()
  try {
    await context.resume()
    let buffer = videoCallBufferCache.get(url)
    if (!buffer) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to fetch voice clip (${res.status})`)
      const arr = await res.arrayBuffer()
      buffer = await context.decodeAudioData(arr.slice(0))
      videoCallBufferCache.set(url, buffer)
    }
    if (gen !== videoCallGeneration) return Promise.resolve()
    const src = context.createBufferSource()
    src.buffer = buffer
    const gain = context.createGain()
    gain.gain.value = gainValue
    src.connect(gain)
    gain.connect(voiceCallBus)
    videoCallActiveSources.add(src)
    const staggerMs = Math.random() * 1000 + 800
    return new Promise((resolve) => {
      src.onended = () => {
        videoCallActiveSources.delete(src)
        resolve()
      }
      window.setTimeout(() => {
        if (gen !== videoCallGeneration) {
          resolve()
          return
        }
        try {
          src.start(0)
        } catch {
          resolve()
        }
      }, staggerMs)
    })
  } catch (err) {
    console.warn('Video call voice failed', err)
    return Promise.resolve()
  }
}

const nextClipEtaEl = document.querySelector('#nextClipEta')

function updateNextClipEtaReadout() {
  if (!nextClipEtaEl) return
  if (!gameState.currentPlanet || gameState.travel.active) {
    nextClipEtaEl.textContent = gameState.travel.active ? 'Travel…' : '—'
    return
  }
  const sec = secondsUntilNextClipBoundary(gameState.repeatingAngle, ORBIT_PERIOD_SECONDS)
  if (!Number.isFinite(sec) || sec < 0) {
    nextClipEtaEl.textContent = '—'
    return
  }
  nextClipEtaEl.textContent = `${sec.toFixed(1)}s`
}

function animateSound() {
  requestAnimationFrame(animateSound)
  analyser.getByteFrequencyData(frequencyData)
  updateNextClipEtaReadout()

  if (gameState.currentPlanet) {
    ensurePlanetCrossfade(gameState.currentPlanet.name)
      .then(() => tickPlanetAudio())
      .catch((err) => console.error('Planet audio update failed', err))
  }

  const w = soundCanvas.clientWidth
  const h = soundCanvas.clientHeight
  soundVisualizer.clearRect(0, 0, w, h)
  const barWidth = w / frequencyBufferLength
  soundVisualizer.fillStyle = colorGreen
  for (let i = 0; i < frequencyBufferLength; i++) {
    const barHeight = (frequencyData[i] / 255) * (h / 2)
    soundVisualizer.fillRect(
      i * barWidth,
      h / 2 - barHeight,
      Math.max(0, barWidth - 1),
      barHeight,
    )
    soundVisualizer.fillRect(
      i * barWidth,
      h / 2,
      Math.max(0, barWidth - 1),
      barHeight,
    )
  }
}

animateSound()