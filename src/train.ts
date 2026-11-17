import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { classifyVariation, computeMetrics, liveCue, scoreFrame, VARIATIONS, type FrameMetrics, type Pt, type Variation } from './analysis';
import { HoldTracker, NegativeTracker, summarize, ZONE_DEG, type SetRecord, type Tracker } from './tracker';
import { addSet, deleteSet, loadPrefs, savePrefs } from './store';
import { canRecord, deleteClip, fixDuration, putClip, SetRecorder } from './clips';
import { CUE_LABEL, FAILURE_HINT, FAILURE_LABEL, fmtTime, VAR_LABEL } from './labels';
import { loadPose } from './pose';

const TARGETS = [3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 45, 60];
/** Keep recording this long after a set ends, so the moment the form broke is on video. */
const TAIL_MS = 1000;

const BONES: [number, number][] = [[11, 13], [13, 15], [12, 14], [14, 16], [11, 12], [23, 24], [11, 23], [12, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

export function initTrain(root: HTMLElement) {
  const prefs = loadPrefs();
  root.innerHTML = `
    <div class="stage">
      <video playsinline muted autoplay></video>
      <canvas></canvas>
      <div class="hud" hidden>
        <div class="timer" dir="ltr"><span class="t">0.0</span><small class="goal"></small></div>
        <div class="live"><span class="score-pill">–</span><span class="var-pill"></span></div>
      </div>
      <div class="cue" hidden></div>
      <div class="status" hidden></div>
      <div class="result" hidden></div>
      <div class="intro">
        <h1>Front Lever Analyst</h1>
        <p>הצב את הטלפון <b>מהצד</b>, כך שכל הגוף והמתח בפריים. הטיימר מתחיל לבד כשאתה נכנס לצורה.</p>
        <button class="primary" data-act="camera">הפעל מצלמה</button>
        <button data-act="file">נתח סרטון קיים</button>
        <input type="file" accept="video/*" hidden />
        <p class="err" hidden></p>
      </div>
    </div>
    <div class="last-set" hidden></div>
    <div class="controls">
      <div class="seg" data-ctl="mode">
        <button data-v="hold">החזקה</button><button data-v="negative">נגטיב</button>
      </div>
      <select data-ctl="variation" aria-label="וריאציה">
        <option value="auto">וריאציה: זיהוי אוטומטי</option>
        ${VARIATIONS.map(v => `<option value="${v}">${VAR_LABEL[v]}</option>`).join('')}
      </select>
      <select data-ctl="target" aria-label="יעד זמן"></select>
      <div class="row">
        <button data-act="flip">החלף מצלמה</button>
        <button data-act="sound"></button>
        <button data-act="stop">עצור</button>
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const video = $<HTMLVideoElement>('video'), canvas = $<HTMLCanvasElement>('canvas'), ctx = canvas.getContext('2d')!;
  const hud = $('.hud'), timerEl = $('.timer .t'), goalEl = $('.timer .goal'), scoreEl = $('.score-pill'), varEl = $('.var-pill');
  const cueEl = $('.cue'), statusEl = $('.status'), resultEl = $('.result'), intro = $('.intro'), errEl = $('.err'), lastEl = $('.last-set');
  const fileInput = $<HTMLInputElement>('input[type=file]'), stage = $('.stage');
  const modeSeg = $('[data-ctl=mode]'), varSel = $<HTMLSelectElement>('[data-ctl=variation]'), soundBtn = $('[data-act=sound]');
  const targetSel = $<HTMLSelectElement>('[data-ctl=target]');

  let pose: PoseLandmarker | null = null;
  let stream: MediaStream | null = null;
  let source: 'camera' | 'file' | null = null;
  let tracker: Tracker = prefs.mode === 'hold' ? new HoldTracker() : new NegativeTracker();
  let raf = 0, lastVT = -1, prevSide: 'L' | 'R' | undefined, smooth: FrameMetrics | null = null;
  let session = 0;
  /** Duration of the set that just ended – stays on screen until the next one starts. */
  let frozen: number | null = null, goalHit = false;
  let recorder: SetRecorder | null = null, canvasStream: MediaStream | null = null, recordBroken = false;
  let lastBeepSec = 0, lastCueAt = 0, audio: AudioContext | null = null, wake: { release(): Promise<void> } | null = null;

  const fillTargets = () => {
    const list = TARGETS.includes(prefs.target) || !prefs.target ? TARGETS : [...TARGETS, prefs.target].sort((a, b) => a - b);
    targetSel.innerHTML = `<option value="0">יעד זמן: ללא</option>${list.map(n => `<option value="${n}">יעד: ${n} שנ׳</option>`).join('')}<option value="custom">יעד: אחר…</option>`;
  };
  fillTargets();

  const syncControls = () => {
    targetSel.value = String(prefs.target);
    targetSel.hidden = prefs.mode !== 'hold';
    goalEl.textContent = prefs.mode === 'hold' && prefs.target ? `/ ${prefs.target}` : '';
    modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.mode));
    varSel.value = prefs.variation;
    soundBtn.textContent = prefs.sound ? 'צליל: פועל' : 'צליל: כבוי';
    root.querySelector<HTMLElement>('[data-act=flip]')!.hidden = source !== 'camera';
    root.querySelector<HTMLElement>('[data-act=stop]')!.hidden = source === null;
    root.classList.toggle('running', source !== null);
  };
  syncControls();

  /** `force` plays even when sound is off – used for the target alert the user asked for explicitly. */
  const beep = (freq: number, dur = 0.12, { force = false, delay = 0, loud = false } = {}) => {
    if ((!prefs.sound && !force) || !audio) return;
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = loud ? 'square' : 'sine';
    o.frequency.value = freq; g.gain.value = loud ? 0.35 : 0.25;
    o.connect(g).connect(audio.destination);
    const at = audio.currentTime + delay;
    o.start(at); o.stop(at + dur);
  };
  const goalAlarm = () => { for (const d of [0, 0.25, 0.5]) beep(1320, 0.18, { force: true, delay: d, loud: true }); };

  const manualVar = (): Variation | null => (prefs.variation === 'auto' ? null : (prefs.variation as Variation));
  const now = () => (source === 'file' ? video.currentTime : performance.now() / 1000);

  function startRecording() {
    if (recordBroken || !canRecord()) return;
    try {
      canvasStream ??= canvas.captureStream(30);
      recorder = new SetRecorder(canvasStream);
    } catch { recordBroken = true; recorder = null; }
  }

  function finishSet(samples: Parameters<typeof summarize>[1], tailMs: number) {
    hud.classList.remove('active'); cueEl.hidden = true;
    const rec = summarize(prefs.mode, samples, manualVar());
    const r = recorder; recorder = null;
    resultEl.hidden = false; statusEl.hidden = true;
    if (!rec) {
      r?.cancel();
      frozen = null;
      resultEl.className = 'result skip';
      resultEl.textContent = prefs.mode === 'hold' ? 'קצר מדי (פחות משנייה) – לא נשמר' : 'הירידה לא הושלמה – לא נשמר';
      return;
    }
    addSet(rec); beep(440, 0.25); showLast(rec, !!r);
    frozen = rec.duration;
    hud.classList.add('done');
    resultEl.className = 'result ok';
    resultEl.textContent = `✓ נשמר בהתקדמות · ${VAR_LABEL[rec.variation]} · ציון ${Math.round(rec.score)}`;
    r?.finish(tailMs).then(blob => {
      if (!blob) { if (lastEl.dataset.id === rec.id) lastEl.querySelector('.clip')!.innerHTML = ''; return; }
      const url = putClip(rec.id, blob);
      if (lastEl.dataset.id === rec.id) showClip(url);
    });
  }

  function showClip(url: string) {
    const box = lastEl.querySelector('.clip')!;
    box.innerHTML = `<video controls playsinline muted loop src="${url}"></video><p class="muted">הסרטון זמין רק עד שסוגרים את האפליקציה – הוא לא נשמר במכשיר.</p>`;
    fixDuration(box.querySelector('video')!);
  }

  function showLast(rec: SetRecord, recording: boolean) {
    const neg = rec.mode === 'negative';
    lastEl.hidden = false;
    lastEl.dataset.id = rec.id;
    lastEl.innerHTML = `
      <div class="last-head"><b>${neg ? 'נגטיב' : 'החזקה'} · ${VAR_LABEL[rec.variation]}</b><button data-del>מחק</button></div>
      <div class="tiles">
        <div><span>${fmtTime(rec.duration)}</span><small>${neg ? 'משך ירידה' : 'זמן'}</small></div>
        <div><span>${Math.round(rec.score)}</span><small>ציון</small></div>
        <div><span>${fmtTime(rec.qualityTime)}</span><small>${neg ? `זמן באזור ±${ZONE_DEG}°` : 'זמן איכותי'}</small></div>
      </div>
      ${rec.failure ? `<p><b>מה נשבר ראשון:</b> ${FAILURE_LABEL[rec.failure]}</p><p class="muted">${FAILURE_HINT[rec.failure]}</p>` : ''}
      ${neg && rec.peakVel ? `<p class="muted">הנפילה המהירה ביותר סביב ${Math.round(rec.dropAngle!)}° (${Math.round(rec.peakVel)}°/שנ׳)</p>` : ''}
      <div class="clip">${recording ? '<p class="muted">מכין סרטון של הסט…</p>' : ''}</div>`;
    lastEl.querySelector('[data-del]')!.addEventListener('click', () => {
      if (!confirm('למחוק את הסט?')) return;
      deleteSet(rec.id); deleteClip(rec.id); lastEl.hidden = true; lastEl.dataset.id = '';
      if (frozen !== null) { frozen = null; resultEl.hidden = true; hud.classList.remove('done', 'reached'); }
    });
  }

  // The canvas is the viewfinder: the camera frame is painted onto it, so what you see is exactly
  // what is analysed, even where the WebView fails to composite the <video> element itself.
  function paintFrame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (source === 'camera') ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  function draw(lm: Pt[] | null, color: string) {
    paintFrame();
    if (!lm) return;
    const u = Math.max(2, canvas.width / 220);
    const side = prevSide === 'R' ? 12 : 11;
    ctx.setLineDash([u * 3, u * 3]); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = u * 0.6;
    ctx.beginPath(); ctx.moveTo(0, lm[side].y); ctx.lineTo(canvas.width, lm[side].y); ctx.stroke();
    ctx.setLineDash([]); ctx.lineCap = 'round'; ctx.strokeStyle = color; ctx.lineWidth = u * 1.6;
    for (const [a, b] of BONES) {
      if (lm[a].v < 0.3 || lm[b].v < 0.3) continue;
      ctx.beginPath(); ctx.moveTo(lm[a].x, lm[a].y); ctx.lineTo(lm[b].x, lm[b].y); ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
      if (lm[i].v < 0.3) continue;
      ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, u * 1.3, 0, 7); ctx.fill();
    }
  }

  function handle(ev: ReturnType<Tracker['update']>, tailMs = TAIL_MS) {
    if (!ev) return;
    if (ev.type === 'start') {
      hud.classList.remove('done', 'reached'); hud.classList.add('active');
      frozen = null; goalHit = false; lastBeepSec = 0; resultEl.hidden = true;
      beep(880);
    } else finishSet(ev.samples, tailMs);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || !video.videoWidth || video.currentTime === lastVT) return;
    lastVT = video.currentTime;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    if (!pose) { paintFrame(); return; } // model still loading – show the live picture meanwhile
    const res = pose.detectForVideo(video, performance.now());
    const raw = res.landmarks[0];
    const t = now();
    let m: FrameMetrics | null = null, lm: Pt[] | null = null;
    if (raw) {
      lm = raw.map(p => ({ x: p.x * canvas.width, y: p.y * canvas.height, v: p.visibility ?? 0 }));
      const cur = computeMetrics(lm, prevSide);
      prevSide = cur.side;
      // light smoothing against landmark jitter
      const a = 0.5, mix = (k: 'torso' | 'hipDev' | 'kneeBend' | 'kneeBendOther' | 'elbowBend') => (smooth ? smooth[k] + a * (cur[k] - smooth[k]) : cur[k]);
      m = smooth = { ...cur, torso: mix('torso'), hipDev: mix('hipDev'), kneeBend: mix('kneeBend'), kneeBendOther: mix('kneeBendOther'), elbowBend: mix('elbowBend') };
    } else smooth = null;

    handle(tracker.update(t, m));

    // Record from the moment the body gets into position, so the clip includes the entry.
    const busy = tracker.active || tracker.arming;
    if (source === 'camera' && busy && !recorder) startRecording();
    else if (!busy && recorder) { recorder.cancel(); recorder = null; }

    const v = m ? manualVar() ?? classifyVariation(m) : null;
    const sc = m && v ? scoreFrame(m, v).total : null;
    const good = m !== null && m.confidence >= 0.4;
    draw(good ? lm : null, !tracker.active || sc === null ? '#9aa4b2' : sc >= 80 ? '#3ddc84' : sc >= 60 ? '#ffc53d' : '#ff5c5c');
    statusEl.hidden = good || !resultEl.hidden;
    if (!good) statusEl.textContent = 'לא מזהה גוף – ודא שכל הגוף בפריים, מהצד';

    const el = tracker.elapsed(t);
    timerEl.textContent = (tracker.active ? el : frozen ?? 0).toFixed(1);
    if (tracker.active && m && v) {
      scoreEl.textContent = prefs.mode === 'hold' ? String(Math.round(sc!)) : `${Math.round(m.torso)}°`;
      varEl.textContent = VAR_LABEL[v];
      if (prefs.mode === 'hold') {
        const sec = Math.floor(el), goal = prefs.target;
        if (sec > lastBeepSec) {
          lastBeepSec = sec;
          if (!goal) { if (sec % 5 === 0) beep(660, 0.06); }
          else if (sec >= goal - 3 && sec < goal) beep(880, 0.08, { force: true }); // countdown to the target
        }
        if (goal && !goalHit && el >= goal) { goalHit = true; hud.classList.add('reached'); goalAlarm(); }
        if (performance.now() - lastCueAt > 500) {
          lastCueAt = performance.now();
          const cue = liveCue(m, v);
          cueEl.hidden = !cue;
          if (cue) cueEl.textContent = CUE_LABEL[cue];
        }
      }
    } else if (!tracker.active) {
      scoreEl.textContent = m ? `${Math.round(m.torso)}°` : '–';
      varEl.textContent = frozen !== null ? 'הסט נשמר' : prefs.mode === 'hold' ? 'ממתין לצורה' : 'ממתין לירידה מהיפוך';
    }
  }

  async function begin(kind: 'camera' | 'file', file?: File) {
    errEl.hidden = true;
    audio ??= new AudioContext();
    audio.resume().catch(() => {});
    frozen = null; resultEl.hidden = true; hud.classList.remove('done', 'reached', 'active');
    statusEl.hidden = false; statusEl.textContent = 'טוען מודל זיהוי תנועה…';
    intro.hidden = true;
    const my = ++session;
    try {
      stopSource();
      if (kind === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: prefs.facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
        video.srcObject = stream; video.loop = false; video.controls = false;
        stage.classList.toggle('mirror', prefs.facing === 'user');
      } else {
        video.srcObject = null; video.src = URL.createObjectURL(file!); video.controls = true;
        stage.classList.remove('mirror');
      }
      source = kind;
      syncControls();
      // Show the picture right away so the phone can be aimed while the model loads.
      tracker.reset(); lastVT = -1;
      cancelAnimationFrame(raf); loop();
      await video.play();
      pose = await loadPose();
      if (my !== session) return;
      statusEl.hidden = true; hud.hidden = false;
      try { wake = await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* optional */ }
    } catch (e) {
      if (my !== session) return;
      stopSource();
      intro.hidden = false; statusEl.hidden = true;
      errEl.hidden = false;
      errEl.textContent = kind === 'camera' && (e as Error).name === 'NotAllowedError'
        ? 'אין הרשאה למצלמה. אשר גישה למצלמה בהגדרות הדפדפן.'
        : 'שגיאה: ' + ((e as Error).message || e);
    }
    syncControls();
  }

  function stopSource() {
    cancelAnimationFrame(raf);
    handle(tracker.flush(), 0);
    recorder?.cancel(); recorder = null;
    canvasStream?.getTracks().forEach(t => t.stop()); canvasStream = null;
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); }
    video.srcObject = null; video.load();
    wake?.release().catch(() => {}); wake = null;
    source = null; smooth = null; hud.hidden = true; cueEl.hidden = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  video.addEventListener('ended', () => handle(tracker.flush()));
  video.addEventListener('seeked', () => { tracker.reset(); hud.classList.remove('active'); });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) begin('file', f); fileInput.value = ''; });

  root.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'camera') begin('camera');
    else if (act === 'file') fileInput.click();
    else if (act === 'flip') { prefs.facing = prefs.facing === 'user' ? 'environment' : 'user'; savePrefs(prefs); begin('camera'); }
    else if (act === 'sound') { prefs.sound = !prefs.sound; savePrefs(prefs); syncControls(); }
    else if (act === 'stop') { session++; stopSource(); intro.hidden = false; statusEl.hidden = true; resultEl.hidden = true; syncControls(); }
    const mode = t.closest<HTMLElement>('[data-ctl=mode] button')?.dataset.v as 'hold' | 'negative' | undefined;
    if (mode && mode !== prefs.mode) {
      handle(tracker.flush());
      prefs.mode = mode; savePrefs(prefs);
      tracker = mode === 'hold' ? new HoldTracker() : new NegativeTracker();
      hud.classList.remove('active', 'done', 'reached'); frozen = null; resultEl.hidden = true; syncControls();
    }
  });
  varSel.addEventListener('change', () => { prefs.variation = varSel.value; savePrefs(prefs); });
  targetSel.addEventListener('change', () => {
    let n = Number(targetSel.value);
    if (targetSel.value === 'custom') {
      n = Math.round(Number(prompt('יעד בשניות:', String(prefs.target || 10))));
      if (!Number.isFinite(n) || n < 1 || n > 600) { syncControls(); return; }
    }
    prefs.target = n; savePrefs(prefs); fillTargets(); syncControls();
    audio ??= new AudioContext(); audio.resume().catch(() => {}); // unlock audio while we have a tap
  });
}
