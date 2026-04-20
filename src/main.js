import './style.css'
import * as THREE from 'three'
import {
  gameState,
  ORBIT_PERIOD_SECONDS,
  planetNameToKey,
  planetKeyFromName,
  travelCosts,
} from './gameState.js'
import {
  playVideoCallVoiceConcurrent,
  stopVideoCallVoice,
  listCeoVoiceUrlsInFolder,
  pickRandomFromUrls,
  pickRandomDistinctUrls,
  getSongScoringContexts,
} from './Sound/Visualizer.js'
import { computeVcSongVerdict } from './vcScoring.js'
import {
  initStatCharts,
  recordMoneyHistory,
  recordStakeholderHistory,
} from './statsCharts.js'

export {
  gameState,
  ORBIT_PERIOD_SECONDS,
  planetNameToKey,
  planetKeyFromName,
  travelCosts,
} from './gameState.js'

const beamSongEarthButton = document.querySelector('#beamSongEarthButton')
document.querySelector('#moneyValue').textContent = gameState.money.toLocaleString()
document.querySelector('#stakeholderAppreciationValue').textContent = gameState.stakeholderAppreciation.toLocaleString()

initStatCharts(
  document.querySelector('#moneyChart'),
  document.querySelector('#stakeholderChart'),
)


const VC_FOLDER_HELLO = 'hello'
const VC_FOLDER_ALMOST = 'almost' // second stage 1 line 
const VC_FOLDER_GOOD = 'good'
const VC_FOLDER_BAD = 'bad'
const VC_FOLDER_ADLIBS = 'adlibs'
const VC_STAGE2_ADLIB_COUNT = 2
const VC_ADLIB_GAIN = 0.42

function pickVideoCallStage1Urls() {
  const hello = listCeoVoiceUrlsInFolder(VC_FOLDER_HELLO)
  const almost = listCeoVoiceUrlsInFolder(VC_FOLDER_ALMOST)
  const stage1Url = pickRandomFromUrls(hello)
  let stage1AlmostUrl = pickRandomFromUrls(almost)
  if (!stage1AlmostUrl && hello.length > 1) {
    stage1AlmostUrl = pickRandomFromUrls(hello.filter((u) => u !== stage1Url))
  }
  if (!stage1AlmostUrl) stage1AlmostUrl = stage1Url
  return { stage1Url, stage1AlmostUrl }
}


function pickVideoCallStage2Urls(songGood) {
  const mainPool = listCeoVoiceUrlsInFolder(songGood ? VC_FOLDER_GOOD : VC_FOLDER_BAD)
  const stage2MainUrl = pickRandomFromUrls(mainPool)
  const adlibPool = listCeoVoiceUrlsInFolder(VC_FOLDER_ADLIBS)
  const stage2AdlibUrls = pickRandomDistinctUrls(adlibPool, VC_STAGE2_ADLIB_COUNT + 3).filter(
    (u) => u && u !== stage2MainUrl,
  ).slice(0, VC_STAGE2_ADLIB_COUNT)
  return { stage2MainUrl, stage2AdlibUrls }
}

function initVideoCallPopup() {
  const overlay = document.querySelector('#videoCallOverlay')
  const dialog = overlay?.querySelector?.('.vc-dialog')
  const image = document.querySelector('#videoCallImage')
  const titleEl = overlay?.querySelector?.('.vc-title')
  const gameOverPage = document.querySelector('#vcGameOverPage')
  const gameOverRestart = document.querySelector('#vcGameOverRestart')

  if (!overlay || !image) return { open: () => {}, close: () => {} }


  function showGameOverLayer() {
    if (!gameOverPage) return
    gameOverPage.hidden = false
    gameOverPage.setAttribute('aria-hidden', 'false')
    dialog?.classList?.add('vc-game-over-recap')
    if (titleEl) titleEl.textContent = 'Game Over'
  }

  function openGameOverRecap() {
    if (openTimer) window.clearTimeout(openTimer)
    openTimer = 0
    clearPendingCallTimers()
    stopVideoCallVoice()
    overlay.hidden = false
    resetAnimState()
 
    showGameOverLayer()
  }

  let openTimer = 0
  const pendingCallTimers = [];

  function clearPendingCallTimers() {
    pendingCallTimers.forEach((id) => window.clearTimeout(id))
    pendingCallTimers.length = 0
  }

  function resetAnimState() {
    if (!dialog?.classList) return
    dialog.classList.remove('vc-incoming')
    dialog.classList.remove('vc-open')
  }

  function openVideoCall(sendingSong=true, tutorial=false) {
    const { songGood, score } = computeVcSongVerdict(getSongScoringContexts())
    const imgSrc = songGood ? 'src/assets/CEOS_GOOD.png' : 'src/assets/CEOS_BAD.png'
    const { stage1Url, stage1AlmostUrl } = pickVideoCallStage1Urls()
    const { stage2MainUrl, stage2AdlibUrls } = pickVideoCallStage2Urls(songGood)
    const firingURL = pickRandomFromUrls(listCeoVoiceUrlsInFolder('fired'))
    const tutorialURL = pickRandomFromUrls(listCeoVoiceUrlsInFolder('welcome'))

    overlay.hidden = false

    resetAnimState()
    if (dialog?.classList) dialog.classList.add('vc-incoming')

    if (openTimer) window.clearTimeout(openTimer)
    clearPendingCallTimers()
    stopVideoCallVoice()

    openTimer = window.setTimeout(() => {
      openTimer = 0
      if (dialog?.classList) {
        dialog.classList.remove('vc-incoming')
        dialog.offsetHeight; //force reflow
        dialog.classList.add('vc-open')
      }
      
      if (sendingSong) {
        // Stage 1: two lines (second does not stop the first - layered / staggered).
        void playVideoCallVoiceConcurrent(stage1Url, 1)
        pendingCallTimers.push(
          window.setTimeout(() => {
            void playVideoCallVoiceConcurrent(stage1AlmostUrl, 1)
          }, 2000),
        )
        pendingCallTimers.push(
          window.setTimeout(() => {
            stopVideoCallVoice()
            image.src = imgSrc
            // Stage 2: one main verdict + concurrent adlibs
            void playVideoCallVoiceConcurrent(stage2MainUrl, 1)
          
            pendingCallTimers.push(
              window.setTimeout(() => {
                closeVideoCall()
                const stakeCore = Math.round(
                  Math.max(10, Math.min(140, 22 + Math.abs(score) * 11 + Math.max(0, score) * 6)),
                )
                const stakeJitter = Math.round((Math.random() - 0.5) * 34)
                gameState.stakeholderAppreciation += songGood ? stakeCore + stakeJitter : -(stakeCore + stakeJitter)
                document.querySelector('#stakeholderAppreciationValue').textContent =
                  gameState.stakeholderAppreciation.toLocaleString()
                if (songGood) {

                  //min: 150,000, max: 900,000 (+ up to 55,000 jitter)
                  // So actual min total: 150,000, max total: 955,000
                  const moneyCore = Math.round(
                    Math.max(100_000, Math.min(900_000, Math.max(0, score) * 40_000)),
                  )
                  gameState.money += moneyCore + Math.round(Math.random() * 300_000)
        
                }
                document.querySelector('#moneyValue').textContent = gameState.money.toLocaleString()
                recordStakeholderHistory()
                recordMoneyHistory()
              }, 5000),
            )
          }, 6000),
        )
      }else{
        if(tutorial){
          image.src = 'src/assets/CEOS_GOOD.png'
          pendingCallTimers.push(
            window.setTimeout(() => {
              stopVideoCallVoice()
              void playVideoCallVoiceConcurrent(tutorialURL, 1)
              pendingCallTimers.push(
                window.setTimeout(() => {
                  closeVideoCall()
                }, 19*1000)
              )
            }, 300),
          )
        }else{
          image.src = 'src/assets/CEOS_BAD.png'
          pendingCallTimers.push(
            window.setTimeout(() => {
              stopVideoCallVoice()
              void playVideoCallVoiceConcurrent(firingURL, 1)
              pendingCallTimers.push(
                window.setTimeout(() => {
                  gameState.stakeholderAppreciation = -9999999;
                  document.querySelector('#stakeholderAppreciationValue').textContent = gameState.stakeholderAppreciation.toLocaleString()
                  //closeVideoCall()
                  openGameOverRecap()
                }, 13*1000)
              )
            }, 300),
          )
        }
      }
    }, 1000)
  }

  function closeVideoCall() {
    overlay.hidden = true
    if (openTimer) window.clearTimeout(openTimer)
    openTimer = 0
    clearPendingCallTimers()
    stopVideoCallVoice()
    resetAnimState()
    image.src = 'src/assets/CEOS.png'
  }


  gameOverRestart?.addEventListener('click', () => {
    window.location.reload()
  })

  return { open: openVideoCall, close: closeVideoCall }
}

function initTravelConfirmPopup() {
  const overlay = document.querySelector('#travelConfirmOverlay')
  const closeBtn = document.querySelector('#closeTravelConfirm')
  const okBtn = document.querySelector('#travelConfirmOk')
  const cancelBtn = document.querySelector('#travelConfirmCancel')
  const nameEl = document.querySelector('#travelConfirmPlanet')
  const costEl = document.querySelector('#travelConfirmCost')

  if (!overlay || !closeBtn || !okBtn || !cancelBtn || !nameEl || !costEl) {
    return { open: () => {} }
  }

  let pendingConfirm = /** @type {null | { onConfirm: () => void }} */ (null)

  function close(e) {
    overlay.hidden = true
    pendingConfirm = null
    if(e){
      e.stopPropagation();
    }
  }

  function open({ planetName, cost, onConfirm }) {
    nameEl.textContent = String(planetName ?? '')
    costEl.textContent = `$${Math.round(Number(cost ?? 0)).toLocaleString()}`
    pendingConfirm = { onConfirm }
    overlay.hidden = false
  }

  closeBtn.addEventListener('click', (e) => close(e))
  cancelBtn.addEventListener('click', (e) => close(e))
  okBtn.addEventListener('click', (e) => {
    if(e){
      e.stopPropagation();
    }
    const action = pendingConfirm?.onConfirm
    close()
    try {
      action?.()
    } catch (err) {
      console.error('Travel confirm action failed', err)
    }
  })

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close(ev)
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !overlay.hidden) close(ev)
  })

  return { open, close }
}

function initBeamSongConfirmPopup({ openVideoCall }) {
  const overlay = document.querySelector('#beamSongConfirmOverlay')
  const closeBtn = document.querySelector('#closeBeamSongConfirm')
  const sendBtn = document.querySelector('#beamSongSendButton')
  const cancelBtn = document.querySelector('#beamSongCancelButton')

  const actions = document.querySelector('#beamSongActions')
  const progressWrap = document.querySelector('#beamSongProgressContainer')
  const progressPct = document.querySelector('#beamSongProgressPercent')
  const progressBar = document.querySelector('#beamSongProgressBar')
  const completeMsg = document.querySelector('#beamSongCompleteMsg')

  if (
    !overlay ||
    !closeBtn ||
    !sendBtn ||
    !cancelBtn ||
    !actions ||
    !progressWrap ||
    !progressPct ||
    !progressBar ||
    !completeMsg
  ) {
    return { open: () => {}, close: () => {} }
  }

  let raf = 0
  let running = false
  /** True while fake progress is running; used to pair `beamplayback:start` / `beamplayback:end`. */
  let beamPlaybackArmed = false

  function setProgress(pct) {
    const p = Math.max(0, Math.min(100, pct))
    progressPct.textContent = String(Math.round(p))
    progressBar.style.width = `${p}%`
  }

  function resetUi() {
    actions.style.display = ''
    progressWrap.style.display = 'none'
    completeMsg.style.display = 'none'
    sendBtn.disabled = false
    cancelBtn.disabled = false
    closeBtn.disabled = false
    setProgress(0)
  }

  function close(e) {
    if (beamPlaybackArmed) {
      beamPlaybackArmed = false
      window.dispatchEvent(new CustomEvent('beamplayback:end'))
    }
    overlay.hidden = true
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    resetUi()
    if(e){
      e.stopPropagation();
    }
  }

  function open() {
    resetUi()
    overlay.hidden = false
  }

  function beginFakeProgress(e) {
    if(e){
      e.stopPropagation();
    }
    beamPlaybackArmed = true
    window.dispatchEvent(new CustomEvent('beamplayback:start'))
    running = true
    actions.style.display = 'none'
    progressWrap.style.display = ''
    completeMsg.style.display = 'none'
    sendBtn.disabled = true
    cancelBtn.disabled = true
    closeBtn.disabled = true

    const durationMs = 2400
    const start = performance.now()

    const tick = (now) => {
      if (!running) return
      const t = Math.max(0, Math.min(1, (now - start) / durationMs))
      // Ease-out so it feels like "upload"
      const eased = 1 - Math.pow(1 - t, 3)
      setProgress(eased * 100)

      if (t >= 1) {
        running = false
        // Restore prior listen mode, then open video (recording plays only until here).
        close(e)
        try {
          openVideoCall?.()
        } catch (err) {
          console.error('Failed to open video call after beam progress', err)
        }
        return
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
  }

  closeBtn.addEventListener('click', (e) => close(e))
  cancelBtn.addEventListener('click', (e) => close(e))
  sendBtn.addEventListener('click', (e) => beginFakeProgress(e))

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close(ev)
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !overlay.hidden) close(ev)
  })

  return { open, close }
}
function isOnEarth() {
  return String(gameState.currentPlanet?.name ?? '').trim().toLowerCase() === 'earth'
}

function syncBeamSongButtonState() {
  if (!beamSongEarthButton) return
  const disabled = !isOnEarth() || Boolean(gameState.travel?.active)
  beamSongEarthButton.disabled = disabled
  beamSongEarthButton.innerHTML = disabled ? 'Must be on Earth to beam' : 'Beam your song to Earth'
}




function INIT_SCENE() {

  const container = document.querySelector('#app');
  const probe = new THREE.Group()
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.1,
    100,
  )
  camera.position.z = 50

  const renderer = new THREE.WebGLRenderer({ antialias: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1))
  
  renderer.setSize(container.clientWidth - 12, container.clientHeight - 12)
  container.appendChild(renderer.domElement)

  function syncScene() {
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (cw > 0 && ch > 0) {
      camera.aspect = cw / ch
      camera.updateProjectionMatrix()
      renderer.setSize(cw - 12, ch - 12)
    }
  }
  syncScene()
  const sizeObserver = new ResizeObserver(syncScene)
  sizeObserver.observe(container)

  const geometry = new THREE.CylinderGeometry(0.75,1,1.5, 6, 1,false)
  const material = new THREE.MeshBasicMaterial({ color: 0x51e86a, wireframe: true })
  const sphere = new THREE.Mesh(geometry, material)
  probe.add(sphere)
  const geometry2 = new THREE.BoxGeometry(8, 1.3, 0.1, 4,1)
  const material2 = new THREE.MeshBasicMaterial({ color: 0x51e86a, wireframe: true })
  const box = new THREE.Mesh(geometry2, material2)
  probe.add(box)
  scene.add(probe)
  probe.scale.set(0.5, 0.5, 0.5);

  function createNameSprite(text) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const fontPx = 24
    ctx.font = `${fontPx}px monospace`
    const padding = 32
    const metrics = ctx.measureText(String(text))
    const textW = Math.ceil(metrics.width)
    const textH = Math.ceil(fontPx * 1.5)

    canvas.width = textW + padding * 2
    canvas.height = textH + padding * 2

    ctx.font = `${fontPx}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(51,205,52,0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 8)
    ctx.fillStyle = '#33cd34'
    ctx.fillText(String(text), canvas.width / 2, canvas.height / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    const sprite = new THREE.Sprite(material)

    // Scale tuned for this scene (camera z=50). Adjust if needed.
    const aspect = canvas.width / canvas.height
    const base = 4.5
    sprite.scale.set(base * aspect, base, 1)
    return sprite
  }

  function createPlanet(x,y, size, name) {
    const planet = new THREE.SphereGeometry(size, 10, 10)  
    const planetMaterial = new THREE.MeshBasicMaterial({ color: 0x51e86a, wireframe: true })
    const planetMesh = new THREE.Mesh(planet, planetMaterial)
    scene.add(planetMesh)
    planetMesh.position.x = x;
    planetMesh.position.y = y;
    planetMesh.name=name;

    const label = createNameSprite(name)
    if (label) {
      // Place the label above the planet, and let the sprite always face camera.
      label.position.set(0, size + 2.2, 0)
      planetMesh.add(label)
      planetMesh.userData.label = label
    }
   
    return planetMesh;
  }
  let earth = createPlanet(0, 0, 5, 'Earth');
  createPlanet(-26, -18, 3, 'Blue Sky Country Road');
  createPlanet(11, -13, 3, 'Rock and Roll Planet');
  createPlanet(30, 12, 3, 'Disco Ball Planet');
  
  const clock = new THREE.Clock()

  // Probe movement/orbit state
  let orbitRadius = 0
  let orbitAngularSpeed = 0
  let orbitAngle = 0

  

  const tmpToProbe = new THREE.Vector3()
  const tmpOrbitOffset = new THREE.Vector3()
  const tmpPos = new THREE.Vector3()

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  function beginTravelToOrbit(planet) {
    if (gameState.currentPlanet == planet) {
      return;
    }
    syncBeamSongButtonState()
    gameState.currentPlanet = planet

    const r = planet.geometry?.parameters?.radius ?? 1
    orbitRadius = r + 2

    tmpToProbe.copy(probe.position).sub(planet.position)
    const a = Math.atan2(tmpToProbe.y, tmpToProbe.x)
    orbitAngle = Number.isFinite(a) ? a : 0

    tmpOrbitOffset.set(Math.cos(orbitAngle) * orbitRadius, Math.sin(orbitAngle) * orbitRadius, 0)
    gameState.travel.start.copy(probe.position)
    gameState.travel.end.copy(planet.position).add(tmpOrbitOffset)

    const distance = gameState.travel.start.distanceTo(gameState.travel.end)
    const minSeconds = 0.35
    const secondsPerUnit = 0.1
    gameState.travel.duration = Math.max(minSeconds, distance * secondsPerUnit)
    gameState.travel.startTime = clock.getElapsedTime()
    gameState.travel.active = true

    // Orbit speed: longer orbit period for larger orbits (feels calmer).
    const orbitPeriod = ORBIT_PERIOD_SECONDS //+ orbitRadius * 0.25
    orbitAngularSpeed = (Math.PI * 2) / orbitPeriod
  }

  
  beginTravelToOrbit(earth);
  function updateProbePosition(dt) {
    if (!gameState.currentPlanet) return

    // Phase 1: travel toward orbit ring (time-based duration scales with distance)
    if (gameState.travel.active) {
      const now = clock.getElapsedTime()
      gameState.travel.t = THREE.MathUtils.clamp((now - gameState.travel.startTime) / gameState.travel.duration, 0, 1)
      const eased = easeInOutCubic(gameState.travel.t)
      tmpPos.lerpVectors(gameState.travel.start, gameState.travel.end, eased)
      probe.position.copy(tmpPos)

      // Face the planet while approaching
      probe.lookAt(gameState.currentPlanet.position)
      probe.rotation.z = 0

      if (gameState.travel.t >= 1) {
        gameState.travel.active = false
        if(gameState.currentPlanet.name != 'Earth'){
          if(gameState.money < travelCosts[planetKeyFromName(gameState.currentPlanet.name)][planetKeyFromName('Earth')]){
            videoCallUi.open(false);
          }
        }
      }
      syncBeamSongButtonState()
      return
    }

    // Phase 2: orbit continuously around the planet we're "at"
    orbitAngle += orbitAngularSpeed * dt
    tmpOrbitOffset.set(Math.cos(orbitAngle) * orbitRadius, Math.sin(orbitAngle) * orbitRadius, 0)
    probe.position.copy(gameState.currentPlanet.position).add(tmpOrbitOffset)
    probe.lookAt(gameState.currentPlanet.position)
    probe.rotation.z = 0

    const wrappedDeg = ((THREE.MathUtils.radToDeg(orbitAngle) % 360) + 360) % 360
    gameState.repeatingAngle = wrappedDeg
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const travelConfirmUi = initTravelConfirmPopup()

  function pickPlanetFromIntersection(obj) {
    if (!obj) return null
    // Clicking the label sprite returns the sprite; we want the planet mesh.
    if (obj.isSprite && obj.parent) return obj.parent
    return obj
  }

  window.addEventListener('click', (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  
    // Normalize coordinates: -1 to +1, corrected for canvas position
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;   

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
      if(intersects[0].object.parent == probe){
        return;
      }
      const target = pickPlanetFromIntersection(intersects[0].object)
      if (!target || !target.geometry) return
      if (target.name == gameState.currentPlanet?.name) {
        return
      }
      const cost = travelCosts[planetKeyFromName(gameState.currentPlanet.name)][planetKeyFromName(target.name)]
      travelConfirmUi.open({
        planetName: target?.name ?? 'planet',
        cost,
        onConfirm: () => {
          if (cost > gameState.money) {
            return
          }
          gameState.money -= cost
          document.querySelector('#moneyValue').textContent = gameState.money.toLocaleString()
          recordMoneyHistory()
          beginTravelToOrbit(target);
          
        },
      })
    }
  });

  function animateScene() {
    requestAnimationFrame(animateScene)
    renderer.render(scene, camera)
    const dt = Math.min(clock.getDelta(), 0.05)
    updateProbePosition(dt)
  };

animateScene()

}

INIT_SCENE()

const videoCallUi = initVideoCallPopup()
const beamSongUi = initBeamSongConfirmPopup({ openVideoCall: videoCallUi?.open })

if (beamSongEarthButton) {
  syncBeamSongButtonState()
  beamSongEarthButton.addEventListener('click', () => {
    syncBeamSongButtonState()
    if (beamSongEarthButton.disabled) return
    try {
      beamSongUi.open()
    } catch (err) {
      console.error('Failed to open beam confirm', err)
    }
  })
}

videoCallUi.open(false,true);