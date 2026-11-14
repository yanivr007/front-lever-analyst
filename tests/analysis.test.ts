import { describe, expect, it } from 'vitest';
import { classifyVariation, computeMetrics, liveCue, scoreFrame, type Pt } from '../src/analysis';
import { HoldTracker, NegativeTracker, summarize, type Sample } from '../src/tracker';

const rad = (d: number) => (d * Math.PI) / 180;

/** Build a side-view skeleton hanging from a bar. Angles in degrees; y grows downwards. */
function skeleton(o: { torso?: number; hip?: number; knee?: number; elbow?: number; otherKnee?: number } = {}): Pt[] {
  const { torso = 0, hip = 0, knee = 0, elbow = 0, otherKnee = knee } = o;
  const lm: Pt[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0.9 }));
  const sh = { x: 300, y: 300 };
  const dir = (a: number, len: number, from: { x: number; y: number }) => ({ x: from.x + len * Math.cos(rad(a)), y: from.y + len * Math.sin(rad(a)) });
  const hipP = dir(torso, 100, sh);                 // body points to +x, tilted down by `torso`
  const leg = (kb: number) => {
    const thighA = torso - hip;                      // flexion rotates the thigh up, towards the arms
    const kneeP = dir(thighA, 80, hipP);
    return { kneeP, ank: dir(thighA + kb, 80, kneeP) };
  };
  const el = dir(-70, 50, sh);                       // arms go up to the bar
  const wr = dir(-70 - elbow, 50, el);
  const a = leg(knee), b = leg(otherKnee);
  const set = (i: number, p: { x: number; y: number }) => { lm[i] = { ...p, v: 0.9 }; };
  for (const [s, l] of [[0, a], [1, b]] as const) {
    set(11 + s, sh); set(13 + s, el); set(15 + s, wr); set(23 + s, hipP); set(25 + s, l.kneeP); set(27 + s, l.ank);
  }
  return lm;
}

describe('computeMetrics', () => {
  it('reads a perfect full lever', () => {
    const m = computeMetrics(skeleton());
    expect(m.torso).toBeCloseTo(0, 5);
    expect(m.hipDev).toBeCloseTo(0, 3);
    expect(m.kneeBend).toBeCloseTo(0, 3);
    expect(m.elbowBend).toBeCloseTo(0, 3);
    expect(m.hanging).toBe(true);
    expect(classifyVariation(m)).toBe('full');
    expect(scoreFrame(m, 'full').total).toBeCloseTo(100, 3);
    expect(liveCue(m, 'full')).toBeNull();
  });
  it('signs torso and hip deviations', () => {
    expect(computeMetrics(skeleton({ torso: 20 })).torso).toBeCloseTo(20, 3);
    expect(computeMetrics(skeleton({ torso: -20 })).torso).toBeCloseTo(-20, 3);
    expect(computeMetrics(skeleton({ hip: 30 })).hipDev).toBeCloseTo(30, 3);
    expect(computeMetrics(skeleton({ hip: -25 })).hipDev).toBeCloseTo(-25, 3);
    expect(computeMetrics(skeleton({ elbow: 40 })).elbowBend).toBeCloseTo(40, 3);
  });
  it('is mirror-invariant', () => {
    const mirrored = skeleton({ torso: 10, hip: 30 }).map(p => ({ ...p, x: 1000 - p.x }));
    const m = computeMetrics(mirrored);
    expect(m.torso).toBeCloseTo(10, 3);
    expect(m.hipDev).toBeCloseTo(30, 3);
  });
  it('classifies variations', () => {
    expect(classifyVariation(computeMetrics(skeleton({ hip: 120, knee: 130 })))).toBe('tuck');
    expect(classifyVariation(computeMetrics(skeleton({ hip: 80, knee: 100 })))).toBe('advTuck');
    expect(classifyVariation(computeMetrics(skeleton({ knee: 90 })))).toBe('halfLay');
    expect(classifyVariation(computeMetrics(skeleton({ knee: 5, otherKnee: 120 })))).toBe('oneLeg');
  });
  it('scores faults and cues the worst one', () => {
    const sag = computeMetrics(skeleton({ torso: 18 }));
    expect(scoreFrame(sag, 'full').total).toBeLessThan(85);
    expect(liveCue(sag, 'full')).toBe('raise');
    expect(liveCue(computeMetrics(skeleton({ hip: 35 })), 'full')).toBe('pike');
    expect(liveCue(computeMetrics(skeleton({ elbow: 45 })), 'tuck')).toBe('elbows');
    // a tuck is not punished for bent hips/knees
    expect(scoreFrame(computeMetrics(skeleton({ hip: 120, knee: 130 })), 'tuck').total).toBeCloseTo(100, 3);
  });
  it('a dead hang is not a lever', () => {
    const m = computeMetrics(skeleton({ torso: 88 }));
    expect(m.torso).toBeGreaterThan(80);
  });
});

function run(tr: HoldTracker | NegativeTracker, frames: [number, Pt[] | null][]) {
  const events: string[] = []; let samples: Sample[] = [];
  for (const [t, lm] of frames) {
    const e = tr.update(t, lm ? computeMetrics(lm) : null);
    if (e) { events.push(e.type); if (e.type === 'end') samples = e.samples; }
  }
  return { events, samples };
}
const seq = (from: number, to: number, f: (t: number) => Pt[] | null): [number, Pt[] | null][] => {
  const out: [number, Pt[] | null][] = [];
  for (let t = from; t < to - 1e-9; t += 1 / 30) out.push([t, f(t)]);
  return out;
};

describe('HoldTracker', () => {
  it('times a hold and finds what broke first', () => {
    const frames = [
      ...seq(0, 2, () => skeleton({ torso: 88 })),                                   // hanging
      ...seq(2, 10, t => skeleton({ torso: 2, hip: t > 8 ? (t - 8) * 15 + 3 : 3 })), // 8 s lever, hips pike at the end
      ...seq(10, 12, () => skeleton({ torso: 88 })),
    ];
    const { events, samples } = run(new HoldTracker(), frames);
    expect(events).toEqual(['start', 'end']);
    const rec = summarize('hold', samples, null)!;
    expect(rec.duration).toBeGreaterThan(7.7);
    expect(rec.duration).toBeLessThan(8.1);
    expect(rec.variation).toBe('full');
    expect(rec.failure).toBe('pike');
    expect(rec.score).toBeGreaterThan(85);
    expect(rec.qualityTime).toBeGreaterThan(6);
  });
  it('ignores a brief pass through horizontal and survives short dropouts', () => {
    expect(run(new HoldTracker(), seq(0, 0.25, () => skeleton())).events).toEqual([]);
    const frames = seq(0, 5, t => (t > 2 && t < 2.3 ? null : skeleton()));
    const tr = new HoldTracker();
    const { events } = run(tr, frames);
    expect(events).toEqual(['start']);
    expect(tr.elapsed(5)).toBeCloseTo(5, 1);
  });
  it('does not start for someone lying down (hands not above shoulders)', () => {
    const lying = skeleton().map((p, i) => (i === 15 || i === 16 ? { ...p, y: 320 } : p));
    expect(run(new HoldTracker(), seq(0, 3, () => lying)).events).toEqual([]);
  });
});

describe('NegativeTracker', () => {
  it('measures a descent and the time in the lever zone', () => {
    // inverted for 1 s, then -80° → 80°: slow (10°/s) inside ±20°, fast (80°/s) outside
    const angle = (t: number) => {
      if (t < 1) return -80;
      if (t < 1.75) return -80 + (t - 1) * 80;       // to -20
      if (t < 5.75) return -20 + (t - 1.75) * 10;    // to +20 over 4 s
      return Math.min(80, 20 + (t - 5.75) * 80);
    };
    const { events, samples } = run(new NegativeTracker(), seq(0, 8, t => skeleton({ torso: angle(t) })));
    expect(events).toEqual(['start', 'end']);
    const rec = summarize('negative', samples, null)!;
    expect(rec.qualityTime).toBeGreaterThan(3.6);
    expect(rec.qualityTime).toBeLessThan(4.3);
    expect(rec.peakVel!).toBeGreaterThan(60);
    expect(rec.score).toBeGreaterThan(90);
  });
});
