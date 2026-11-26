// fetch wrapper for the server API.

export async function getHealth() {
  const res = await fetch('/health');
  if (!res.ok) throw new Error(`GET /health: ${res.status}`);
  return res.json();
}

export async function getDictionary(lang) {
  const res = await fetch(`/api/i18n/${lang}`);
  if (!res.ok) throw new Error(`GET /api/i18n/${lang}: ${res.status}`);
  return res.json();
}

// Returns { status, data } — the status distinguishes 404 from network errors.
export async function getCharacter() {
  const res = await fetch('/api/character');
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function createCharacter(name) {
  const res = await fetch('/api/character', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Stage 06b-fix: out-of-battle recovery.
export async function rest() {
  const res = await fetch('/api/character/rest', { method: 'POST' });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function heal() {
  const res = await fetch('/api/character/heal', { method: 'POST' });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Returns { status, data } — the status distinguishes 403/404 from errors.
export async function getWorld() {
  const res = await fetch('/api/world');
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function getLocation(id) {
  const res = await fetch(`/api/location/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function travel(to, lang) {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const res = await fetch(`/api/travel${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, lang }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Returns { status, data } — status 404 when the battle does not exist.
export async function getBattle(id) {
  const res = await fetch(`/api/battle/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function getActiveBattle() {
  const res = await fetch('/api/battle/active');
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function startBattle(mobIds) {
  const res = await fetch('/api/battle/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobIds }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Stage 5d: battle actions and highlight sets.
export async function postBattleAction(id, action, lang) {
  const res = await fetch(`/api/battle/${encodeURIComponent(id)}/action?lang=${encodeURIComponent(lang)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, lang }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function getBattleHighlight(id, action) {
  const res = await fetch(
    `/api/battle/${encodeURIComponent(id)}/highlight?action=${encodeURIComponent(action)}`,
  );
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Stage 5d-fix: leave the battle without resolving it (no HP/XP/loot).
export async function postBattleAbandon(id, lang) {
  const res = await fetch(`/api/battle/${encodeURIComponent(id)}/abandon?lang=${encodeURIComponent(lang)}`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function getInventory() {
  const res = await fetch('/api/inventory');
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function equipItem(inventoryId) {
  const res = await fetch('/api/inventory/equip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inventoryId }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function unequipItem(inventoryId) {
  const res = await fetch('/api/inventory/unequip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inventoryId }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function useItem(inventoryId) {
  const res = await fetch('/api/inventory/use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inventoryId }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Stage 8: shops and NPCs.
export async function getShop(shopId) {
  const res = await fetch(`/api/shop/${encodeURIComponent(shopId)}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function buyItem(shopId, itemId, qty = 1) {
  const res = await fetch(`/api/shop/${encodeURIComponent(shopId)}/buy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, qty }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function sellItem(shopId, inventoryId) {
  const res = await fetch(`/api/shop/${encodeURIComponent(shopId)}/sell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inventoryId }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function getNpc(npcId, lang) {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const res = await fetch(`/api/npc/${encodeURIComponent(npcId)}${query}`);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function beggar(npcId) {
  const res = await fetch(`/api/npc/${encodeURIComponent(npcId)}/beggar`, {
    method: 'POST',
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

