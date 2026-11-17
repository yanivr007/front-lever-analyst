// Turns a stream of per-frame metrics into sets (holds / negatives) and summarises them.
import { classifyVariation, scoreFrame, type Core, type FrameMetrics, type ScoreParts, type Variation } from './analysis';

export interface Sample extends Core { t: number }

export type Mode = 'hold' | 'negative';
export type FailureKey = 'drop' | 'pike' | 'arch' | 'elbows' | 'knees' | 'none';

export interface SetRecord {
  id: string;
  at: number;
  mode: Mode;
  variation: Variation;
  /** true if the variation was detected automatically. */
  auto: boolean;
  duration: number;
  score: number;
  /** Hold: seconds with score >= QUALITY_SCORE. Negative: seconds within the lever zone. */
  qualityTime: number;
  /** Std-dev of torso angle in degrees (hold only). Lower = steadier. */
  stability: number;
  parts: ScoreParts;
  /** What broke first. null = set too short to tell. */
  failure: FailureKey | null;
  /** Negative only: angle (deg) where the descent was fastest, and that speed in deg/s. */
  dropAngle?: number;
  peakVel?: number;
  samples: Sample[];
}

export const QUALITY_SCORE = 70;
export const ZONE_DEG = 20;
const ENTER_DEG = 22, STAY_DEG = 32, ENTER_S = 0.4, EXIT_S = 0.5, MIN_HOLD_S = 1;
/** How long the body may be lost from view (no reliable landmarks) before a hold counts as over. */
const LOST_S = 1.5;
const SAMPLE_DT = 0.1;

export type TrackEvent = { type: 'start' } | { type: 'end'; samples: Sample[] } | null;

const r1 = (x: number) => Math.round(x * 10) / 10;
const toSample = (t: number, m: Core): Sample => ({
  t: Math.round(t * 100) / 100, torso: r1(m.torso), hipDev: r1(m.hipDev),
  kneeBend: r1(m.kneeBend), kneeBendOther: r1(m.kneeBendOther), elbowBend: r1(m.elbowBend),
});

export interface Tracker {
  readonly active: boolean;
  /** About to start a set (in position, waiting for confirmation) – used to start recording early. */
  readonly arming: boolean;
  /** Seconds since the current set started (0 when idle). */
  elapsed(t: number): number;
  update(t: number, m: FrameMetrics | null): TrackEvent;
  /** Force-finish a set in progress (video ended, camera stopped). */
  flush(): TrackEvent;
  reset(): void;
}

export class HoldTracker implements Tracker {
  active = false;
  private candSince: number | null = null;
  private start = 0;
  private lastGood = 0;
  private lastT = -1;
  private samples: Sample[] = [];
  private pending: Sample[] = [];

  reset() { this.active = false; this.candSince = null; this.samples = []; this.pending = []; this.lastT = -1; }
  elapsed(t: number) { return this.active ? Math.max(0, t - this.start) : 0; }
  get arming() { return this.candSince !== null; }

  private push(list: Sample[], t: number, m: Core) {
    const last = list[list.length - 1];
    if (!last || t - last.t >= SAMPLE_DT) list.push(toSample(t, m));
  }

  update(t: number, m: FrameMetrics | null): TrackEvent {
    if (this.lastT >= 0 && t < this.lastT) this.reset();               // video seeked back
    else if (this.lastT >= 0 && t - this.lastT > 2) {                  // frames stalled: keep what we have
      const ev = this.flush(); this.lastT = t; return ev;
    }
    this.lastT = t;
    const ok = (lim: number, conf: number) => !!m && m.confidence >= conf && m.hanging && Math.abs(m.torso) < lim;
    if (!this.active) {
      if (ok(ENTER_DEG, 0.5)) {
        if (this.candSince === null) { this.candSince = t; this.pending = []; }
        this.push(this.pending, t, m!);
        if (t - this.candSince >= ENTER_S) {
          this.active = true; this.start = this.candSince; this.lastGood = t;
          this.samples = this.pending; this.pending = []; this.candSince = null;
          return { type: 'start' };
        }
      } else this.candSince = null;
      return null;
    }
    if (ok(STAY_DEG, 0.4)) { this.lastGood = t; this.push(this.samples, t, m!); return null; }
    // Clearly out of shape → end quickly. Body merely not detected (jitter, occlusion) → give it longer.
    const seen = !!m && m.confidence >= 0.4;
    if (t - this.lastGood >= (seen ? EXIT_S : LOST_S)) return this.flush();
    return null;
  }

  flush(): TrackEvent {
    if (!this.active) { this.reset(); return null; }
    const samples = this.samples.filter(s => s.t <= this.lastGood);
    const dur = this.lastGood - this.start;
    this.reset();
    return dur >= MIN_HOLD_S ? { type: 'end', samples } : { type: 'end', samples: [] };
  }
}

/** A negative = controlled descent from inverted (torso < -45°) down to a hang (torso > 55°). */
export class NegativeTracker implements Tracker {
  active = false;
  private armed = false;
  private start = 0;
  private lastSeen = 0;
  private lastT = -1;
  private samples: Sample[] = [];

  reset() { this.active = false; this.armed = false; this.samples = []; this.lastT = -1; }
  elapsed(t: number) { return this.active ? Math.max(0, t - this.start) : 0; }
  get arming() { return this.armed; }

  update(t: number, m: FrameMetrics | null): TrackEvent {
    if (this.lastT >= 0 && (t < this.lastT || t - this.lastT > 2)) this.reset();
    this.lastT = t;
    if (!m || m.confidence < 0.4 || !m.hanging) {
      if ((this.active || this.armed) && t - this.lastSeen > 1.5) this.reset();
      return null;
    }
    this.lastSeen = t;
    if (!this.active) {
      if (m.torso < -45) this.armed = true;
      else if (this.armed) {
        this.armed = false; this.active = true; this.start = t; this.samples = [toSample(t, m)];
        return { type: 'start' };
      }
      return null;
    }
    if (m.torso < -60) { this.active = false; this.armed = true; this.samples = []; return { type: 'end', samples: [] }; }
    const last = this.samples[this.samples.length - 1];
    if (t - last.t >= SAMPLE_DT) this.samples.push(toSample(t, m));
    if (m.torso > 55) return this.flush();
    return null;
  }

  flush(): TrackEvent {
    if (!this.active) { this.reset(); return null; }
    const samples = this.samples;
    const complete = samples.length > 3 && samples[samples.length - 1].torso > 40;
    this.reset();
    return { type: 'end', samples: complete ? samples : [] };
  }
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

function majorityVariation(samples: Core[]): Variation {
  const c = new Map<Variation, number>();
  for (const s of samples) { const v = classifyVariation(s); c.set(v, (c.get(v) ?? 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'full';
}

function meanParts(samples: Core[], v: Variation): ScoreParts {
  const ps = samples.map(s => scoreFrame(s, v).parts);
  const avg = (k: keyof ScoreParts) => (ps.length && ps[0][k] !== null ? mean(ps.map(p => p[k] as number)) : null);
  return { horizontal: avg('horizontal') ?? 0, hips: avg('hips'), elbows: avg('elbows') ?? 0, knees: avg('knees') };
}

/** Compare the end of the hold with its beginning: which fault grew the most? */
export function detectFailure(samples: Sample[], v: Variation): FailureKey | null {
  if (samples.length < 2) return null;
  const t0 = samples[0].t, dur = samples[samples.length - 1].t - t0;
  if (dur < 3) return null;
  const base = samples.filter(s => s.t - t0 <= dur * 0.4);
  const end = samples.filter(s => s.t - t0 >= dur - Math.max(0.8, dur * 0.2));
  const d = (f: (s: Sample) => number) => median(end.map(f)) - median(base.map(f));
  const straight = v === 'full' || v === 'straddle' || v === 'oneLeg';
  const hip = v === 'tuck' || v === 'advTuck' ? 0 : d(s => s.hipDev);
  const cands: [FailureKey, number][] = [
    ['drop', d(s => s.torso) / 8],
    ['pike', hip / 12],
    ['arch', -hip / 12],
    ['elbows', d(s => s.elbowBend) / 12],
    ['knees', straight ? d(s => (v === 'oneLeg' ? Math.min(s.kneeBend, s.kneeBendOther) : s.kneeBend)) / 15 : 0],
  ];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][1] >= 1 ? cands[0][0] : 'none';
}

export function summarize(mode: Mode, samples: Sample[], manual: Variation | null, at = Date.now()): SetRecord | null {
  if (samples.length < 2) return null;
  const duration = samples[samples.length - 1].t - samples[0].t;
  const dts = samples.map((s, i) => (i ? s.t - samples[i - 1].t : 0));
  const id = at.toString(36) + Math.random().toString(36).slice(2, 6);
  const rel = samples.map(s => ({ ...s, t: Math.round((s.t - samples[0].t) * 100) / 100 }));

  if (mode === 'hold') {
    const variation = manual ?? majorityVariation(samples);
    const scores = samples.map(s => scoreFrame(s, variation).total);
    const torsoMean = mean(samples.map(s => s.torso));
    return {
      id, at, mode, variation, auto: !manual, duration,
      score: mean(scores),
      qualityTime: scores.reduce((acc, sc, i) => acc + (sc >= QUALITY_SCORE ? dts[i] : 0), 0),
      stability: Math.sqrt(mean(samples.map(s => (s.torso - torsoMean) ** 2))),
      parts: meanParts(samples, variation),
      failure: detectFailure(samples, variation),
      samples: rel,
    };
  }

  const zone = samples.filter(s => Math.abs(s.torso) < ZONE_DEG);
  const variation = manual ?? majorityVariation(zone.length ? zone : samples);
  const zoneTime = samples.reduce((acc, s, i) => acc + (Math.abs(s.torso) < ZONE_DEG ? dts[i] : 0), 0);
  const parts = meanParts(zone, variation);
  const form = zone.length ? ((parts.hips ?? 1) + parts.elbows + (parts.knees ?? 1)) / 3 : 0;
  // Fastest part of the descent, measured over ~0.3 s windows.
  let peakVel = 0, dropAngle = 0;
  for (let i = 0, j = 0; i < samples.length; i++) {
    while (j < samples.length - 1 && samples[j].t - samples[i].t < 0.3) j++;
    const dt = samples[j].t - samples[i].t;
    if (dt < 0.15) continue;
    const vel = (samples[j].torso - samples[i].torso) / dt;
    if (vel > peakVel) { peakVel = vel; dropAngle = (samples[i].torso + samples[j].torso) / 2; }
  }
  return {
    id, at, mode, variation, auto: !manual, duration,
    score: 100 * (0.6 * Math.min(1, zoneTime / 3) + 0.4 * form),
    qualityTime: zoneTime, stability: 0, parts, failure: null,
    dropAngle, peakVel, samples: rel,
  };
}
