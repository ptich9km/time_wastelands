import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import {
  applyAction,
  aimBonusFor,
  battleHighlight,
  battleVictoryXp,
  shootChance,
} from '../engine';
import type { BattleState, Participant } from '../state';
import type { Action } from '../actions';
import { xpToNextLevel } from '../formulas';
import { loadGameData } from '../../../schemas/loader';
import { loadI18n, setI18n } from '../../../i18n';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const gameData = loadGameData(path.join(ROOT, 'data'));
const config = gameData.battleConfig;
const items = gameData.items.items;
const mobs = gameData.mobs.mobs;

beforeAll(() => {
  setI18n(loadI18n(path.join(ROOT, 'data')));
});

const NOW = '2026-01-01T00:00:00.000Z';

function playerFixture(): Participant {
  return {
    id: 'player',
    kind: 'player',
    refId: '1',
    stats: { str: 3, agi: 3, int: 3, end: 3, per: 10, intel: 0 },
    hp: 65,
    hpMax: 65,
    ap: 21,
    apMax: 21,
    hex: { q: 1, r: 3 },
    position: 'stand',
    facing: 0,
    equipment: {
      weaponId: 'army_pistol',
      armor: { head: null, torso: null, arms: null, legs: null },
    },
    weaponCharges: 8,
    effects: [],
    characterName: 'Test',
  };
}

function mobFixture(): Participant {
  const mob = mobs.find((m) => m.id === 'pipe_rat')!;
  return {
    id: 'mob_1',
    kind: 'mob',
    refId: mob.id,
    stats: { ...mob.stats },
    hp: mob.hp,
    hpMax: mob.hp,
    ap: 4,
    apMax: 4,
    hex: { q: 3, r: 3 },
    position: 'stand',
    facing: 0,
    equipment: { weaponId: null, armor: { head: null, torso: null, arms: null, legs: null } },
    effects: [],
    mobLevel: mob.level,
    mobNameKey: mob.nameKey,
  };
}

function makeState(): BattleState {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    round: 1,
    status: 'active',
    phase: 'player_turn',
    map: { width: 8, height: 8, obstacles: [] },
    participants: [playerFixture(), mobFixture()],
    turnOrder: ['player', 'mob_1'],
    currentActorId: 'player',
    log: [],
    context: { locationId: 'zarya', isAmbush: false, cover: false, timeOfDay: 'day' },
    healLimit: { current: 50, max: 97, regenPerRound: 13 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// Applies a mutation to a deep copy of the fixture.
function state(fn: (s: BattleState) => void = () => {}): BattleState {
  const s = structuredClone(makeState());
  fn(s);
  return s;
}

function player(s: BattleState): Participant {
  return s.participants.find((p) => p.kind === 'player')!;
}

function mob(s: BattleState): Participant {
  return s.participants.find((p) => p.kind === 'mob')!;
}

function act(s: BattleState, action: Action, rngValues: number[] = [0]) {
  let i = 0;
  const rng = () => (i < rngValues.length ? rngValues[i++] : 0.99);
  return applyAction({ state: s, action, config, items, mobs, rng, lang: 'ru' });
}

// --- move ---

describe('applyAction: move', () => {
  it('успех: игрок сдвинулся на соседний гекс, ОД −4, лог +1', () => {
    const s = state();
    const res = act(s, { type: 'move', to: { q: 2, r: 3 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).hex).toEqual({ q: 2, r: 3 });
    expect(player(res.newState).ap).toBe(17);
    expect(res.logEntries).toHaveLength(1);
    expect(res.logEntries[0].type).toBe('info');
    // immutability: the original state is untouched
    expect(player(s).hex).toEqual({ q: 1, r: 3 });
  });

  it('не хватает ОД', () => {
    const s = state((st) => {
      player(st).ap = 2;
    });
    expect(act(s, { type: 'move', to: { q: 2, r: 3 } })).toMatchObject({
      ok: false,
      error: 'not_enough_ap',
    });
  });

  it('не соседний гекс → not_adjacent', () => {
    const res = act(state(), { type: 'move', to: { q: 3, r: 3 } });
    expect(res).toMatchObject({ ok: false, error: 'occupied' }); // mob stands there
    const res2 = act(state(), { type: 'move', to: { q: 3, r: 4 } });
    expect(res2).toMatchObject({ ok: false, error: 'not_adjacent' });
  });

  it('гекс занят → occupied', () => {
    const s = state((st) => {
      mob(st).hex = { q: 2, r: 3 };
    });
    expect(act(s, { type: 'move', to: { q: 2, r: 3 } })).toMatchObject({
      ok: false,
      error: 'occupied',
    });
  });

  it('стена → blocked', () => {
    const s = state((st) => {
      st.map.obstacles.push({ hex: { q: 2, r: 3 }, type: 'wall', blocksLos: true, blocksMove: true });
    });
    expect(act(s, { type: 'move', to: { q: 2, r: 3 } })).toMatchObject({
      ok: false,
      error: 'blocked',
    });
  });

  it('за границей карты → out_of_bounds', () => {
    const s = state((st) => {
      player(st).hex = { q: 0, r: 3 };
    });
    expect(act(s, { type: 'move', to: { q: -1, r: 3 } })).toMatchObject({
      ok: false,
      error: 'out_of_bounds',
    });
  });

  it('в позе run шаг стоит 2 ОД', () => {
    const s = state((st) => {
      player(st).position = 'run';
    });
    const res = act(s, { type: 'move', to: { q: 2, r: 3 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(player(res.newState).ap).toBe(19);
  });
});

// --- shoot ---

describe('applyAction: shoot', () => {
  it('успех: HP цели уменьшился, патрон −1, лог попадания', () => {
    const res = act(state(), { type: 'shoot', targetId: 'mob_1', zone: 'torso' }, [0, 0.5, 0.99, 0.99]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mob(res.newState).hp).toBeLessThan(18);
    expect(player(res.newState).weaponCharges).toBe(7);
    expect(player(res.newState).ap).toBe(21 - config.apCosts.shootLight);
    expect(res.logEntries.map((e) => e.type)).toEqual(['hit']);
  });

  it('промах тоже списывает патрон и ОД', () => {
    // per 0 → chance 5%; roll 0.5 = 50 >= 5 → miss
    const s = state((st) => {
      player(st).stats.per = 0;
    });
    const res = act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' }, [0.5]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mob(res.newState).hp).toBe(18);
    expect(player(res.newState).weaponCharges).toBe(7);
    expect(res.logEntries.map((e) => e.type)).toEqual(['miss']);
  });

  it('не хватает ОД', () => {
    const s = state((st) => {
      player(st).ap = 3;
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'not_enough_ap',
    });
  });

  it('без оружия → no_weapon', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = null;
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'no_weapon',
    });
  });

  it('оружие отсутствует в items → unknown_item', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = 'ghost_gun';
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'unknown_item',
    });
  });

  it('без патронов → no_ammo', () => {
    const s = state((st) => {
      player(st).weaponCharges = 0;
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'no_ammo',
    });
  });

  it('нет линии видимости → no_line_of_sight', () => {
    const s = state((st) => {
      st.map.obstacles.push({ hex: { q: 2, r: 3 }, type: 'wall', blocksLos: true, blocksMove: true });
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'no_line_of_sight',
    });
  });

  it('за пределом дальности → out_of_range', () => {
    const s = state((st) => {
      mob(st).hex = { q: 6, r: 3 }; // distance 5, army_pistol range 3
    });
    expect(act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'out_of_range',
    });
  });

  it('неверная цель (игрок) → invalid_target', () => {
    expect(act(state(), { type: 'shoot', targetId: 'player', zone: 'torso' })).toMatchObject({
      ok: false,
      error: 'invalid_target',
    });
  });

  it('крит: урон ×1.5, лог crit', () => {
    // roll hit=0, damage roll=0 → 6, crit roll=0.01 (<0.05) → 9, no pen
    const res = act(state(), { type: 'shoot', targetId: 'mob_1', zone: 'torso' }, [0, 0, 0.01, 0.99]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mob(res.newState).hp).toBe(18 - 9);
    expect(res.logEntries[0].type).toBe('crit');
  });

  it('убийство: victory, phase finished, XP > 0', () => {
    const s = state((st) => {
      mob(st).hp = 3;
    });
    const res = act(s, { type: 'shoot', targetId: 'mob_1', zone: 'torso' }, [0, 0, 0.99, 0.99]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newState.status).toBe('victory');
    expect(res.newState.result).toBe('victory');
    expect(res.newState.phase).toBe('finished');
    expect(res.logEntries.map((e) => e.type)).toContain('death');
    expect(battleVictoryXp({ state: res.newState, mobs, playerLevel: 1, config })).toBe(18);
  });

  it('снайперская винтовка тратит свой AP-кост', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = 'sniper_rifle';
      player(st).weaponCharges = 5;
      mob(st).hex = { q: 3, r: 5 }; // distance 4, sniper range 8
    });
    const res = act(s, { type: 'shoot', targetId: 'mob_1', zone: 'head' }, [0, 0, 0.99, 0.99]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(player(res.newState).ap).toBe(21 - config.apCosts.shootSniper);
    }
  });
});

// --- aim ---

describe('applyAction: aim', () => {
  it('−5 ОД, effect aim добавлен, следующий выстрел точнее на 15%', () => {
    const s = state((st) => {
      player(st).stats.per = 0;
    });
    const res = act(s, { type: 'aim' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = player(res.newState);
    expect(p.ap).toBe(16);
    expect(aimBonusFor(p.effects)).toBe(15);

    const target = mob(res.newState);
    const weapon = items.find((i) => i.id === 'army_pistol')!;
    if (weapon.type !== 'weapon') throw new Error('fixture');
    const base = shootChance({
      player: player(s),
      target,
      weapon,
      zone: 'torso',
      distanceHexes: 2,
      config,
    });
    const aimed = shootChance({
      player: p,
      target,
      weapon,
      zone: 'torso',
      distanceHexes: 2,
      config,
    });
    expect(aimed - base).toBeCloseTo(15);
  });

  it('не хватает ОД', () => {
    const s = state((st) => {
      player(st).ap = 4;
    });
    expect(act(s, { type: 'aim' })).toMatchObject({ ok: false, error: 'not_enough_ap' });
  });

  it('выстрел снимает прицеливание', () => {
    const aimRes = act(state(), { type: 'aim' });
    if (!aimRes.ok) throw new Error('aim failed');
    const shot = act(aimRes.newState, { type: 'shoot', targetId: 'mob_1', zone: 'torso' }, [0, 0, 0.99, 0.99]);
    if (!shot.ok) throw new Error('shoot failed');
    expect(aimBonusFor(player(shot.newState).effects)).toBe(0);
  });
});

// --- stance ---

describe('applyAction: setStance', () => {
  it('run → stand бесплатно', () => {
    const s = state((st) => {
      player(st).position = 'run';
    });
    const res = act(s, { type: 'setStance', stance: 'stand' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).ap).toBe(21);
    expect(player(res.newState).position).toBe('stand');
  });

  it('stand → crouch стоит 3 ОД', () => {
    const res = act(state(), { type: 'setStance', stance: 'crouch' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(player(res.newState).ap).toBe(18);
  });

  it('→ cover без соседнего препятствия → cover_not_available', () => {
    expect(act(state(), { type: 'setStance', stance: 'cover' })).toMatchObject({
      ok: false,
      error: 'cover_not_available',
    });
  });

  it('→ cover рядом со стеной: стоит 3 ОД', () => {
    const s = state((st) => {
      st.map.obstacles.push({ hex: { q: 2, r: 3 }, type: 'wall', blocksLos: true, blocksMove: true });
    });
    const res = act(s, { type: 'setStance', stance: 'cover' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(player(res.newState).position).toBe('cover');
      expect(player(res.newState).ap).toBe(18);
    }
  });

  it('stand → run бесплатно', () => {
    const res = act(state(), { type: 'setStance', stance: 'run' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(player(res.newState).ap).toBe(21);
  });
});

// --- reload ---

describe('applyAction: reload', () => {
  it('патроны восстановлены, ОД −5 (light)', () => {
    const s = state((st) => {
      player(st).weaponCharges = 1;
    });
    const res = act(s, { type: 'reload' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).weaponCharges).toBe(8);
    expect(player(res.newState).ap).toBe(21 - config.apCosts.reloadLight);
    expect(res.logEntries[0].type).toBe('info');
  });

  it('без оружия → no_weapon', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = null;
    });
    expect(act(s, { type: 'reload' })).toMatchObject({ ok: false, error: 'no_weapon' });
  });

  it('melee-оружие без магазина → no_weapon', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = 'rusty_pipe';
      player(st).weaponCharges = undefined;
    });
    expect(act(s, { type: 'reload' })).toMatchObject({ ok: false, error: 'no_weapon' });
  });
});

// --- useItem ---

describe('applyAction: useItem', () => {
  it('лечит 20, лимит лечения уменьшается на 20', () => {
    const s = state((st) => {
      player(st).hp = 40;
    });
    const res = act(s, { type: 'useItem', itemId: 'medkit', inventoryId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).hp).toBe(60);
    expect(res.newState.healLimit.current).toBe(30);
    expect(player(res.newState).ap).toBe(21 - config.apCosts.useItem);
    expect(res.logEntries[0].type).toBe('heal');
  });

  it('лечение не превышает остаток лимита', () => {
    const s = state((st) => {
      player(st).hp = 40;
      st.healLimit.current = 5;
    });
    const res = act(s, { type: 'useItem', itemId: 'medkit', inventoryId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).hp).toBe(45);
    expect(res.newState.healLimit.current).toBe(0);
  });

  it('лимит лечения 0: heal = 0, но ОД −8, лог «организм не воспринимает»', () => {
    const s = state((st) => {
      player(st).hp = 40;
      st.healLimit.current = 0;
    });
    const res = act(s, { type: 'useItem', itemId: 'medkit', inventoryId: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(player(res.newState).hp).toBe(40);
    expect(player(res.newState).ap).toBe(13);
    expect(res.logEntries).toHaveLength(1);
  });

  it('неизвестный предмет → unknown_item', () => {
    expect(act(state(), { type: 'useItem', itemId: 'nope', inventoryId: 1 })).toMatchObject({
      ok: false,
      error: 'unknown_item',
    });
  });

  it('не расходник → unknown_item', () => {
    expect(act(state(), { type: 'useItem', itemId: 'army_pistol', inventoryId: 1 })).toMatchObject({
      ok: false,
      error: 'unknown_item',
    });
  });
});

// --- endTurn ---

describe('applyAction: endTurn', () => {
  it('5e-контракт: endTurn только передаёт ход мобам (phase enemy_turn, раунд не растёт)', () => {
    const s = state((st) => {
      player(st).ap = 5;
      st.healLimit.current = 30;
    });
    const res = act(s, { type: 'endTurn' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newState.phase).toBe('enemy_turn');
    expect(res.newState.round).toBe(1);
    expect(player(res.newState).ap).toBe(5);
    expect(res.newState.healLimit.current).toBe(30);
    // No log entries: the round/AP/heal bookkeeping lives in runEnemyTurn.
    expect(res.logEntries).toHaveLength(0);
  });

  it('повторный endTurn в фазе мобов → not_your_turn', () => {
    const first = act(state(), { type: 'endTurn' });
    if (!first.ok) throw new Error('first endTurn failed');
    const second = act(first.newState, { type: 'endTurn' });
    expect(second).toMatchObject({ ok: false, error: 'not_your_turn' });
  });

  it('все мобы мертвы → victory', () => {
    const s = state((st) => {
      mob(st).hp = 0;
    });
    const res = act(s, { type: 'endTurn' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newState.status).toBe('victory');
    expect(res.newState.phase).toBe('finished');
  });
});

// --- flee ---

describe('applyAction: flee', () => {
  it('из run побег может удаться → status fled', () => {
    const s = state((st) => {
      player(st).position = 'run';
    });
    const res = act(s, { type: 'flee' }, [0]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newState.status).toBe('fled');
    expect(res.newState.result).toBe('fled');
    expect(res.newState.phase).toBe('finished');
    expect(res.logEntries[0].type).toBe('flee');
  });

  it('провал побега → бой продолжается', () => {
    const s = state((st) => {
      player(st).position = 'run';
    });
    const res = act(s, { type: 'flee' }, [0.99]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newState.status).toBe('active');
    expect(res.logEntries[0].type).toBe('info');
  });

  it('не в run → cannot_flee', () => {
    expect(act(state(), { type: 'flee' })).toMatchObject({ ok: false, error: 'cannot_flee' });
  });
});

// --- общая валидация ---

describe('applyAction: validation', () => {
  it('ход моба → not_your_turn', () => {
    const s = state((st) => {
      st.currentActorId = 'mob_1';
    });
    expect(act(s, { type: 'aim' })).toMatchObject({ ok: false, error: 'not_your_turn' });
  });

  it('бой завершён → battle_finished', () => {
    const s = state((st) => {
      st.status = 'victory';
    });
    expect(act(s, { type: 'aim' })).toMatchObject({ ok: false, error: 'battle_finished' });
  });

  it('updatedAt обновляется, logEntries попадают в newState.log', () => {
    const res = act(state(), { type: 'aim' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.newState.log).toHaveLength(1);
      expect(res.newState.updatedAt).not.toBe(NOW);
    }
  });
});

// --- highlight ---

describe('battleHighlight', () => {
  it('move: достижимые гексы с учётом ОД', () => {
    const s = state((st) => {
      player(st).ap = 8; // two steps at cost 4
    });
    const res = battleHighlight({ state: s, action: 'move', config, items });
    expect(res.reachable).toBeDefined();
    // 8 AP → 2 steps; some hexes are cut by the map edge
    expect(res.reachable!.length).toBeGreaterThan(6);
    expect(res.reachable).not.toContain('1,3'); // start excluded
  });

  it('move: 0 ОД → ничего', () => {
    const s = state((st) => {
      player(st).ap = 0;
    });
    expect(battleHighlight({ state: s, action: 'move', config, items }).reachable).toEqual([]);
  });

  it('shoot: LOS-гексы в пределах дальности (wall режет)', () => {
    const s = state((st) => {
      st.map.obstacles.push({ hex: { q: 2, r: 3 }, type: 'wall', blocksLos: true, blocksMove: true });
    });
    const res = battleHighlight({ state: s, action: 'shoot', config, items });
    expect(res.los).toBeDefined();
    expect(res.los).not.toContain('3,3'); // mob behind the wall
    expect(res.los!.length).toBeLessThan(30);
  });

  it('shoot без оружия → пустой los', () => {
    const s = state((st) => {
      player(st).equipment.weaponId = null;
    });
    expect(battleHighlight({ state: s, action: 'shoot', config, items }).los).toEqual([]);
  });
});

// --- XP thresholds (sanity) ---

describe('xpToNextLevel', () => {
  it('растёт с уровнем', () => {
    expect(xpToNextLevel({ level: 2, config: config.xp })).toBeGreaterThan(
      xpToNextLevel({ level: 1, config: config.xp }),
    );
  });
});
