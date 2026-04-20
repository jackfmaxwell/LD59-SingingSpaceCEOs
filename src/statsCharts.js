import { gameState, STAT_CHART_MAX_POINTS } from './gameState.js'
import { colorGreen } from './gameState.js'

let moneyCanvas = null
let stakeholderCanvas = null

let resizeObserver = null

let windowResizeBound = false

function capHistory(arr) {
  while (arr.length > STAT_CHART_MAX_POINTS) arr.shift()
}

function drawSparkline(canvas, values, stroke) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const cssW = Math.max(1, canvas.clientWidth | 0)
  const cssH = Math.max(1, canvas.clientHeight | 0)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.clearRect(0, 0, cssW, cssH)

  const padX = 4
  const padY = 5
  const w = cssW - 2 * padX
  const h = cssH - 2 * padY

  if (values.length === 0) return

  const minV = Math.min(...values)
  const maxV = Math.max(...values)
  let lo = minV
  let hi = maxV
  if (hi <= lo) {
    lo -= 1
    hi += 1
  }

  ctx.strokeStyle = 'rgba(127, 255, 0, 0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padX, padY + h * 0.5)
  ctx.lineTo(padX + w, padY + h * 0.5)
  ctx.stroke()

  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.25
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()

  for (let i = 0; i < values.length; i++) {
    const t = values.length === 1 ? 1 : i / (values.length - 1)
    const x = padX + t * w
    const yn = (values[i] - lo) / (hi - lo)
    const y = padY + h - yn * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

export function refreshStatCharts() {
  if (moneyCanvas) {
    drawSparkline(moneyCanvas, gameState.moneyHistory, colorGreen)
  }
  if (stakeholderCanvas) {
    drawSparkline(
      stakeholderCanvas,
      gameState.stakeholderAppreciationHistory,
      colorGreen,
    )
  }
}

export function recordMoneyHistory() {
  gameState.moneyHistory.push(gameState.money)
  capHistory(gameState.moneyHistory)
  refreshStatCharts()
}

export function recordStakeholderHistory() {
  gameState.stakeholderAppreciationHistory.push(gameState.stakeholderAppreciation)
  capHistory(gameState.stakeholderAppreciationHistory)
  refreshStatCharts()
}

export function initStatCharts(m, s) {
  moneyCanvas = m ?? null
  stakeholderCanvas = s ?? null
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  const wrap = moneyCanvas?.closest?.('.hud-panel')?.parentElement
  if (wrap && moneyCanvas) {
    resizeObserver = new ResizeObserver(() => refreshStatCharts())
    resizeObserver.observe(wrap)
  }
  if (!windowResizeBound) {
    window.addEventListener('resize', refreshStatCharts)
    windowResizeBound = true
  }
  refreshStatCharts()
}
