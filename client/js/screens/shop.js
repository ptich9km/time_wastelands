// Stage 8: shop screen — buy tab (live prices, stock, requirements) and
// sell tab (inventory, 50% / 70% for the trend item).

import { getShop, getCharacter, getInventory, buyItem, sellItem } from '../api.js';
import { t } from '../i18n.js';

const RARITY_COLORS = {
  common: '#d4c9b8',
  uncommon: '#5a8ba8',
  rare: '#c9a227',
  epic: '#a83232',
};

function requirementText(requirements) {
  const keys = ['level', 'str', 'agi', 'int', 'end', 'per', 'intel'];
  const parts = [];
  for (const key of keys) {
    if (requirements?.[key] !== undefined) {
      parts.push(`${t(`ui.stat.${key}`)} ${requirements[key]}`);
    }
  }
  return parts.join(' · ');
}

function requirementsMet(character, requirements) {
  for (const [key, need] of Object.entries(requirements ?? {})) {
    if ((character[key] ?? 0) < need) return false;
  }
  return true;
}

function sellPrice(basePrice, isTrend) {
  return Math.floor(basePrice * (isTrend ? 0.7 : 0.5));
}

// options: { onBack() }
export function renderShop(root, shopId, options) {
  const wrap = document.createElement('div');
  wrap.className = 'shop-screen';

  const head = document.createElement('div');
  head.className = 'location-head';
  const title = document.createElement('h2');
  title.className = 'location-title';
  title.textContent = t('ui.shop.title');
  const buttons = document.createElement('div');
  buttons.className = 'screen-buttons';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn btn-secondary';
  refreshBtn.textContent = t('ui.shop.button.refresh');
  const backBtn = document.createElement('button');
  backBtn.className = 'btn btn-secondary';
  backBtn.textContent = t('ui.shop.button.back');
  backBtn.addEventListener('click', () => options.onBack());
  buttons.append(refreshBtn, backBtn);
  head.append(title, buttons);

  const moneyEl = document.createElement('p');
  moneyEl.className = 'location-meta';

  const tabs = document.createElement('div');
  tabs.className = 'shop-tabs';
  const buyTab = document.createElement('button');
  buyTab.className = 'btn btn-secondary shop-tab active';
  buyTab.textContent = t('ui.shop.tab.buy');
  const sellTab = document.createElement('button');
  sellTab.className = 'btn btn-secondary shop-tab';
  sellTab.textContent = t('ui.shop.tab.sell');
  tabs.append(buyTab, sellTab);

  const messageEl = document.createElement('p');
  messageEl.className = 'location-action-message';
  const errorEl = document.createElement('p');
  errorEl.className = 'inline-error';

  const content = document.createElement('div');
  wrap.append(head, moneyEl, tabs, messageEl, errorEl, content);
  root.replaceChildren(wrap);

  let shop = null;
  let character = null;
  let inventory = [];
  let activeTab = 'buy';

  function describeError(data) {
    const code = data?.error;
    const known = [
      'not_enough_money', 'out_of_stock', 'requirements_not_met',
      'not_in_city', 'not_found', 'not_sellable',
    ];
    return known.includes(code) ? t(`ui.shop.error.${code}`) : t('ui.error.data');
  }

  async function reload() {
    errorEl.textContent = '';
    const [shopRes, charRes, invRes] = await Promise.all([
      getShop(shopId),
      getCharacter(),
      getInventory(),
    ]);
    if (shopRes.status !== 200) {
      errorEl.textContent = describeError(shopRes.data);
      shop = null;
      content.replaceChildren();
      return;
    }
    shop = shopRes.data.shop;
    if (charRes.status === 200) character = charRes.data.character;
    if (invRes.status === 200) inventory = invRes.data.items ?? [];
    title.textContent = t(shop.nameKey);
    moneyEl.textContent = t('ui.character.money', { money: character?.money ?? 0 });
    renderContent();
  }

  function renderContent() {
    content.replaceChildren();
    if (!shop || !character) return;
    if (activeTab === 'buy') renderBuyTab();
    else renderSellTab();
  }

  function renderBuyTab() {
    const table = document.createElement('div');
    table.className = 'shop-table';

    const header = document.createElement('div');
    header.className = 'shop-row shop-row-head';
    header.innerHTML = `
      <span></span>
      <span>${t('ui.shop.column.item')}</span>
      <span>${t('ui.shop.column.price')}</span>
      <span>${t('ui.shop.column.stock')}</span>
      <span>${t('ui.shop.column.requirements')}</span>
      <span></span>
    `;
    table.append(header);

    for (const entry of shop.items) {
      const met = requirementsMet(character, entry.requirements);
      const buyable = entry.stock > 0 && character.money >= entry.price && met;
      const row = document.createElement('div');
      row.className = `shop-row${buyable ? '' : ' disabled'}`;

      const icon = document.createElement('span');
      icon.className = 'shop-icon';
      icon.textContent = entry.icon;

      const name = document.createElement('span');
      name.className = 'shop-name';
      name.style.color = RARITY_COLORS[entry.rarity] ?? RARITY_COLORS.common;
      name.textContent = t(entry.nameKey);
      if (entry.trend) {
        const badge = document.createElement('span');
        badge.className = 'shop-trend';
        badge.textContent = t('ui.shop.trend');
        name.append(' ', badge);
      }

      const price = document.createElement('span');
      price.className = 'shop-price';
      price.textContent = entry.price;

      const stock = document.createElement('span');
      stock.className = 'shop-stock';
      stock.textContent = entry.stock;

      const req = document.createElement('span');
      req.className = `shop-requirements${met ? '' : ' unmet'}`;
      req.textContent = requirementText(entry.requirements) || '—';

      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn btn-secondary';
      buyBtn.textContent = t('ui.shop.button.buy');
      buyBtn.disabled = !buyable;
      if (!buyable) {
        buyBtn.title = entry.stock <= 0
          ? t('ui.shop.error.out_of_stock')
          : character.money < entry.price
            ? t('ui.shop.error.not_enough_money')
            : t('ui.shop.error.requirements_not_met');
      }
      buyBtn.addEventListener('click', async () => {
        messageEl.textContent = '';
        errorEl.textContent = '';
        const res = await buyItem(shopId, entry.itemId);
        if (res.status === 200) {
          character = res.data.character;
          inventory = res.data.inventory ?? inventory;
          shop = res.data.shop;
          moneyEl.textContent = t('ui.character.money', { money: character.money });
          renderContent();
        } else {
          errorEl.textContent = describeError(res.data);
        }
      });

      row.append(icon, name, price, stock, req, buyBtn);
      table.append(row);
    }
    content.append(table);
  }

  function renderSellTab() {
    const trendIds = new Set(shop.items.filter((i) => i.trend).map((i) => i.itemId));
    const sellable = inventory.filter((row) => !row.equippedSlot);

    if (sellable.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'location-meta';
      empty.textContent = t('ui.inventory.empty');
      content.append(empty);
      return;
    }

    const table = document.createElement('div');
    table.className = 'shop-table';
    for (const row of sellable) {
      const item = row.item;
      if (!item) continue;
      const isTrend = trendIds.has(item.id);
      const price = sellPrice(item.price, isTrend);

      const rowEl = document.createElement('div');
      rowEl.className = 'shop-row';

      const icon = document.createElement('span');
      icon.className = 'shop-icon';
      icon.textContent = item.icon;

      const name = document.createElement('span');
      name.className = 'shop-name';
      name.style.color = RARITY_COLORS[item.rarity] ?? RARITY_COLORS.common;
      name.textContent = `${t(item.nameKey)} ×${row.qty}`;
      if (isTrend) {
        const badge = document.createElement('span');
        badge.className = 'shop-trend';
        badge.textContent = t('ui.shop.trend');
        name.append(' ', badge);
      }

      const priceEl = document.createElement('span');
      priceEl.className = 'shop-price';
      priceEl.textContent = price;

      const sellBtn = document.createElement('button');
      sellBtn.className = 'btn btn-secondary';
      sellBtn.textContent = t('ui.shop.button.sell');
      sellBtn.addEventListener('click', async () => {
        messageEl.textContent = '';
        errorEl.textContent = '';
        const res = await sellItem(shopId, row.inventoryId);
        if (res.status === 200) {
          character = res.data.character;
          inventory = res.data.inventory ?? inventory;
          shop = res.data.shop;
          moneyEl.textContent = t('ui.character.money', { money: character.money });
          messageEl.textContent = t('ui.shop.sold', { price: res.data.price });
          renderContent();
        } else {
          errorEl.textContent = describeError(res.data);
        }
      });

      rowEl.append(icon, name, priceEl, document.createElement('span'), document.createElement('span'), sellBtn);
      table.append(rowEl);
    }
    content.append(table);
  }

  buyTab.addEventListener('click', () => {
    activeTab = 'buy';
    buyTab.classList.add('active');
    sellTab.classList.remove('active');
    renderContent();
  });
  sellTab.addEventListener('click', () => {
    activeTab = 'sell';
    sellTab.classList.add('active');
    buyTab.classList.remove('active');
    renderContent();
  });
  refreshBtn.addEventListener('click', () => reload());

  reload();
}
