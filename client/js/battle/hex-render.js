// Stage 6b: SVG hex map renderer with highlight and animation hooks.

import { hexToPixel, hexCorners, hexKey } from './hex.js';
import { t } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PADDING = 8;

const POSITION_ICON = { stand: '🧍', crouch: '🧎', run: '🏃', cover: '🛡️' };

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function hexRender(container, params) {
  let current = params;
  const view = document.createElement('div');
  view.className = 'battle-map-view';
  const svg = svgEl('svg', { class: 'battle-map-svg', role: 'img' });
  const floatingLayer = document.createElement('div');
  floatingLayer.className = 'battle-floating-layer';
  view.append(svg, floatingLayer);
  container.replaceChildren(view);
  // key → polygon, for direct hover toggling without a full redraw
  // (rebuilding the SVG under the cursor would retrigger mouseover in a loop).
  let polyByKey = new Map();
  let hoverKeyInternal = null;
  let bounds = null;
  let currentHexSize = 28;

  function setHover(key) {
    if (hoverKeyInternal === key) return;
    if (hoverKeyInternal) polyByKey.get(hoverKeyInternal)?.classList.remove('hover');
    hoverKeyInternal = key;
    if (key) polyByKey.get(key)?.classList.add('hover');
  }

  function draw() {
    const { map, participants, highlight = {}, hexSize = 28 } = current;
    const { onHexClick, onHexHover } = current;
    currentHexSize = hexSize;

    // Lay out all hexes and compute the bounding box.
    const hexes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < map.height; r++) {
      for (let q = 0; q < map.width; q++) {
        const center = hexToPixel({ q, r }, hexSize);
        const corners = hexCorners(center, hexSize);
        for (const c of corners) {
          minX = Math.min(minX, c.x);
          minY = Math.min(minY, c.y);
          maxX = Math.max(maxX, c.x);
          maxY = Math.max(maxY, c.y);
        }
        hexes.push({ hex: { q, r }, key: `${q},${r}`, center, corners });
      }
    }
    const left = minX - PADDING;
    const top = minY - PADDING;
    const width = maxX - minX + 2 * PADDING;
    const height = maxY - minY + 2 * PADDING;
    bounds = { left, top, width, height };
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

    svg.replaceChildren();
    polyByKey = new Map();

    const obstacleByKey = new Map(map.obstacles.map((o) => [hexKey(o.hex), o]));
    const selectedKey = highlight.selected ? hexKey(highlight.selected) : null;
    const hoverKey = highlight.hover ? hexKey(highlight.hover) : null;

    // Hex layer.
    for (const { hex, key, corners } of hexes) {
      const classes = ['hex'];
      const obstacle = obstacleByKey.get(key);
      if (obstacle) classes.push(`obstacle-${obstacle.type}`);
      if (highlight.reachable?.has(key)) classes.push('reachable');
      if (highlight.los?.has(key)) classes.push('los');
      if (key === selectedKey) classes.push('selected');
      if (key === hoverKey) classes.push('hover');
      const poly = svgEl('polygon', {
        points: corners.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' '),
        class: classes.join(' '),
        'data-hex': key,
      });
      polyByKey.set(key, poly);
      svg.append(poly);
    }
    // restore the hover outline after a rebuild
    if (hoverKeyInternal) polyByKey.get(hoverKeyInternal)?.classList.add('hover');

    // The current actor's hex keeps a pulsing outline until the next update.
    if (current.currentActorId) {
      const actor = participants.find((p) => p.id === current.currentActorId && p.hp > 0);
      if (actor) polyByKey.get(hexKey(actor.hex))?.classList.add('turn-glow');
    }

    // Participant layer.
    for (const p of participants) {
      if (p.hp <= 0) continue;
      const center = hexToPixel(p.hex, hexSize);
      const g = svgEl('g', {
        class: `participant ${p.kind}${p.kind === 'mob' ? ` mob-${p.refId}` : ''}`,
        transform: `translate(${center.x},${center.y})`,
        'data-participant': p.id,
        'data-hex': hexKey(p.hex),
      });

      // HP bar (20×2) above the token.
      const barW = 20;
      const hpPct = p.hpMax > 0 ? Math.max(0, Math.min(1, p.hp / p.hpMax)) : 0;
      g.append(svgEl('rect', { x: -barW / 2, y: -hexSize * 0.85, width: barW, height: 2, class: 'hp-bg' }));
      g.append(
        svgEl('rect', {
          x: -barW / 2,
          y: -hexSize * 0.85,
          width: barW * hpPct,
          height: 2,
          class: 'hp-fill',
        }),
      );

      const label = svgEl('text', { y: 6, 'text-anchor': 'middle', class: 'participant-label' });
      label.textContent = p.kind === 'player' ? '@' : (t(p.mobNameKey ?? '') || '?').charAt(0).toUpperCase();
      g.append(label);

      const pos = svgEl('text', {
        x: hexSize * 0.45,
        y: hexSize * 0.75,
        'text-anchor': 'middle',
        class: 'position-icon',
      });
      pos.textContent = POSITION_ICON[p.position] ?? '';
      g.append(pos);

      svg.append(g);
    }
  }

  function hexFromEvent(e) {
    const key = e.target?.dataset?.hex;
    if (!key) return null;
    const [q, r] = key.split(',').map(Number);
    return { q, r };
  }

  function onClick(e) {
    const hex = hexFromEvent(e);
    if (hex && current.onHexClick) current.onHexClick(hex);
  }

  function onOver(e) {
    const hex = hexFromEvent(e);
    setHover(hex ? hexKey(hex) : null);
    if (current.onHexHover) current.onHexHover(hex);
  }

  function onOut(e) {
    if (e.target?.dataset?.hex) {
      setHover(null);
      if (current.onHexHover) current.onHexHover(null);
    }
  }

  svg.addEventListener('click', onClick);
  svg.addEventListener('mouseover', onOver);
  svg.addEventListener('mouseout', onOut);

  function restart(element, className) {
    if (!element) return;
    element.classList.remove(className);
    // Force a reflow so an identical animation can be replayed.
    void element.getBoundingClientRect();
    element.classList.add(className);
    element.addEventListener('animationend', () => element.classList.remove(className), {
      once: true,
    });
  }

  draw();

  return {
    update(next) {
      current = { ...current, ...next };
      draw();
    },
    animateHex(hex, className) {
      restart(polyByKey.get(hexKey(hex)), className);
    },
    animateStance(participantId) {
      const group = [...svg.querySelectorAll('[data-participant]')].find(
        (node) => node.dataset.participant === participantId,
      );
      restart(group?.querySelector('.position-icon'), 'anim-stance-pulse');
    },
    floatingLabel(hex, text, className) {
      if (!bounds) return;
      const center = hexToPixel(hex, currentHexSize);
      const label = document.createElement('span');
      label.className = className;
      label.textContent = text;
      label.style.left = `${((center.x - bounds.left) / bounds.width) * 100}%`;
      label.style.top = `${((center.y - bounds.top) / bounds.height) * 100}%`;
      floatingLayer.append(label);
      label.addEventListener('animationend', () => label.remove(), { once: true });
    },
    destroy() {
      svg.removeEventListener('click', onClick);
      svg.removeEventListener('mouseover', onOver);
      svg.removeEventListener('mouseout', onOut);
      view.remove();
    },
  };
}
