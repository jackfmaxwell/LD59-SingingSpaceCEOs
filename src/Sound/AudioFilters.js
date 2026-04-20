/**
 * Audio filtering 
 *
 * filtering topology  (band limiting, reverb, analyser tap, recording tap).
 */

/**
 * @typedef {Object} AudioFilters
 * @property {AudioContext} context
 * @property {AnalyserNode} analyser
 * @property {MediaStreamAudioDestinationNode} recordDestination
 * @property {GainNode} input Gain node to connect sources into (master bus).
 * @property {GainNode} recordingsBus Dry bus for baked takes (decoded layers); sums into master, never through reverb/band/pitch.
 * @property {GainNode} voiceCallBus Dry bus for CEO / video-call voice; same merge as recordingsBus.
 * @property {GainNode} outputGain Post-FX master gain (hear + record).
 * @property {(enabled: boolean) => void} setBandEnabled
 * @property {(loHz: number, hiHz: number) => void} setBandFrequencies
 * @property {(enabled: boolean) => void} setPitchEnabled
 * @property {(params: { rateHz?: number, depth?: number, baseDelayMs?: number }) => void} setPitchParams
 * @property {(enabled: boolean) => void} setReverbEnabled
 * @property {(params: { mix?: number, seconds?: number, decay?: number }) => void} setReverbParams
 * @property {(linear: number) => void} setOutputGain Post-FX master level (hear + record).
 * @property {() => FilterSnapshot} getFilterSnapshot
 */

/**
 * @typedef {Object} FilterSnapshot
 * @property {number} inputGain
 * @property {number} outputGain
 * @property {boolean} bandEnabled
 * @property {number} bandLoHz
 * @property {number} bandHiHz
 * @property {boolean} pitchEnabled
 * @property {number} pitchRateHz
 * @property {number} pitchDepth
 * @property {number} pitchBaseDelayMs
 * @property {boolean} reverbEnabled
 * @property {number} reverbMix
 * @property {number} reverbSeconds
 * @property {number} reverbDecay
 */

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x)))
}

function clampOutputGain(x) {
  return Math.max(0, Math.min(2, Number(x)))
}

function pickFinite(x, fallback) {
  const n = Number(x)
  return Number.isFinite(n) ? n : fallback
}

//Generate a simple synthetic impulse response (no external asset).
function makeImpulseResponse(context, seconds, decay) {
  const sr = context.sampleRate
  const len = Math.max(1, Math.floor(sr * Math.max(0.05, seconds)))
  const buffer = context.createBuffer(2, len, sr)
  const d = Math.max(0.1, decay)

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < len; i++) {
      const t = i / len
      // Exponential falloff + noise.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, d)
    }
  }
  return buffer
}

/**
 * Create the filtering / FX portion of the WebAudio graph.
 *
 * Topology:
 *   sources -> input(master) -> split dry/wet -> sum -> (optional pitch) -> (optional band) -> analyser
 *     -> preMasterMix --+
 *                        +-> outputGain (post-FX master) -> destination
 *                        |                          \-> recordDestination
 *   recordingsBus (decoded layers / dry overdub) ----+
 *   voiceCallBus (VC clips) -------------------------+
 *
 * Rebuilds only reconnect the live FX tail up to `analyser`; `preMasterMix` -> `outputGain`
 * -> speakers/recorder stay wired so dry recordings never share a node with the convolver chain.
 *
 * @param {AudioContext} context
 * @param {{
 *   fftSize?: number,
 *   masterGain?: number,
 *   band?: { enabled?: boolean, loHz?: number, hiHz?: number },
 *   reverb?: { enabled?: boolean, mix?: number, seconds?: number, decay?: number },
 *   outputGain?: number,
 * }} [opts]
 * @returns {AudioFilters}
 */
export function createAudioFilters(context, opts) {
  const options = opts ?? {}

  const analyser = context.createAnalyser()
  analyser.fftSize = options.fftSize ?? 256

  const recordDestination = context.createMediaStreamDestination()

  /** Post-FX master gain: same signal to speakers and MediaRecorder (via recordDestination). */
  const outputGain = context.createGain()
  outputGain.gain.value = clampOutputGain(options.outputGain ?? 1)

  /** Sums live FX path (post-analyser) with dry recorded layers before master gain. */
  const preMasterMix = context.createGain()
  preMasterMix.gain.value = 1

  /**
   * Connect decoded MediaRecorder layers here only. They merge at `preMasterMix`, not `input`,
   * so band / reverb / pitch-wobble cannot run twice on playback.
   */
  const recordingsBus = context.createGain()
  recordingsBus.gain.value = 1
  recordingsBus.connect(preMasterMix)

  const voiceCallBus = context.createGain()
  voiceCallBus.gain.value = 1
  voiceCallBus.connect(preMasterMix)

  const input = context.createGain()
  input.gain.value = pickFinite(options.masterGain, 0.25)

  // --- Reverb (convolver) with dry/wet ---
  const convolver = context.createConvolver()
  const wetGain = context.createGain()
  const dryGain = context.createGain()
  const reverbSum = context.createGain()

  // --- Pitch effect (vibrato-style) ---
  // This is not a perfect pitch shifter; it modulates pitch by modulating delay time.
  const pitchDelay = context.createDelay(0.05)
  pitchDelay.delayTime.value = 0.008 // base delay (seconds)
  const pitchLfo = context.createOscillator()
  pitchLfo.type = 'sine'
  pitchLfo.frequency.value = 6.0
  const pitchLfoGain = context.createGain()
  pitchLfoGain.gain.value = 0.0 // depth (seconds) — 0 disables modulation
  pitchLfo.connect(pitchLfoGain)
  pitchLfoGain.connect(pitchDelay.delayTime)
  pitchLfo.start()

  // --- Band limiting (hi-pass then lo-pass) ---
  const bandHighpass = context.createBiquadFilter()
  bandHighpass.type = 'highpass'
  bandHighpass.Q.value = 0.707

  const bandLowpass = context.createBiquadFilter()
  bandLowpass.type = 'lowpass'
  bandLowpass.Q.value = 0.707

  // Wiring that never changes:
  input.connect(dryGain)
  input.connect(wetGain)
  wetGain.connect(convolver)
  dryGain.connect(reverbSum)
  convolver.connect(reverbSum)

  let bandEnabled = Boolean(options.band?.enabled)
  let reverbEnabled = Boolean(options.reverb?.enabled)
  let reverbMix = clamp01(options.reverb?.mix ?? 0.25)
  let reverbSeconds = pickFinite(options.reverb?.seconds, 1.2)
  let reverbDecay = pickFinite(options.reverb?.decay, 2.0)

  let pitchEnabled = false
  let pitchRateHz = 6.0
  let pitchDepth = 0.0022 // seconds (approx 2.2ms)
  let pitchBaseDelayMs = 8.0

  function applyPitchParams() {
    pitchLfo.frequency.value = Math.max(0.1, pickFinite(pitchRateHz, 6.0))
    const baseMs = Math.max(1, pickFinite(pitchBaseDelayMs, 8.0))
    pitchDelay.delayTime.value = baseMs / 1000
    // Depth is the modulation amplitude. Clamp so it stays musical and avoids delay going negative.
    const depthSec = Math.max(0, Math.min(0.01, pickFinite(pitchDepth, 0)))
    pitchLfoGain.gain.value = pitchEnabled ? depthSec : 0
  }

  function applyReverbMix() {
    const mix = reverbEnabled ? reverbMix : 0
    wetGain.gain.value = mix
    dryGain.gain.value = 1 - mix
  }

  function rebuildImpulse() {
    convolver.buffer = makeImpulseResponse(context, reverbSeconds, reverbDecay)
  }

  function reconnectMainChain() {
    // We rebuild the tail connections so “band enabled” can be toggled cleanly.
    try {
      reverbSum.disconnect()
    } catch (_) {}
    try {
      pitchDelay.disconnect()
    } catch (_) {}
    try {
      bandHighpass.disconnect()
    } catch (_) {}
    try {
      bandLowpass.disconnect()
    } catch (_) {}
    try {
      analyser.disconnect()
    } catch (_) {}

    const sourceNode = pitchEnabled ? pitchDelay : reverbSum
    if (pitchEnabled) {
      reverbSum.connect(pitchDelay)
    }

    if (bandEnabled) {
      sourceNode.connect(bandHighpass)
      bandHighpass.connect(bandLowpass)
      bandLowpass.connect(analyser)
    } else {
      sourceNode.connect(analyser)
    }

    // Live path only: analyser -> preMasterMix (layers enter via recordingsBus -> preMasterMix).
    analyser.connect(preMasterMix)
  }

  function setBandFrequencies(loHz, hiHz) {
    bandHighpass.frequency.value = Math.max(10, pickFinite(loHz, bandHighpass.frequency.value))
    bandLowpass.frequency.value = Math.max(
      bandHighpass.frequency.value + 1,
      pickFinite(hiHz, bandLowpass.frequency.value),
    )
  }

  function setBandEnabled(enabled) {
    bandEnabled = Boolean(enabled)
    reconnectMainChain()
  }

  function setPitchEnabled(enabled) {
    pitchEnabled = Boolean(enabled)
    applyPitchParams()
    reconnectMainChain()
  }

  function setPitchParams(params) {
    if (!params) return
    if (params.rateHz != null) pitchRateHz = pickFinite(params.rateHz, pitchRateHz)
    if (params.depth != null) pitchDepth = pickFinite(params.depth, pitchDepth)
    if (params.baseDelayMs != null) pitchBaseDelayMs = pickFinite(params.baseDelayMs, pitchBaseDelayMs)
    applyPitchParams()
  }

  function setReverbEnabled(enabled) {
    reverbEnabled = Boolean(enabled)
    applyReverbMix()
  }

  function setReverbParams(params) {
    if (!params) return
    if (params.mix != null) reverbMix = clamp01(params.mix)

    const nextSeconds = params.seconds != null ? pickFinite(params.seconds, reverbSeconds) : reverbSeconds
    const nextDecay = params.decay != null ? pickFinite(params.decay, reverbDecay) : reverbDecay
    const irChanged = nextSeconds !== reverbSeconds || nextDecay !== reverbDecay
    reverbSeconds = nextSeconds
    reverbDecay = nextDecay

    applyReverbMix()
    if (irChanged) rebuildImpulse()
  }

  // Initial state
  setBandFrequencies(options.band?.loHz ?? 200, options.band?.hiHz ?? 2200)
  rebuildImpulse()
  applyReverbMix()
  applyPitchParams()
  reconnectMainChain()

  // Master bus to device + recorder: wired once; not torn down when FX topology toggles.
  preMasterMix.connect(outputGain)
  outputGain.connect(context.destination)
  try {
    outputGain.connect(recordDestination)
  } catch (_) {}

  function setOutputGain(linear) {
    outputGain.gain.value = clampOutputGain(linear)
  }

  function getFilterSnapshot() {
    return {
      inputGain: input.gain.value,
      outputGain: outputGain.gain.value,
      bandEnabled,
      bandLoHz: bandHighpass.frequency.value,
      bandHiHz: bandLowpass.frequency.value,
      pitchEnabled,
      pitchRateHz,
      pitchDepth,
      pitchBaseDelayMs,
      reverbEnabled,
      reverbMix,
      reverbSeconds,
      reverbDecay,
    }
  }

  return {
    context,
    analyser,
    recordDestination,
    recordingsBus,
    voiceCallBus,
    input,
    outputGain,
    setBandEnabled,
    setBandFrequencies,
    setPitchEnabled,
    setPitchParams,
    setReverbEnabled,
    setReverbParams,
    setOutputGain,
    getFilterSnapshot,
  }
}

