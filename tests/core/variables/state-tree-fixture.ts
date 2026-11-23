/**
 * 状态树投影 / 分区测试共用夹具：一份覆盖各类字段的小存档。
 */
import type { StateTreeInput } from '../../../src/core/variables/state-tree-projection';
import {
  createDefaultCharacterState,
  createDefaultQuest,
  type CharacterState,
} from '../../../src/core/types/types';

export const GAME_TIME = {
  era: '复兴纪元',
  year: 512,
  month: 3,
  day: 15,
  weekday: 3,
  hour: 19,
  minute: 5,
};

export function makePlayer(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: 'player-id',
    saveId: 'save-1',
    type: 'player',
    name: '艾琳',
    race: '人类',
    gender: '女',
    identity: ['冒险者'],
    occupation: ['剑士'],
    tier: 2,
    level: 6,
    totalExp: 900,
    expToNext: 1200,
    attributes: { str: 10, dex: 8, con: 12, int: 6, spi: 9 },
    hp: 300,
    maxHp: 5000,
    mp: 20,
    maxMp: 777,
    sp: 3,
    maxSp: 3,
    money: 120,
    location: '王都/北门',
    present: true,
    currentAction: '检查行囊',
    thoughts: '今晚得找个落脚处',
    ageAnchor: { startAge: 20, month: 3, day: 10 },
    customFields: { birthday: '3月10日', age: 20, secret: 'x' },
    introducedBy: 'turn-0',
    inventory: [
      {
        name: '长剑',
        quantity: 1,
        equippedSlot: '武器',
        type: '武器',
        rarity: '稀有',
        description: '一把好剑',
        effects: { 锋利: '攻击附带流血' },
        tags: ['金属'],
        stats: { 攻击力: 15 },
        durability: 40,
        maxDurability: 50,
      },
      {
        name: '治疗药水',
        quantity: 3,
        type: '消耗品',
        rarity: '普通',
        description: '恢复体力',
        tags: [],
      },
      { name: '旧护符', quantity: 2, equippedSlot: '饰品', description: '叠在一起的护符' },
      { name: '绳子', quantity: 1, equippedSlot: null },
    ],
    skills: [
      {
        name: '斩击',
        description: '基础剑技',
        type: 'active',
        rarity: '普通',
        cost: { type: 'SP', amount: 10 },
        skillPower: 30,
        relevantAttribute: 'str',
        damageType: '物理',
        cooldown: 0,
      },
      { name: '直觉', description: '感知危险', type: 'passive', costText: '每天一次' },
    ],
    statusEffects: [
      {
        name: '流血',
        description: '持续失血',
        category: '减益',
        stacks: 2,
        maxStacks: 5,
        remainingTime: 3,
        timeUnit: '回合',
        source: '战斗-狼',
        effects: { hp: -5 },
        effectDescriptions: { 失血: '每回合损失生命' },
      },
      {
        name: '祝福',
        description: '神的眷顾',
        category: '增益',
        stacks: 1,
        remainingTime: null,
        durationText: '直到离开城镇',
        timeUnit: '小时',
        source: '神殿',
        effects: {},
      },
    ],
    ...overrides,
  });
}

export function makeNpc(name: string, overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: `id-${name}`,
    saveId: 'save-1',
    type: 'npc',
    name,
    location: '王都/酒馆',
    present: false,
    currentAction: '',
    money: 10,
    ...overrides,
  });
}

export function makeInput(overrides: Partial<StateTreeInput> = {}): StateTreeInput {
  return {
    characters: [
      makePlayer(),
      makeNpc('布兰', { present: true, appearance: '高个子' }),
      makeNpc('卡拉'),
      makeNpc('哥布林', { type: 'monster', quantity: 3, present: true }),
    ],
    profile: {
      fp: 42,
      gameTime: GAME_TIME,
      affections: { 布兰: 30, 卡拉: -10 },
      variables: { user: { 线索: ['钥匙'] }, sys: { 计数: 1 } },
      quests: {
        寻找钥匙: {
          ...createDefaultQuest(),
          status: '进行中',
          priority: '高',
          objective: '找到钥匙',
        },
        护送商队: { ...createDefaultQuest(), status: '已完成' },
      },
      news: [
        {
          id: 'n1',
          title: '旧闻',
          content: '很久以前',
          category: '王都',
          publishedAt: 1,
          read: true,
        },
        {
          id: 'n2',
          title: '集市开张',
          content: '热闹',
          category: '王都',
          publishedAt: 2,
          read: false,
        },
        {
          id: 'n3',
          title: '边境告急',
          content: '兽人来袭',
          category: '',
          publishedAt: 3,
          read: false,
        },
      ],
    },
    weather: '小雨',
    turn: 7,
    ...overrides,
  };
}
