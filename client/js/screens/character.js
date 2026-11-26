// Character screen (stage 2): stats, HP/AP, money, location. Display only.

import { t } from '../i18n.js';
import { getInventory } from '../api.js';

const SLOT_ORDER = ['weapon', 'head', 'torso', 'jacket', 'legs', 'boots'];

// Portrait placeholder: SVG silhouette with jacket #6b4e35.
const PORTRAIT_SVG = `
<svg class="char-portrait" viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
  <rect width="120" height="140" fill="#1a1614"/>
  <circle cx="60" cy="42" r="20" fill="#3a322c"/>
  <path d="M20 140 L28 92 Q60 70 92 92 L100 140 Z" fill="#6b4e35"/>
  <path d="M20 140 L28 92 Q60 70 92 92 L100 140 Z" fill="none" stroke="#3a322c" stroke-width="2"/>
</svg>`;

function statRow(key, value) {
  return `
    <div class="stat-row">
      <span class="stat-name" data-i18n="ui.stat.${key}">${t(`ui.stat.${key}`)}</span>
      <span class="stat-value">${value}</span>
    </div>`;
}

// Stage 9: weapon skills (5 categories), display only — no spending buttons.
function weaponSkillsPanel(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const rows = skills
    .map(
      (s) => `
      <div class="stat-row">
        <span class="stat-name">${t(`ui.weapon_category.${s.weaponCategory}`)}</span>
        <span class="stat-value">${t('ui.character.weapon_skill.row', { category: t(`ui.weapon_category.${s.weaponCategory}`), skill: s.skill, hits: s.hits })}</span>
      </div>`,
    )
    .join('');
  return `
    <div class="panel char-weapon-skills">
      <p class="equip-title">${t('ui.character.weapon_skills')}</p>
      ${rows}
    </div>`;
}

export function renderCharacter(root, character, options = {}) {
  const hpPct = character.hp_max > 0
    ? Math.round((character.hp_current / character.hp_max) * 100)
    : 0;
  const xpNext = 600 * character.level;
  const locationName = t(`location.${character.location_id}.name`);

  const el = document.createElement('div');
  el.className = 'char-sheet';
  el.innerHTML = `
    <div class="char-head">
      ${PORTRAIT_SVG}
      <div>
        <h2 class="char-name">${character.name}</h2>
        <p>${t('ui.character.level', { level: character.level })}</p>
        <p>${t('ui.character.xp', { xp: character.xp, next: xpNext })}</p>
        <p title="${t('ui.character.money_tooltip')}">🪖 ${t('ui.character.money', { money: character.money })}</p>
        <p>${t('ui.character.location', { name: locationName })}</p>
        ${character.perk_points > 0
          ? `<p>${t('ui.character.perk_points', { n: character.perk_points })}
               <span class="muted">— ${t('ui.character.perk_points_note')}</span></p>`
          : ''}
      </div>
    </div>
    <div class="panel">
      <div class="hp-bar"><div class="hp-bar-fill" style="width:${hpPct}%"></div>
        <span class="bar-label">${t('ui.character.hp', { cur: character.hp_current, max: character.hp_max })}</span>
      </div>
      <div class="ap-bar"><div class="ap-bar-fill" style="width:100%"></div>
        <span class="bar-label">${t('ui.character.ap', { cur: character.ap_max, max: character.ap_max })}</span>
      </div>
    </div>
    <div class="panel char-stats">
      ${statRow('str', character.str)}
      ${statRow('agi', character.agi)}
      ${statRow('int', character.int)}
      ${statRow('end', character.end)}
      ${statRow('per', character.per)}
      ${statRow('intel', character.intel)}
    </div>
    ${weaponSkillsPanel(character.weaponSkills)}
  `;
  if (options.onOpenMap || options.onOpenInventory || options.onTestBattle) {
    const nav = document.createElement('div');
    nav.className = 'screen-buttons';
    // Dev-only button (stage 5c); removed in stage 6.
    if (options.onTestBattle) {
      const battleBtn = document.createElement('button');
      battleBtn.className = 'btn btn-danger';
      battleBtn.textContent = t('ui.battle.test.start');
      battleBtn.addEventListener('click', () => options.onTestBattle());
      nav.append(battleBtn);
    }
    if (options.onOpenInventory) {
      const invBtn = document.createElement('button');
      invBtn.className = 'btn btn-secondary';
      invBtn.textContent = t('ui.inventory.title');
      invBtn.addEventListener('click', () => options.onOpenInventory());
      nav.append(invBtn);
    }
    if (options.onOpenMap) {
      const mapBtn = document.createElement('button');
      mapBtn.className = 'btn btn-secondary';
      mapBtn.textContent = t('ui.location.button.map');
      mapBtn.addEventListener('click', () => options.onOpenMap());
      nav.append(mapBtn);
    }
    el.append(nav);
  }

  // Equipment block (loaded async — inventory may not exist yet).
  const equipPanel = document.createElement('div');
  equipPanel.className = 'panel char-equipment';
  el.append(equipPanel);
  (async () => {
    const { status, data } = await getInventory();
    if (status !== 200) return;
    equipPanel.replaceChildren();
    const title = document.createElement('p');
    title.className = 'equip-title';
    title.textContent = t('ui.inventory.slot.title');
    equipPanel.append(title);
    for (const slot of SLOT_ORDER) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const name = document.createElement('span');
      name.className = 'stat-name';
      name.textContent = t(`ui.inventory.slot.${slot}`);
      const value = document.createElement('span');
      value.className = 'stat-value';
      const eq = data.equipped[slot];
      const entry = eq ? data.items.find((i) => i.inventoryId === eq.inventoryId) : null;
      value.textContent = entry ? `${entry.item.icon} ${t(entry.item.nameKey)}` : t('ui.inventory.slot.empty');
      row.append(name, value);
      equipPanel.append(row);
    }
  })();
  root.replaceChildren(el);
}
