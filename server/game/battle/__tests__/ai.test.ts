import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { decideMobAction, findBestMoveHex } from '../ai';
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
  mobId: string,
  hex: { q: number; r: number },
  over: Partial<Participant> = {},
): Participant {
  const def = mobs.find((m) => m.id === mobId)!;
  return {
    id: 'mob_1',
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

function decide(mob: Participant, state: BattleState, cfg = config) {
  return decideMobAction({ mob, state, items, mobs, config: cfg, rng: () => 0 });
}

const wall = (q: number, r: number): Obstacle => ({
  hex: { q, r },
  type: 'wall',
  blocksLos: true,
  blocksMove: true,
  blocksMelee: true,
});

describe('decideMobAction: aggressive', () => {
  it('в упор (distance 1, melee) → shoot в preferZone', () => {
    const mob = mobFixture('pipe_rat', { q: 2, r: 3 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toEqual({
      type: 'shoot',
      targetId: 'player',
      zone: 'torso',
    });
  });

  it('далеко (distance 5, range 1) → move в сторону игрока', () => {
    const mob = mobFixture('pipe_rat', { q: 6, r: 3 });
    const state = makeState([playerFixture(), mob]);
    const decision = decide(mob, state);
    expect(decision.type).toBe('move');
    if (decision.type === 'move') {
      expect(decision.to.q).toBe(5);
      expect(decision.to.r).toBe(3);
    }
  });

  it('distance 2, range 1 → один шаг к игроку', () => {
    const mob = mobFixture('pipe_rat', { q: 3, r: 3 });
    const state = makeState([playerFixture(), mob]);
    const decision = decide(mob, state);
    expect(decision).toEqual({ type: 'move', to: { q: 2, r: 3 } });
  });

  it('стрелок: distance 3, range 3, есть LOS → shoot', () => {
    const mob = mobFixture('bandit_shooter', { q: 4, r: 3 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toMatchObject({ type: 'shoot', targetId: 'player' });
  });

  it('стрелок: distance 2, range 3, нет LOS (стена) → move на LOS-гекс', () => {
    const mob = mobFixture('bandit_shooter', { q: 3, r: 3 });
    const state = makeState([playerFixture(), mob], [wall(2, 3)]);
    const decision = decide(mob, state);
    expect(decision.type).toBe('move');
    if (decision.type === 'move') {
      // The mob steps off the blocked line; it must not enter the wall.
      expect(decision.to).not.toEqual({ q: 2, r: 3 });
      expect(decision.to).not.toEqual({ q: 3, r: 3 });
    }
  });

  it('стрелок: distance 4, range 3 → move', () => {
    const mob = mobFixture('bandit_shooter', { q: 5, r: 3 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state).type).toBe('move');
  });
});

describe('decideMobAction: coward', () => {
  it('hp 8/30 (< 30%) и ap 12 → flee', () => {
    const mob = mobFixture('ash_dog', { q: 5, r: 3 }, { hp: 8, hpMax: 30 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toEqual({ type: 'flee' });
  });

  it('hp 8/30, ap 3 (< fleeApThreshold и < moveCost) → wait', () => {
    const mob = mobFixture('ash_dog', { q: 5, r: 3 }, { hp: 8, hpMax: 30, ap: 3 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toEqual({ type: 'wait' });
  });

  it('hp 8/30, ap 6, fleeApThreshold 9 → move к укрытию', () => {
    const mob = mobFixture('ash_dog', { q: 3, r: 3 }, { hp: 8, hpMax: 30, ap: 6 });
    const state = makeState([playerFixture(), mob], [wall(4, 4)]);
    const cfg = {
      ...config,
      ai: {
        ...config.ai,
        coward: { ...config.ai.coward, fleeApThreshold: 9 },
      },
    };
    const decision = decide(mob, state, cfg);
    expect(decision.type).toBe('move');
    if (decision.type === 'move') {
      expect(decision.to).not.toEqual({ q: 4, r: 4 });
    }
  });

  it('hp 20/30 (не в бегстве) → shoot/move как aggressive', () => {
    const mob = mobFixture('ash_dog', { q: 2, r: 3 }, { hp: 20, hpMax: 30 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toMatchObject({ type: 'shoot', targetId: 'player' });
  });
});

describe('decideMobAction: общие правила', () => {
  it('ap < moveCost при далёкой цели → wait', () => {
    const mob = mobFixture('pipe_rat', { q: 6, r: 3 }, { ap: 3 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toEqual({ type: 'wait' });
  });

  it('все враги мертвы → wait', () => {
    const mob = mobFixture('pipe_rat', { q: 2, r: 3 });
    const state = makeState([playerFixture({ hp: 0 }), mob]);
    expect(decide(mob, state)).toEqual({ type: 'wait' });
  });

  it('мёртвый моб → wait', () => {
    const mob = mobFixture('pipe_rat', { q: 2, r: 3 }, { hp: 0 });
    const state = makeState([playerFixture(), mob]);
    expect(decide(mob, state)).toEqual({ type: 'wait' });
  });
});

describe('findBestMoveHex', () => {
  const base = {
    from: { q: 3, r: 3 },
    targetHex: { q: 0, r: 0 },
    obstacles: [wall(1, 0)],
    occupiedHexes: [] as { q: number; r: number }[],
    mapWidth: 10,
    mapHeight: 10,
  };

  it('предпочитает гекс с LOS', () => {
    // "2,0" is close but the wall at (1,0) blocks LOS; "0,2" has LOS but is farther.
    const reachable = new Set(['2,0', '0,2']);
    const best = findBestMoveHex({ ...base, reachable, weaponRange: 2, needsLos: true });
    expect(best).toEqual({ q: 0, r: 2 });
  });

  it('без LOS-предпочтения выбирает ближайший', () => {
    const reachable = new Set(['0,2', '0,1']);
    const best = findBestMoveHex({ ...base, reachable, weaponRange: 1, needsLos: false });
    expect(best).toEqual({ q: 0, r: 1 });
  });

  it('пустой reachable → null', () => {
    expect(
      findBestMoveHex({
        ...base,
        reachable: new Set<string>(),
        weaponRange: 1,
        needsLos: true,
      }),
    ).toBeNull();
  });
});
