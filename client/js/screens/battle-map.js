// Stage 6b: battle screen — WebSocket actions, delta log, animations, sound
// and the full result overlay.

import { t, getLang } from '../i18n.js';
import { audio } from '../audio.js';
import {
  getBattle,
  getBattleHighlight,
  getCharacter,
  getInventory,
  getWorld,
  postBattleAbandon,
} from '../api.js';
import { hexRender } from '../battle/hex-render.js';
import { buildPath } from '../battle/hex.js';
import { showBattleResult } from './battle-result.js';

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECTS = 5;
const ACTION_TIMEOUT_MS = 10_000;
// Let the last hit / death animation and HP bar transition play before the
// full-screen result overlay covers the map.
const RESULT_DELAY_MS = 900;
const LOG_LIMIT = 20;
const POSITION_ICON = { stand: '🧍', crouch: '🧎', run: '🏃', cover: '🛡️' };
const STANCE_CYCLE = ['stand', 'crouch', 'cover', 'run'];
const ZONES = ['head', 'torso', 'arms', 'legs'];

function participantName(p) {
  return p.kind === 'player' ? (p.characterName ?? p.id) : t(p.mobNameKey ?? '');
}

function hpClass(hp, hpMax) {
  const ratio = hpMax > 0 ? hp / hpMax : 0;
  if (ratio > 0.5) return 'hp-high';
  if (ratio >= 0.25) return 'hp-mid';
  return 'hp-low';
}

function restartClass(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.getBoundingClientRect();
  element.classList.add(className);
  element.addEventListener('animationend', () => element.classList.remove(className), {
    once: true,
  });
}

function renderParticipants(listEl, participants) {
  // Reuse rows across redraws so the CSS width/color transition on the HP bar
  // actually runs instead of being replaced by a brand-new element.
  const existing = new Map(
    [...listEl.querySelectorAll('[data-participant-id]')].map((row) => [row.dataset.participantId, row]),
  );
  for (const p of participants) {
    let row = existing.get(p.id);
    if (row) {
      existing.delete(p.id);
    } else {
      row = document.createElement('div');
      row.dataset.participantId = p.id;

      const name = document.createElement('span');
      name.className = 'battle-participant-name';
      const pose = document.createElement('span');
      pose.className = 'battle-participant-pose';
      const text = document.createElement('span');
      text.className = 'battle-participant-text';
      name.append(pose, text);

      const bar = document.createElement('div');
      bar.className = 'hp-bar battle-hp-bar';
      const fill = document.createElement('div');
      fill.className = 'hp-bar-fill';
      const label = document.createElement('span');
      label.className = 'bar-label';
      bar.append(fill, label);

      row.append(name, bar);
      listEl.append(row);
    }

    row.className = `battle-participant${p.hp <= 0 ? ' dead' : ''}`;
    row.querySelector('.battle-participant-pose').textContent = POSITION_ICON[p.position] ?? '';
    row.querySelector('.battle-participant-text').textContent = participantName(p);

    const bar = row.querySelector('.battle-hp-bar');
    bar.className = `hp-bar battle-hp-bar ${hpClass(p.hp, p.hpMax)}`;
    bar.querySelector('.hp-bar-fill').style.width = `${
      p.hpMax > 0 ? Math.round((p.hp / p.hpMax) * 100) : 0
    }%`;
    bar.querySelector('.bar-label').textContent = `${p.hp} / ${p.hpMax}`;
  }
  for (const stale of existing.values()) stale.remove();
}

function parseDamage(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== 'hit' && entry.type !== 'crit') continue;
    const match = entry.text?.match(/(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function targetOfEntry(entry, participants) {
  const text = entry?.text ?? '';
  const named = participants.find(
    (p) => p.kind === 'mob' && participantName(p) && text.includes(participantName(p)),
  );
  if (named) return named;
  if (entry?.actor !== 'player') return participants.find((p) => p.kind === 'player');
  return participants.find((p) => p.kind === 'mob' && p.hp > 0);
}

// Compare the last rendered state with the broadcast one. Only fresh log
// entries and HP/position deltas produce effects, so reconnects stay silent.
function detectEffects(previous, next) {
  const effects = {
    hits: [],
    misses: [],
    deaths: [],
    heals: [],
    stances: [],
    reload: false,
  };
  if (!previous) return effects;
  const fresh = next.log.slice(previous.log.length);
  const before = new Map(previous.participants.map((p) => [p.id, p]));
  const combatEntries = fresh.filter((e) => e.type === 'hit' || e.type === 'crit');

  for (const p of next.participants) {
    const old = before.get(p.id);
    if (!old) continue;
    if (p.hp < old.hp) {
      const crit = fresh.some(
        (e) =>
          e.type === 'crit' &&
          (e.actor === p.id ||
            (p.kind === 'player' ? e.actor !== 'player' : e.text?.includes(participantName(p)))),
      );
      effects.hits.push({ participant: p, crit, damage: parseDamage(combatEntries) });
    }
    if (old.hp > 0 && p.hp <= 0) effects.deaths.push(p);
    if (p.hp > old.hp) effects.heals.push(p);
    if (p.kind === 'player' && p.position !== old.position) effects.stances.push(p);
  }
  for (const entry of fresh) {
    if (entry.type !== 'miss') continue;
    const target = targetOfEntry(entry, next.participants);
    if (target) effects.misses.push(target);
  }
  const oldPlayer = before.get('player') ?? previous.participants.find((p) => p.kind === 'player');
  const player = next.participants.find((p) => p.kind === 'player');
  if (oldPlayer && player && player.weaponCharges > oldPlayer.weaponCharges) {
    effects.reload = true;
  }
  return effects;
}

// Delta log rendering (stage 5d-fix): polling must not reset the scroll
// position. Entries carry no numeric id, so the append point is tracked by the
// number of entries already rendered.
function makeLogLine(entry, names) {
  const line = document.createElement('p');
  line.className = `battle-log-entry battle-log-${entry.type}`;
  const actorName =
    entry.actor !== 'player' && entry.actor !== 'system' ? names.get(entry.actor) : null;
  const text = actorName
    ? t('ui.battle.log.actor_mob', { mob: actorName, text: entry.text })
    : entry.text;
  line.textContent = `[${entry.round}] ${text}`;
  return line;
}

function renderLog(logEl, logButton, log, participants, view) {
  const names = new Map((participants ?? []).map((p) => [p.id, participantName(p)]));

  // A shorter log means the view belongs to another battle: start over.
  if (log.length < view.lastLength) {
    logEl.replaceChildren();
    view.lastLength = 0;
    view.dirty = false;
  }
  const fresh = log.slice(view.lastLength);
  if (fresh.length === 0) return;

  // Remember the scroll position before touching the DOM.
  const atBottom =
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
  const firstRender = view.lastLength === 0 && logEl.childElementCount === 0;

  const fragment = document.createDocumentFragment();
  for (const entry of fresh) fragment.append(makeLogLine(entry, names));
  logEl.append(fragment);
  view.lastLength = log.length;

  if (atBottom || firstRender) {
    logEl.scrollTop = logEl.scrollHeight;
    view.dirty = false;
  } else {
    view.dirty = true;
  }
  // Keep the DOM bounded when following the tail; while the player is reading
  // older entries, keep everything so nothing shifts under the cursor.
  while (atBottom && logEl.childElementCount > LOG_LIMIT) {
    logEl.firstElementChild?.remove();
  }
  logButton.hidden = !view.dirty;
}

export async function renderBattleMap(container, battleId, options = {}) {
  const el = document.createElement('div');
  el.className = 'battle-screen';
  const buttons = [
    ['move', 'move'],
    ['shoot', 'shoot'],
    ['aim', 'aim'],
    ['stance', 'stance'],
    ['reload', 'reload'],
    ['item', 'item'],
    ['flee', 'flee'],
    ['end_turn', 'end_turn'],
  ];
  el.innerHTML = `
    <div class="battle-head">
      <h2 data-i18n="ui.battle.map.title">${t('ui.battle.map.title')}</h2>
      <p class="battle-round"></p>
      <p class="battle-turn"></p>
      <p class="battle-banner" hidden></p>
      <span class="battle-ws-status offline">
        <span class="battle-ws-dot"></span>
        <span class="battle-ws-label">${t('ui.battle.ws.offline')}</span>
      </span>
      <button class="battle-mute-btn" type="button">🔊</button>
      <button class="btn btn-secondary battle-abandon-btn">${t('ui.battle.button.abandon')}</button>
    </div>
    <div class="battle-layout">
      <div class="battle-map-wrap panel"></div>
      <div class="battle-side">
        <div class="panel">
          <p class="battle-side-title">${t('ui.battle.participants')}</p>
          <div class="battle-participants"></div>
        </div>
        <div class="panel">
          <p class="battle-side-title">${t('ui.battle.log')}</p>
          <div class="battle-log-wrap">
            <div class="battle-log"></div>
            <button class="battle-log-new" hidden>${t('ui.battle.log.new_messages')}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="battle-actions panel">
      <div class="battle-actions-status">
        <span class="battle-ap"></span>
        <span class="battle-position"></span>
        <span class="battle-weapon"></span>
      </div>
      <div class="battle-buttons">
        ${buttons
          .map(
            ([key, action]) =>
              `<button class="btn btn-secondary battle-btn" data-action="${action}" disabled>${t(
                `ui.battle.button.${key}`,
              )}</button>`,
          )
          .join('')}
      </div>
      <p class="battle-hint"></p>
      <div class="battle-zones" hidden>
        ${ZONES.map(
          (zone) =>
            `<button class="btn btn-secondary battle-zone-btn" data-zone="${zone}">${t(
              `ui.battle.zone.${zone}`,
            )}</button>`,
        ).join('')}
        <button class="btn battle-zone-cancel" data-zone="cancel">${t('ui.battle.button.close')}</button>
      </div>
      <div class="battle-items" hidden></div>
      <p class="battle-error" hidden></p>
    </div>
    <div class="battle-modal" hidden>
      <div class="battle-modal-box panel">
        <h3 class="battle-modal-title">${t('ui.battle.abandon.confirm_title')}</h3>
        <p class="battle-modal-text">${t('ui.battle.abandon.confirm_text')}</p>
        <div class="battle-modal-actions">
          <button class="btn btn-secondary battle-abandon-no">${t('ui.battle.abandon.confirm_no')}</button>
          <button class="btn btn-danger battle-abandon-yes">${t('ui.battle.abandon.confirm_yes')}</button>
        </div>
      </div>
    </div>
  `;
  container.replaceChildren(el);

  const roundEl = el.querySelector('.battle-round');
  const turnEl = el.querySelector('.battle-turn');
  const bannerEl = el.querySelector('.battle-banner');
  const mapWrap = el.querySelector('.battle-map-wrap');
  const participantsEl = el.querySelector('.battle-participants');
  const logEl = el.querySelector('.battle-log');
  const apEl = el.querySelector('.battle-ap');
  const positionEl = el.querySelector('.battle-position');
  const weaponEl = el.querySelector('.battle-weapon');
  const hintEl = el.querySelector('.battle-hint');
  const errorEl = el.querySelector('.battle-error');
  const zonesEl = el.querySelector('.battle-zones');
  const itemsEl = el.querySelector('.battle-items');
  const buttonsEl = el.querySelector('.battle-buttons');
  const logButton = el.querySelector('.battle-log-new');
  const abandonBtn = el.querySelector('.battle-abandon-btn');
  const modalEl = el.querySelector('.battle-modal');
  const abandonYes = el.querySelector('.battle-abandon-yes');
  const abandonNo = el.querySelector('.battle-abandon-no');
  const statusEl = el.querySelector('.battle-ws-status');
  const statusLabelEl = el.querySelector('.battle-ws-label');
  const muteBtn = el.querySelector('.battle-mute-btn');

  const ui = {
    state: null,
    mapView: null,
    mode: 'idle', // 'idle' | 'move' | 'shoot'
    selected: null,
    reachable: null,
    los: null,
    pendingTarget: null,
    busy: false,
    rewards: null,
    logView: { lastLength: 0, dirty: false },
  };
  let socket = null;
  let keepalive = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let pendingAction = null;
  let resultHandle = null;
  let resultShown = false;
  let resultTimer = null;

  function setConnectionState(kind, key = `ui.battle.ws.${kind}`) {
    statusEl.className = `battle-ws-status ${kind}`;
    statusLabelEl.textContent = t(key);
  }

  function renderMute() {
    const muted = audio.isMuted();
    muteBtn.textContent = muted ? '🔇' : '🔊';
    const title = t(muted ? 'ui.battle.mute.off' : 'ui.battle.mute.on');
    muteBtn.title = title;
    muteBtn.setAttribute('aria-label', title);
  }

  // Ends the transport without tearing down the map (the result overlay sits
  // on top of the last battle state).
  function stopSocket() {
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
      socket = null;
    }
    setConnectionState('offline');
  }

  function resolvePending(result) {
    if (!pendingAction) return;
    clearTimeout(pendingAction.timer);
    const pending = pendingAction;
    pendingAction = null;
    pending.resolve(result);
  }

  function disconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (resultTimer !== null) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    stopSocket();
    resolvePending({ ok: false, error: 'offline' });
    resultHandle?.destroy();
    resultHandle = null;
    ui.mapView?.destroy();
    ui.mapView = null;
  }

  function playerOf(state) {
    return state.participants.find((p) => p.kind === 'player');
  }

  function flashHeal(participantId) {
    const row = [...participantsEl.querySelectorAll('[data-participant-id]')].find(
      (node) => node.dataset.participantId === participantId,
    );
    restartClass(row?.querySelector('.battle-hp-bar'), 'hp-heal-flash');
  }

  function flashPose(participantId) {
    const row = [...participantsEl.querySelectorAll('[data-participant-id]')].find(
      (node) => node.dataset.participantId === participantId,
    );
    restartClass(row?.querySelector('.battle-participant-pose'), 'anim-stance-pulse');
  }

  function clearMode() {
    ui.mode = 'idle';
    ui.reachable = null;
    ui.los = null;
    ui.pendingTarget = null;
    zonesEl.hidden = true;
    itemsEl.hidden = true;
  }

  function showError(error) {
    const key = `battle.error.${error || 'invalid_action'}`;
    errorEl.textContent = t(key);
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  function redraw() {
    const state = ui.state;
    if (!state) return;
    const player = playerOf(state);
    const active = state.status === 'active' && state.currentActorId === 'player';

    roundEl.textContent = t('ui.battle.round', { n: state.round });
    if (state.status === 'active') {
      const actor = state.participants.find((p) => p.id === state.currentActorId);
      turnEl.textContent =
        state.currentActorId === 'player'
          ? t('ui.battle.turn.player', { round: state.round })
          : t('ui.battle.turn.mob', { mob: actor ? participantName(actor) : '' });
    } else {
      turnEl.textContent = '';
    }
    const bannerKey =
      state.status === 'victory'
        ? 'battle.log.victory'
        : state.status === 'defeat'
          ? 'battle.log.defeat'
          : state.status === 'fled'
            ? 'battle.log.flee_success'
            : null;
    bannerEl.hidden = bannerKey === null;
    if (bannerKey) bannerEl.textContent = t(bannerKey);

    if (player) {
      apEl.textContent = t('ui.battle.ap', { cur: player.ap, max: player.apMax });
      positionEl.textContent = t(`ui.battle.position.${player.position}`);
      const hasWeapon = player.equipment.weaponId !== null;
      weaponEl.textContent =
        hasWeapon && player.weaponCharges !== undefined
          ? t('ui.battle.weapon_charges', { n: player.weaponCharges })
          : '';
    }

    hintEl.textContent =
      ui.mode === 'move'
        ? t('ui.battle.mode.move')
        : ui.mode === 'shoot'
          ? t('ui.battle.mode.shoot')
          : '';

    // Button availability (server still validates everything).
    const hasWeapon = player && player.equipment.weaponId !== null;
    const hasMagazine = hasWeapon && player.weaponCharges !== undefined;
    const availability = {
      move: active && player.ap > 0,
      shoot: active && hasWeapon && (!hasMagazine || player.weaponCharges > 0) && player.ap >= 8,
      aim: active && player.ap >= 5,
      stance: active,
      reload: active && hasMagazine,
      item: active && player.ap >= 8,
      flee: active && player.position === 'run',
      end_turn: active,
    };
    for (const btn of buttonsEl.querySelectorAll('.battle-btn')) {
      btn.disabled = !availability[btn.dataset.action];
      btn.classList.toggle('active', btn.dataset.action === ui.mode);
    }

    const highlight = {
      selected: ui.selected,
      reachable: ui.reachable ?? undefined,
      los: ui.los ?? undefined,
    };
    if (ui.mapView) {
      ui.mapView.update({
        map: state.map,
        participants: state.participants,
        highlight,
        currentActorId: state.currentActorId,
      });
    } else {
      ui.mapView = hexRender(mapWrap, {
        map: state.map,
        participants: state.participants,
        highlight,
        currentActorId: state.currentActorId,
        onHexClick: handleHexClick,
        onHexHover: () => {
          // Hover outline is handled inside hexRender (no full redraw).
        },
      });
    }
    renderParticipants(participantsEl, state.participants);
    renderLog(logEl, logButton, state.log, state.participants, ui.logView);
    // A finished battle (victory/defeat/fled) still needs a way back to the
    // location: the abandon endpoint only applies to active battles. Use an
    // existing i18n key so the button works on a server started before the fix.
    abandonBtn.hidden = false;
    abandonBtn.textContent = t('ui.battle.button.abandon');
  }

  function applyState(state) {
    const previousStatus = ui.state?.status;
    ui.state = state;
    if (ui.pendingTarget) {
      const target = state.participants.find(
        (p) => p.id === ui.pendingTarget && p.hp > 0,
      );
      if (!target) zonesEl.hidden = true;
    }
    redraw();
    if (state.status !== 'active' && previousStatus === 'active') clearMode();
  }

  function playEffects(effects) {
    for (const hit of effects.hits) {
      ui.mapView?.animateHex(hit.participant.hex, hit.crit ? 'anim-crit' : 'anim-hit');
      if (hit.damage !== null) {
        ui.mapView?.floatingLabel(hit.participant.hex, String(hit.damage), 'damage-number');
      }
      if (hit.crit) {
        ui.mapView?.floatingLabel(hit.participant.hex, t('ui.battle.label.crit'), 'crit-label');
        audio.playCrit();
      } else {
        audio.playHit();
      }
    }
    for (const target of effects.misses) {
      ui.mapView?.animateHex(target.hex, 'anim-miss');
      ui.mapView?.floatingLabel(target.hex, t('ui.battle.label.miss'), 'miss-label');
      audio.playMiss();
    }
    for (const dead of effects.deaths) {
      ui.mapView?.animateHex(dead.hex, 'anim-death');
      audio.playDeath();
    }
    for (const healed of effects.heals) {
      flashHeal(healed.id);
      audio.playHeal();
    }
    for (const changed of effects.stances) {
      ui.mapView?.animateStance(changed.id);
      flashPose(changed.id);
      audio.playStance();
    }
    if (effects.reload) audio.playReload();
  }

  function handleStateMessage(state, animate = true) {
    const effects = animate ? detectEffects(ui.state, state) : null;
    applyState(state);
    if (effects) playEffects(effects);
  }

  async function showFullResult(state, rewards = null, delayMs = 0) {
    if (resultShown || !state || state.status === 'active') return;
    resultShown = true;
    stopSocket();
    clearMode();

    // Fetch result context in parallel with the animation delay.
    const contextPromise = Promise.all([
      getCharacter().catch(() => ({ status: 0, data: null })),
      getWorld().catch(() => ({ status: 0, data: null })),
      getInventory().catch(() => ({ status: 0, data: null })),
    ]).catch(() => []);

    if (delayMs > 0) {
      await new Promise((resolve) => {
        resultTimer = setTimeout(() => {
          resultTimer = null;
          resolve();
        }, delayMs);
      });
    }
    if (!el.isConnected) return;

    const [character, world, inventory] = await contextPromise;
    let returnLocationId = state.context?.locationId;
    let cityName = null;
    let hpMax;
    let items = [];
    const char = character?.data?.character;
    if (char) {
      returnLocationId = char.location_id ?? returnLocationId;
      hpMax = char.hp_max;
      const location = world?.data?.locations?.find((loc) => loc.id === char.location_id);
      cityName = location?.nameKey ? t(location.nameKey) : char.location_id;
    }
    if (inventory?.data?.items) {
      items = inventory.data.items.map((row) => row.item).filter(Boolean);
    }

    resultHandle = showBattleResult(el, {
      result: state.status,
      rewards: rewards ?? ui.rewards ?? {},
      items,
      cityName,
      hpMax,
      onReturn: () => leaveBattle(returnLocationId),
    });
  }

  function sendAction(action) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      errorEl.textContent = t('ui.battle.ws.offline');
      errorEl.hidden = false;
      return Promise.resolve({ ok: false, error: 'offline' });
    }
    if (pendingAction) return Promise.resolve({ ok: false, error: 'busy' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingAction?.timer === timer) {
          pendingAction = null;
          resolve({ ok: false, error: 'offline' });
        }
      }, ACTION_TIMEOUT_MS);
      pendingAction = { resolve, timer };
      socket.send(JSON.stringify({ type: 'action', action, lang: getLang() }));
    });
  }

  async function handleServerMessage(raw) {
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : null;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pong') return;
    if (message.type === 'error') {
      showError(message.error);
      resolvePending({ ok: false, error: message.error });
      return;
    }
    if (message.type === 'end') {
      if (message.rewards) ui.rewards = message.rewards;
      handleStateMessage(message.state, true);
      resolvePending({ ok: true, state: message.state });
      showFullResult(message.state, message.rewards ?? ui.rewards, RESULT_DELAY_MS);
      return;
    }
    if (!message.state) return;
    if (message.rewards) ui.rewards = message.rewards;
    handleStateMessage(message.state, message.type === 'update');
    resolvePending({ ok: true, state: message.state });
    if (message.state.status !== 'active') {
      showFullResult(message.state, ui.rewards, RESULT_DELAY_MS);
    }
  }

  function scheduleReconnect() {
    if (!el.isConnected) return;
    if (reconnectAttempts >= MAX_RECONNECTS) {
      setConnectionState('offline', 'ui.battle.ws.reconnect_failed');
      return;
    }
    reconnectAttempts += 1;
    setConnectionState('offline', 'ui.battle.ws.reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    if (!el.isConnected) return;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws/battle/${encodeURIComponent(
      battleId,
    )}?lang=${encodeURIComponent(getLang())}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    setConnectionState('offline');
    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectAttempts = 0;
      setConnectionState('online');
    };
    ws.onmessage = (event) => handleServerMessage(event.data);
    ws.onclose = async (event) => {
      if (socket !== ws) return;
      socket = null;
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
      resolvePending({ ok: false, error: 'offline' });
      setConnectionState('offline');
      if (event.code === 4000) {
        // A finished battle cannot be joined over WS: load its final state over REST.
        const { status, data } = await getBattle(battleId);
        if (status === 200 && data?.state && el.isConnected) {
          ui.rewards = data.rewards ?? null;
          handleStateMessage(data.state, false);
          showFullResult(data.state, ui.rewards);
        }
        return;
      }
      if (event.code !== 1000) scheduleReconnect();
    };
    keepalive = setInterval(() => {
      if (!el.isConnected) {
        disconnect();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
  }

  async function doAction(action) {
    clearError();
    if (!ui.state || ui.state.status !== 'active') return false;
    // The enemy turn is resolved on the server before the update is broadcast;
    // this hint is visible only during that short round trip.
    if (action.type === 'endTurn') {
      hintEl.textContent = t('ui.battle.enemy_turn');
    }
    const result = await sendAction(action);
    if (result.ok) {
      // handleServerMessage already applied the broadcast state and effects.
      if (result.state && result.state !== ui.state) applyState(result.state);
      clearMode();
      return true;
    }
    showError(result.error ?? 'invalid_action');
    redraw();
    return false;
  }

  async function enterMode(mode) {
    clearError();
    if (ui.mode === mode) {
      clearMode();
      redraw();
      return;
    }
    const { status, data } = await getBattleHighlight(battleId, mode);
    if (status !== 200 || !data) {
      showError('battle_finished');
      return;
    }
    ui.mode = mode;
    ui.pendingTarget = null;
    ui.selected = null;
    zonesEl.hidden = true;
    itemsEl.hidden = true;
    if (mode === 'move') {
      ui.reachable = new Set(data.reachable ?? []);
      ui.los = null;
    } else {
      ui.los = new Set(data.los ?? []);
      ui.reachable = null;
    }
    redraw();
  }

  function handleHexClick(hex) {
    if (!ui.state || ui.busy) return;
    ui.selected = hex;

    if (ui.mode === 'move') {
      const player = playerOf(ui.state);
      const key = `${hex.q},${hex.r}`;
      if (!ui.reachable?.has(key)) {
        showError('not_adjacent');
        redraw();
        return;
      }
      // The server moves one adjacent hex per action: walk the BFS path.
      const path = player ? buildPath(player.hex, hex, ui.reachable) : null;
      if (!path || path.length === 0) {
        showError('not_adjacent');
        redraw();
        return;
      }
      ui.busy = true;
      clearMode();
      (async () => {
        try {
          for (const step of path) {
            const ok = await doAction({ type: 'move', to: step });
            if (!ok) break;
          }
        } finally {
          ui.busy = false;
          redraw();
        }
      })();
      return;
    }

    if (ui.mode === 'shoot') {
      const target = ui.state.participants.find(
        (p) => p.kind === 'mob' && p.hp > 0 && p.hex.q === hex.q && p.hex.r === hex.r,
      );
      if (target) {
        ui.pendingTarget = target.id;
        zonesEl.hidden = false;
        itemsEl.hidden = true;
      }
      redraw();
      return;
    }
    redraw();
  }

  function nextStance(current) {
    const idx = STANCE_CYCLE.indexOf(current);
    return STANCE_CYCLE[(idx + 1) % STANCE_CYCLE.length];
  }

  async function openItems() {
    clearError();
    const player = playerOf(ui.state);
    if (!player) return;
    const { status, data } = await getInventory();
    if (status !== 200 || !data) {
      showError('unknown_item');
      return;
    }
    const usable = data.items.filter(
      (row) =>
        row.item &&
        row.item.type === 'consumable' &&
        ((row.item.effect?.heal ?? 0) > 0 || row.item.effect?.cure),
    );
    itemsEl.replaceChildren();
    const title = document.createElement('p');
    title.className = 'battle-side-title';
    title.textContent = t('ui.battle.items.title');
    itemsEl.append(title);
    if (usable.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = t('ui.battle.items.empty');
      itemsEl.append(empty);
    }
    for (const row of usable) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary battle-item-btn';
      btn.textContent = `${t(row.item.nameKey)} ×${row.qty}`;
      btn.addEventListener('click', () => {
        itemsEl.hidden = true;
        doAction({ type: 'useItem', itemId: row.itemId, inventoryId: row.inventoryId });
      });
      itemsEl.append(btn);
    }
    const close = document.createElement('button');
    close.className = 'btn battle-item-close';
    close.textContent = t('ui.battle.button.close');
    close.addEventListener('click', () => {
      itemsEl.hidden = true;
    });
    itemsEl.append(close);
    itemsEl.hidden = false;
    zonesEl.hidden = true;
  }

  function leaveBattle(locationId) {
    disconnect();
    clearMode();
    options.onAbandoned?.(locationId);
  }

  abandonBtn.addEventListener('click', () => {
    if (!ui.state) return;
    // Already resolved: nothing to abandon, just close the battle screen.
    if (ui.state.status !== 'active') {
      leaveBattle(ui.state.context?.locationId);
      return;
    }
    modalEl.hidden = false;
  });
  abandonNo.addEventListener('click', () => {
    modalEl.hidden = true;
  });
  abandonYes.addEventListener('click', async () => {
    modalEl.hidden = true;
    if (ui.busy) return;
    ui.busy = true;
    clearError();
    const { status, data } = await postBattleAbandon(battleId, getLang());
    ui.busy = false;
    if (status === 200 && data?.state) {
      // Stage 6b: abandoning shows the fled result; the return button exits.
      handleStateMessage(data.state, false);
      showFullResult(data.state, data.rewards);
      return;
    }
    showError(data?.error ?? 'battle_finished');
  });
  logButton.addEventListener('click', () => {
    logEl.scrollTop = logEl.scrollHeight;
    ui.logView.dirty = false;
    logButton.hidden = true;
  });
  muteBtn.addEventListener('click', () => {
    audio.toggleMuted();
    renderMute();
  });

  buttonsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.battle-btn');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const player = playerOf(ui.state);
    switch (action) {
      case 'move':
        enterMode('move');
        break;
      case 'shoot':
        enterMode('shoot');
        break;
      case 'aim':
        doAction({ type: 'aim' });
        break;
      case 'stance':
        doAction({ type: 'setStance', stance: nextStance(player.position) });
        break;
      case 'reload':
        doAction({ type: 'reload' });
        break;
      case 'item':
        openItems();
        break;
      case 'flee':
        doAction({ type: 'flee' });
        break;
      case 'end_turn':
        doAction({ type: 'endTurn' });
        break;
      default:
        break;
    }
  });

  zonesEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    const zone = btn.dataset.zone;
    if (zone === 'cancel') {
      zonesEl.hidden = true;
      ui.pendingTarget = null;
      redraw();
      return;
    }
    if (!ui.pendingTarget) return;
    const targetId = ui.pendingTarget;
    zonesEl.hidden = true;
    doAction({ type: 'shoot', targetId, zone });
  });

  renderMute();
  connect();
}
