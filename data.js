// douluo-combat / data.js
// 纯数据层：元素、武魂品质、魂师类型、魂环/魂骨档位、魂技模板、功法、地图。
// 不引用任何宿主 API，可离线 import。

/* ---------------- 属性 ---------------- */

// tier 只用来在界面上分组：basic = 五行，ext = 四象，rare = 高阶
// 用户可以在「设置 → 属性与克制」里增删，改动存进扩展设置
export const ELEMENTS = {
    metal:   { id: 'metal',   name: '金',   color: '#e8e3d3', tier: 'basic' },
    wood:    { id: 'wood',    name: '木',   color: '#7bd88f', tier: 'basic' },
    water:   { id: 'water',   name: '水',   color: '#6fb7ff', tier: 'basic' },
    fire:    { id: 'fire',    name: '火',   color: '#ff7a59', tier: 'basic' },
    earth:   { id: 'earth',   name: '土',   color: '#c9a26b', tier: 'basic' },
    wind:    { id: 'wind',    name: '风',   color: '#9be7d0', tier: 'ext' },
    thunder: { id: 'thunder', name: '雷',   color: '#ffe066', tier: 'ext' },
    light:   { id: 'light',   name: '光',   color: '#fff3b0', tier: 'ext' },
    dark:    { id: 'dark',    name: '暗',   color: '#8b7bd8', tier: 'ext' },
    holy:    { id: 'holy',    name: '神圣', color: '#ffd9a0', tier: 'rare' },
    life:    { id: 'life',    name: '生命', color: '#7be8a8', tier: 'rare' },
    poison:  { id: 'poison',  name: '毒',   color: '#a3e635', tier: 'rare' },
    spirit:  { id: 'spirit',  name: '精神', color: '#d8b4fe', tier: 'rare' },
    time:    { id: 'time',    name: '时间', color: '#c0c8ff', tier: 'rare' },
    space:   { id: 'space',   name: '空间', color: '#a0a8e8', tier: 'rare' },
    destroy: { id: 'destroy', name: '毁灭', color: '#ff5c5c', tier: 'rare' },
};

// 克制表：key 克数组里的每一个。多对多，允许互克（光暗、时空、神圣毁灭、生命毒）。
// 判定规则（engine.elementMultiplier）：
//   只有 A 克 B        → A 打 B 1.5 倍
//   只有 B 克 A        → A 打 B 0.5 倍
//   A B 互相克         → 只保留增伤，双方打对方都是 1.5 倍
export const ELEMENT_BEATS = {
    // 五行轮：金克木 → 木克土 → 土克水 → 水克火 → 火克金
    metal:   ['wood'],
    wood:    ['earth'],
    earth:   ['water', 'thunder'],      // 土克水；接地引雷
    water:   ['fire'],
    fire:    ['metal'],
    // 四象
    wind:    ['earth', 'poison'],       // 风蚀岩土；吹散毒雾
    thunder: ['water', 'metal', 'wind'],// 雷导水、克金、压风
    light:   ['dark'],
    dark:    ['light', 'spirit'],       // 光暗互克；暗蚀心神
    // 高阶
    holy:    ['dark', 'destroy'],
    destroy: ['holy', 'life'],
    life:    ['poison'],
    poison:  ['life'],
    spirit:  ['holy'],
    time:    ['space'],
    space:   ['time'],
};

// 运行时改属性/克制用（设置面板保存后调这个，战斗立刻生效）
export function applyElementConfig(cfg) {
    if (!cfg) return;
    if (cfg.elements && typeof cfg.elements === 'object') {
        for (const k of Object.keys(ELEMENTS)) delete ELEMENTS[k];
        for (const [id, def] of Object.entries(cfg.elements)) {
            ELEMENTS[id] = { id, name: def.name || id, color: def.color || '#9fb3c8', tier: def.tier || 'ext' };
        }
    }
    if (cfg.beats && typeof cfg.beats === 'object') {
        for (const k of Object.keys(ELEMENT_BEATS)) delete ELEMENT_BEATS[k];
        for (const [a, list] of Object.entries(cfg.beats)) {
            ELEMENT_BEATS[a] = Array.isArray(list) ? [...list] : [];
        }
    }
}

// 导出当前状态（存设置用）
export function elementConfigSnapshot() {
    const elements = {};
    for (const [id, d] of Object.entries(ELEMENTS)) elements[id] = { name: d.name, color: d.color, tier: d.tier };
    const beats = {};
    for (const [a, list] of Object.entries(ELEMENT_BEATS)) if (list.length) beats[a] = [...list];
    return { elements, beats };
}

/* ---------------- 武魂品质 ---------------- */

// mul：五维与派生整体缩放；ringMul：魂环属性缩放；ceiling：属性成长上限系数
export const QUALITY = {
    trash: { id: 'trash', name: '废武魂', mul: 0.72, ringMul: 0.65, ceiling: 0.8, color: '#7c828c' },
    normal: { id: 'normal', name: '普通武魂', mul: 1.0, ringMul: 1.0, ceiling: 1.0, color: '#9fb3c8' },
    fine: { id: 'fine', name: '良品武魂', mul: 1.14, ringMul: 1.18, ceiling: 1.12, color: '#5fd6a4' },
    epic: { id: 'epic', name: '极品武魂', mul: 1.32, ringMul: 1.42, ceiling: 1.28, color: '#c9a0ff' },
    divine: { id: 'divine', name: '神级武魂', mul: 1.55, ringMul: 1.75, ceiling: 1.45, color: '#ffd166' },
};

export const QUALITY_ORDER = ['trash', 'normal', 'fine', 'epic', 'divine'];

/* ---------------- 属性成长表 ---------------- */
// 来自《斗罗武魂完整数值体系》。核心规则：
//   每级五维总和 = 该品质的总成长（普通 5.0、神级 13.0…）
//   总和按系别向量分摊到五项，向量和恒为 5，所以品质决定总量、系别决定形状
//   单维 = 等级 × (总成长 / 5) × 向量[该项]
// 用文档自带的例子验过：神级控制 30 级 = 30 × (13/5) × [0.7,0.7,1.0,1.6,1.0]
//   = 54.6 / 54.6 / 78 / 124.8 / 78，和原文一致。

export const ATTR_ORDER = ['str', 'vit', 'agi', 'spi', 'sou'];

export const GROWTH = {
    // 五项单级成长总和
    total: { trash: 2.0, normal: 5.0, fine: 6.5, epic: 9.0, divine: 13.0 },
    // 系别倾斜比例向量（和为 5.0）
    vector: {
        attack: [1.6, 1.0, 0.7, 0.7, 1.0],
        defense: [0.7, 1.6, 0.7, 1.0, 1.0],
        agility: [1.0, 0.7, 1.6, 0.7, 1.0],
        control: [0.7, 0.7, 1.0, 1.6, 1.0],
        support: [0.7, 1.0, 0.7, 1.0, 1.6],
        // 食物系原文没给，按辅助的偏魂力处理
        food: [0.7, 1.0, 0.7, 1.0, 1.6],
        // 双生按均值兜底
        twin: [1.0, 1.0, 1.0, 1.0, 1.0],
    },
    // 第七节：品质系数 / 年限系数
    qualityCoef: { trash: 0.3, normal: 1.0, fine: 1.3, epic: 1.8, divine: 2.6 },
    ringCoef: { 百年: 0.2, 千年: 0.5, 万年: 1.0, 十万年: 2.0, 百万年: 4.0 },
};

/**
 * 按品质 / 系别 / 等级算一版裸五维。
 */
export function growthAttrs({ quality = 'normal', role = 'attack', lv = 10 } = {}) {
    const total = GROWTH.total[quality] ?? GROWTH.total.normal;
    const vec = GROWTH.vector[role] || GROWTH.vector.attack;
    const lvN = Math.max(1, Math.min(200, Number(lv) || 10));
    const perLevel = total / 5;
    const out = {};
    ATTR_ORDER.forEach((k, i) => {
        const v = lvN * perLevel * (vec[i] ?? 1);
        out[k] = Math.round(v * 100) / 100;
    });
    return out;
}

/**
 * 把「目标五维」反推成单位存的那组裸值（attrs）。
 * computeStats 里还会再乘 role.attrs 和 quality.mul，这里先除回去，
 * 保证最后算出来的五维正好等于目标值。
 */
export function attrsFromTarget(target, quality = 'normal', role = 'attack') {
    const q = QUALITY[quality] || QUALITY.normal;
    const w = ROLES[role]?.attrs || ROLES.attack.attrs;
    const out = {};
    ATTR_ORDER.forEach((k) => {
        const t = Number(target?.[k]) || 0;
        const denom = (w[k] ?? 1) * q.mul;
        out[k] = denom ? Math.round((t / denom) * 100) / 100 : 0;
    });
    return out;
}

/* ---------------- 魂师类型 ---------------- */

// attrs：五维权重（乘在基础上）；derived：派生值额外百分比
export const ROLES = {
    attack: {
        id: 'attack', name: '强攻系', color: '#ff7a59',
        attrs: { str: 1.30, vit: 1.00, agi: 0.92, spi: 0.88, sou: 0.90 },
        derived: { atkPct: 8, critDmgPct: 4 },
        hint: '力高攻高，破韧慢但单发伤害最高',
    },
    agility: {
        id: 'agility', name: '敏攻系', color: '#6fb7ff',
        attrs: { str: 1.10, vit: 0.80, agi: 1.38, spi: 0.90, sou: 0.72 },
        derived: { spdPct: 10, critPct: 5 },
        hint: '速高暴高，多动、易暴击，血薄',
    },
    control: {
        id: 'control', name: '控制系', color: '#c9a0ff',
        attrs: { str: 0.85, vit: 0.95, agi: 0.96, spi: 1.36, sou: 1.00 },
        derived: { ctrlPct: 15, hitPct: 3 },
        hint: '精神力高，幻境控制时长最长',
    },
    defense: {
        id: 'defense', name: '防御系', color: '#c9a26b',
        attrs: { str: 1.00, vit: 1.42, agi: 0.80, spi: 0.80, sou: 1.00 },
        derived: { defPct: 12, poisePct: 15 },
        hint: '体高韧长，扛削韧、扛控制',
    },
    support: {
        id: 'support', name: '辅助系', color: '#7bd88f',
        attrs: { str: 0.70, vit: 0.90, agi: 0.95, spi: 1.10, sou: 1.38 },
        derived: { healPct: 20, shieldPct: 20 },
        hint: '魂力高，治疗与护盾效率最高',
    },
    food: {
        id: 'food', name: '食物系', color: '#ffd166',
        attrs: { str: 0.72, vit: 1.02, agi: 0.90, spi: 1.00, sou: 1.32 },
        derived: { healPct: 12, buffPct: 15 },
        hint: '魂力高，群体恢复与增益',
    },
    twin: {
        id: 'twin', name: '双生武魂', color: '#ff9ecd',
        attrs: { str: 1.08, vit: 1.05, agi: 1.05, spi: 1.10, sou: 1.12 },
        derived: { atkPct: 5, healPct: 5, ctrlPct: 5 },
        hint: '全属性偏高，魂技池更深',
    },
};

/* ---------------- 魂环档位 ---------------- */

// attr：单环属性点；mod：派生修正倍率
export const RING_TIERS = [
    { id: 'tenYear', name: '十年魂环', min: 0, max: 99, attr: 3, mod: 0.7, color: '#8a8f98' },
    { id: 'hundred', name: '百年魂环', min: 100, max: 999, attr: 6, mod: 1.0, color: '#9fb3c8' },
    { id: 'thousand', name: '千年魂环', min: 1000, max: 9999, attr: 14, mod: 1.3, color: '#5fd6a4' },
    { id: 'tenThousand', name: '万年魂环', min: 10000, max: 99999, attr: 26, mod: 1.7, color: '#c9a0ff' },
    { id: 'hundredThousand', name: '十万年魂环', min: 100000, max: Number.POSITIVE_INFINITY, attr: 44, mod: 2.2, color: '#ffd166' },
];

export function ringTierOf(year) {
    const y = Number(year) || 0;
    for (let i = RING_TIERS.length - 1; i >= 0; i -= 1) {
        if (y >= RING_TIERS[i].min) return RING_TIERS[i];
    }
    return RING_TIERS[0];
}

/* ---------------- 魂骨 ---------------- */

export const BONE_SLOTS = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

export const BONE_SLOT_NAMES = {
    head: '头部魂骨',
    torso: '躯干魂骨',
    leftArm: '左臂魂骨',
    rightArm: '右臂魂骨',
    leftLeg: '左腿魂骨',
    rightLeg: '右腿魂骨',
};

// 魂骨同样按年限分档，属性比同档魂环更强，且只加在对应部位的主属性上
export const BONE_TIERS = [
    { id: 'thousand', name: '千年魂骨', min: 1000, max: 9999, attr: 18, mod: 1.25, color: '#5fd6a4' },
    { id: 'tenThousand', name: '万年魂骨', min: 10000, max: 99999, attr: 34, mod: 1.6, color: '#c9a0ff' },
    { id: 'hundredThousand', name: '十万年魂骨', min: 100000, max: Number.POSITIVE_INFINITY, attr: 58, mod: 2.1, color: '#ffd166' },
];

export function boneTierOf(year) {
    const y = Number(year) || 0;
    for (let i = BONE_TIERS.length - 1; i >= 0; i -= 1) {
        if (y >= BONE_TIERS[i].min) return BONE_TIERS[i];
    }
    return BONE_TIERS[0];
}

// 部位主属性：头→神，躯干→体，左右臂→力，左右腿→敏
export const BONE_SLOT_ATTR = {
    head: 'spi',
    torso: 'vit',
    leftArm: 'str',
    rightArm: 'str',
    leftLeg: 'agi',
    rightLeg: 'agi',
};

/* ---------------- 魂技模板 ---------------- */

// 从文本解析出魂技名后，用关键词匹配到模板，补上机制参数。
// range 是格数，aoe 0 = 单体、1 = 目标周围一圈、2 = 目标周围两圈。
export const SKILL_TEMPLATES = {
    physSingle: { power: 1.15, poise: 20, cost: 6, cd: 0, range: 1, aoe: 0, kind: 'phys' },
    physMulti: { power: 0.82, poise: 15, cost: 13, cd: 2, range: 1, aoe: 1, kind: 'phys' },
    spiritSingle: { power: 1.08, poise: 12, cost: 8, cd: 1, range: 4, aoe: 0, kind: 'spirit' },
    spiritMulti: { power: 0.78, poise: 10, cost: 15, cd: 2, range: 4, aoe: 1, kind: 'spirit' },
    heal: { power: 1.25, poise: 0, cost: 10, cd: 2, range: 3, aoe: 0, kind: 'heal' },
    healAll: { power: 0.85, poise: 0, cost: 16, cd: 3, range: 0, aoe: 2, kind: 'heal' },
    buff: { power: 0, poise: 0, cost: 9, cd: 2, range: 3, aoe: 1, kind: 'buff' },
    debuff: { power: 0, poise: 0, cost: 9, cd: 2, range: 4, aoe: 0, kind: 'debuff' },
    shield: { power: 0, poise: 0, cost: 10, cd: 2, range: 3, aoe: 0, kind: 'shield' },
    controlPhys: { power: 0.65, poise: 26, cost: 11, cd: 2, range: 1, aoe: 0, kind: 'control', control: 'bind' },
    controlPsy: { power: 0.72, poise: 8, cost: 13, cd: 3, range: 4, aoe: 0, kind: 'control', control: 'illusion' },
    dash: { power: 1.0, poise: 14, cost: 7, cd: 1, range: 3, aoe: 0, kind: 'phys', move: 'dash' },
    push: { power: 1.1, poise: 30, cost: 10, cd: 2, range: 1, aoe: 0, kind: 'phys', move: 'push' },
};

// 关键词 → 模板。按顺序匹配，越靠前优先级越高。
export const SKILL_KEYWORDS = [
    { keys: ['幻', '梦', '瞳', '迷', '魅', '魇', '惑'], template: 'controlPsy', element: 'water' },
    { keys: ['缚', '缠', '困', '锁', '藤', '笼', '禁'], template: 'controlPhys', element: 'wood' },
    { keys: ['盾', '甲', '护', '壁', '障', '罩'], template: 'shield', element: 'earth' },
    { keys: ['愈', '疗', '回春', '春', '润', '露', '药', '香', '生'], template: 'heal' },
    { keys: ['增幅', '强化', '气势', '怒吼', '鼓舞', '威'], template: 'buff' },
    { keys: ['弱', '衰', '破甲', '削', '蚀'], template: 'debuff' },
    { keys: ['闪', '瞬', '移', '遁', '掠', '突'], template: 'dash', element: 'metal' },
    { keys: ['击退', '震退', '崩', '撞'], template: 'push', element: 'earth' },
    { keys: ['焰', '火', '焚', '爆', '烈', '炎'], template: 'spiritMulti', element: 'fire' },
    { keys: ['冰', '霜', '寒', '冻', '雪'], template: 'spiritSingle', element: 'water' },
    { keys: ['雷', '电', '霆'], template: 'spiritSingle', element: 'metal' },
    { keys: ['刺', '斩', '刃', '剑', '枪', '锤', '爪', '拳', '掌'], template: 'physSingle', element: 'metal' },
    { keys: ['扫', '荡', '旋', '乱', '雨', '幕'], template: 'physMulti' },
    { keys: ['光', '圣', '净', '明'], template: 'spiritSingle', element: 'fire' },
    { keys: ['藤', '木', '林', '青'], template: 'controlPhys', element: 'wood' },
    { keys: ['岩', '石', '土', '泥'], template: 'physSingle', element: 'earth' },
    { keys: ['风', '气', '罡'], template: 'physSingle', element: 'wood' },
];

/* ---------------- 默认魂技库 ---------------- */

function sk(id, name, element, kind, opts) {
    return { id, name, element, kind, effects: [], desc: '', ...opts };
}

export const DEFAULT_SKILLS = [
    sk('split-stone', '裂石斩', 'earth', 'phys', {
        cost: 5, cd: 0, power: 1.0, poise: 18, range: 1, aoe: 0,
        target: 'enemy', desc: '最朴素的近身斩击，低耗、稳定削韧。',
    }),
    sk('mountain-break', '崩山击', 'earth', 'phys', {
        cost: 12, cd: 2, power: 1.55, poise: 55, range: 1, aoe: 0,
        target: 'enemy', desc: '高削韧强击，压韧性条的主力。',
    }),
    sk('silk-bind', '千丝缠绕', 'wood', 'control', {
        cost: 8, cd: 2, power: 0.6, poise: 26, range: 2, aoe: 0, control: 'bind', controlTurns: 1,
        target: 'enemy', desc: '物理束缚，时长取决于削韧占比与目标剩余韧性。',
        effects: [{ type: 'debuff', stat: 'spd', value: -25, mode: 'pct', turns: 2, chance: 100, label: '缠足' }],
    }),
    sk('flame-burst', '赤焰爆', 'fire', 'spirit', {
        cost: 11, cd: 1, power: 1.1, poise: 12, range: 3, aoe: 1,
        target: 'allEnemy', desc: '范围灼烧，附带持续伤害。',
        effects: [{ type: 'burn', value: 6, turns: 2, chance: 80, label: '灼烧' }],
    }),
    sk('frost-chain', '寒霜锁链', 'water', 'spirit', {
        cost: 10, cd: 2, power: 0.95, poise: 10, range: 4, aoe: 0, control: 'illusion', controlTurns: 1,
        target: 'enemy', desc: '幻境类冻结，精神越高控得越久。',
        effects: [{ type: 'debuff', stat: 'spd', value: -30, mode: 'pct', turns: 2, chance: 100, label: '寒霜' }],
    }),
    sk('piercing-thrust', '破军突刺', 'metal', 'phys', {
        cost: 9, cd: 1, power: 1.2, poise: 30, range: 2, aoe: 0, penetration: 25,
        target: 'enemy', desc: '无视 25% 防御的突刺。',
    }),
    sk('shield-of-qi', '玄龟护体', 'earth', 'shield', {
        cost: 9, cd: 2, power: 0, poise: 0, range: 0, aoe: 0, shieldPct: 0.22, shieldTurns: 3,
        target: 'self', desc: '按最大生命 22% 生成护盾，持续 3 回合。',
    }),
    sk('spring-heal', '春风化雨', 'wood', 'heal', {
        cost: 10, cd: 2, power: 1.3, poise: 0, range: 3, aoe: 0,
        target: 'ally', desc: '单体治疗，治疗量吃魂力与治疗加成。',
    }),
    sk('radiance', '光明礼赞', 'fire', 'buff', {
        cost: 12, cd: 3, power: 0, poise: 0, range: 0, aoe: 2,
        target: 'allAlly', desc: '群体攻击与暴击提升。',
        effects: [{ type: 'buff', stat: 'atk', value: 18, mode: 'pct', turns: 3, chance: 100, label: '礼赞' }],
    }),
    sk('weaken-eye', '削弱之瞳', 'water', 'debuff', {
        cost: 9, cd: 2, power: 0, poise: 0, range: 4, aoe: 0,
        target: 'enemy', desc: '削减目标防御与精神。',
        effects: [
            { type: 'buff', stat: 'def', value: -28, mode: 'pct', turns: 2, chance: 100, label: '破甲' },
            { type: 'buff', stat: 'spi', value: -20, mode: 'pct', turns: 2, chance: 100, label: '失神' },
        ],
    }),
    sk('thunder-storm', '万钧雷霆', 'metal', 'spirit', {
        cost: 16, cd: 3, power: 0.95, poise: 25, range: 5, aoe: 1, penetration: 15,
        target: 'allEnemy', desc: '大范围雷击，附带短暂麻痹。',
        effects: [{ type: 'stun', turns: 1, chance: 35, label: '麻痹' }],
    }),
    sk('true-body', '武魂真身', 'earth', 'buff', {
        cost: 20, cd: 4, power: 0, poise: 0, range: 0, aoe: 0,
        target: 'self', desc: '全属性大幅提升，持续 3 回合。',
        effects: [
            { type: 'buff', stat: 'atk', value: 35, mode: 'pct', turns: 3, chance: 100, label: '真身' },
            { type: 'buff', stat: 'def', value: 35, mode: 'pct', turns: 3, chance: 100, label: '真身' },
            { type: 'buff', stat: 'spd', value: 20, mode: 'pct', turns: 3, chance: 100, label: '真身' },
        ],
    }),
];

/* ---------------- 功法 ---------------- */

// mods 用派生值键名，百分比后缀 Pct
export const TECHNIQUES = {
    'chongtian': { id: 'chongtian', name: '冲天诀', rarity: 'blue', mods: { atkPct: 8, critDmgPct: 6 }, desc: '力道贯通，攻击与爆伤提升。' },
    'jingshen': { id: 'jingshen', name: '凝神诀', rarity: 'blue', mods: { spiPct: 10, ctrlPct: 12 }, desc: '精神凝练，控制类时长增加。' },
    'tiegu': { id: 'tiegu', name: '铁骨功', rarity: 'green', mods: { vitPct: 10, poisePct: 12 }, desc: '体魄坚韧，抗击退抗削韧。' },
    'liuyun': { id: 'liuyun', name: '流云步', rarity: 'green', mods: { agiPct: 10, moveFlat: 1 }, desc: '身法轻快，移动格数 +1。' },
    'xuanming': { id: 'xuanming', name: '玄冥劲', rarity: 'purple', mods: { penetrationFlat: 12, atkPct: 6 }, desc: '穿透防御的阴劲。' },
    'bufa': { id: 'bufa', name: '不灭金身', rarity: 'purple', mods: { defPct: 15, shieldPct: 20 }, desc: '护体金身，护盾效率提升。' },
    'huichun': { id: 'huichun', name: '回春术', rarity: 'green', mods: { healPct: 18, souPct: 8 }, desc: '治疗效率提升。' },
    'jifeng': { id: 'jifeng', name: '疾风诀', rarity: 'blue', mods: { spdPct: 10, atkSpdFlat: 10 }, desc: '出手更快。' },
    'poshi': { id: 'poshi', name: '破势诀', rarity: 'blue', mods: { poiseDmgPct: 20 }, desc: '削韧效率 +20%，破防更快。' },
    'guixi': { id: 'guixi', name: '龟息功', rarity: 'green', mods: { hpPct: 12, ctrlResistPct: 15 }, desc: '抗控制。' },
};

export const RARITY = {
    green: { id: 'green', name: '绿', color: '#5fd6a4' },
    blue: { id: 'blue', name: '蓝', color: '#6fb7ff' },
    purple: { id: 'purple', name: '紫', color: '#c9a0ff' },
    orange: { id: 'orange', name: '橙', color: '#ffb45c' },
    red: { id: 'red', name: '红', color: '#ff6b6b' },
};

/* ---------------- 通用装备 ---------------- */

export const EQUIP_SLOTS = ['weapon', 'armor', 'accessory'];

export const EQUIP_SLOT_NAMES = {
    weapon: '武器',
    armor: '护甲',
    accessory: '饰品',
};

export const DEFAULT_EQUIPMENT = [
    { id: 'iron-sword', name: '精铁剑', slot: 'weapon', quality: 'normal', mods: { atk: 18 }, desc: '最普通的制式短剑。' },
    { id: 'spirit-blade', name: '魂导战刃', slot: 'weapon', quality: 'fine', mods: { atk: 42, penetrationFlat: 8 }, desc: '刻有魂导纹路的战刃。' },
    { id: 'heavy-hammer', name: '玄铁重锤', slot: 'weapon', quality: 'fine', mods: { atk: 55, spd: -6, poiseDmgPct: 10 }, desc: '重，但削韧强。' },
    { id: 'leather-armor', name: '皮甲', slot: 'armor', quality: 'normal', mods: { def: 12, maxHp: 60 }, desc: '轻便护具。' },
    { id: 'iron-plate', name: '玄铁重铠', slot: 'armor', quality: 'fine', mods: { def: 40, maxHp: 180, spdPct: -8 }, desc: '防御高，拖速度。' },
    { id: 'agility-boots', name: '疾风靴', slot: 'accessory', quality: 'fine', mods: { spd: 12, moveFlat: 1 }, desc: '提升移动与速度。' },
    { id: 'crit-ring', name: '暴击指环', slot: 'accessory', quality: 'fine', mods: { critPct: 8, critDmgPct: 20 }, desc: '暴击流核心。' },
    { id: 'guardian-talisman', name: '护身符', slot: 'accessory', quality: 'green', mods: { maxPoise: 30, sdef: 10 }, desc: '稳固韧性条，抗打断。' },
    { id: 'pierce-needle', name: '穿甲针', slot: 'accessory', quality: 'blue', mods: { penetrationFlat: 18, hitPct: 4 }, desc: '专破高防目标。' },
];

/* ---------------- 魂骨库 ---------------- */

// 魂骨是独立槽位，按年限给属性，可附带魂技
export const DEFAULT_BONES = [
    { id: 'head-1k', name: '千年头部魂骨', slot: 'head', year: 1000, mods: { spi: 20, hitPct: 3 }, desc: '精神凝聚。' },
    { id: 'torso-10k', name: '万年躯干魂骨', slot: 'torso', year: 10000, mods: { vit: 40, maxHp: 260 }, desc: '气血充盈。' },
    { id: 'arm-1k', name: '千年臂骨', slot: 'rightArm', year: 1000, mods: { str: 22, atkPct: 6 }, desc: '力发于臂。' },
    { id: 'leg-10k', name: '万年腿骨', slot: 'leftLeg', year: 10000, mods: { agi: 38, spdPct: 8, moveFlat: 1 }, desc: '疾行如风。' },
    { id: 'leg-100k', name: '十万年腿部魂骨', slot: 'leftLeg', year: 100000, mods: { agi: 70, spdPct: 15, moveFlat: 2, atkSpdFlat: 15 }, desc: '踏空而行。' },
];

/* ---------------- 战场 ---------------- */

export const BATTLEFIELD = {
    width: 12,
    height: 8,
    // 我方出生区 / 敌方出生区
    allyZone: { x0: 0, x1: 3 },
    enemyZone: { x0: 8, x1: 11 },
    // 相邻判定用切比雪夫距离（八方向）
    diagonal: true,
};

/* ---------------- 预设单位 ---------------- */

export const PRESET_UNITS = [
    {
        id: 'p-min',
        name: '我方·敏攻系魂师',
        lv: 32,
        quality: 'fine',
        role: 'agility',
        martial: '疾风魔狼',
        element: 'metal',
        attrs: { str: 14, vit: 11, agi: 19, spi: 12, sou: 13 },
        rings: [
            { year: 300, skills: ['piercing-thrust'] },
            { year: 1200, skills: ['split-stone'] },
            { year: 3500, skills: ['thunder-storm'] },
        ],
        techniques: ['chongtian', 'jifeng'],
        equipment: ['spirit-blade', 'agility-boots', 'crit-ring'],
        bones: [],
        side: 'ally',
        pos: { x: 4, y: 3 },
    },
    {
        id: 'p-ctl',
        name: '我方·控制系魂师',
        lv: 31,
        quality: 'fine',
        role: 'control',
        martial: '蓝银草',
        element: 'wood',
        attrs: { str: 9, vit: 12, agi: 13, spi: 20, sou: 16 },
        rings: [
            { year: 400, skills: ['silk-bind'] },
            { year: 1500, skills: ['weaken-eye'] },
            { year: 4000, skills: ['radiance'] },
        ],
        techniques: ['jingshen', 'poshi'],
        equipment: ['leather-armor', 'guardian-talisman'],
        bones: [{ id: 'head-1k', year: 1000 }],
        side: 'ally',
        pos: { x: 3, y: 4 },
    },
    {
        id: 'e-atk',
        name: '对手·强攻系魂师',
        lv: 33,
        quality: 'fine',
        role: 'attack',
        martial: '暗金恐爪熊',
        element: 'metal',
        attrs: { str: 22, vit: 16, agi: 12, spi: 10, sou: 11 },
        rings: [
            { year: 500, skills: ['mountain-break'] },
            { year: 2000, skills: ['flame-burst'] },
            { year: 5000, skills: ['true-body'] },
        ],
        techniques: ['chongtian'],
        equipment: ['heavy-hammer', 'iron-plate'],
        bones: [{ id: 'arm-1k', year: 1000 }],
        side: 'enemy',
        pos: { x: 8, y: 3 },
    },
    {
        id: 'e-def',
        name: '对手·防御系魂师',
        lv: 30,
        quality: 'normal',
        role: 'defense',
        martial: '玄龟',
        element: 'earth',
        attrs: { str: 15, vit: 22, agi: 9, spi: 10, sou: 12 },
        rings: [
            { year: 400, skills: ['shield-of-qi'] },
            { year: 1800, skills: ['split-stone'] },
        ],
        techniques: ['tiegu', 'guixi'],
        equipment: ['iron-plate'],
        bones: [{ id: 'torso-10k', year: 10000 }],
        side: 'enemy',
        pos: { x: 9, y: 4 },
    },
];

/* ---------------- 查询 ---------------- */

const ALL_SKILLS = [...DEFAULT_SKILLS];

/** 注册解析出来的魂技，供 findSkill 查找 */
export function registerSkills(list) {
    for (const s of list || []) {
        const i = ALL_SKILLS.findIndex((x) => x.id === s.id);
        if (i >= 0) ALL_SKILLS[i] = s;
        else ALL_SKILLS.push(s);
    }
}

export function findSkill(id) {
    return ALL_SKILLS.find((s) => s.id === id) || null;
}

export function allSkills() {
    return ALL_SKILLS.slice();
}

export function findEquipment(id) {
    return DEFAULT_EQUIPMENT.find((e) => e.id === id) || null;
}

export function findBone(id) {
    return DEFAULT_BONES.find((b) => b.id === id) || null;
}

export function findTechnique(id) {
    return TECHNIQUES[id] || null;
}
