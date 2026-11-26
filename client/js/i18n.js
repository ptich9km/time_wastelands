// i18n на клиенте: словарь, переключение языка, data-i18n атрибуты.

import { getDictionary } from './api.js';

const SUPPORTED = ['ru', 'en'];
const STORAGE_KEY = 'lang';

let currentLang = 'ru';
let dict = {};

export function getLang() {
  return currentLang;
}

export function t(key, params) {
  let text = dict[key];
  if (text === undefined) {
    console.warn(`[i18n] missing key: ${key}`);
    return `[missing:${key}]`;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

// Обновляет текстовое содержимое всех [data-i18n] на странице.
// Плейсхолдеры {k} не подставляются здесь — динамику делает main.js.
export function applyTranslations() {
  document.title = t('ui.title');
  document.documentElement.lang = currentLang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  dict = await getDictionary(lang);
  applyTranslations();
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  }
}

export function initLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && SUPPORTED.includes(saved) ? saved : 'ru';
}
