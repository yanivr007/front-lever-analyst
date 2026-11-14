import './style.css';
import { initTrain } from './train';
import { initHistory, renderHistory } from './history';

const app = document.getElementById('app')!;
app.innerHTML = `
  <section id="view-train" class="view"></section>
  <section id="view-history" class="view" hidden></section>
  <nav class="tabs">
    <button data-tab="train" class="on">אימון</button>
    <button data-tab="history">התקדמות</button>
  </nav>`;

const views = { train: document.getElementById('view-train')!, history: document.getElementById('view-history')! };
initTrain(views.train);
initHistory(views.history);

app.querySelector('.tabs')!.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (!b) return;
  const tab = b.dataset.tab as keyof typeof views;
  for (const k of Object.keys(views) as (keyof typeof views)[]) views[k].hidden = k !== tab;
  app.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  if (tab === 'history') renderHistory();
});

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js');
