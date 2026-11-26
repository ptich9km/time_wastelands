// Stage 3: location screen — name, type, description, ambient phrases, exits.
// Stage 06b-fix: out-of-battle recovery actions (rest, hospital, medkit).

import {
  getLocation,
  getWorld,
  getCharacter,
  getInventory,
  getNpc,
  beggar,
  travel,
  rest,
  heal,
  useItem,
} from '../api.js';
import { getLang, t } from '../i18n.js';
import { TYPE_ICONS, TRAVEL_TIME_MS, travelWithProgress } from './map.js';

const REST_COOLDOWN_MS = 5 * 60 * 1000;

function cooldownRemainingSec(lastRestAt) {
  if (!lastRestAt) return 0;
  const elapsed = Date.now() - Date.parse(lastRestAt);
  if (!Number.isFinite(elapsed) || elapsed >= REST_COOLDOWN_MS) return 0;
  return Math.ceil((REST_COOLDOWN_MS - elapsed) / 1000);
}

// world_state timestamps written by SQLite datetime('now') carry no timezone;
// treat them as UTC, matching the server-side comparison.
function parseDbTime(value) {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function describeError(data) {
  const code = data?.error;
  if (code === 'rest_cooldown') {
    return t('ui.location.rest.cooldown', { sec: data.remainingSec });
  }
  if (code === 'full_hp') return t('ui.location.rest.full_hp');
  if (code === 'not_in_city' || code === 'not_enough_money' || code === 'no_medkit') {
    return t(`ui.location.error.${code}`);
  }
  // Stage 8: begging errors.
  if (code === 'not_eligible' || code === 'already_begged') {
    return t(`ui.npc.beggar.${code}`);
  }
  return t('ui.error.data');
}

// Stage 8: NPC dialog modal — line plus an optional rumor.
async function openNpcDialog(npcId, errorEl) {
  const { status, data } = await getNpc(npcId, getLang());
  if (status !== 200 || !data?.npc) {
    errorEl.textContent = t('ui.error.data');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'npc-dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'npc-dialog';

  const titleEl = document.createElement('h3');
  titleEl.textContent = t('ui.npc.dialog_title', { name: t(data.npc.nameKey) });
  const lineEl = document.createElement('p');
  lineEl.className = 'npc-dialog-line';
  lineEl.textContent = data.npc.line;
  dialog.append(titleEl, lineEl);
  if (data.npc.rumor) {
    const rumorEl = document.createElement('p');
    rumorEl.className = 'npc-rumor';
    rumorEl.textContent = `${t('ui.npc.rumor')} ${data.npc.rumor}`;
    dialog.append(rumorEl);
  }
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-secondary';
  closeBtn.textContent = t('ui.inventory.button.close');
  closeBtn.addEventListener('click', () => overlay.remove());
  dialog.append(closeBtn);
  overlay.append(dialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

// options: { onMap(), onCharacter(), onTraveled(travelResult) }
export function renderLocation(root, locationId, options) {
  const wrap = document.createElement('div');
  wrap.className = 'location-screen';

  const head = document.createElement('div');
  head.className = 'location-head';
  const title = document.createElement('h2');
  title.className = 'location-title';
  const buttons = document.createElement('div');
  buttons.className = 'screen-buttons';
  const mapBtn = document.createElement('button');
  mapBtn.className = 'btn btn-secondary';
  mapBtn.textContent = t('ui.location.button.map');
  mapBtn.addEventListener('click', () => options.onMap());
  const charBtn = document.createElement('button');
  charBtn.className = 'btn btn-secondary';
  charBtn.textContent = t('ui.location.button.character');
  charBtn.addEventListener('click', () => options.onCharacter());
  buttons.append(mapBtn, charBtn);
  head.append(title, buttons);

  const body = document.createElement('div');
  body.append(head);

  const errorEl = document.createElement('p');
  errorEl.className = 'inline-error';
  const messageEl = document.createElement('p');
  messageEl.className = 'location-action-message';
  const actionsEl = document.createElement('div');
  actionsEl.className = 'panel location-actions';

  const progressEl = document.createElement('div');
  progressEl.className = 'travel-progress';

  wrap.append(body, errorEl, progressEl);
  root.replaceChildren(wrap);

  let currentLoc = null;
  let character = null;
  let inventory = [];
  let busy = false;

  function makeButton(text, disabled, onClick) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = text;
    btn.disabled = disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderActions() {
    actionsEl.replaceChildren();
    if (!currentLoc || !character) return;

    const sectionTitle = document.createElement('h3');
    sectionTitle.textContent = t('ui.location.actions');
    actionsEl.append(sectionTitle);

    const hpPct = character.hp_max > 0
      ? Math.round((character.hp_current / character.hp_max) * 100)
      : 0;
    const status = document.createElement('div');
    status.innerHTML = `
      <div class="hp-bar"><div class="hp-bar-fill" style="width:${hpPct}%"></div>
        <span class="bar-label">${t('ui.character.hp', { cur: character.hp_current, max: character.hp_max })}</span>
      </div>
      <p class="location-meta">${t('ui.character.money', { money: character.money })}</p>
    `;
    actionsEl.append(status);

    const fullHp = character.hp_current >= character.hp_max;

    if (currentLoc.type === 'city') {
      const remainingSec = cooldownRemainingSec(character.last_rest_at);
      let restText = t('ui.location.button.rest');
      if (fullHp) restText = t('ui.location.rest.full_hp');
      else if (remainingSec > 0) restText = t('ui.location.rest.cooldown', { sec: remainingSec });
      const restBtn = makeButton(restText, busy || fullHp || remainingSec > 0, () =>
        runAction(rest, () => {
          messageEl.textContent = t('ui.location.rest_done');
        }),
      );
      actionsEl.append(restBtn);

      const healCost = Math.max(5, character.hp_max - character.hp_current);
      const healBtn = makeButton(
        t('ui.location.button.heal', { cost: healCost }),
        busy || fullHp || character.money < healCost,
        () => {
          const healed = character.hp_max - character.hp_current;
          return runAction(heal, () => {
            messageEl.textContent = t('ui.location.healed', { hp: healed });
          });
        },
      );
      if (!fullHp && character.money < healCost) {
        healBtn.title = t('ui.location.error.not_enough_money');
      }
      actionsEl.append(healBtn);

      // Stage 8: shop entry point.
      if (currentLoc.shopId) {
        actionsEl.append(
          makeButton(t('ui.location.button.shop'), busy, () =>
            options.onShop(currentLoc.shopId),
          ),
        );
      }

      // Stage 8: begging is offered only when truly desperate.
      const beggarEligible =
        character.money < 20 && character.hp_current < character.hp_max * 0.3;
      if (beggarEligible && currentLoc.npcIds?.length > 0) {
        actionsEl.append(
          makeButton(t('ui.location.button.beggar'), busy, () =>
            runAction(() => beggar(currentLoc.npcIds[0]), (data) => {
              messageEl.textContent = t('ui.npc.beggar.received', {
                money: data.received.money,
                hp: data.received.hp,
              });
            }),
          ),
        );
      }
    }

    if (!fullHp) {
      const healers = inventory.filter(
        (row) => row.item?.type === 'consumable' && (row.item.effect?.heal ?? 0) > 0,
      );
      const healerCount = healers.reduce((sum, row) => sum + row.qty, 0);
      let medkitText = t('ui.location.error.no_medkit');
      if (healerCount > 0) {
        medkitText = `${t('ui.location.button.use_medkit')} ×${healerCount}`;
      }
      const medkitBtn = makeButton(medkitText, busy || healerCount === 0, () =>
        runAction(() => useItem(healers[0].inventoryId), (data) => {
          inventory = data.inventory ?? inventory;
          messageEl.textContent = t('ui.location.healed', { hp: data.healed });
        }),
      );
      actionsEl.append(medkitBtn);
    }
  }

  async function runAction(request, onSuccess) {
    if (busy) return;
    busy = true;
    errorEl.textContent = '';
    messageEl.textContent = '';
    renderActions();

    let status = 0;
    let data = null;
    try {
      ({ status, data } = await request());
    } catch (err) {
      console.error(err);
    }
    busy = false;
    if (status === 200 && data) {
      character = data.character ?? character;
      onSuccess(data);
    } else {
      errorEl.textContent = describeError(data);
    }
    renderActions();
  }

  (async () => {
    const [{ status, data: loc }, worldRes, charRes, invRes] = await Promise.all([
      getLocation(locationId),
      getWorld(),
      getCharacter(),
      getInventory(),
    ]);
    if (status !== 200) {
      // Not visible / unknown — fall back to the map.
      options.onMap();
      return;
    }
    const currentId = worldRes.status === 200 ? worldRes.data.current : null;
    const canTravelFrom = loc.isCurrent && currentId === loc.id;

    currentLoc = loc;
    if (charRes.status === 200) character = charRes.data.character;
    if (invRes.status === 200) inventory = invRes.data.items ?? [];

    title.textContent = `${t(loc.nameKey)}${loc.isCurrent ? ` — ${t('ui.location.current')}` : ''}`;

    const meta = document.createElement('p');
    meta.className = 'location-meta';
    meta.textContent = `${t(`ui.location.type.${loc.type}`)} · ${t('ui.location.danger', { level: loc.dangerLevel })}`;

    // Stage 7: respawn status is shown for non-city locations.
    const respawnEl = document.createElement('p');
    respawnEl.className = 'location-meta';
    if (loc.type !== 'city') {
      const respawnAt = loc.respawnAt ? parseDbTime(loc.respawnAt) : 0;
      if (respawnAt > Date.now()) {
        const min = Math.ceil((respawnAt - Date.now()) / 60_000);
        respawnEl.textContent = t('ui.location.respawn_wait', { min });
      } else {
        respawnEl.textContent = t('ui.location.respawn_ready');
      }
    }

    const desc = document.createElement('p');
    desc.className = 'location-desc';
    desc.textContent = t(loc.descriptionKey);

    const ambient = document.createElement('div');
    ambient.className = 'location-ambient';
    for (const key of loc.ambientKeys) {
      const line = document.createElement('p');
      line.textContent = t(key);
      ambient.append(line);
    }

    // Stage 8: named NPCs of the location; a click opens the dialog modal.
    const npcList = document.createElement('div');
    npcList.className = 'npc-list';
    for (const npcId of loc.npcIds ?? []) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary npc-item';
      btn.textContent = `💬 ${t(`npc.${npcId}.name`)}`;
      btn.addEventListener('click', () => {
        errorEl.textContent = '';
        openNpcDialog(npcId, errorEl);
      });
      npcList.append(btn);
    }

    const connTitle = document.createElement('h3');
    connTitle.className = 'location-connections-title';
    connTitle.textContent = t('ui.location.connections');

    const connList = document.createElement('div');
    connList.className = 'location-connections';
    let traveling = false;
    for (const conn of loc.connections) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary connection-btn';
      btn.textContent = `${TYPE_ICONS[conn.locationType] ?? '❓'} ${t(conn.nameKey)}`;
      btn.addEventListener('click', async () => {
        if (traveling) return;
        errorEl.textContent = '';
        if (!canTravelFrom) {
          // Not standing here — traveling is impossible, go look at the map.
          options.onMap();
          return;
        }
        traveling = true;
        const result = await travelWithProgress(
          progressEl,
          conn.to,
          t(conn.nameKey),
          TRAVEL_TIME_MS[conn.type] ?? TRAVEL_TIME_MS.plain,
        );
        traveling = false;
        if (result.status === 200) {
          options.onTraveled(result.data);
        } else {
          const code = result.data?.error ?? 'unknown_location';
          errorEl.textContent = t(`ui.map.error.${code}`);
        }
      });
      connList.append(btn);
    }

    body.append(meta);
    if (loc.type !== 'city') body.append(respawnEl);
    body.append(desc, ambient, actionsEl, messageEl);
    if (npcList.children.length > 0) body.append(npcList);
    body.append(connTitle, connList);
    renderActions();
  })();
}
