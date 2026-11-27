// Stage 4b: inventory screen — equipment slots, item grid, detail panel.

import { getInventory, equipItem, unequipItem } from '../api.js';
import { t } from '../i18n.js';
import { itemIcon } from '../icons.js';

const RARITY_COLORS = {
  common: '#d4c9b8',
  uncommon: '#5a8ba8',
  rare: '#c9a227',
  epic: '#a83232',
};

const SLOT_ORDER = ['weapon', 'head', 'torso', 'jacket', 'legs', 'boots'];

function requirementLines(item) {
  const req = item.requirements ?? {};
  const keys = ['level', 'str', 'agi', 'int', 'end', 'per', 'intel'];
  const lines = [];
  for (const key of keys) {
    if (req[key] !== undefined) {
      lines.push(`${t(`ui.stat.${key}`)}: ${req[key]}`);
    }
  }
  return lines;
}

function missingText(missing) {
  const parts = [];
  for (const [key, value] of Object.entries(missing)) {
    if (value && typeof value === 'object') {
      parts.push(`${t(`ui.stat.${key}`)} ${value.need} (${t('ui.inventory.have', { have: value.have })})`);
    }
  }
  return parts.join(', ');
}

function detailStatLines(item) {
  const lines = [];
  if (item.type === 'weapon') {
    lines.push(t('ui.inventory.detail.damage', { min: item.damage.min, max: item.damage.max }));
    lines.push(t('ui.inventory.detail.range', { r: item.range }));
    lines.push(t('ui.inventory.detail.pen', { pen: item.pen }));
    lines.push(t('ui.inventory.detail.ap', { ap: item.apCost }));
  }
  if (item.type === 'armor') {
    lines.push(
      t('ui.inventory.detail.armor', {
        head: item.armor.head,
        torso: item.armor.torso,
        arms: item.armor.arms,
        legs: item.armor.legs,
      }),
    );
  }
  lines.push(t('ui.inventory.detail.weight', { w: item.weight }));
  return lines;
}

// options: { onCharacter() }
export function renderInventory(root, options) {
  const wrap = document.createElement('div');
  wrap.className = 'inventory-screen';

  const head = document.createElement('div');
  head.className = 'inventory-head';
  const title = document.createElement('h2');
  title.className = 'inventory-title';
  title.textContent = t('ui.inventory.title');
  const buttons = document.createElement('div');
  buttons.className = 'screen-buttons';
  const charBtn = document.createElement('button');
  charBtn.className = 'btn btn-secondary';
  charBtn.textContent = t('ui.inventory.button.character');
  charBtn.addEventListener('click', () => options.onCharacter());
  buttons.append(charBtn);
  head.append(title, buttons);

  const errorEl = document.createElement('p');
  errorEl.className = 'inline-error';

  const layout = document.createElement('div');
  layout.className = 'inventory-layout';

  const left = document.createElement('div');
  const slotsEl = document.createElement('div');
  slotsEl.className = 'equip-slots';
  const grid = document.createElement('div');
  grid.className = 'inv-grid';
  left.append(slotsEl, grid);

  const detailEl = document.createElement('div');
  detailEl.className = 'inv-detail';
  layout.append(left, detailEl);

  wrap.append(head, errorEl, layout);
  root.replaceChildren(wrap);

  let state = null;

  function itemByInventoryId(id) {
    return state?.items.find((i) => i.inventoryId === id) ?? null;
  }

  function renderDetail(entry) {
    detailEl.replaceChildren();
    if (!entry) return;
    const { item } = entry;
    const h = document.createElement('h3');
    h.textContent = t(item.nameKey);
    h.style.color = RARITY_COLORS[item.rarity] ?? RARITY_COLORS.common;

    const desc = document.createElement('p');
    desc.textContent = t(item.descriptionKey);

    const reqs = requirementLines(item);
    if (reqs.length > 0) {
      const reqTitle = document.createElement('p');
      reqTitle.className = 'inv-detail-label';
      reqTitle.textContent = t('ui.inventory.detail.requirements');
      detailEl.append(reqTitle);
      for (const line of reqs) {
        const p = document.createElement('p');
        p.textContent = line;
        detailEl.append(p);
      }
    }

    for (const line of detailStatLines(item)) {
      const p = document.createElement('p');
      p.className = 'inv-detail-stat';
      p.textContent = line;
      detailEl.append(p);
    }

    const isEquipped = entry.equippedSlot !== null;
    const isEquippable = item.type === 'weapon' || item.type === 'armor';
    const equipBtn = document.createElement('button');
    equipBtn.className = 'btn';
    equipBtn.textContent = isEquipped
      ? t('ui.inventory.button.unequip')
      : t('ui.inventory.button.equip');
    if (!isEquipped && !isEquippable) {
      equipBtn.disabled = true;
      equipBtn.title = t('ui.inventory.error.not_equippable');
    }
    equipBtn.addEventListener('click', async () => {
      errorEl.textContent = '';
      const res = isEquipped
        ? await unequipItem(entry.inventoryId)
        : await equipItem(entry.inventoryId);
      if (res.status === 200) {
        state = {
          ...state,
          equipped: res.data.equipped,
          items: res.data.inventory,
        };
        renderAll();
      } else {
        const code = res.data?.error ?? 'not_found';
        if (code === 'requirements_not_met') {
          errorEl.textContent = t('ui.inventory.error.requirements_not_met', {
            missing: missingText(res.data.missing ?? {}),
          });
        } else {
          errorEl.textContent = t(`ui.inventory.error.${code}`);
        }
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-secondary';
    closeBtn.textContent = t('ui.inventory.button.close');
    closeBtn.addEventListener('click', () => {
      detailEl.replaceChildren();
      renderAll();
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'screen-buttons';
    btnRow.append(equipBtn, closeBtn);
    detailEl.prepend(h, desc);
    detailEl.append(btnRow);
  }

  function renderAll() {
    // Equipment slots panel.
    slotsEl.replaceChildren();
    for (const slot of SLOT_ORDER) {
      const cell = document.createElement('div');
      cell.className = 'equip-slot';
      const label = document.createElement('span');
      label.className = 'equip-slot-label';
      label.textContent = t(`ui.inventory.slot.${slot}`);
      cell.append(label);
      const eq = state.equipped[slot];
      if (eq) {
        const entry = itemByInventoryId(eq.inventoryId);
        if (entry) {
          const icon = itemIcon(entry.item, '❓', 'equip-slot-icon item-icon');
          const name = document.createElement('span');
          name.className = 'equip-slot-name';
          name.textContent = t(entry.item.nameKey);
          cell.append(icon, name);
          cell.addEventListener('click', () => renderDetail(entry));
        }
      } else {
        cell.classList.add('empty');
        const empty = document.createElement('span');
        empty.className = 'equip-slot-empty';
        empty.textContent = t('ui.inventory.slot.empty');
        cell.append(empty);
      }
      slotsEl.append(cell);
    }

    // Items grid.
    grid.replaceChildren();
    if (state.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'inv-empty';
      empty.textContent = t('ui.inventory.empty');
      grid.append(empty);
      return;
    }
    for (const entry of state.items) {
      const card = document.createElement('div');
      card.className = 'inv-item';
      if (entry.equippedSlot) card.classList.add('equipped');
      const icon = itemIcon(entry.item, '❓', 'inv-item-icon item-icon');
      const name = document.createElement('span');
      name.className = 'inv-item-name';
      name.textContent = t(entry.item?.nameKey ?? entry.itemId);
      name.style.color = RARITY_COLORS[entry.item?.rarity] ?? RARITY_COLORS.common;
      card.append(icon, name);
      if (entry.qty > 1) {
        const qty = document.createElement('span');
        qty.className = 'inv-item-qty';
        qty.textContent = `×${entry.qty}`;
        card.append(qty);
      }
      card.addEventListener('click', () => renderDetail(entry));
      grid.append(card);
    }

    const capacity = document.createElement('p');
    capacity.className = 'inv-capacity';
    capacity.textContent = t('ui.inventory.capacity', {
      used: state.capacity.usedSlots,
      max: state.capacity.maxSlots,
    });
    grid.append(capacity);
  }

  (async () => {
    const { status, data } = await getInventory();
    if (status !== 200) {
      errorEl.textContent = t('ui.error.data');
      return;
    }
    state = data;
    renderAll();
  })();
}
