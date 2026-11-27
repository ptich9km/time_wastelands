// Stage 10c-3: sprite icons with an emoji/number fallback.

function fallbackElement(text, className) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function imageWithFallbacks(sources, fallbackText, className) {
  const unique = [...new Set(sources.filter(Boolean))];
  if (unique.length === 0) return fallbackElement(fallbackText, className);
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  let index = 0;
  img.addEventListener('error', () => {
    index += 1;
    if (index < unique.length) {
      img.src = unique[index];
    } else {
      img.replaceWith(fallbackElement(fallbackText, className));
    }
  });
  img.src = unique[0];
  return img;
}

export function itemIcon(item, fallbackText = '?', className = 'item-icon') {
  const fallback = item?.icon ?? fallbackText;
  if (!item?.iconImage) return fallbackElement(fallback, className);
  return imageWithFallbacks([item.iconImage], fallback, className);
}

export function mobIcon(participant, fallbackText = '?', className = 'mob-icon') {
  const refId = participant?.refId;
  if (!refId) return fallbackElement(fallbackText, className);
  const sources = participant.isElite
    ? [`/assets/mobs/${refId}_elite.png`, `/assets/mobs/${refId}.png`]
    : [`/assets/mobs/${refId}.png`];
  return imageWithFallbacks(sources, fallbackText, className);
}

export function npcPortrait(npc, fallbackText = '💬', className = 'npc-portrait') {
  const id = typeof npc === 'string' ? npc : npc?.id;
  if (!id && !npc?.portrait) return fallbackElement(fallbackText, className);
  const sources = [npc?.portrait, id ? `/assets/npcs/${id}.png` : null];
  return imageWithFallbacks(sources, fallbackText, className);
}
