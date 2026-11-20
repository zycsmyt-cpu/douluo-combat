// douluo-combat / engine.js
// 战斗内核：纯函数 + Battle 类，不碰 DOM、不依赖宿主。
// 行动用行动条（ATB）推进，位置用网格坐标。

import {
    ELEMENT_BEATS,
    BATTLEFIELD,
    BONE_SLOT_ATTR,
    QUALITY,
    ROLES,
    RING_TIERS,
    boneTierOf,
    ringTierOf,
    findSkill,
    findEquipment,
    findBone,
    findTechnique,
} from './data.js';

// 单位身上的魂技/魂骨/功法/装备可以是 id（引用模板库），也可以是完整对象（单位私有）。
// 统一用这几个归一化，改动只影响拿到的那个对象，不污染全局模板。
export const resolveSkill = (x) => (!x ? null : (typeof x === 'string' ? findSkill(x) : x));
export const resolveBone = (x) => (!x ? null : (typeof x === 'string' ? findBone(x) : x));
export const resolveTech = (x) => (!x ? null : (typeof x === 'string' ? findTechnique(x) : x));
export const resolveEquip = (x) => (!x ? null : (typeof x === 'string' ? findEquipment(x) : x));

// 取一个稳定的 id：对象直接读 id，字符串原样返回
export const idOf = (x) => (typeof x === 'string' ? x : (x && x.id) || '');

export const CONFIG = {
    defenseK: 120,          // 减免率 = 有效防御 / (有效防御 + K)
    hitMin: 5,
    hitMax: 98,
    critCap: 90,
    penCap: 80,             // 穿透上限 %
    breakMultiplier: 1.5,   // 破防期间受伤倍率
    poiseRegenDelay: 2,
    poiseRegenRatio: 0.5,
    counterUp: 1.5,         // 克制：伤害 ×1.5（互克也走这条）
    counterDown: 0.5,       // 被克：伤害 ×0.5
    minDamage: 1,
    atbMax: 100,
    atbSpeed: 0.08,         // 行动条积累系数（每 tick 充能 = spd * atkSpd/100 * 该值）
    ticksPerRound: 12,
    controlMaxTurns: 4,
    shakeMax: 6,            // 单次位移上限格数
};

/* ---------------- 随机 ---------------- */

export function mulberry32(seed) {
    let a = Number(seed) >>> 0 || 1;
    return function rng() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Dice {
    constructor(rng) {
        this.rng = typeof rng === 'function' ? rng : Math.random;
    }

    d100() {
        return Math.floor(this.rng() * 100) + 1;
    }

    d10() {
        return Math.floor(this.rng() * 10) + 1;
    }

    chance(pct) {
        return this.d100() <= pct;
    }

    pick(list) {
        return list[Math.floor(this.rng() * list.length)];
    }
}

/* ---------------- 基础工具 ---------------- */

export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// 属性关系，只有四种结果：
//   up     = A 克 B（B 不克 A）→ A 打 B ×1.5
//   down   = B 克 A（A 不克 B）→ A 打 B ×0.5
//   mutual = 互克（光暗、时空那种）→ 只保留增伤，双方都 ×1.5
//   none   = 无关 → ×1
export function elementRelation(attacker, defender) {
    const a = String(attacker || '');
    const d = String(defender || '');
    if (!a || !d || a === d) return 'none';
    const aBeats = (ELEMENT_BEATS[a] || []).includes(d);
    const dBeats = (ELEMENT_BEATS[d] || []).includes(a);
    if (aBeats && dBeats) return 'mutual';
    if (aBeats) return 'up';
    if (dBeats) return 'down';
    return 'none';
}

export function elementMultiplier(attacker, defender) {
    const rel = elementRelation(attacker, defender);
    if (rel === 'up' || rel === 'mutual') return CONFIG.counterUp;
    if (rel === 'down') return CONFIG.counterDown;
    return 1;
}

export function distance(a, b) {
    if (!a || !b) return 99;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/* ---------------- 派生值 ---------------- */

function applyMods(s, mods) {
    for (const [k, v] of Object.entries(mods || {})) {
        const name = k.replace(/(Pct|Flat)$/, '');
        if (!(name in s) || typeof s[name] !== 'number') continue;
        if (k.endsWith('Pct')) s[name] *= 1 + v / 100;
        else s[name] += v;
    }
}const ATTR_KEYS = ['str', 'vit', 'agi', 'spi', 'sou'];

export function computeStats(unit) {
    const quality = QUALITY[unit.quality] || QUALITY.normal;
    const role = ROLES[unit.role] || null;
    const lv = Number(unit.lv) || 1;
    const raw = unit.attrs || {};

    // ---------- 1. 收集所有修饰 ----------
    const attrFlat = { str: 0, vit: 0, agi: 0, spi: 0, sou: 0 };
    const attrPct = { str: 0, vit: 0, agi: 0, spi: 0, sou: 0 };
    const flat = {};
    const pct = {};
    let ringHp = 0;
    let ringMp = 0;
    let ringAtk = 0;
    let ringSatk = 0;
    let ringPoise = 0;

    const collect = (mods) => {
        for (const [k, v] of Object.entries(mods || {})) {
            const isPct = k.endsWith('Pct');
            const isFlat = k.endsWith('Flat');
            const name = k.replace(/(Pct|Flat)$/, '');
            if (isPct) {
                if (name in attrPct) attrPct[name] += v;
                else pct[name] = (pct[name] || 0) + v;
            } else if (isFlat) {
                if (name in attrFlat) attrFlat[name] += v;
                else flat[name] = (flat[name] || 0) + v;
            } else if (k in attrFlat) {
                attrFlat[k] += v;
            } else {
                flat[k] = (flat[k] || 0) + v;
            }
        }
    };

    // 魂环：按档位给固定点数
    for (const ring of unit.rings || []) {
        const tier = ringTierOf(ring.year);
        const k = tier.attr * quality.ringMul * tier.mod;
        ringHp += k * 4;
        ringMp += k * 2;
        ringAtk += k * 0.6;
        ringSatk += k * 0.6;
        ringPoise += k;
    }

    // 魂骨
    for (const bone of unit.bones || []) {
        let def = typeof bone === 'string' ? findBone(bone) : bone;
        if (def && def.id) {
            const base = findBone(def.id);
            if (base) def = { ...base, ...def };
        }
        if (!def) continue;
        const tier = boneTierOf(def.year || 1000);
        const slot = def.slot || 'torso';
        const attr = BONE_SLOT_ATTR[slot] || 'vit';
        const k = tier.attr * quality.ringMul;
        ringHp += k * 3;
        ringPoise += k * 0.8;
        attrFlat[attr] += k;
        if (attr === 'spi') pct.ctrlPct = (pct.ctrlPct || 0) + 4;
        collect(def.mods || {});
    }

    // 功法
    for (const t of unit.techniques || []) {
        const tech = typeof t === 'string' ? findTechnique(t) : t;
        if (tech) collect(tech.mods || {});
    }

    // 装备
    for (const e of unit.equipment || []) {
        const def = typeof e === 'string' ? findEquipment(e) : e;
        if (def) collect(def.mods || {});
    }

    // ---------- 2. 五维 ----------
    const a = {};
    for (const k of ATTR_KEYS) {
        const base = Number(raw[k]) || 0;
        const w = role && role.attrs[k] != null ? role.attrs[k] : 1;
        a[k] = (base * w * quality.mul + attrFlat[k]) * (1 + (attrPct[k] || 0) / 100);
    }

    // ---------- 3. 派生 ----------
    const s = {
        maxHp: 60 + a.vit * 12 + lv * 6 + ringHp,
        maxMp: 30 + a.sou * 10 + lv * 2 + ringMp,
        atk: 8 + a.str * 2.2 + lv * 1.2 + ringAtk,
        def: 4 + a.str * 1.1 + a.vit * 1.4,
        satk: 8 + a.spi * 2.2 + a.sou * 0.8 + ringSatk,
        sdef: 4 + a.spi * 1.2 + a.sou * 1.2,
        spd: 10 + a.agi * 2.4,
        move: 2 + Math.floor(a.agi / 10),
        atkSpd: 100 + a.agi * 0.5,
        hit: 78 + a.agi * 1.1 + a.spi * 0.3,
        eva: 4 + a.agi * 1.15,
        crit: 6 + a.spi * 0.6 + a.agi * 0.2,
        critDmg: 160 + a.spi * 1.2,
        maxPoise: 50 + a.vit * 2.5 + lv * 1.5 + ringPoise,
        penetration: 0,
        shieldMax: 0,
        poiseDmgPct: 0,
        ctrlPct: 0,
        ctrlResistPct: 0,
        healPct: 0,
        shieldPct: 0,
        buffPct: 0,
    };

    // 类型固有加成
    if (role && role.derived) {
        for (const [k, v] of Object.entries(role.derived)) {
            const name = k.replace(/(Pct|Flat)$/, '');
            if (k.endsWith('Pct')) {
                if (name === 'atk' || name === 'def' || name === 'spd' || name === 'satk' || name === 'sdef' || name === 'maxHp') {
                    s[name] *= 1 + v / 100;
                } else if (name in s) {
                    s[name] += v;
                }
            } else if (name in s) {
                s[name] += v;
            }
        }
    }

    // ---------- 4. 平面加成 / 百分比 ----------
    for (const [k, v] of Object.entries(flat)) {
        if (k in s && typeof s[k] === 'number') s[k] += v;
    }
    for (const [k, v] of Object.entries(pct)) {
        if (k in s && typeof s[k] === 'number') s[k] *= 1 + v / 100;
    }

    // ---------- 5. 增益 / 减益 ----------
    for (const b of unit.buffs || []) {
        const key = b.stat;
        if (!key) continue;
        const v = Number(b.value) || 0;
        if (key in a) {
            a[key] *= b.mode === 'pct' ? 1 + v / 100 : 1;
            if (b.mode !== 'pct') a[key] += v;
        } else if (key in s && typeof s[key] === 'number') {
            if (b.mode === 'pct') s[key] *= 1 + v / 100;
            else s[key] += v;
        }
    }

    // ---------- 6. 收敛 ----------
    s.crit = clamp(s.crit, 0, CONFIG.critCap);
    s.hit = clamp(s.hit, CONFIG.hitMin, CONFIG.hitMax);
    s.eva = Math.max(0, s.eva);
    s.penetration = clamp(s.penetration, 0, CONFIG.penCap);
    s.maxHp = Math.max(1, s.maxHp);
    s.maxMp = Math.max(0, s.maxMp);
    s.maxPoise = Math.max(1, s.maxPoise);
    s.move = Math.max(1, Math.round(s.move));
    s.spd = Math.max(1, s.spd);
    s.atkSpd = Math.max(20, s.atkSpd);
    s.attrs = a;
    return s;
}

export function syncVitals(unit) {
    const s = computeStats(unit);
    unit.maxHp = Math.round(s.maxHp);
    unit.maxMp = Math.round(s.maxMp);
    unit.maxPoise = Math.round(s.maxPoise);
    if (unit.hp > unit.maxHp) unit.hp = unit.maxHp;
    if (unit.mp > unit.maxMp) unit.mp = unit.maxMp;
    if (unit.poise > unit.maxPoise) unit.poise = unit.maxPoise;
    return s;
}

/* ---------------- 单位 ---------------- */

let unitSeq = 0;

export function createUnit(cfg, side) {
    unitSeq += 1;
    const u = {
        uid: `${side || 'ally'}-${unitSeq}`,
        side: side || 'ally',
        name: cfg.name || '无名魂师',
        lv: Number(cfg.lv) || 1,
        quality: QUALITY[cfg.quality] ? cfg.quality : 'normal',
        role: ROLES[cfg.role] ? cfg.role : null,
        martial: cfg.martial || '',
        element: cfg.element || 'earth',
        attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10, ...(cfg.attrs || {}) },
        rings: (cfg.rings || []).map((r) => ({ ...r })),
        bones: (cfg.bones || []).map((b) => (typeof b === 'string' ? b : { ...b })),
        techniques: (cfg.techniques || []).map((t) => (typeof t === 'string' ? t : { ...t })),
        equipment: (cfg.equipment || []).map((e) => (typeof e === 'string' ? e : { ...e })),
        skills: (cfg.skills || []).map((s) => (typeof s === 'string' ? s : { ...s })),
        pos: cfg.pos ? { x: cfg.pos.x, y: cfg.pos.y } : null,
        buffs: [],
        alive: true,
        hp: 1,
        mp: 0,
        poise: 1,
        shield: 0,
        shieldTurns: 0,
        atb: 0,
        cds: {},
        stunned: 0,
        brokenTurns: 0,
        poiseTimer: 0,
        moved: 0,
    };

    // 魂环上挂的魂技一并收进技能池（技能可能是 id，也可能是本单位私有的对象）
    const skillIdOf = (s) => (typeof s === 'string' ? s : (s && s.id));
    const hasSkill = (id) => u.skills.some((s) => skillIdOf(s) === id);
    for (const r of u.rings) {
        for (const s of r.skills || []) {
            const sk = resolveSkill(s);
            if (sk && !hasSkill(sk.id)) u.skills.push(typeof s === 'string' ? s : { ...sk });
        }
    }
    // 魂骨附带的魂技
    for (const b of u.bones) {
        const def = typeof b === 'string' ? findBone(b) : b;
        if (def && def.skill && !hasSkill(def.skill)) u.skills.push(def.skill);
    }

    const s = computeStats(u);
    u.hp = Math.round(s.maxHp);
    u.mp = Math.round(s.maxMp);
    u.poise = Math.round(s.maxPoise);
    u.maxHp = Math.round(s.maxHp);
    u.maxMp = Math.round(s.maxMp);
    u.maxPoise = Math.round(s.maxPoise);
    if (!u.pos) {
        u.pos = { x: side === 'enemy' ? 9 : 2, y: 3 };
    }
    return u;
}

export function statBlock(unit) {
    const s = computeStats(unit);
    const maxHp = Math.round(s.maxHp);
    return {
        maxHp,
        hp: Math.min(unit.hp, maxHp),
        maxMp: Math.round(s.maxMp),
        mp: Math.round(unit.mp),
        maxPoise: Math.round(s.maxPoise),
        poise: Math.round(unit.poise),
        shield: Math.round(unit.shield || 0),
        atk: Math.round(s.atk),
        def: Math.round(s.def),
        satk: Math.round(s.satk),
        sdef: Math.round(s.sdef),
        spd: Math.round(s.spd * 10) / 10,
        move: s.move,
        atkSpd: Math.round(s.atkSpd),
        hit: Math.round(s.hit),
        eva: Math.round(s.eva),
        crit: Math.round(s.crit * 10) / 10,
        critDmg: Math.round(s.critDmg),
        penetration: Math.round(s.penetration),
        broken: unit.brokenTurns > 0,
        atb: Math.round(unit.atb || 0),
    };
}

/* ---------------- 基础攻击 ---------------- */

export const BASIC_ATTACK = {
    id: 'basic',
    name: '普通攻击',
    element: null,
    kind: 'phys',
    cost: 0,
    cd: 0,
    power: 1.0,
    poise: 12,
    range: 1,
    aoe: 0,
    target: 'enemy',
    effects: [],
    desc: '不消耗魂力的近身攻击。',
};

/* ---------------- 战斗 ---------------- */

export class Battle {
    constructor(opts = {}) {
        this.field = opts.field || BATTLEFIELD;
        this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
        this.dice = new Dice(this.rng);
        this.units = [];
        for (const a of opts.allies || []) this.units.push(createUnit(a, 'ally'));
        for (const e of opts.enemies || []) this.units.push(createUnit(e, 'enemy'));
        this.round = 0;
        this.tickCount = 0;
        this.actions = 0;
        this.log = [];
        this.finished = false;
        this.winner = null;
        this.currentUnit = null;
        this.ensurePositions();
    }

    /* --- 站位 --- */

    ensurePositions() {
        const used = new Set();
        const place = (u, zone) => {
            if (u.pos && u.pos.x >= 0 && u.pos.x < this.field.width && u.pos.y >= 0 && u.pos.y < this.field.height) {
                const k = `${u.pos.x},${u.pos.y}`;
                if (!used.has(k)) { used.add(k); return; }
            }
            for (let y = 0; y < this.field.height; y += 1) {
                for (let x = zone.x0; x <= zone.x1; x += 1) {
                    const k = `${x},${y}`;
                    if (!used.has(k)) { used.add(k); u.pos = { x, y }; return; }
                }
            }
            u.pos = { x: zone.x0, y: 0 };
        };
        for (const u of this.units) {
            place(u, u.side === 'ally' ? this.field.allyZone : this.field.enemyZone);
        }
    }

    inBounds(x, y) {
        return x >= 0 && x < this.field.width && y >= 0 && y < this.field.height;
    }

    // 紧贴场地的一圈格子：走进去等于主动撤出演武场
    outRing(x, y) {
        const W = this.field.width;
        const H = this.field.height;
        return x >= -1 && x <= W && y >= -1 && y <= H && !this.inBounds(x, y);
    }

    occupied(x, y, exceptUid) {
        return this.units.find((u) => u.alive && u.uid !== exceptUid && u.pos.x === x && u.pos.y === y) || null;
    }

    /* --- 查询 --- */

    aliveOf(side) {
        return this.units.filter((u) => u.alive && (!side || u.side === side));
    }

    byUid(uid) {
        return this.units.find((u) => u.uid === uid) || null;
    }

    enemiesOf(unit) {
        return this.aliveOf(unit.side === 'ally' ? 'enemy' : 'ally');
    }

    alliesOf(unit) {
        return this.aliveOf(unit.side);
    }

    nearestEnemy(unit, maxRange) {
        const list = this.enemiesOf(unit);
        if (!list.length) return null;
        let best = null;
        let bestD = 999;
        for (const e of list) {
            const d = distance(unit.pos, e.pos);
            if (d < bestD) { bestD = d; best = e; }
        }
        if (maxRange != null && bestD > maxRange) return best;
        return best;
    }

    /* --- 行动条 --- */

    refreshCurrent() {
        if (this.finished) { this.currentUnit = null; return; }
        let guard = 0;
        while (guard < 800) {
            guard += 1;
            let pick = null;
            for (const u of this.aliveOf()) {
                if (u.atb >= CONFIG.atbMax && (!pick || u.atb > pick.atb)) pick = u;
            }
            if (pick) { this.currentUnit = pick; return; }

            for (const u of this.aliveOf()) {
                const s = computeStats(u);
                u.atb = Math.min(300, (u.atb || 0) + s.spd * (s.atkSpd / 100) * CONFIG.atbSpeed);
            }
            this.tickCount += 1;
            const nr = Math.floor(this.tickCount / CONFIG.ticksPerRound) + 1;
            if (nr !== this.round) {
                this.round = nr;
                this.nextRound();
            }
        }
        this.currentUnit = null;
    }

    current() {
        return this.currentUnit;
    }

    /* --- 开始 --- */

    start() {
        this.log = [];
        this.round = 1;
        this.tickCount = 0;
        this.actions = 0;
        const ev = [];
        const push = (o) => { ev.push(o); this.log.push(o); return o; };

        push({ t: 'sys', text: `【斗魂开始】${this.aliveOf('ally').length} 人 vs ${this.aliveOf('enemy').length} 人，战场 ${this.field.width}×${this.field.height}` });

        for (const u of this.aliveOf()) {
            u.atb = this.dice.d100() * 0.4;
        }

        const order = this.aliveOf()
            .slice()
            .sort((a, b) => computeStats(b).spd - computeStats(a).spd);
        push({
            t: 'sys',
            text: `速度序：${order.map((u) => `${u.name}(SPD ${Math.round(computeStats(u).spd)})`).join(' → ')}`,
        });

        this.refreshCurrent();
        return ev;
    }

    /* --- 回合推进 --- */

    nextRound() {
        for (const u of this.aliveOf()) {
            if (u.buffs && u.buffs.length) {
                for (const b of u.buffs) b.turns -= 1;
                u.buffs = u.buffs.filter((b) => b.turns > 0);
            }
            if (u.shieldTurns > 0) {
                u.shieldTurns -= 1;
                if (u.shieldTurns <= 0) u.shield = 0;
            }
            if (u.poiseTimer > 0) u.poiseTimer -= 1;
            else if (u.poise < computeStats(u).maxPoise) {
                u.poise = Math.min(computeStats(u).maxPoise, u.poise + computeStats(u).maxPoise * CONFIG.poiseRegenRatio);
            }
            if (u.cds) {
                for (const k of Object.keys(u.cds)) {
                    u.cds[k] = Math.max(0, u.cds[k] - 1);
                    if (u.cds[k] === 0) delete u.cds[k];
                }
            }
            const s = computeStats(u);
            u.mp = Math.min(Math.round(s.maxMp), u.mp + Math.round(s.maxMp * 0.12));
            u.moved = 0;
        }
        syncVitalsAll(this);
    }

    /* --- 可用魂技 --- */

    availableSkills(unit) {
        const out = [];
        for (const raw of unit.skills || []) {
            const sk = resolveSkill(raw);
            if (!sk) continue;
            const cd = (unit.cds && unit.cds[sk.id]) || 0;
            if (cd > 0) continue;
            if ((sk.cost || 0) > unit.mp) continue;
            out.push(sk);
        }
        return out;
    }

    // 技能优先从单位自己身上取（每人独立），取不到再回落全局库
    ownSkill(unit, id) {
        for (const raw of unit.skills || []) {
            const sk = resolveSkill(raw);
            if (sk && sk.id === id) return sk;
        }
        return null;
    }

    /* --- 主行动 --- */

    act(skillId, targetUid, opts = {}) {
        const ev = [];
        const push = (o) => { ev.push(o); this.log.push(o); return o; };

        this.refreshCurrent();
        const actor = this.currentUnit;
        if (!actor || this.finished) return ev;

        // 硬直
        if (actor.brokenTurns > 0) {
            actor.brokenTurns = 0;
            push({ t: 'sys', text: `${actor.name} 处于破防硬直，跳过本回合。` });
            this.endTurn(actor);
            return ev;
        }
        if (actor.stunned > 0) {
            actor.stunned -= 1;
            push({ t: 'sys', text: `${actor.name} 被控制，无法行动。` });
            this.endTurn(actor);
            return ev;
        }

        // 移动
        if (skillId === 'move') {
            const { x, y } = opts;
            if (!this.tryMove(actor, x, y, push)) return ev;
            this.endTurn(actor);
            return ev;
        }

        const skill = skillId === 'basic' ? BASIC_ATTACK : (this.ownSkill(actor, skillId) || findSkill(skillId));
        if (!skill) { push({ t: 'sys', text: '没有这个魂技。' }); return ev; }

        const cd = (actor.cds && actor.cds[skill.id]) || 0;
        if (cd > 0) { push({ t: 'sys', text: `「${skill.name}」冷却中（${cd} 回合）。` }); return ev; }
        if ((skill.cost || 0) > actor.mp) {
            push({ t: 'sys', text: `魂力不足，「${skill.name}」需要 ${skill.cost}。` });
            return ev;
        }

        // 目标解析
        let targets = [];
        if (skill.target === 'self') {
            targets = [actor];
        } else if (skill.target === 'allAlly' || skill.target === 'allEnemy') {
            const pool = skill.target === 'allAlly' ? this.alliesOf(actor) : this.enemiesOf(actor);
            targets = this.pickAoeTargets(actor, pool, skill);
        } else if (skill.target === 'ally') {
            const t = targetUid ? this.byUid(targetUid) : null;
            targets = [t && t.alive && t.side === actor.side ? t : this.lowestHpAlly(actor)];
        } else {
            const t = targetUid ? this.byUid(targetUid) : null;
            targets = [t && t.alive ? t : this.nearestEnemy(actor, skill.range)];
        }
        targets = targets.filter(Boolean);

        if (!targets.length) {
            push({ t: 'sys', text: `${actor.name} 找不到目标。` });
            return ev;
        }

        // 射程检查（只对敌我相对的单体技能生效）
        if (skill.target !== 'self' && skill.target !== 'allAlly') {
            const far = targets.find((t) => distance(actor.pos, t.pos) > (skill.range || 1) + (skill.aoe || 0));
            if (far) {
                push({
                    t: 'sys',
                    text: `${actor.name} 与 ${far.name} 距离 ${distance(actor.pos, far.pos)} 格，超出「${skill.name}」射程 ${skill.range}，这次行动作废。`,
                });
                // 超射程仍然结束这次行动，否则外部驱动（AI / 测试）会原地卡死
                this.endTurn(actor);
                return ev;
            }
        }

        actor.mp -= skill.cost || 0;
        if (skill.cd) actor.cds[skill.id] = skill.cd;

        push({
            t: 'act',
            actor: actor.uid,
            text: `${actor.name} 使用「${skill.name}」。`,
        });

        if (skill.move === 'dash') this.doDash(actor, targets[0], push);

        for (const t of targets) {
            if (!t.alive && skill.kind !== 'heal' && skill.kind !== 'buff') continue;
            this.resolve(actor, t, skill, push);
            if (this.checkEnd(push)) break;
        }

        if (skill.move === 'push') {
            for (const t of targets) if (t.alive) this.doPush(actor, t, push);
        }

        this.endTurn(actor);
        return ev;
    }

    pickAoeTargets(actor, pool, skill) {
        if (!skill.aoe) return pool.slice();
        if (skill.target === 'allAlly') return pool.slice();
        // 群体攻击：以最近的敌人为圆心
        const center = this.nearestEnemy(actor, 99);
        if (!center || !pool.includes(center)) return pool.slice(0, 1);
        return pool.filter((u) => distance(u.pos, center.pos) <= skill.aoe);
    }

    lowestHpAlly(actor) {
        const list = this.alliesOf(actor);
        if (!list.length) return actor;
        return list.slice().sort((a, b) => a.hp / computeStats(a).maxHp - b.hp / computeStats(b).maxHp)[0];
    }

    endTurn(actor) {
        this.actions += 1;
        actor.atb = Math.max(0, actor.atb - CONFIG.atbMax);
        // 攻速溢出：行动条额外回补
        const s = computeStats(actor);
        if (s.atkSpd > 100) actor.atb += Math.min(60, (s.atkSpd - 100) * 0.3);
        this.refreshCurrent();
    }

    /* --- 位移 --- */

    tryMove(unit, x, y, push) {
        const s = computeStats(unit);
        // 走到场地外圈 = 尝试撤出演武场，要过骰子判定
        if (this.outRing(x, y)) {
            const d = distance(unit.pos, { x, y });
            const budget = s.move - (unit.moved || 0);
            if (d > budget) {
                push({ t: 'sys', text: `${unit.name} 本回合只能再走 ${budget} 格（移速 ${s.move}），够不到场外。` });
                return false;
            }
            this.attemptEscape(unit, push);
            return true;
        }
        if (!this.inBounds(x, y)) { push({ t: 'sys', text: '目标格超出战场。' }); return false; }
        const d = distance(unit.pos, { x, y });
        const budget = s.move - (unit.moved || 0);
        if (d > budget) {
            push({ t: 'sys', text: `${unit.name} 本回合只能再走 ${budget} 格（移速 ${s.move}）。` });
            return false;
        }
        if (this.occupied(x, y, unit.uid)) { push({ t: 'sys', text: '那格已经有单位了。' }); return false; }
        const from = `${unit.pos.x},${unit.pos.y}`;
        unit.pos = { x, y };
        unit.moved = (unit.moved || 0) + d;
        push({ t: 'move', actor: unit.uid, text: `${unit.name} 从 ${from} 移动到 ${x},${y}（${d} 格）。` });
        return true;
    }

    // 主动撤出演武场：掷 d100 判定，看闪避和移速
    attemptEscape(unit, push) {
        const s = computeStats(unit);
        const chance = clamp(Math.round(55 + (s.eva - 20) * 0.8 + (s.move - 2) * 4), 15, 92);
        const roll = this.dice.d100();
        if (roll <= chance) {
            const from = `${unit.pos.x},${unit.pos.y}`;
            unit.alive = false;
            unit.fled = true;
            unit.hp = 0;
            unit.atb = 0;
            unit.pos = { x: -1, y: -1 };
            push({ t: 'flee', actor: unit.uid, text: `${unit.name} 从 ${from} 撤离，掷出 ${roll} ≤ ${chance}，逃跑成功。` });
            this.checkEnd(push);
            return;
        }
        push({ t: 'escape-fail', actor: unit.uid, text: `${unit.name} 想撤出演武场，掷出 ${roll} 超过 ${chance}，被别人拦回来了。` });
    }

    // 被击飞出界：直接判负退场
    knockOut(unit, push) {
        if (!unit.alive) return;
        unit.alive = false;
        unit.outOfBound = true;
        unit.hp = 0;
        unit.atb = 0;
        unit.pos = { x: -1, y: -1 };
        push({ t: 'ko', actor: unit.uid, text: `${unit.name} 被击出演武场，判负退场。` });
        this.checkEnd(push);
    }

    // 整队认输

    // 认输：整队退出，不写伤害日志，直接判负
    concede(side) {
        if (this.finished) return [];
        const ev = [];
        const push = (o) => { ev.push(o); this.log.push(o); return o; };
        const name = side === 'ally' ? '我方' : '敌方';
        this.units.filter((u) => u.side === side && u.alive).forEach((u) => {
            u.alive = false;
            u.fled = true;
            u.hp = 0;
        });
        this.finished = true;
        this.winner = side === 'ally' ? 'enemy' : 'ally';
        push({ t: 'flee', text: `${name}认输，全员退出演武场。` });
        push({ t: 'end', text: `【斗魂结束】${name}认输，${this.winner === 'ally' ? '我方' : '敌方'}胜利。` });
        return ev;
    }

    doDash(actor, target, push) {
        if (!target) return;
        // 冲刺到目标相邻格
        const spots = [];
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                const x = target.pos.x + dx;
                const y = target.pos.y + dy;
                if (this.inBounds(x, y) && !this.occupied(x, y, actor.uid)) spots.push({ x, y });
            }
        }
        if (!spots.length) return;
        spots.sort((a, b) => distance(actor.pos, a) - distance(actor.pos, b));
        const spot = spots[0];
        if (distance(actor.pos, spot) <= 1) return;
        actor.pos = spot;
        push({ t: 'move', actor: actor.uid, text: `${actor.name} 突进到 ${spot.x},${spot.y}。` });
    }

    doPush(actor, target, push) {
        const dx = Math.sign(target.pos.x - actor.pos.x) || 1;
        const dy = Math.sign(target.pos.y - actor.pos.y) || 0;
        let pushed = false;
        for (let i = 0; i < 2; i += 1) {
            const nx = target.pos.x + dx;
            const ny = target.pos.y + dy;
            if (this.occupied(nx, ny, target.uid)) break;
            // 被推出场外：直接判负（不是自己走的，不给骰子）
            if (!this.inBounds(nx, ny)) {
                this.knockOut(target, push);
                return;
            }
            target.pos = { x: nx, y: ny };
            pushed = true;
        }
        if (!pushed) return;
        push({ t: 'move', actor: target.uid, text: `${target.name} 被击退到 ${target.pos.x},${target.pos.y}。` });
    }

    /* --- 结算 --- */

    resolve(actor, target, skill, push) {
        const a = computeStats(actor);

        // 治疗 / 纯增益
        if (skill.kind === 'heal') {
            const amount = Math.round((a.satk * (skill.power || 1) + a.maxHp * 0.05) * (1 + a.healPct / 100));
            target.hp = Math.min(computeStats(target).maxHp, target.hp + amount);
            push({ t: 'heal', actor: actor.uid, target: target.uid, value: amount, text: `${actor.name} 为 ${target.name} 回复 ${amount} 点生命。` });
            this.applyEffects(actor, target, skill, push);
            return;
        }

        if (skill.kind === 'shield') {
            const s = computeStats(target);
            const amount = Math.round(s.maxHp * (skill.shieldPct || 0.2) * (1 + a.shieldPct / 100));
            target.shield = Math.max(target.shield || 0, 0) + amount;
            target.shieldTurns = Math.max(target.shieldTurns || 0, skill.shieldTurns || 3);
            push({ t: 'shield', actor: actor.uid, target: target.uid, value: amount, text: `${target.name} 获得 ${amount} 点护盾（${target.shieldTurns} 回合）。` });
            return;
        }

        if (skill.kind === 'buff' || skill.kind === 'debuff') {
            this.applyEffects(actor, target, skill, push);
            return;
        }

        // 命中判定
        const t0 = computeStats(target);
        const need = clamp(Math.round(a.hit - t0.eva + (skill.hitMod || 0)), CONFIG.hitMin, CONFIG.hitMax);
        const hitRoll = this.dice.d100();
        if (hitRoll > need) {
            push({
                t: 'miss', actor: actor.uid, target: target.uid, roll: hitRoll, need,
                text: `${actor.name} 的「${skill.name}」落空（命中 ${need}%/掷 ${hitRoll}）。`,
            });
            return;
        }

        // 暴击
        const critNeed = clamp(Math.round(a.crit + (skill.critMod || 0)), 0, CONFIG.critCap);
        const critRoll = this.dice.d100();
        const crit = critRoll <= critNeed;

        // 伤害
        const isPhys = skill.kind === 'phys';
        const atkSide = isPhys ? a.atk : a.satk;
        const defSideRaw = isPhys ? t0.def : t0.sdef;
        const pen = clamp((a.penetration || 0) + (skill.penetration || 0), 0, CONFIG.penCap);
        const defSide = defSideRaw * (1 - pen / 100);
        const mitigation = defSide / (defSide + CONFIG.defenseK);

        let dmg = atkSide * (skill.power || 1) * (1 - mitigation);
        if (crit) dmg *= a.critDmg / 100;
        if (target.brokenTurns > 0) dmg *= CONFIG.breakMultiplier;
        const elemMul = elementMultiplier(skill.element || actor.element, target.element);
        const elemRel = elementRelation(skill.element || actor.element, target.element);
        dmg *= elemMul;
        dmg *= 0.9 + this.dice.d10() * 0.02;
        dmg = Math.max(CONFIG.minDamage, Math.floor(dmg));

        // 护盾吸收
        let absorbed = 0;
        if (target.shield > 0 && !skill.shieldPierce) {
            absorbed = Math.min(target.shield, dmg);
            target.shield -= absorbed;
            dmg -= absorbed;
            if (target.shield <= 0) { target.shield = 0; target.shieldTurns = 0; }
        }
        target.hp = Math.max(0, target.hp - dmg);

        const bits = [];
        if (crit) bits.push(`暴击 ×${(a.critDmg / 100).toFixed(2)}`);
        if (elemRel === 'mutual') bits.push(`互克 ×${CONFIG.counterUp}`);
        else if (elemRel === 'up') bits.push(`克制 ×${CONFIG.counterUp}`);
        else if (elemRel === 'down') bits.push(`被克 ×${CONFIG.counterDown}`);
        if (target.brokenTurns > 0) bits.push('破防 ×1.5');
        if (pen > 0) bits.push(`穿透 ${Math.round(pen)}%`);
        if (absorbed > 0) bits.push(`护盾吸收 ${absorbed}`);

        push({
            t: 'hit',
            actor: actor.uid,
            target: target.uid,
            value: dmg,
            crit,
            roll: hitRoll,
            need,
            critRoll,
            critNeed,
            text: `${actor.name} 的「${skill.name}」命中 ${target.name}，造成 ${dmg} 点伤害`
                + (bits.length ? `（${bits.join('，')}）` : '')
                + `（命中 ${need}%/掷 ${hitRoll}，暴击 ${critNeed}%/掷 ${critRoll}）`,
        });

        // 削韧
        this.applyPoise(actor, target, skill, crit, a, push);
        // 状态
        this.applyEffects(actor, target, skill, push);
        // 控制
        this.applyControl(actor, target, skill, a, t0, push);

        if (target.hp <= 0) {
            target.alive = false;
            push({ t: 'down', target: target.uid, text: `${target.name} 倒下。` });
        }
    }

    applyPoise(actor, target, skill, crit, a, push) {
        const base = (skill.poise || 0) * (1 + (a.poiseDmgPct || 0) / 100);
        if (base <= 0) return;
        const amount = Math.round(base * (crit ? 1.5 : 1));
        const s = computeStats(target);
        target.poise = Math.max(0, target.poise - amount);
        target.poiseTimer = CONFIG.poiseRegenDelay + 1;
        push({
            t: 'poise', target: target.uid, value: amount,
            text: `${target.name} 韧性 -${amount}（${Math.round(target.poise)}/${Math.round(s.maxPoise)}）。`,
        });
        if (target.poise <= 0 && target.brokenTurns <= 0) {
            target.brokenTurns = 1;
            target.poise = 0;
            push({ t: 'break', target: target.uid, text: `${target.name} 韧性被击穿，进入破防！` });
        }
    }

    applyControl(actor, target, skill, a, t0, push) {
        if (!skill.control) return;
        const s = computeStats(target);
        const resist = 1 - clamp(s.ctrlResistPct || 0, 0, 80) / 100;
        let turns = 1;

        if (skill.control === 'illusion') {
            // 幻境：施法者精神力 vs 目标精神力
            const caster = a.attrs.spi * (1 + (a.ctrlPct || 0) / 100);
            const victim = Math.max(1, t0.attrs.spi);
            const ratio = caster / victim;
            turns = Math.round((skill.controlTurns || 1) * clamp(ratio * 0.85, 0.6, 2.4));
            push({
                t: 'ctrl',
                target: target.uid,
                text: `幻境判定：精神 ${Math.round(caster)} vs ${Math.round(victim)}，控制 ${turns} 回合。`,
            });
        } else {
            // 物理：削韧占比决定时长，目标剩余韧性抗性
            const poiseDmg = (skill.poise || 0) * (1 + (a.poiseDmgPct || 0) / 100);
            const ratio = poiseDmg / Math.max(1, t0.maxPoise);
            const remain = target.poise / Math.max(1, t0.maxPoise);
            turns = Math.round((skill.controlTurns || 1) * (1 + ratio * 3) * (1 - remain * 0.4));
            push({
                t: 'ctrl',
                target: target.uid,
                text: `束缚判定：削韧 ${Math.round(poiseDmg)} / 韧性 ${Math.round(t0.maxPoise)}，控制 ${turns} 回合。`,
            });
        }

        turns = Math.round(turns * resist);
        turns = clamp(turns, 1, CONFIG.controlMaxTurns);
        target.stunned = Math.max(target.stunned || 0, turns);
        push({
            t: 'ctrl',
            target: target.uid,
            text: `${target.name} 被${skill.control === 'illusion' ? '幻境' : '束缚'}控制 ${turns} 回合。`,
        });
    }

    applyEffects(actor, target, skill, push) {
        for (const eff of skill.effects || []) {
            if (!this.dice.chance(eff.chance == null ? 100 : eff.chance)) continue;
            const label = eff.label || '状态';
            if (eff.type === 'burn' || eff.type === 'bleed') {
                const dmg = Math.round(computeStats(target).maxHp * ((eff.value || 5) / 100));
                target.hp = Math.max(0, target.hp - dmg);
                push({ t: 'dot', target: target.uid, value: dmg, text: `${target.name} 受到「${label}」${dmg} 点持续伤害。` });
                if (target.hp <= 0) { target.alive = false; push({ t: 'down', target: target.uid, text: `${target.name} 倒下。` }); }
            } else if (eff.type === 'stun') {
                target.stunned = Math.max(target.stunned || 0, eff.turns || 1);
                push({ t: 'ctrl', target: target.uid, text: `${target.name} 陷入「${label}」。` });
            } else if (eff.type === 'shield') {
                const amount = Math.round(computeStats(target).maxHp * ((eff.value || 20) / 100));
                target.shield = (target.shield || 0) + amount;
                target.shieldTurns = Math.max(target.shieldTurns || 0, eff.turns || 2);
                push({ t: 'shield', target: target.uid, value: amount, text: `${target.name} 获得「${label}」护盾 ${amount}。` });
            } else {
                target.buffs = target.buffs || [];
                target.buffs.push({
                    stat: eff.stat,
                    value: eff.value,
                    mode: eff.mode || 'pct',
                    turns: eff.turns || 2,
                    label,
                });
                push({
                    t: 'buff',
                    target: target.uid,
                    text: `${target.name} ${eff.value > 0 ? '获得' : '受到'}「${label}」（${eff.stat} ${eff.value > 0 ? '+' : ''}${eff.value}${eff.mode === 'pct' ? '%' : ''}，${eff.turns || 2} 回合）。`,
                });
            }
        }
    }

    checkEnd(push) {
        if (this.finished) return true;
        const ally = this.aliveOf('ally').length;
        const enemy = this.aliveOf('enemy').length;
        if (ally > 0 && enemy > 0) return false;
        this.finished = true;
        this.winner = ally > 0 ? 'ally' : enemy > 0 ? 'enemy' : 'draw';

        // 有人是走出去的，报告里说清楚是溃逃还是肉搏打死
        const fledCount = this.units.filter((u) => u.fled).length;
        let txt;
        if (fledCount > 0) {
            if (this.winner === 'ally') txt = '我方胜利（敌方溃逃）。';
            else if (this.winner === 'enemy') txt = '我方溃逃，斗魂判负。';
            else txt = '双方都撤出演武场，判平。';
        } else {
            txt = this.winner === 'ally' ? '我方胜利。' : this.winner === 'enemy' ? '我方全灭。' : '同归于尽。';
        }
        push({ t: 'end', text: `【斗魂结束】${txt}` });
        return true;
    }

    /* --- AI --- */

    autoAct() {
        this.refreshCurrent();
        const actor = this.currentUnit;
        if (!actor || this.finished) return [];
        const skills = this.availableSkills(actor);
        const target = this.nearestEnemy(actor, 99);

        // 1. 该放盾/治疗
        const heal = skills.find((s) => s.kind === 'heal');
        if (heal) {
            const hurt = this.alliesOf(actor)
                .filter((u) => u.hp / computeStats(u).maxHp < 0.6)
                .sort((a, b) => a.hp / computeStats(a).maxHp - b.hp / computeStats(b).maxHp);
            if (hurt.length) return this.act(heal.id, hurt[0].uid);
        }
        const shield = skills.find((s) => s.kind === 'shield');
        if (shield && actor.hp / computeStats(actor).maxHp < 0.5) {
            return this.act(shield.id, actor.uid);
        }

        // 2. 增幅
        const buff = skills.find((s) => s.kind === 'buff' && !actor.buffs.some((b) => b.label === (s.effects?.[0]?.label || '')));
        if (buff && this.dice.chance(35)) return this.act(buff.id, actor.uid);

        // 3. 射程内最优攻击
        const offensive = skills.filter((s) => ['phys', 'spirit', 'control'].includes(s.kind) && s.power > 0);
        const inRange = offensive.filter((s) => target && distance(actor.pos, target.pos) <= (s.range || 1));
        if (inRange.length) {
            inRange.sort((a, b) => (b.power * ((b.poise || 0) + 1)) - (a.power * ((a.poise || 0) + 1)));
            const pick = inRange[0];
            const tgt = this.nearestEnemy(actor, pick.range);
            return this.act(pick.id, tgt ? tgt.uid : null);
        }

        // 4. 走位靠近
        if (target) {
            const s = computeStats(actor);
            const best = this.bestStepToward(actor, target, s.move);
            if (best) return this.act('move', null, best);
        }

        // 5. 摸不到就打最近的
        return this.act('basic', target ? target.uid : null);
    }

    bestStepToward(actor, target, budget) {
        let best = null;
        let bestD = distance(actor.pos, target.pos);
        for (let dx = -budget; dx <= budget; dx += 1) {
            for (let dy = -budget; dy <= budget; dy += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) > budget) continue;
                const x = actor.pos.x + dx;
                const y = actor.pos.y + dy;
                if (!this.inBounds(x, y) || this.occupied(x, y, actor.uid)) continue;
                const d = distance({ x, y }, target.pos);
                if (d < bestD) { bestD = d; best = { x, y }; }
            }
        }
        return best;
    }
}

function syncVitalsAll(battle) {
    for (const u of battle.units) if (u.alive) syncVitals(u);
}

/* ---------------- 渲染 ---------------- */

export function renderEvents(events) {
    return (events || []).map((e) => e.text).filter(Boolean);
}

export function renderBattleReport(battle) {
    if (!battle) return '';
    const lines = [];
    lines.push(`【斗魂】第 ${battle.round} 回合`);
    for (const side of ['ally', 'enemy']) {
        const list = battle.aliveOf(side);
        if (!list.length) {
            const ran = battle.units.filter((u) => u.side === side && u.fled).length;
            const ko = battle.units.filter((u) => u.side === side && u.outOfBound).length;
            const label = ko > 0 ? '被打出演武场' : ran > 0 ? '全员撤离' : '全灭';
            lines.push(`${side === 'ally' ? '我方' : '敌方'}：${label}`);
            continue;
        }
        lines.push(`${side === 'ally' ? '我方' : '敌方'}：`);
        for (const u of list) {
            const s = statBlock(u);
            const parts = [`${u.name} Lv.${u.lv}`, `HP ${s.hp}/${s.maxHp}`, `魂力 ${s.mp}/${s.maxMp}`, `韧性 ${s.poise}/${s.maxPoise}`];
            if (s.shield > 0) parts.push(`护盾 ${s.shield}`);
            if (s.broken) parts.push('破防中');
            parts.push(`位置 ${u.pos.x},${u.pos.y}`);
            lines.push(`  ${parts.join('｜')}`);
        }
    }
    if (battle.finished) {
        const fledCount = battle.units.filter((u) => u.fled).length;
        const koCount = battle.units.filter((u) => u.outOfBound).length;
        let result;
        if (fledCount > 0 && koCount > 0) {
            result = battle.winner === 'ally' ? '我方胜利（敌方有溃逃、有出界）'
                : battle.winner === 'enemy' ? '我方溃逃/出界，判负'
                    : '双方俱退，判平';
        } else if (koCount > 0) {
            result = battle.winner === 'ally' ? '我方胜利（敌方被打出场外）'
                : battle.winner === 'enemy' ? '我方被打出演武场，判负'
                    : '同归于尽';
        } else if (fledCount > 0) {
            result = battle.winner === 'ally' ? '我方胜利（敌方溃逃）'
                : battle.winner === 'enemy' ? '我方溃逃，判负'
                    : '双方俱退，判平';
        } else {
            result = battle.winner === 'ally' ? '我方胜利'
                : battle.winner === 'enemy' ? '我方全灭'
                    : '同归于尽';
        }
        lines.push(`【结果】${result}`);
    }
    return lines.join('\n');
}
