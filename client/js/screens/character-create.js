// Character creation screen (stage 2). Stats are fixed; only `name` is sent.

import { t } from '../i18n.js';
import { createCharacter } from '../api.js';

// Preview is computed on the client; the server recomputes with the same formulas.
const START_STATS = { str: 3, agi: 3, int: 3, end: 3, per: 0, intel: 0 };
const PREVIEW_HP = 50 + 5 * START_STATS.end; // 65
const PREVIEW_AP = 15 + 2 * START_STATS.end; // 21

export function renderCharacterCreate(root, { onCreated }) {
  const el = document.createElement('div');
  el.className = 'char-create';
  el.innerHTML = `
    <h2 data-i18n="ui.character.create.title">${t('ui.character.create.title')}</h2>
    <label class="char-create-label" for="char-name" data-i18n="ui.character.create.name">${t('ui.character.create.name')}</label>
    <input id="char-name" class="char-create-input" type="text" maxlength="20" autocomplete="off">
    <div class="panel char-create-preview">
      <p data-i18n="ui.character.create.stats">${t('ui.character.create.stats')}</p>
      <p data-i18n="ui.character.create.hp_preview">${t('ui.character.create.hp_preview')}</p>
      <p data-i18n="ui.character.create.ap_preview">${t('ui.character.create.ap_preview')}</p>
    </div>
    <p class="char-create-error" id="char-create-error"></p>
    <button class="btn" id="char-create-submit" data-i18n="ui.character.create.submit">${t('ui.character.create.submit')}</button>
  `;
  root.replaceChildren(el);

  const input = el.querySelector('#char-name');
  const errorEl = el.querySelector('#char-create-error');
  const submitBtn = el.querySelector('#char-create-submit');

  const showError = (key) => {
    errorEl.textContent = t(key);
    errorEl.classList.add('visible');
  };

  submitBtn.addEventListener('click', async () => {
    errorEl.classList.remove('visible');
    const name = input.value.trim();
    // Early check on the client; the server validates anyway.
    if (!/^[\p{L}0-9 \-]{2,20}$/u.test(name)) {
      showError('ui.character.create.error.name');
      return;
    }
    submitBtn.disabled = true;
    try {
      const { status, data } = await createCharacter(name);
      if (status === 201) {
        onCreated(data.character);
      } else if (status === 400) {
        showError('ui.character.create.error.name');
      } else if (status === 409) {
        showError('ui.character.create.error.exists');
      } else {
        showError('ui.error.data');
      }
    } catch (err) {
      console.error(err);
      showError('ui.error.data');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
