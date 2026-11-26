// Stage 6b: full-screen battle result (victory / defeat / fled).
// The death intro is the first phase of the defeat result, not a separate screen.

import { t } from '../i18n.js';
import { audio } from '../audio.js';

const TITLES = {
  victory: 'ui.battle.result.victory_title',
  defeat: 'ui.battle.result.defeat_title',
  fled: 'ui.battle.result.fled_title',
};

const ICONS = { victory: '🏆', defeat: '💀', fled: '🏃' };
const INTRO_DELAY_MS = 1000;
const FADE_MS = 500;

function line(text, className = '') {
  const node = document.createElement('p');
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function lootBlock(rewards, items) {
  const block = document.createElement('div');
  block.className = 'battle-result-section';
  block.append(line(t('ui.battle.result.loot_title'), 'battle-result-loot-title'));

  const loot = rewards?.loot ?? [];
  if (loot.length === 0) {
    block.append(line(t('ui.battle.result.loot_empty')));
    return block;
  }

  const byId = new Map(items.filter(Boolean).map((item) => [item.id, item]));
  for (const reward of loot) {
    const item = byId.get(reward.itemId);
    const row = document.createElement('div');
    row.className = 'battle-result-loot-row';
    const icon = document.createElement('span');
    icon.className = 'battle-result-loot-icon';
    icon.textContent = item?.icon ?? '•';
    const name = document.createElement('span');
    name.textContent = item?.nameKey ? t(item.nameKey) : reward.itemId;
    const qty = document.createElement('span');
    qty.textContent = `×${reward.qty}`;
    row.append(icon, name, qty);
    block.append(row);
  }
  return block;
}

export function showBattleResult(container, params) {
  const {
    result,
    rewards = {},
    items = [],
    cityName,
    hpMax,
    onReturn,
  } = params;
  const overlay = document.createElement('div');
  overlay.className = `battle-result-overlay result-${result}`;
  const card = document.createElement('div');
  card.className = 'battle-result-card panel';

  const icon = document.createElement('div');
  icon.className = 'battle-result-icon';
  icon.textContent = ICONS[result] ?? '';
  const title = document.createElement('h3');
  title.className = 'battle-result-title';
  title.textContent = t(TITLES[result]);
  card.append(icon, title);

  if (result === 'defeat') {
    card.append(line(t('ui.battle.result.defeat_intro'), 'battle-result-death-intro'));
    overlay.classList.add('defeat-pending');
  }

  const details = document.createElement('div');
  details.className = 'battle-result-details';
  if (result === 'victory') {
    const stats = document.createElement('div');
    stats.className = 'battle-result-section';
    if (typeof rewards.xp === 'number') {
      stats.append(line(t('ui.battle.result.xp', { xp: rewards.xp })));
    }
    details.append(stats, lootBlock(rewards, items));
    if (rewards.levelUp) {
      const levelUp = document.createElement('div');
      levelUp.className = 'battle-result-section';
      levelUp.append(
        line(t('ui.battle.result.levelup', { level: rewards.newLevel }), 'battle-result-levelup'),
        line(t('ui.battle.result.stats_grew'), 'battle-result-stats'),
      );
      details.append(levelUp);
    }
  } else if (result === 'defeat') {
    const losses = document.createElement('div');
    losses.className = 'battle-result-section';
    if (cityName) losses.append(line(t('ui.battle.result.defeat_wake', { city: cityName })));
    if (typeof rewards.moneyLost === 'number') {
      losses.append(line(t('ui.battle.result.money_lost', { money: rewards.moneyLost })));
    }
    if (typeof hpMax === 'number') {
      losses.append(line(t('ui.battle.result.hp_after', { hp: 1, max: hpMax })));
    }
    details.append(losses);
  } else {
    const fled = document.createElement('div');
    fled.className = 'battle-result-section';
    fled.append(line(t('ui.battle.result.fled_text')));
    details.append(fled);
  }
  card.append(details);

  const button = document.createElement('button');
  button.className = 'btn btn-secondary battle-result-return';
  button.textContent = t('ui.battle.result.button_return');
  button.disabled = true;
  button.addEventListener('click', () => {
    if (!button.disabled) onReturn?.();
  });
  card.append(button);
  overlay.append(card);
  container.append(overlay);

  const timers = [];
  timers.push(
    setTimeout(() => {
      overlay.classList.remove('defeat-pending');
      button.disabled = false;
    }, result === 'defeat' ? INTRO_DELAY_MS : FADE_MS),
  );

  if (result === 'victory') audio.playVictory();
  if (result === 'defeat') audio.playDefeat();

  return {
    destroy() {
      for (const timer of timers) clearTimeout(timer);
      overlay.remove();
    },
  };
}
