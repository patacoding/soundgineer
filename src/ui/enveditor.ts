// Envelope display: renders the DAHDSR shape from the current parameters, and (SP-EXT) lets the shape be dragged.
//
// The knobs below remain the editor of record -- all nine parameters have one -- and this is a second, direct view of
// the same five times and the sustain level. Editing here writes through the same engine.setParam(index, normalized)
// the knobs use, so the DSP, the worklet and the parameter registry are untouched.
//
// Two decisions come from reading the original instead of inventing: the time axis is FIXED and logarithmic (1 ms to
// 10 s, a decade per grid line), because the previous projection normalised by the sum of the stage times and so
// rescaled the whole drawing while a drag was in progress, sliding the handle out from under the cursor; and each
// handle owns exactly one axis -- a stage handle moves its own time sideways, the sustain handle moves its level up and
// down -- so no handle is ambiguous and no hit-test priority is needed. The three curve parameters are deliberately
// left to their knobs rather than given an invented vertical gesture.
import { paramIndex, normToValue, valueToNorm, PARAMS } from '../shared/params'
import type { SynthEngine } from '../audio/engine'
import { el } from './common'

const T_MIN = 0.001                 // 1 ms
const T_MAX = 10                    // 10 s
const PAD = 6
const SUS_W = 0.08                  // the sustain plateau's width, as a fraction of the plot

function shape(t: number, c: number): number {
  return Math.pow(t, Math.pow(2, c * 3))
}

interface Handle { field: 'delay' | 'attack' | 'hold' | 'decay' | 'release' | 'sustain'; axis: 'x' | 'y'; x: number; y: number }

export class EnvDisplay {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly cx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private handles: Handle[] = []
  private drag: { field: Handle['field']; axis: 'x' | 'y'; grabX: number; before: number } | null = null

  constructor(private readonly engine: SynthEngine, private env: number) {
    this.root = el('div', 'env-display')
    this.canvas = el('canvas')
    this.root.appendChild(this.canvas)
    this.cx = this.canvas.getContext('2d')!
    this.canvas.style.touchAction = 'none'
    this.canvas.style.cursor = 'crosshair'
    this.canvas.addEventListener('pointerdown', this.onDown)
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerup', this.onUp)
    this.canvas.addEventListener('pointercancel', this.onUp)
    new ResizeObserver(() => this.resize()).observe(this.root)
    for (let e = 1; e <= 6; e++) {
      for (const f of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release', 'atk_curve', 'dec_curve', 'rel_curve']) {
        engine.onParam(paramIndex(`env${e}.${f}`), () => this.draw())
      }
    }
  }

  setEnv(env: number): void {
    this.env = env
    this.draw()
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.w = this.root.clientWidth
    this.h = this.root.clientHeight
    this.canvas.width = this.w * dpr
    this.canvas.height = this.h * dpr
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  private v(field: string): number {
    const i = paramIndex(`env${this.env}.${field}`)
    return normToValue(PARAMS[i], this.engine.getParam(i))
  }

  private setValue(field: string, value: number): void {
    const i = paramIndex(`env${this.env}.${field}`)
    const v = Math.min(1, Math.max(0, valueToNorm(PARAMS[i], value)))
    this.engine.setParam(i, v)
    this.draw()
  }

  // ── the fixed logarithmic axis ──────────────────────────────────────────────────────────────────────────
  private X(t: number): number {
    const x = Math.log(Math.min(T_MAX, Math.max(T_MIN, t)) / T_MIN) / Math.log(T_MAX / T_MIN)
    return PAD + x * (this.w - PAD * 2)
  }
  private Tinv(x: number): number {
    const f = (x - PAD) / ((this.w - PAD * 2) || 1)
    return T_MIN * Math.pow(T_MAX / T_MIN, Math.min(1, Math.max(0, f)))
  }
  private Y(level: number): number { return (1 - level) * (this.h - 10) + 5 }

  // ── interaction: one axis per handle ────────────────────────────────────────────────────────────────────
  private onDown = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    let best: Handle | null = null
    let bestD = 14
    for (const h of this.handles) {
      const d = Math.hypot(h.x - px, h.y - py)
      if (d < bestD) { bestD = d; best = h }
    }
    if (!best) return
    this.drag = { field: best.field, axis: best.axis, grabX: px, before: this.v(best.field) }
    this.canvas.style.cursor = best.axis === 'y' ? 'ns-resize' : 'ew-resize'
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* a synthetic or stale pointer id must not end the drag */ }
    e.preventDefault()
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return
    const r = this.canvas.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    if (this.drag.axis === 'y') {
      this.setValue('sustain', Math.min(1, Math.max(0, 1 - (py - 5) / ((this.h - 10) || 1))))
    } else {
      // the stage's own time: its start does not move during the drag, so the handle stays under the cursor
      const d = this.drag
      const stages: Handle['field'][] = ['delay', 'attack', 'hold', 'decay', 'release']
      const upto = stages.slice(0, stages.indexOf(d.field)).reduce((a, f) => a + this.v(f), 0)
      const target = this.Tinv(px) - upto
      const i = paramIndex(`env${this.env}.${d.field}`)
      this.setValue(d.field, Math.min(PARAMS[i].max, Math.max(PARAMS[i].min, target)))
    }
    e.preventDefault()
  }

  private onUp = (e: PointerEvent): void => {
    if (this.drag) { this.canvas.style.cursor = 'crosshair'; this.drag = null }
    try { this.canvas.releasePointerCapture(e.pointerId) } catch { /* nothing to release */ }
  }

  draw(): void {
    const c = this.cx
    const w = this.w
    const h = this.h
    if (!w || !h) return
    c.clearRect(0, 0, w, h)

    // the axis: a line per decade, so the mapping is legible
    c.strokeStyle = '#ffffff12'
    c.lineWidth = 1
    for (const t of [0.001, 0.01, 0.1, 1, 10]) {
      const x = this.X(t)
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke()
    }

    const del = this.v('delay')
    const atk = this.v('attack')
    const hold = this.v('hold')
    const dec = this.v('decay')
    const sus = this.v('sustain')
    const rel = this.v('release')
    const ac = this.v('atk_curve')
    const dc = this.v('dec_curve')
    const rc = this.v('rel_curve')

    const t1 = del
    const t2 = del + atk
    const t3 = t2 + hold
    const t4 = t3 + dec
    const susEnd = Math.min(T_MAX, t4 + (SUS_W * (T_MAX - T_MIN)))
    const t5 = Math.min(T_MAX, susEnd + rel)
    const N = 40

    c.beginPath()
    c.moveTo(this.X(0), this.Y(0))
    c.lineTo(this.X(t1), this.Y(0))
    for (let i = 1; i <= N; i++) c.lineTo(this.X(t1 + (i / N) * atk), this.Y(shape(i / N, ac)))
    c.lineTo(this.X(t3), this.Y(1))
    for (let i = 1; i <= N; i++) c.lineTo(this.X(t3 + (i / N) * dec), this.Y(sus + (1 - sus) * (1 - shape(i / N, -dc))))
    c.lineTo(this.X(susEnd), this.Y(sus))
    for (let i = 1; i <= N; i++) c.lineTo(this.X(susEnd + (i / N) * rel), this.Y(sus * (1 - shape(i / N, -rc))))
    c.strokeStyle = '#ff9a3c'
    c.lineWidth = 2
    c.stroke()
    c.lineTo(this.X(t5), this.Y(0) + 5)
    c.lineTo(this.X(0), this.Y(0) + 5)
    c.closePath()
    c.fillStyle = '#ff9a3c15'
    c.fill()

    // the handles: five times (sideways) and the sustain level (up and down)
    this.handles = [
      { field: 'delay', axis: 'x', x: this.X(t1), y: this.Y(0) },
      { field: 'attack', axis: 'x', x: this.X(t2), y: this.Y(1) },
      { field: 'hold', axis: 'x', x: this.X(t3), y: this.Y(1) },
      { field: 'decay', axis: 'x', x: this.X(t4), y: this.Y(sus) },
      { field: 'sustain', axis: 'y', x: this.X((t4 + susEnd) / 2), y: this.Y(sus) },
      { field: 'release', axis: 'x', x: this.X(t5), y: this.Y(0) },
    ]
    c.fillStyle = '#ff9a3c'
    for (const hd of this.handles) { c.beginPath(); c.arc(hd.x, hd.y, 3.5, 0, Math.PI * 2); c.fill() }
    ;(window as unknown as { __sgrEnvHandles?: unknown }).__sgrEnvHandles = this.handles.map((x) => ({ ...x }))

    // live value line
    const live = this.engine.sourceValues[this.env - 1] ?? 0
    if (live > 0.001) {
      c.beginPath()
      c.moveTo(0, this.Y(live))
      c.lineTo(w, this.Y(live))
      c.strokeStyle = '#ff9a3c50'
      c.lineWidth = 1
      c.stroke()
    }
  }
}
