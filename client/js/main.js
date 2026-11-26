// Client entry: language + screen routing (create / character / map / location).

import { getHealth, getCharacter, startBattle, getActiveBattle } from './api.js';
import { armAudioOnGesture } from './audio.js';
import { initLang, setLang, t } from './i18n.js';
import { renderCharacterCreate } from './screens/character-create.js';
import { renderCharacter } from './screens/character.js';
import { renderMap } from './screens/map.js';
import { renderLocation } from './screens/location.js';
import { renderInventory } from './screens/inventory.js';
import { renderShop } from './screens/shop.js';
import { renderBattleMap } from './screens/battle-map.js';

const root = document.getElementById('screen-root');

let character = null;
// Current screen: 'create' | 'character' | 'map' | 'location' | 'inventory' | 'battle-map'.
let screen = 'character';
let currentLocationId = null;
let currentBattleId = null;
let currentShopId = null;

function syncUrl() {
  const url = new URL(window.location.href);
  if (screen === 'battle-map' && currentBattleId) {
    url.searchParams.set('battle', currentBattleId);
  } else {
    url.searchParams.delete('battle');
  }
  window.history.replaceState(null, '', url);
}

function go(next, param = null) {
  screen = next;
  currentLocationId = next === 'location' ? param : null;
  currentBattleId = next === 'battle-map' ? param : null;
  currentShopId = next === 'shop' ? param : null;
  syncUrl();
  renderCurrent();
}

// Dev-only test battle (removed in stage 6): starts a fight with pipe_rat,
// or rejoins the already active battle on 409.
async function startTestBattle() {
  const { status, data } = await startBattle(['pipe_rat']);
  if (status === 201) {
    go('battle-map', data.battleId);
    return;
  }
  if (status === 409) {
    const active = await getActiveBattle();
    if (active.status === 200) {
      go('battle-map', active.data.state.id);
      return;
    }
  }
  root.querySelector('.battle-test-error')?.remove();
  const err = document.createElement('p');
  err.className = 'battle-test-error';
  err.textContent = t('ui.battle.error.start');
  root.append(err);
}

function renderCurrent() {
  if (!character) {
    renderCharacterCreate(root, {
      onCreated: (c) => {
        character = c;
        go('character');
      },
    });
    return;
  }
  if (screen === 'map') {
    renderMap(root, {
      onCharacter: () => go('character'),
      onLocation: (id) => go('location', id),
      onTraveled: (result) => {
        character = result.character;
        // Stage 7: an encounter on arrival opens the battle screen.
        if (result.battle) go('battle-map', result.battle.id);
        else go('location', result.toLocationId);
      },
    });
  } else if (screen === 'location' && currentLocationId) {
    renderLocation(root, currentLocationId, {
      onMap: () => go('map'),
      onCharacter: () => go('character'),
      onTraveled: (result) => {
        character = result.character;
        if (result.battle) go('battle-map', result.battle.id);
        else go('location', result.toLocationId);
      },
      onShop: (shopId) => go('shop', shopId),
    });
  } else if (screen === 'shop' && currentShopId) {
    renderShop(root, currentShopId, {
      onBack: () => go('location', character.location_id),
    });
  } else if (screen === 'inventory') {
    renderInventory(root, {
      onCharacter: () => go('character'),
    });
  } else if (screen === 'battle-map' && currentBattleId) {
    renderBattleMap(root, currentBattleId, {
      // Stage 6a: sync changes HP/XP/level/money/location, so the cached
      // character must be reloaded before showing any other screen.
      onAbandoned: async (locationId) => {
        const updated = await loadCharacter().catch(() => null);
        go('location', updated?.location_id ?? locationId);
      },
    });
  } else {
    renderCharacter(root, character, {
      onOpenMap: () => go('map'),
      onOpenInventory: () => go('inventory'),
      onTestBattle: () => startTestBattle(),
    });
  }
}

async function loadCharacter() {
  const { status, data } = await getCharacter();
  if (status === 200) {
    character = data.character;
  } else if (status === 404) {
    character = null;
  } else {
    throw new Error(`GET /api/character: ${status}`);
  }
  return character;
}

async function init() {
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.addEventListener('click', async () => {
      await setLang(btn.dataset.lang);
      renderCurrent(); // language switch re-renders the current screen
    });
  }

  armAudioOnGesture();
  await setLang(initLang());

  try {
    // Sanity-check the server (health is kept for /health diagnostics).
    await getHealth();
    await loadCharacter();
    // Deep link: ?battle=<id> restores the battle map after a page reload.
    const battleParam = new URLSearchParams(window.location.search).get('battle');
    if (character && battleParam) {
      go('battle-map', battleParam);
    } else {
      go(character ? 'character' : 'create');
    }
  } catch (err) {
    console.error(err);
    root.textContent = t('ui.error.data');
  }
}

init();
