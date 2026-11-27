import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { runEnemyTurn } from '../engine';
import { decideMobAction } from '../ai';
import type { BattleState, Obstacle, Participant } from '../state';
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

function playerFixture(over: Partial<Participant> = {}): Participant {
  return {
    id: 'player',
    kind: 'player',
    refId: '1',
    stats: { str: 3, agi: 3, int: 3, end: 3, per: 0, intel: 0 },
    hp: 65,
    hpMax: 65,
    ap: 21,
    apMax: 21,
    hex: { q: 1, r: 3 },
    position: 'stand',
    facing: 0,
    equipment: {
      weaponId: 'rusty_pipe',
      armor: { head: null, torso: null, arms: null, legs: null },
    },
    effects: [],
    characterName: 'Test',
    ...over,
  };
}

function mobFixture(
  id: string,
  mobId: string,
  hex: { q: number; r: number },
  over: Partial<Participant> = {},
): Participant {
  const def = mobs.find((m) => m.id === mobId)!;
  return {
    id,
    kind: 'mob',
    refId: def.id,
    stats: { ...def.stats },
    hp: def.hp,
    hpMax: def.hp,
    ap: def.moveAp + def.attackAp,
    apMax: def.moveAp + def.attackAp,
    hex,
    position: 'stand',
    facing: 0,
    equipment: { weaponId: null, armor: { head: null, torso: null, arms: null, legs: null } },
    effects: [],
    mobLevel: def.level,
    mobNameKey: def.nameKey,
    ...over,
  };
}

function makeState(participants: Participant[], obstacles: Obstacle[] = []): BattleState {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    round: 1,
    status: 'active',
    phase: 'enemy_turn',
    map: { width: 10, height: 10, obstacles },
    participants,
    turnOrder: participants.map((p) => p.id),
    currentActorId: 'player',
    log: [],
    context: { locationId: 'zarya', isAmbush: false, cover: false, timeOfDay: 'day' },
    healLimit: { current: 50, max: 97, regenPerRound: 13 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function run(state: BattleState, rngValues: number[] = [0]) {
  let i = 0;
  const rng = () => (i < rngValues.length ? rngValues[i++] : 0.99);
  return runEnemyTurn({ state, config, items, mobs, rng, lang: 'ru' });
}

function playerOf(state: BattleState): Participant {
  return state.participants.find((p) => p.kind === 'player')!;
}

function mobOf(state: BattleState, id = 'mob_1'): Participant {
  return state.participants.find((p) => p.id === id)!;
}

const wall = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'wall',
  blocksLos: true,
  blocksMove: true,
  blocksMelee: true,
});

describe('runEnemyTurn: aggressive mobs', () => {
  it('1 моб в упор, ap 12 → 1 shoot, игрок теряет HP, раунд +1, ОД восстановлены, healLimit +13', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 2, r: 3 })]);
    state.round = 1;
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99]);

    expect(playerOf(newState).hp).toBe(61); // pipe_rat 4..8, min roll = 4
    expect(newState.round).toBe(2);
    expect(playerOf(newState).ap).toBe(21);
    expect(mobOf(newState).ap).toBe(mobOf(newState).apMax);
    expect(newState.healLimit.current).toBe(63); // 50 + 13
    expect(newState.phase).toBe('player_turn');
    expect(newState.currentActorId).toBe('player');
    expect(logEntries.map((e) => e.type)).toEqual(['hit', 'info', 'system']);
    expect(logEntries[0].actor).toBe('mob_1');
    // No AP left for a second attack: the mob waits out the rest of its turn.
    expect(logEntries[1].text).toContain('выжидает');
  });

  it('1 моб далеко (distance 5, ap 12) → 3 move, дистанция −3', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 6, r: 3 })]);
    const { newState, logEntries } = run(state);

    expect(mobOf(newState).hex).toEqual({ q: 3, r: 3 }); // 6→5→4→3
    expect(logEntries.filter((e) => e.type === 'info')).toHaveLength(3);
    expect(logEntries.filter((e) => e.type === 'hit')).toHaveLength(0);
  });

  it('стрелок (distance 4, range 3) → 1 move + 1 shoot', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'bandit_shooter', { q: 5, r: 3 })]);
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99]);

    expect(mobOf(newState).hex).toEqual({ q: 4, r: 3 });
    expect(playerOf(newState).hp).toBeLessThan(65);
    expect(logEntries.some((e) => e.type === 'hit')).toBe(true);
    expect(logEntries.filter((e) => e.type === 'info')).toHaveLength(1);
  });

  it('2 моба в упор → 2 shoot, урон от обоих', () => {
    const state = makeState([
      playerFixture(),
      mobFixture('mob_1', 'pipe_rat', { q: 2, r: 3 }),
      mobFixture('mob_2', 'ash_dog', { q: 2, r: 4 }),
    ]);
    state.turnOrder = ['player', 'mob_1', 'mob_2'];
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99, 0, 0, 0.99, 0.99]);

    expect(playerOf(newState).hp).toBe(65 - 4 - 2); // pipe_rat min 4, ash_dog min 2
    expect(logEntries.filter((e) => e.type === 'hit')).toHaveLength(2);
  });

  it('не стреляет сквозь стену (нет LOS, мало ОД до выстрела)', () => {
    const state = makeState(
      [
        playerFixture(),
        mobFixture('mob_1', 'bandit_shooter', { q: 3, r: 3 }, { ap: 8, apMax: 8 }),
      ],
      [wall(2, 3)],
    );
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99]);

    expect(playerOf(newState).hp).toBe(65);
    expect(logEntries.some((e) => e.type === 'hit' || e.type === 'crit')).toBe(false);
    expect(logEntries.some((e) => e.type === 'info')).toBe(true); // it moved
  });

  it('не входит в занятый гекс', () => {
    const state = makeState([
      playerFixture({ hex: { q: 0, r: 3 } }),
      mobFixture('mob_1', 'pipe_rat', { q: 3, r: 3 }),
      mobFixture('mob_2', 'ash_dog', { q: 2, r: 3 }),
    ]);
    state.turnOrder = ['player', 'mob_1', 'mob_2'];
    const decision = decideMobAction({
      mob: state.participants[1],
      state,
      items,
      mobs,
      config,
      rng: () => 0,
    });
    expect(decision.type).toBe('move');
    if (decision.type === 'move') {
      expect(decision.to).not.toEqual({ q: 2, r: 3 });
    }

    const { newState } = run(state);
    const keys = newState.participants.map((p) => `${p.hex.q},${p.hex.r}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('runEnemyTurn: coward mobs', () => {
  it('hp 8/30 → flee, успех → status fled', () => {
    const state = makeState([
      playerFixture(),
      mobFixture('mob_1', 'ash_dog', { q: 2, r: 3 }, { hp: 8, hpMax: 30 }),
    ]);
    const { newState, logEntries } = run(state, [0]);

    expect(newState.status).toBe('fled');
    expect(newState.phase).toBe('finished');
    expect(logEntries[0].type).toBe('flee');
    expect(logEntries[0].actor).toBe('mob_1');
  });

  it('hp 8/30, побег провалился → моб остаётся, лог mob_flee_fail', () => {
    const state = makeState([
      playerFixture(),
      mobFixture('mob_1', 'ash_dog', { q: 2, r: 3 }, { hp: 8, hpMax: 30 }),
    ]);
    const { newState, logEntries } = run(state, [0.99]);

    expect(newState.status).toBe('active');
    expect(logEntries[0].type).toBe('info');
    expect(logEntries[0].text).toContain('сбежать');
    expect(newState.participants).toHaveLength(2);
  });
});

describe('runEnemyTurn: смерть игрока', () => {
  it('игрок умирает → status defeat, phase finished', () => {
    const state = makeState([
      playerFixture({ hp: 2 }),
      mobFixture('mob_1', 'pipe_rat', { q: 2, r: 3 }),
    ]);
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99]);

    expect(playerOf(newState).hp).toBe(0);
    expect(newState.status).toBe('defeat');
    expect(newState.result).toBe('defeat');
    expect(newState.phase).toBe('finished');
    expect(logEntries.some((e) => e.type === 'death')).toBe(true);
    expect(logEntries.some((e) => e.text === 'Вы погибли.')).toBe(true);
  });
});

describe('runEnemyTurn: раунд и состояние', () => {
  it('раунд увеличивается ровно на 1 за вызов', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 9, r: 9 })]);
    state.round = 4;
    expect(run(state).newState.round).toBe(5);
  });

  it('healLimit не превышает max', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 9, r: 9 })]);
    state.healLimit.current = 90;
    expect(run(state).newState.healLimit.current).toBe(97);
  });

  it('ОД всех участников = apMax после хода мобов', () => {
    const state = makeState([
      playerFixture({ ap: 3 }),
      mobFixture('mob_1', 'pipe_rat', { q: 9, r: 9 }),
    ]);
    const { newState } = run(state);
    for (const p of newState.participants) {
      expect(p.ap).toBe(p.apMax);
    }
  });

  it('эффекты тикают и истекают на новом раунде', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 9, r: 9 })]);
    playerOf(state).effects.push({
      id: 'aim',
      kind: 'buff',
      ttlRounds: 1,
      payload: { hitBonus: 15 },
    });
    const { newState } = run(state);
    expect(playerOf(newState).effects).toHaveLength(0);
  });

  it('phase player_turn → state как есть, пустой лог', () => {
    const state = makeState([playerFixture(), mobFixture('mob_1', 'pipe_rat', { q: 2, r: 3 })]);
    state.phase = 'player_turn';
    const before = structuredClone(state);
    const { newState, logEntries } = run(state);
    expect(logEntries).toHaveLength(0);
    expect(newState).toEqual(before);
  });

  it('мёртвые мобы пропускаются', () => {
    const state = makeState([
      playerFixture(),
      mobFixture('mob_1', 'pipe_rat', { q: 2, r: 3 }, { hp: 0 }),
      mobFixture('mob_2', 'ash_dog', { q: 2, r: 4 }),
    ]);
    state.turnOrder = ['player', 'mob_1', 'mob_2'];
    const { newState, logEntries } = run(state, [0, 0, 0.99, 0.99]);

    // Only mob_2 acted.
    expect(logEntries.filter((e) => e.actor === 'mob_1')).toHaveLength(0);
    expect(logEntries.filter((e) => e.actor === 'mob_2').length).toBeGreaterThan(0);
    expect(mobOf(newState, 'mob_1').hp).toBe(0);
  });
});
