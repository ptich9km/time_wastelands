// Stage 3: world map screen — 20x20 grid with fog of war.

import { getWorld, travel } from '../api.js';
import { getLang, t } from '../i18n.js';

export const TYPE_ICONS = {
  city: '🏙️',
  waste: '🌫️',
  ruins: '🏚️',
  mine: '⛏️',
  road: '🛤️',
  camp: '🏕️',
};

// Base travel animation duration by connection type (matches the server).
export const TRAVEL_TIME_MS = { road: 900, plain: 1500 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs a travel request with the "on the way" animation.
// Returns { status, data } after at least baseTimeMs has passed.
export async function travelWithProgress(progressEl, toId, name, baseTimeMs) {
  progressEl.replaceChildren();
  progressEl.classList.add('active');
  const label = document.createElement('span');
  label.className = 'bar-label';
  label.textContent = t('ui.travel.progress', { name });
  const fill = document.createElement('div');
  fill.className = 'travel-progress-fill';
  fill.style.transitionDuration = `${baseTimeMs}ms`;
  progressEl.append(fill, label);
  // Force a reflow so the width transition actually animates.
  void fill.offsetWidth;
  fill.style.width = '100%';
  const [result] = await Promise.all([travel(toId, getLang()), delay(baseTimeMs)]);
  progressEl.classList.remove('active');
  progressEl.replaceChildren();
  // Stage 7: an encounter flashes a notice before the battle screen opens.
  if (result.status === 200 && result.data?.battle) {
    const elite = result.data.battle.participants?.some((p) => p.isElite);
    const notice = document.createElement('span');
    notice.className = 'bar-label';
    notice.textContent = t(elite ? 'ui.travel.encounter_elite' : 'ui.travel.encounter');
    progressEl.append(notice);
    await delay(800);
    progressEl.replaceChildren();
  }
  return result;
}

// options: { onCharacter(), onLocation(id), onTraveled(travelResult) }
export function renderMap(root, options) {
  const wrap = document.createElement('div');
  wrap.className = 'map-screen';

  const head = document.createElement('div');
  head.className = 'map-head';
  const title = document.createElement('h2');
  title.className = 'map-title';
  title.textContent = t('ui.map.title');
  const buttons = document.createElement('div');
  buttons.className = 'screen-buttons';
  const charBtn = document.createElement('button');
  charBtn.className = 'btn btn-secondary';
  charBtn.textContent = t('ui.map.button.character');
  charBtn.addEventListener('click', () => options.onCharacter());
  const locBtn = document.createElement('button');
  locBtn.className = 'btn btn-secondary';
  locBtn.textContent = t('ui.map.button.location');
  buttons.append(locBtn, charBtn);
  head.append(title, buttons);

  const errorEl = document.createElement('p');
  errorEl.className = 'inline-error';

  const progressEl = document.createElement('div');
  progressEl.className = 'travel-progress';

  const grid = document.createElement('div');
  grid.className = 'map-grid';

  wrap.append(head, errorEl, progressEl, grid);
  root.replaceChildren(wrap);

  (async () => {
    const { status, data } = await getWorld();
    if (status !== 200) {
      errorEl.textContent = t('ui.error.data');
      return;
    }
    const byCell = new Map();
    for (const loc of data.locations) {
      byCell.set(`${loc.coords.x},${loc.coords.y}`, loc);
    }
    const current = data.locations.find((l) => l.id === data.current);
    const adjacent = new Set((current?.connections ?? []).map((c) => c.to));
    locBtn.addEventListener('click', () => options.onLocation(data.current));

    let traveling = false;
    const onCellClick = async (loc) => {
      if (traveling) return;
      errorEl.textContent = '';
      if (loc.id === data.current) {
        options.onLocation(loc.id);
        return;
      }
      if (!loc.isVisible || !adjacent.has(loc.id)) return;
      traveling = true;
      const conn = current.connections.find((c) => c.to === loc.id);
      const name = t(loc.nameKey);
      const result = await travelWithProgress(
        progressEl,
        loc.id,
        name,
        TRAVEL_TIME_MS[conn?.type] ?? TRAVEL_TIME_MS.plain,
      );
      traveling = false;
      if (result.status === 200) {
        options.onTraveled(result.data);
      } else {
        const code = result.data?.error ?? 'unknown_location';
        errorEl.textContent = t(`ui.map.error.${code}`);
      }
    };

    const frag = document.createDocumentFragment();
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const cell = document.createElement('div');
        cell.className = 'map-hex';
        const loc = byCell.get(`${x},${y}`);
        if (!loc || !loc.isVisible) {
          cell.classList.add('fog');
        } else {
          cell.classList.add('visible');
          cell.textContent = TYPE_ICONS[loc.type] ?? '❓';
          cell.title = t('ui.map.tooltip', {
            name: t(loc.nameKey),
            level: `${loc.levelRange[0]}–${loc.levelRange[1]}`,
            danger: loc.dangerLevel,
          });
          cell.addEventListener('click', () => onCellClick(loc));
          if (loc.id === data.current) {
            cell.classList.add('current');
          }
        }
        frag.append(cell);
      }
    }
    grid.replaceChildren(frag);
  })();
}
