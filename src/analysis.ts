// Pure geometry: turns pose landmarks into front-lever metrics and a form score.

export interface Pt { x: number; y: number; v: number }

export type Variation = 'tuck' | 'advTuck' | 'oneLeg' | 'halfLay' | 'straddle' | 'full';
export const VARIATIONS: Variation[] = ['tuck', 'advTuck', 'oneLeg', 'halfLay', 'straddle', 'full'];

export interface FrameMetrics {
  /** Shoulder→hip line vs horizontal, degrees. 0 = horizontal, +90 = dead hang, -90 = inverted. */
  torso: number;
  /** Signed hip deviation from a straight line, degrees. + = piked (flexed), - = arched. */
  hipDev: number;
  /** Knee bend from straight, degrees (most visible leg). */
  kneeBend: number;
  /** Knee bend of the other leg. */
  kneeBendOther: number;
  /** Elbow bend from straight, degrees. */
  elbowBend: number;
  /** Wrists clearly above shoulders (i.e. hanging from something). */
  hanging: boolean;
  /** Mean landmark visibility of the chosen side, 0..1. */
  confidence: number;
  side: 'L' | 'R';
}

/** The angles everything else is derived from. */
export type Core = Pick<FrameMetrics, 'torso' | 'hipDev' | 'kneeBend' | 'kneeBendOther' | 'elbowBend'>;

const IDX = {
  L: { sh: 11, el: 13, wr: 15, hip: 23, knee: 25, ank: 27 },
  R: { sh: 12, el: 14, wr: 16, hip: 24, knee: 26, ank: 28 },
} as const;

const deg = (r: number) => (r * 180) / Math.PI;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function angleAt(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d === 0) return 180;
  return deg(Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))));
}

function sideVisibility(lm: Pt[], s: 'L' | 'R'): number {
  const i = IDX[s];
  return (lm[i.sh].v + lm[i.el].v + lm[i.wr].v + lm[i.hip].v + lm[i.knee].v + lm[i.ank].v) / 6;
}

/**
 * @param lm 33 BlazePose landmarks in pixel coordinates (x right, y down).
 * @param prevSide previously used body side, for hysteresis.
 */
export function computeMetrics(lm: Pt[], prevSide?: 'L' | 'R'): FrameMetrics {
  const vL = sideVisibility(lm, 'L'), vR = sideVisibility(lm, 'R');
  let side: 'L' | 'R' = vL >= vR ? 'L' : 'R';
  if (prevSide && Math.abs(vL - vR) < 0.15) side = prevSide;
  const i = IDX[side], o = IDX[side === 'L' ? 'R' : 'L'];
  const sh = lm[i.sh], el = lm[i.el], wr = lm[i.wr], hip = lm[i.hip], knee = lm[i.knee], ank = lm[i.ank];

  const torsoLen = Math.hypot(hip.x - sh.x, hip.y - sh.y) || 1;
  const torso = deg(Math.atan2(hip.y - sh.y, Math.abs(hip.x - sh.x)));

  // Hip: which way does the thigh deviate from the torso line? Towards the arms = flexion (pike).
  const ux = hip.x - sh.x, uy = hip.y - sh.y;
  const cross = (ax: number, ay: number) => ux * ay - uy * ax;
  const thighSide = Math.sign(cross(knee.x - hip.x, knee.y - hip.y));
  const armSide = Math.sign(cross(wr.x - sh.x, wr.y - sh.y));
  const hipMag = 180 - angleAt(sh, hip, knee);
  const hipDev = thighSide === armSide || armSide === 0 ? hipMag : -hipMag;

  return {
    torso,
    hipDev,
    kneeBend: 180 - angleAt(hip, knee, ank),
    kneeBendOther: 180 - angleAt(lm[o.hip], lm[o.knee], lm[o.ank]),
    elbowBend: 180 - angleAt(sh, el, wr),
    hanging: sh.y - wr.y > 0.2 * torsoLen,
    confidence: side === 'L' ? vL : vR,
    side,
  };
}

/** Guess the variation from a single frame. Straddle can't be told apart from a side view. */
export function classifyVariation(m: Core): Variation {
  const kMax = Math.max(m.kneeBend, m.kneeBendOther), kMin = Math.min(m.kneeBend, m.kneeBendOther);
  if (kMin < 30 && kMax > 70) return 'oneLeg';
  if (m.kneeBend > 55) {
    if (m.hipDev > 95) return 'tuck';
    if (m.hipDev > 40) return 'advTuck';
    return 'halfLay';
  }
  return 'full';
}

export interface ScoreParts { horizontal: number; hips: number | null; elbows: number; knees: number | null }
export interface Score { total: number; parts: ScoreParts }

const pen = (x: number, tol: number, max: number) => clamp01((x - tol) / (max - tol));

/** Form score 0..100 for one frame. Each part is a 0..1 quality (1 = perfect). */
export function scoreFrame(m: Core, v: Variation): Score {
  const horizontal = 1 - pen(Math.abs(m.torso), 4, 30);
  const elbows = 1 - pen(m.elbowBend, 12, 50);
  let hips: number | null = null, knees: number | null = null;
  let w = { h: 0.65, hip: 0, el: 0.35, k: 0 };
  if (v === 'halfLay') {
    hips = 1 - pen(Math.abs(m.hipDev), 10, 45);
    w = { h: 0.45, hip: 0.3, el: 0.25, k: 0 };
  } else if (v === 'full' || v === 'straddle' || v === 'oneLeg') {
    hips = 1 - pen(Math.abs(m.hipDev), 10, 45);
    const kb = v === 'oneLeg' ? Math.min(m.kneeBend, m.kneeBendOther) : m.kneeBend;
    knees = 1 - pen(kb, 10, 45);
    w = { h: 0.4, hip: 0.3, el: 0.2, k: 0.1 };
  }
  const total = 100 * (w.h * horizontal + w.hip * (hips ?? 1) + w.el * elbows + w.k * (knees ?? 1));
  return { total, parts: { horizontal, hips, elbows, knees } };
}

export type Cue = 'raise' | 'lower' | 'pike' | 'arch' | 'elbows' | 'knees' | null;

/** The single most important correction right now. */
export function liveCue(m: Core, v: Variation): Cue {
  const s = scoreFrame(m, v).parts;
  const cands: [number, Cue][] = [
    [s.horizontal, m.torso > 0 ? 'raise' : 'lower'],
    [s.hips ?? 1, m.hipDev > 0 ? 'pike' : 'arch'],
    [s.elbows, 'elbows'],
    [s.knees ?? 1, 'knees'],
  ];
  cands.sort((a, b) => a[0] - b[0]);
  return cands[0][0] < 0.75 ? cands[0][1] : null;
}
