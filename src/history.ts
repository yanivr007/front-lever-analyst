import { VARIATIONS, type Variation } from './analysis';
import { ZONE_DEG, type FailureKey, type Mode, type SetRecord } from './tracker';
import { deleteSet, exportJson, importJson, loadSets } from './store';
import { FAILURE_HINT, FAILURE_LABEL, fmtDate, fmtTime, VAR_LABEL } from './labels';
import { lineChart } from './charts';

let root: HTMLElement;
let mode: Mode = 'hold';
let variation: Variation | 'all' = 'all';

const C1 = 'var(--series-1)', C2 = 'var(--series-2)';
const dayKey = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function initHistory(el: HTMLElement) {
  root = el;
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as Mode | undefined;
    if (m) { mode = m; variation = 'all'; renderHistory(); return; }
    const v = t.closest<HTMLElement>('[data-var]')?.dataset.var as Variation | 'all' | undefined;
    if (v) { variation = v; renderHistory(); return; }
    const id = t.closest<HTMLElement>('[data-set]')?.dataset.set;
    if (id) { const s = loadSets().find(x => x.id === id); if (s) openDetail(s); return; }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'export') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
      a.download = `front-lever-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    } else if (act === 'import') root.querySelector<HTMLInputElement>('input[type=file]')!.click();
  });
  root.addEventListener('change', async e => {
    const inp = e.target as HTMLInputElement;
    if (inp.type !== 'file' || !inp.files?.[0]) return;
    try { alert(`יובאו ${importJson(await inp.files[0].text())} סטים`); } catch { alert('קובץ לא תקין'); }
    renderHistory();
  });
}

export function renderHistory() {
  const all = loadSets();
  const ofMode = all.filter(s => s.mode === mode);
  const vars = VARIATIONS.filter(v => ofMode.some(s => s.variation === v));
  if (variation !== 'all' && !vars.includes(variation)) variation = 'all';
  const sets = ofMode.filter(s => variation === 'all' || s.variation === variation);
  const neg = mode === 'negative';

  const max = (f: (s: SetRecord) => number) => (sets.length ? Math.max(...sets.map(f)) : 0);
  const tiles = [
    [sets.length ? fmtTime(max(s => s.duration)) : '–', neg ? 'ירידה ארוכה ביותר' : 'שיא זמן'],
    [sets.length ? String(Math.round(max(s => s.score))) : '–', 'ציון שיא'],
    [sets.length ? fmtTime(max(s => s.qualityTime)) : '–', neg ? `שיא באזור ±${ZONE_DEG}°` : 'שיא זמן איכותי'],
    [String(sets.length), 'סטים'],
  ];

  const days = new Map<number, SetRecord[]>();
  for (const s of sets) { const k = dayKey(s.at); days.set(k, [...(days.get(k) ?? []), s]); }
  const dayList = [...days.entries()].sort((a, b) => a[0] - b[0]);

  const recent = sets.slice(-20).filter(s => s.failure && s.failure !== 'none');
  const counts = new Map<FailureKey, number>();
  for (const s of recent) counts.set(s.failure!, (counts.get(s.failure!) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  root.innerHTML = `
    <div class="page">
      <div class="seg">
        <button data-mode="hold" class="${neg ? '' : 'on'}">החזקות</button>
        <button data-mode="negative" class="${neg ? 'on' : ''}">נגטיבים</button>
      </div>
      <div class="chips">
        <button data-var="all" class="${variation === 'all' ? 'on' : ''}">הכול</button>
        ${vars.map(v => `<button data-var="${v}" class="${variation === v ? 'on' : ''}">${VAR_LABEL[v]}</button>`).join('')}
      </div>
      <div class="tiles four">${tiles.map(([v, l]) => `<div><span>${v}</span><small>${l}</small></div>`).join('')}</div>
      ${sets.length ? `
      <div class="card"><h3>${neg ? 'זמן באזור הלבר – הטוב ביותר בכל יום' : 'זמן החזקה – הטוב ביותר בכל יום'}</h3><div id="ch-time"></div></div>
      <div class="card"><h3>ציון צורה – ממוצע יומי</h3><div id="ch-score"></div></div>
      ${!neg ? `<div class="card"><h3>מה נשבר ראשון (20 הסטים האחרונים)</h3>${ranked.length ? `
        ${ranked.map(([k, n]) => `<div class="bar-row"><span>${FAILURE_LABEL[k]}</span><div class="bar"><i style="width:${(n / ranked[0][1]) * 100}%"></i></div><b>${n}</b></div>`).join('')}
        <p class="muted">${FAILURE_HINT[ranked[0][0]]}</p>` : '<p class="muted">עדיין אין מספיק החזקות של 3 שניות ומעלה עם שבירת צורה מזוהה.</p>'}</div>` : ''}
      <div class="card"><h3>סטים</h3>
        ${dayList.reverse().map(([d, list]) => `<h4>${new Date(d).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
          ${list.reverse().map(s => `<button class="set-row" data-set="${s.id}"><span>${VAR_LABEL[s.variation]}</span><span dir="ltr">${fmtTime(s.duration)}</span><span class="badge ${s.score >= 80 ? 'good' : s.score >= 60 ? 'mid' : 'bad'}">${Math.round(s.score)}</span></button>`).join('')}`).join('')}
      </div>` : `<p class="empty">עדיין אין ${neg ? 'נגטיבים' : 'החזקות'} שמורים. עבור ל״אימון״ והתחל.</p>`}
      <div class="row">
        <button data-act="export">גיבוי (ייצוא)</button><button data-act="import">שחזור (ייבוא)</button>
        <input type="file" accept="application/json" hidden />
      </div>
      <p class="muted center">כל הנתונים נשמרים רק במכשיר הזה.</p>
    </div>`;

  if (!sets.length) return;
  const asc = [...days.entries()].sort((a, b) => a[0] - b[0]);
  lineChart(root.querySelector('#ch-time')!, [{ name: 'זמן', color: C1, points: asc.map(([d, l]) => ({ x: d, y: Math.max(...l.map(s => (neg ? s.qualityTime : s.duration))) })) }],
    { fmtX: fmtDate, fmtY: y => y.toFixed(1) + 's', yMin: 0, dots: true });
  lineChart(root.querySelector('#ch-score')!, [{ name: 'ציון', color: C1, points: asc.map(([d, l]) => ({ x: d, y: l.reduce((a, s) => a + s.score, 0) / l.length })) }],
    { fmtX: fmtDate, fmtY: y => String(Math.round(y)), yMin: 0, yMax: 100, dots: true });
}

function openDetail(s: SetRecord) {
  const neg = s.mode === 'negative';
  const dlg = document.createElement('dialog');
  dlg.className = 'detail';
  const part = (label: string, v: number | null) => (v === null ? '' : `<div class="bar-row"><span>${label}</span><div class="bar"><i style="width:${v * 100}%"></i></div><b>${Math.round(v * 100)}</b></div>`);
  dlg.innerHTML = `
    <div class="last-head"><b>${neg ? 'נגטיב' : 'החזקה'} · ${VAR_LABEL[s.variation]}${s.auto ? '' : ' (ידני)'}</b><button data-close>סגור</button></div>
    <p class="muted">${new Date(s.at).toLocaleString('he-IL', { dateStyle: 'medium', timeStyle: 'short' })}</p>
    <div class="tiles">
      <div><span>${fmtTime(s.duration)}</span><small>${neg ? 'משך ירידה' : 'זמן'}</small></div>
      <div><span>${Math.round(s.score)}</span><small>ציון</small></div>
      <div><span>${fmtTime(s.qualityTime)}</span><small>${neg ? `באזור ±${ZONE_DEG}°` : 'זמן איכותי'}</small></div>
    </div>
    <h3>פירוק הציון</h3>
    ${neg ? '' : part('אופקיות', s.parts.horizontal)}${part('קו אגן', s.parts.hips)}${part('מרפקים', s.parts.elbows)}${part('ברכיים', s.parts.knees)}
    ${neg ? '' : `<p class="muted">יציבות: סטייה של ±${s.stability.toFixed(1)}° בזווית הגוף</p>`}
    ${s.failure ? `<p><b>מה נשבר ראשון:</b> ${FAILURE_LABEL[s.failure]}</p><p class="muted">${FAILURE_HINT[s.failure]}</p>` : ''}
    ${neg && s.peakVel ? `<p class="muted">הנפילה המהירה ביותר סביב ${Math.round(s.dropAngle!)}° (${Math.round(s.peakVel)}°/שנ׳)</p>` : ''}
    <h3>זוויות לאורך הסט</h3>
    <div id="ch-detail"></div>
    <p class="muted">0° = אופקי. זווית גוף חיובית = מתחת לאופק. אגן חיובי = מקופל, שלילי = מקושת.</p>
    <button class="danger" data-del>מחק סט</button>`;
  document.body.append(dlg);
  lineChart(dlg.querySelector('#ch-detail')!, [
    { name: 'זווית גוף', color: C1, points: s.samples.map(p => ({ x: p.t, y: p.torso })) },
    ...(s.variation === 'tuck' || s.variation === 'advTuck' ? [] : [{ name: 'אגן', color: C2, points: s.samples.map(p => ({ x: p.t, y: p.hipDev })) }]),
  ], { fmtX: x => x.toFixed(1) + 's', fmtY: y => Math.round(y) + '°', refY: 0 });
  dlg.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-close]')) dlg.close();
    if (t.closest('[data-del]') && confirm('למחוק את הסט?')) { deleteSet(s.id); dlg.close(); renderHistory(); }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}
