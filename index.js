// douluo-combat / index.js
// SillyTavern 扩展入口：宿主集成 + 斗魂面板 UI（地图 / 队伍 / 战斗 / 日志）。
// 只用 window.SillyTavern.getContext()，不直接 import 宿主内部模块。

import {
    DEFAULT_SKILLS,
    DEFAULT_EQUIPMENT,
    DEFAULT_BONES,
    BONE_SLOT_NAMES,
    PRESET_UNITS,
    ELEMENTS,
    QUALITY,
    ROLES,
    TECHNIQUES,
    BATTLEFIELD,
    SKILL_TEMPLATES,
    GROWTH,
    growthAttrs,
    attrsFromTarget,
    applyElementConfig,
    elementConfigSnapshot,
    ELEMENT_BEATS,
    ringTierOf,
    findSkill,
    allSkills,
    registerSkills,
} from './data.js';
import {
    Battle, BASIC_ATTACK, statBlock, renderBattleReport, mulberry32, computeStats, CONFIG, clamp,
    resolveSkill, resolveBone, resolveTech, resolveEquip, idOf,
} from './engine.js';
import { parseUnit, gatherSources, gatherMvu, describeMvu, DEFAULT_SOURCES, summarize } from './parser.js';

const MODULE = 'douluo-combat';

// 战斗规则的可调参数（面板「设置」里能改）
const DEFAULT_RULES = {
    defenseK: 190,        // 防御减免常数：减伤率 = 有效防御 / (有效防御 + K)，K 越大减伤越轻
    penCap: 80,           // 穿透上限 %
    controlMaxTurns: 4,   // 控制最多持续回合
    atbSpeed: 0.08,       // 行动条积累系数
};

const DEFAULT_SETTINGS = {
    autoWrite: false,
    showDice: true,
    seed: '',
    units: null,
    sources: null,   // 导入数据源开关
    rules: null,     // 规则参数
    customSkills: null,  // 玩家自己写的魂技
    elementConfig: null, // 自定义属性表 / 克制表
    panelPos: null,      // 浮窗拖过之后记住位置
    panelSize: null,     // 浮窗拖边框缩放过之后记住大小
    fabPos: null,        // 悬浮球拖过之后记住位置
    ai: null,            // AI 接入配置（OpenAI 兼容）
};

// 数据结构版本：加了武魂品质/类型/魂骨/功法/站位之后不兼容旧配置
const SCHEMA = 3;

// AI 接入默认配置：走 OpenAI 兼容的 /chat/completions
const DEFAULT_AI = {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 8000,
    chatCount: 20,
    sources: { chat: true, character: false, worldbook: false, mvu: false },
    mode: 'off',   // off / enemy / auto / narrator
};

const S = {
    settings: { ...DEFAULT_SETTINGS },
    battle: null,
    units: { ally: [], enemy: [] },
    pendingSkill: null,
    pendingTexts: [],
    uiLog: [],
    timer: null,
    editing: null,
    root: null,
    modalEl: null,
    opened: false,
    importText: '',      // 粘贴导入用
    lastParse: null,     // 最近一次解析结果
    debugClicks: false,   // 排查点击问题时打开：记录每次 pointerdown 的落点
};

/* ---------------- 宿主桥 ---------------- */

function ctx() {
    try {
        return window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
    } catch (e) {
        return null;
    }
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clone(o) {
    return JSON.parse(JSON.stringify(o));
}

async function ensureSettings() {
    const c = ctx();
    if (!c || !c.extensionSettings) return;
    if (!c.extensionSettings[MODULE]) {
        c.extensionSettings[MODULE] = clone(DEFAULT_SETTINGS);
    }
    S.settings = Object.assign({}, DEFAULT_SETTINGS, c.extensionSettings[MODULE]);
    S.settings.sources = Object.assign({}, DEFAULT_SOURCES, S.settings.sources || {});
    S.settings.rules = Object.assign({}, DEFAULT_RULES, S.settings.rules || {});

    // 玩家自己写的魂技：读配置后重新注册进技能库，否则存档里的自定义技能查不到
    S.customSkills = Array.isArray(S.settings.customSkills) ? S.settings.customSkills : [];
    registerSkills(S.customSkills);

    // 自定义属性 / 克制表：必须在建单位之前套上，否则 derive 显示的还是老五行
    if (S.settings.elementConfig) applyElementConfig(S.settings.elementConfig);

    // 旧配置（没有 schemaVersion 或版本不符）直接回到预设，避免字段缺失导致空显示
    if (S.settings.schemaVersion !== SCHEMA) {
        S.units.ally = [];
        S.units.enemy = [];
        S.settings.schemaVersion = SCHEMA;
        resetToPresets();
        applyRules();
        return;
    }

    applyRules();
    if (S.settings.units) {
        try {
            S.units.ally = S.settings.units.ally || [];
            S.units.enemy = S.settings.units.enemy || [];
        } catch (e) { /* 配置损坏则回落 */ }
    }
    if (!S.units.ally.length && !S.units.enemy.length) resetToPresets();
}

// 把设置里的规则参数写进引擎 CONFIG（引擎读的就是这个对象）
function applyRules() {
    const r = S.settings.rules || {};
    if (Number.isFinite(Number(r.defenseK))) CONFIG.defenseK = Number(r.defenseK);
    if (Number.isFinite(Number(r.penCap))) CONFIG.penCap = Number(r.penCap);
    if (Number.isFinite(Number(r.controlMaxTurns))) CONFIG.controlMaxTurns = Number(r.controlMaxTurns);
    if (Number.isFinite(Number(r.atbSpeed))) CONFIG.atbSpeed = Number(r.atbSpeed);
}

function saveSettings() {
    const c = ctx();
    if (!c || !c.extensionSettings) return;
    S.settings.units = { ally: S.units.ally, enemy: S.units.enemy };
    S.settings.schemaVersion = SCHEMA;
    c.extensionSettings[MODULE] = S.settings;
    try {
        if (c.saveSettingsDebounced) c.saveSettingsDebounced();
        else if (typeof c.saveSettings === 'function') c.saveSettings();
    } catch (e) { /* 忽略 */ }
}

function resetToPresets() {
    const presets = clone(PRESET_UNITS);
    S.units.ally = presets.slice(0, 2);
    S.units.enemy = presets.slice(2, 4);
    saveSettings();
}

/* ---------------- 写入聊天 ---------------- */

async function sendToChat(text) {
    const c = ctx();
    if (!c || !text) return false;
    const body = String(text);

    try {
        if (Array.isArray(c.chat)) {
            const msg = {
                name: c.name2 || '斗魂裁判',
                is_user: false,
                is_system: true,
                send_date: Date.now(),
                mes: body,
                extra: {},
                swipe_id: 0,
                swipes: [body],
            };
            c.chat.push(msg);
            if (typeof c.addOneMessage === 'function') c.addOneMessage(msg, { scroll: true });
            if (typeof c.saveChat === 'function') await c.saveChat();
            else if (typeof c.saveMetadata === 'function') c.saveMetadata();
            return true;
        }
    } catch (e) { /* 落到路线 2 */ }

    try {
        if (typeof c.executeSlashCommandsWithOptions === 'function') {
            const flat = body.replace(/"/g, '”').replace(/\r?\n/g, ' / ');
            await c.executeSlashCommandsWithOptions(`/send "${flat}"`);
            return true;
        }
    } catch (e) { /* 落到路线 3 */ }

    try {
        await navigator.clipboard.writeText(body);
        toast('写入聊天失败，战报已复制到剪贴板');
    } catch (e) {
        toast('写入聊天失败');
    }
    return false;
}

function toast(text) {
    try {
        if (window.toastr && typeof window.toastr.info === 'function') {
            window.toastr.info(text);
            return;
        }
    } catch (e) { /* 忽略 */ }
    console.log('[douluo-combat]', text);
}

/* ---------------- 日志 ---------------- */

function pushText(text) {
    if (!text) return;
    S.pendingTexts.push(text);
    logOnly(text);
}

function logOnly(text) {
    if (!text) return;
    S.uiLog.push(text);
    if (S.uiLog.length > 400) S.uiLog.splice(0, S.uiLog.length - 400);
}

function runDiagnostics() {
    const c = ctx();
    const t = (v) => typeof v;
    logOnly('[自检] ────────');
    logOnly(`[自检] getContext: ${c ? 'OK' : '缺失'}`);
    if (c) {
        logOnly(`[自检] chat: ${Array.isArray(c.chat) ? `${c.chat.length} 条` : t(c.chat)}`);
        logOnly(`[自检] addOneMessage: ${t(c.addOneMessage)}`);
        logOnly(`[自检] saveChat: ${t(c.saveChat)}`);
        logOnly(`[自检] extensionSettings: ${c.extensionSettings ? 'OK' : '缺失'}`);
        logOnly(`[自检] name1/name2: ${c.name1 || '-'} / ${c.name2 || '-'}`);
        logOnly(`[自检] characters: ${Array.isArray(c.characters) ? `${c.characters.length} 张` : t(c.characters)}`);
        logOnly(`[自检] getCharacterCardFields: ${t(c.getCharacterCardFields)}`);
        logOnly(`[自检] loadWorldInfo: ${t(c.loadWorldInfo)}`);
        try {
            const f = typeof c.getCharacterCardFields === 'function' ? c.getCharacterCardFields() : null;
            if (f) logOnly(`[自检] 卡描述长度: ${(f.description || '').length}`);
        } catch (e) {
            logOnly(`[自检] 卡字段读取失败: ${e.message}`);
        }
        const helperFns = ['getVariables', 'getWorldbook', 'getWorldbookNames', 'TavernHelper'];
        const present = helperFns.filter((k) => typeof window[k] !== 'undefined');
        logOnly(`[自检] 酒馆助手全局: ${present.length ? present.join(', ') : '无'}`);
    }
    logOnly(`[自检] 队伍: 我方 ${S.units.ally.length} / 敌方 ${S.units.enemy.length}`);
    logOnly(`[自检] 战斗: ${S.battle ? `第 ${S.battle.round} 回合` : '未开始'}`);
}

/* ---------------- 战斗 ---------------- */

function buildBattle() {
    if (!S.units.ally.length || !S.units.enemy.length) {
        toast('两边都至少要有一个单位');
        return;
    }
    const seedInput = S.settings.seed;
    let rng;
    if (seedInput !== '' && seedInput != null && Number.isFinite(Number(seedInput))) {
        rng = mulberry32(Number(seedInput));
    }
    S.battle = new Battle({ allies: clone(S.units.ally), enemies: clone(S.units.enemy), rng });
    S.pendingTexts = [];
    S.uiLog = [];
    S.pendingSkill = null;

    S.battle.start();
    pushText(`【斗魂开始】我方 ${S.units.ally.length} 人 vs 敌方 ${S.units.enemy.length} 人`);
    const order = S.battle.aliveOf()
        .slice()
        .sort((a, b) => computeStats(b).spd - computeStats(a).spd)
        .map((u) => `${u.name}(SPD ${Math.round(computeStats(u).spd)})`);
    pushText(`速度序：${order.join(' → ')}`);

    render();
    pump();
}

function finishBattle() {
    const b = S.battle;
    if (!b) return;
    pushText(renderBattleReport(b));
    // narrator 模式：报告照给，再让模型写一段正文
    if (aiCfg().mode === 'narrator' && aiReady()) aiNarrate(b);
    if (S.settings.autoWrite) flushTexts(true);
    render();
}

async function aiNarrate(b) {
    try {
        logOnly('[AI] 正在把战报写成正文…');
        render();
        const report = renderBattleReport(b);
        const content = await callAI([
            {
                role: 'system',
                content: '你是《斗罗大陆》的叙述者。把战斗报告改写成一段 200-400 字的小说正文，保留关键数值与胜负结果，不要编造报告里没有的伤亡或技能。',
            },
            { role: 'user', content: report },
        ]);
        if (content && String(content).trim()) {
            pushText(`【斗魂战报】\n${String(content).trim()}`);
            render();
            if (S.settings.autoWrite) flushTexts(true);
        }
    } catch (e) {
        logOnly(`[AI] 战报润色失败：${e.message}`);
        render();
    }
}

function flushTexts(force) {
    if (!force && !S.settings.autoWrite) return;
    const text = S.pendingTexts.join('\n');
    if (!text.trim()) return;
    S.pendingTexts = [];
    sendToChat(`【斗魂演武】\n${text}`);
}

function currentActor() {
    const b = S.battle;
    return b && !b.finished ? b.current() : null;
}

function onSkill(skillId) {
    const b = S.battle;
    const actor = currentActor();
    if (!b || !actor || actor.side !== 'ally') return;

    const skill = skillId === 'basic' ? BASIC_ATTACK : findSkill(skillId);
    if (!skill) return;

    if (skill.target === 'allEnemy' || skill.target === 'allAlly' || skill.target === 'self') {
        execute(skill.id, null);
        return;
    }
    S.pendingSkill = skill.id;
    render();
}

function onUnitClick(uid) {
    const b = S.battle;
    const actor = currentActor();
    if (!b || !actor || !S.pendingSkill) return;
    const target = b.units.find((u) => u.uid === uid);
    if (!target || !target.alive) return;

    const skill = S.pendingSkill === 'basic' ? BASIC_ATTACK : findSkill(S.pendingSkill);
    if (!skill) return;

    const wantSide = skill.target === 'ally' ? actor.side : (actor.side === 'ally' ? 'enemy' : 'ally');
    if (target.side !== wantSide) {
        toast('目标不合法');
        return;
    }
    execute(skill.id, uid);
}

function onCellClick(x, y) {
    const b = S.battle;
    if (!b || b.finished) return;
    const actor = b.current();
    if (!actor || actor.side !== 'ally') return;

    const occupant = b.units.find((u) => u.alive && u.pos.x === x && u.pos.y === y);
    if (occupant) {
        if (S.pendingSkill) onUnitClick(occupant.uid);
        else if (occupant.side === 'enemy') execute('basic', occupant.uid);
        else toast(`${occupant.name}｜HP ${Math.round(occupant.hp)}/${statBlock(occupant).maxHp}`);
        return;
    }
    if (S.pendingSkill) { S.pendingSkill = null; render(); return; }
    execute('move', null, { x, y });
}

function execute(skillId, targetUid, opts) {
    const b = S.battle;
    if (!b) return;
    S.pendingSkill = null;
    const ev = b.act(skillId, targetUid, opts);
    afterAction(ev);
}

function afterAction(ev) {
    for (const e of ev || []) {
        if (!e || !e.text) continue;
        if (e.t === 'poise' && !S.settings.showDice) continue;
        pushText(e.text);
    }
    if (S.battle && S.battle.finished) {
        finishBattle();
        return;
    }
    render();
    pump();
}

// 把战场压缩成一段文字喂给模型
function describeBattleForAI(b, actor) {
    const lines = [`第 ${b.round} 回合，轮到 ${actor.name}（${actor.side === 'ally' ? '我方' : '敌方'}，uid=${actor.uid}）`];
    for (const u of b.units) {
        if (!u.alive) continue;
        const s = statBlock(u);
        lines.push(`${u.side === 'ally' ? '我方' : '敌方'} ${u.name} uid=${u.uid} HP ${Math.round(s.hp)}/${Math.round(s.maxHp)} 位置(${u.pos.x},${u.pos.y})`);
    }
    return lines.join('\n');
}

// 让模型挑一个技能 + 目标；挑不出来就返回 null，退回规则 AI
async function aiDecide(actor) {
    const b = S.battle;
    if (!b) return null;
    const skills = b.availableSkills(actor);
    const skillList = skills
        .map((s) => `- ${s.id}｜${s.name}｜${s.kind || 'attack'}｜射程 ${s.range || 1}｜耗魂力 ${s.cost || 0}${s.target === 'self' ? '｜自身' : ''}`)
        .join('\n');
    const enemies = b.units.filter((u) => u.alive && u.side !== actor.side);
    const allyList = b.units
        .filter((u) => u.alive && u.side === actor.side)
        .map((u) => `${u.uid}=${u.name}`)
        .join('、');

    const sys = `你是斗罗大陆战斗 AI，只负责给当前行动者选一招。
只输出 JSON，不要解释：{"skill":"技能id","target":"目标uid 或 null"}
- skill 从下面列表里选，普通攻击是 "basic"
- 治疗/增益类选同阵营 uid（${allyList}），攻击类选敌人，自身技能 target 写 null
- 优先用能打出最大收益的招；血量低时优先治疗或撤退`;

    const user = `可选技能：
${skillList}

战场：
${describeBattleForAI(b, actor)}

敌人 uid：${enemies.map((u) => u.uid).join('、') || '无'}`;

    const content = await callAI(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        { maxTokens: 200, temperature: 0.2 },
    );
    const data = extractJson(content);
    if (!data || !data.skill) return null;
    const okSkill = data.skill === 'basic' || skills.some((s) => s.id === data.skill);
    if (!okSkill) return null;
    return { skill: data.skill, target: data.target || null };
}

function pump() {
    const b = S.battle;
    if (!b || b.finished) return;
    const actor = b.current();
    if (!actor) return;

    const mode = aiCfg().mode;
    // 敌方一律自动；AI 全托管时我方也自动
    const auto = actor.side === 'enemy' || mode === 'auto';
    if (!auto) return;

    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(async () => {
        S.timer = null;
        if (!S.battle || S.battle.finished) return;
        const useAI = aiReady() && (mode === 'enemy' || mode === 'auto');
        let ev = null;
        if (useAI) {
            try {
                const decision = await aiDecide(actor);
                if (decision) {
                    ev = b.act(decision.skill, decision.target, {});
                    if (ev && ev.length) logOnly(`[AI] ${actor.name} 选择 ${decision.skill}${decision.target ? ` → ${decision.target}` : ''}`);
                }
            } catch (e) {
                logOnly(`[AI] 决策失败，退回规则 AI：${e.message}`);
            }
        }
        if (!ev) ev = b.autoAct();
        afterAction(ev);
    }, 420);
}

/* ---------------- 渲染：地图 ---------------- */

function tokenLabel(name) {
    const parts = String(name).split('·');
    const last = (parts[parts.length - 1] || '').trim();
    return (last || String(name)).slice(0, 2);
}

function defaultPos(side, i) {
    const x0 = side === 'ally' ? 1 : 9;
    return { x: x0 + (i % 2), y: 2 + (i % 5) };
}

function renderMap() {
    const W = BATTLEFIELD.width;
    const H = BATTLEFIELD.height;
    const b = S.battle;
    const actor = b && !b.finished ? b.current() : null;
    // 战斗中才显示外圈：点外圈＝撤出演武场（逃跑）
    const showRing = !!(b && !b.finished);
    const fleeEnabled = showRing && actor && actor.side === 'ally' && !S.pendingSkill;

    // 未开战时用队伍配置预览站位
    const units = b
        ? b.units
        : [
            ...S.units.ally.map((u, i) => ({
                side: 'ally', alive: true, uid: `p-a${i}`, name: u.name,
                pos: u.pos || defaultPos('ally', i),
            })),
            ...S.units.enemy.map((u, i) => ({
                side: 'enemy', alive: true, uid: `p-e${i}`, name: u.name,
                pos: u.pos || defaultPos('enemy', i),
            })),
        ];

    const x0 = showRing ? -1 : 0;
    const y0 = showRing ? -1 : 0;
    const x1 = showRing ? W : W - 1;
    const y1 = showRing ? H : H - 1;
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;

    const cells = [];
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            if (x < 0 || x >= W || y < 0 || y >= H) {
                cells.push(`<div class="dlc-cell out${fleeEnabled ? ' fleezone' : ''}" data-cell="${x},${y}" title="${fleeEnabled ? '走出去＝撤离演武场（判逃跑）' : '场外'}"></div>`);
                continue;
            }
            const u = units.find((it) => it.alive && it.pos && it.pos.x === x && it.pos.y === y);
            const cls = ['dlc-cell'];
            if (x >= BATTLEFIELD.enemyZone.x0) cls.push('ezone');
            else if (x <= BATTLEFIELD.allyZone.x1) cls.push('azone');
            if (u) {
                cls.push(u.side);
                if (actor === u) cls.push('active');
                if (u.side === 'enemy' && S.pendingSkill) cls.push('targetable');
            }
            const tok = u
                ? `<span class="dlc-tok ${u.side}">${esc(tokenLabel(u.name))}</span>`
                : '';
            // 战斗前才能拖拽摆位
            const canDrag = u && !b;
            const dragAttr = canDrag ? ` draggable="true" data-drag-uid="${u.uid}"` : '';
            cells.push(`<div class="${cls.join(' ')}" data-cell="${x},${y}" title="${x},${y}"${dragAttr}>${tok}</div>`);
        }
    }
    return `<div class="dlc-map" style="grid-template-columns:repeat(${cols},1fr)">${cells.join('')}</div>`;
}

/* ---------------- 渲染：单位卡 ---------------- */

function barInline(label, value, max, cls) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="dlc-bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i><b>${label}</b></div>`;
}

function unitCard(u, compact) {
    const s = statBlock(u);
    const actor = S.battle && !S.battle.finished ? S.battle.current() : null;
    const cls = ['dlc-unit'];
    if (!u.alive) cls.push('dead');
    if (actor === u) cls.push('actor');
    if (s.broken) cls.push('broken');

    const tags = [];
    for (const b of u.buffs || []) {
        tags.push(`<span class="dlc-tag ${b.value < 0 ? 'down' : 'up'}">${esc(b.label || b.stat)} ${b.turns}</span>`);
    }
    if (u.shield > 0) tags.push(`<span class="dlc-tag shield">盾 ${Math.round(u.shield)}</span>`);
    if (u.stunned > 0) tags.push(`<span class="dlc-tag ctrl">控 ${u.stunned}</span>`);
    if (u.silenced > 0) tags.push(`<span class="dlc-tag ctrl">封技 ${u.silenced}</span>`);
    if (s.broken) tags.push('<span class="dlc-tag break">破防</span>');

    const meta = [
        `Lv.${u.lv}`,
        QUALITY[u.quality]?.name,
        ROLES[u.role]?.name,
        u.martial || '',
        ELEMENTS[u.element]?.name,
    ].filter(Boolean).join(' · ');

    if (compact) {
        return `
    <div class="${cls.join(' ')} compact" data-unit="${esc(u.uid)}">
      <div class="dlc-unit-head">
        <span class="dlc-name">${esc(u.name)}</span>
        <span class="dlc-pos">${u.pos.x},${u.pos.y}</span>
      </div>
      <div class="dlc-meta">${esc(meta)}</div>
      ${barInline(`${Math.max(0, s.hp)}/${s.maxHp}`, s.hp, s.maxHp, 'hp')}
      <div class="dlc-bars2">
        ${barInline(`魂 ${s.mp}/${s.maxMp}`, s.mp, s.maxMp, 'mp')}
        ${barInline(`韧 ${s.poise}/${s.maxPoise}`, s.poise, s.maxPoise, 'poise')}
      </div>
      <div class="dlc-stats">攻 ${s.atk}｜防 ${s.def}｜速 ${s.spd}｜移 ${s.move}｜暴 ${s.crit}%｜爆 ${s.critDmg}%｜穿 ${s.penetration}%</div>
      <div class="dlc-tags">${tags.join('')}</div>
    </div>`;
    }

    return `
    <div class="${cls.join(' ')}" data-unit="${esc(u.uid)}">
      <div class="dlc-unit-head">
        <span class="dlc-name">${esc(u.name)}</span>
        <span class="dlc-meta">${esc(meta)}</span>
        <span class="dlc-pos">${u.pos.x},${u.pos.y}</span>
      </div>
      ${barInline(`${Math.max(0, s.hp)}/${s.maxHp}`, s.hp, s.maxHp, 'hp')}
      ${barInline(`魂力 ${s.mp}/${s.maxMp}`, s.mp, s.maxMp, 'mp')}
      ${barInline(`韧性 ${s.poise}/${s.maxPoise}`, s.poise, s.maxPoise, 'poise')}
      <div class="dlc-stats">攻 ${s.atk}｜防 ${s.def}｜精攻 ${s.satk}｜速 ${s.spd}｜移 ${s.move}｜命中 ${s.hit}｜闪避 ${s.eva}｜暴 ${s.crit}%｜爆 ${s.critDmg}%｜穿 ${s.penetration}%</div>
      <div class="dlc-tags">${tags.join('')}</div>
    </div>`;
}

function rosterCard(cfg, side, index) {
    const rings = (cfg.rings || []).map((r) => ringTierOf(r.year).name).join('·') || '无环';
    const ids = new Set([...(cfg.skills || []), ...(cfg.rings || []).flatMap((r) => r.skills || [])]);
    const q = QUALITY[cfg.quality]?.name || '';
    const role = ROLES[cfg.role]?.name || '';
    const p = cfg.pos || defaultPos(side, index);
    return `
    <div class="dlc-roster-item">
      <div class="dlc-roster-top">
        <span class="dlc-roster-name">${esc(cfg.name)}</span>
        <em>Lv.${cfg.lv || 1}${q ? ` · ${esc(q)}` : ''}${role ? ` · ${esc(role)}` : ''} · ${esc(rings)} · ${ids.size} 技</em>
      </div>
      <div class="dlc-roster-bottom">
        <span class="dlc-posedit" title="站位 ${p.x},${p.y}">
          <button class="dlc-nudge" data-nudge="${side}:${index}:left" title="左移一格">←</button>
          <button class="dlc-nudge" data-nudge="${side}:${index}:up" title="上移一格">↑</button>
          <button class="dlc-nudge" data-nudge="${side}:${index}:down" title="下移一格">↓</button>
          <button class="dlc-nudge" data-nudge="${side}:${index}:right" title="右移一格">→</button>
          <span class="dlc-poslabel">${p.x},${p.y}</span>
        </span>
        <span class="dlc-roster-actions">
          <button class="dlc-mini" data-edit="${side}:${index}">编辑</button>
          <button class="dlc-mini" data-act="del" data-side="${side}" data-index="${index}">删</button>
        </span>
      </div>
    </div>`;
}

// 战斗前微调站位：方向键一次一格，切比雪夫网格，越界就夹住
function nudgeUnit(side, index, dir) {
    if (S.battle && !S.battle.finished) {
        toast('战斗中不能改站位，先「重置队伍」或打完这场');
        return;
    }
    const u = S.units[side] && S.units[side][index];
    if (!u) return;
    const p = u.pos || defaultPos(side, index);
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    if (!d) return;
    u.pos = {
        x: clamp((Number(p.x) || 0) + d[0], 0, BATTLEFIELD.width - 1),
        y: clamp((Number(p.y) || 0) + d[1], 0, BATTLEFIELD.height - 1),
    };
    saveSettings();
    render();
}

/* ---------------- 渲染：行动条 ---------------- */

function renderActionBar() {
    const b = S.battle;
    if (!b) return '<div class="dlc-hint">点「开始斗魂」进入战斗。点地图空格可移动。</div>';
    if (b.finished) {
        const txt = b.winner === 'ally' ? '我方胜利' : b.winner === 'enemy' ? '我方全灭' : '同归于尽';
        return `<div class="dlc-result">${txt}
          <button class="dlc-btn" data-act="start">再来一场</button>
          <button class="dlc-btn" data-act="write">写入正文</button></div>`;
    }
    const actor = b.current();
    if (!actor) return '<div class="dlc-hint">等待结算…</div>';
    if (actor.side === 'enemy') return '<div class="dlc-hint">敌方行动中…</div>';

    if (S.pendingSkill) {
        const sk = S.pendingSkill === 'basic' ? BASIC_ATTACK : findSkill(S.pendingSkill);
        return `<div class="dlc-hint">「${esc(sk?.name || '')}」：点击目标
          <button class="dlc-btn" data-act="cancel">取消</button></div>`;
    }

    const skills = b.availableSkills(actor);
    const s = computeStats(actor);
    const btns = skills.map((sk) => {
        const cd = actor.cds[sk.id] || 0;
        const disabled = cd > 0 || actor.mp < (sk.cost || 0);
        const rangeTxt = sk.range ? ` · 射程${sk.range}` : '';
        return `<button class="dlc-skill ${disabled ? 'disabled' : ''}" data-skill="${esc(sk.id)}" ${disabled ? 'disabled' : ''} title="${esc(sk.desc || '')}">
          <b>${esc(sk.name)}</b><em>${sk.cost}魂力${sk.cd ? ` CD${sk.cd}` : ''}${rangeTxt}</em>
        </button>`;
    }).join('');

    return `<div class="dlc-actor">行动：<b>${esc(actor.name)}</b>（移速 ${s.move}，本回合已走 ${actor.moved || 0}）</div>
      <div class="dlc-skills">
        <button class="dlc-skill" data-skill="basic"><b>普通攻击</b><em>0魂力 · 射程1</em></button>
        ${btns}
      </div>`;
}

/* ---------------- 渲染：主面板 ---------------- */

function renderPanel() {
    if (!S.root) return;
    // 记住单位列表的滚动位置：重绘后恢复，连续调站位或拖拽时不会跳回顶部
    const scrollKeep = [];
    S.root.querySelectorAll('.dlc-units').forEach((el) => scrollKeep.push(el.scrollTop));
    const b = S.battle;
    const roundTxt = b ? `第 ${b.round} 回合${b.finished ? '（已结束）' : ''}` : '未开始';

    const allyHtml = b
        ? b.aliveOf('ally').map((u) => unitCard(u, true)).join('')
        : S.units.ally.map((c, i) => rosterCard(c, 'ally', i)).join('');
    const enemyHtml = b
        ? b.aliveOf('enemy').map((u) => unitCard(u, true)).join('')
        : S.units.enemy.map((c, i) => rosterCard(c, 'enemy', i)).join('');

    S.root.innerHTML = `
    <div class="dlc-head" data-drag>
      <div class="dlc-title">⚔ 斗魂演武场</div>
      <div class="dlc-round">${roundTxt}</div>
      <div class="dlc-head-actions">
        <label class="dlc-switch"><input type="checkbox" data-toggle="autoWrite" ${S.settings.autoWrite ? 'checked' : ''}> 结束自动写入</label>
        <button class="dlc-icon" data-act="close">×</button>
      </div>
    </div>
    <div class="dlc-body">
      <div class="dlc-mapwrap">
        ${renderMap()}
        <div class="dlc-maplegend"><span class="azone">我方区</span><span class="ezone">敌方区</span><span>切比雪夫距离</span><span class="outzone">场外＝撤出演武场</span></div>
      </div>
    </div>
    <div class="dlc-sides">
      <div class="dlc-col">
        <div class="dlc-col-head">我方 <button class="dlc-mini" data-act="add" data-side="ally">+ 单位</button></div>
        <div class="dlc-units">${allyHtml || '<div class="dlc-empty">空</div>'}</div>
      </div>
      <div class="dlc-col">
        <div class="dlc-col-head">敌方 <button class="dlc-mini" data-act="add" data-side="enemy">+ 单位</button></div>
        <div class="dlc-units">${enemyHtml || '<div class="dlc-empty">空</div>'}</div>
      </div>
    </div>
    <div class="dlc-log" id="dlc-log">${(S.uiLog || []).map((t) => `<div>${esc(t)}</div>`).join('')}</div>
    <div class="dlc-foot">${renderActionBar()}</div>
    <div class="dlc-toolbar">
      <button class="dlc-btn primary" data-act="start">开始斗魂</button>
      <button class="dlc-btn" data-act="write">写入正文</button>
      <button class="dlc-btn" data-act="import">从卡导入</button>
      <button class="dlc-btn" data-act="paste">粘贴文本</button>
      <button class="dlc-btn" data-act="ai-parse">AI 解析</button>
      <button class="dlc-btn danger" data-act="concede">认输</button>
      <button class="dlc-btn" data-act="settings">设置</button>
      <button class="dlc-btn" data-act="probe">探变量</button>
      <button class="dlc-btn" data-act="reset">重置队伍</button>
      <button class="dlc-btn" data-act="diag">自检</button>
    </div>
    <div class="dlc-resize" data-resize title="拖动缩放"></div>`;

    const logEl = S.root.querySelector('#dlc-log');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;

    // 恢复单位列表滚动位置
    S.root.querySelectorAll('.dlc-units').forEach((el, i) => {
        if (scrollKeep[i] != null) el.scrollTop = scrollKeep[i];
    });
}

function render() {
    renderPanel();
}

/* ---------------- AI 接入（OpenAI 兼容） ---------------- */

// 上一次调用有没有因为 max_tokens 被截断
let lastAITruncated = false;

function aiCfg() {
    const base = S.settings.ai || {};
    return Object.assign({}, DEFAULT_AI, base, {
        sources: Object.assign({}, DEFAULT_AI.sources, base.sources || {}),
    });
}

function aiReady() {
    const c = aiCfg();
    return !!(c.enabled && c.apiKey && c.baseUrl && c.model);
}

async function callAI(messages, opts = {}) {
    const cfg = aiCfg();
    if (!cfg.apiKey) throw new Error('还没填 API Key（设置 → AI 接入）');
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    const url = `${base}/chat/completions`;
    const body = {
        model: cfg.model,
        messages,
        temperature: opts.temperature != null ? opts.temperature : cfg.temperature,
        max_tokens: opts.maxTokens || cfg.maxTokens,
        stream: false,
    };
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(`连不上 ${base}：${e.message}`);
    }
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (_) { /* 忽略 */ }
        throw new Error(`HTTP ${res.status}：${detail || res.statusText}`);
    }
    const data = await res.json();
    const choice = data && data.choices && data.choices[0] ? data.choices[0] : null;
    lastAITruncated = !!(choice && choice.finish_reason === 'length');
    const content = choice && choice.message ? choice.message.content : '';
    if (!content) throw new Error('模型没返回内容');
    return String(content);
}

// 从回复里抠 JSON：模型爱包 ```json 代码块，偶尔还会被 max_tokens 截断
function extractJson(text) {
    if (!text) return null;
    const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
    const raw = fence ? fence[1] : String(text);
    const start = raw.indexOf('{');
    if (start < 0) return null;
    const core = raw.slice(start);
    const end = core.lastIndexOf('}');
    if (end > 0) {
        try {
            return JSON.parse(core.slice(0, end + 1));
        } catch (_) { /* 走修复分支 */ }
    }
    return repairTruncatedJson(core);
}

// 输出被截断时，尽量把已经完整的单位救回来
function repairTruncatedJson(s) {
    const tails = [']}]}', '}]}', ']}}', ']}', ']}', '}}', ']'];
    const lastBrace = s.lastIndexOf('}');
    if (lastBrace > 0) {
        const head = s.slice(0, lastBrace + 1).replace(/[,\s]+$/, '');
        for (const tail of tails) {
            try {
                const obj = JSON.parse(head + tail);
                if (obj && Array.isArray(obj.units) && obj.units.length) return obj;
            } catch (_) { /* 换一种收尾 */ }
        }
    }
    // 倒着剪掉末尾不完整的部分，逐次自动补括号
    const floor = Math.max(10, s.length - 400);
    for (let cut = s.length; cut > floor; cut--) {
        const head = s.slice(0, cut).replace(/[,\s]+$/, '');
        const closed = autoCloseBrackets(head);
        if (!closed) continue;
        try {
            const obj = JSON.parse(closed);
            if (obj && Array.isArray(obj.units) && obj.units.length) return obj;
        } catch (_) { /* 继续剪 */ }
    }
    return null;
}

// 统计还有几层括号没闭合，补上
function autoCloseBrackets(s) {
    let inStr = false;
    let esc = false;
    const stack = [];
    for (const ch of s) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) return null;
    return s + stack.reverse().join('');
}

// 按勾选拼上下文喂给模型
async function collectAIContext() {
    const cfg = aiCfg();
    const src = cfg.sources;
    const c = ctx();
    const parts = [];

    if (src.chat && c && Array.isArray(c.chat) && c.chat.length) {
        const n = Math.max(1, Math.min(200, Number(cfg.chatCount) || 20));
        const msgs = c.chat.slice(-n);
        const text = msgs.map((m) => {
            const who = m.is_user ? '用户' : (m.name || '角色');
            return `${who}：${String(m.mes || '').slice(0, 2200)}`;
        }).join('\n');
        parts.push(`【最近 ${msgs.length} 条聊天】\n${text}`);
    }

    if (src.character) {
        const ch = c && c.characters ? c.characters[c.this_chid] : null;
        if (ch) {
            const bits = [ch.name, ch.description, ch.personality, ch.scenario].filter(Boolean);
            parts.push(`【角色卡】\n${bits.join('\n').slice(0, 4000)}`);
        }
    }

    if (src.worldbook) {
        try {
            const wi = (c && (c.worldInfoSettings && c.worldInfoSettings.world_info)) || (c && c.world_info);
            const names = Array.isArray(wi) ? wi : Object.keys(wi || {});
            if (names.length) parts.push(`【世界书条目】\n${names.slice(0, 60).join('、')}`);
        } catch (_) { /* 世界书结构不稳，拿不到就算了 */ }
    }

    if (src.mvu) {
        try {
            const mvu = await gatherMvu();
            if (mvu.length && mvu[0].filtered && mvu[0].filtered.text) {
                parts.push(`【MVU 变量】\n${mvu[0].filtered.text.slice(0, 3000)}`);
            }
        } catch (_) { /* 忽略 */ }
    }

    return parts.join('\n\n');
}

const AI_UNIT_PROMPT = `你是《斗罗大陆》的魂师数据顾问。根据材料提取所有能参与战斗的魂师，**只输出 JSON**，不要解释、不要代码块。

每个单位的字段：
- side: "ally"（主角方）或 "enemy"（敌对/反派）
- name: 名字
- lv: 魂力等级，1-99 的整数
- quality: trash | normal | fine | epic | divine（废武魂 / 普通 / 良品 / 极品 / 神级）
- role: attack | control | agility | defense | support | food（强攻 / 控制 / 敏攻 / 防御 / 辅助 / 食物）
- martial: 武魂名
- element: metal | wood | water | fire | earth | wind | thunder | light | dark | holy | life | poison | spirit | time | space | destroy
- skills: 魂技数组，每个 {name, kind, element, desc, effects?}
  kind: phys(物理) | spirit(精神) | control(控制) | heal(治疗) | buff(增益) | debuff(减益) | shield(护盾)
  desc 控制在 20 字内，别写小作文，省 token
  effects 是可选的特殊效果数组，按下面写：
  · {"type":"drainMp","value":20} 吸取魂力（抽目标最大魂力 20% 给自己）
  · {"type":"steal","stat":"atk","value":15,"turns":2} 偷属性（目标 -15%，自己 +15%，2 回合）
    stat 写 "all" 表示全五维一起偷（str vit agi spi sou），派生属性会跟着变
  · {"type":"silence","turns":2} 封印魂技（目标 2 回合内只能普攻）
  · {"type":"stun","turns":1} 眩晕
  · {"type":"burn","value":5,"turns":2} 灼烧 / "bleed" 流血
  · {"type":"shield","value":20,"turns":2} 护盾
  · {"type":"debuff","stat":"spd","value":-20,"turns":2} 减益
  stat 可取 str vit agi spi sou atk def spd hit eva crit
  **凡是材料里出现「吸取魂力 / 偷取属性 / 封印魂技 / 眩晕 / 灼烧流血 / 护盾」这类描述，必须用 effects 表达**
- techniques: 功法数组，每个 {name, mods, desc}
- equipment: 装备数组，每个 {name, slot, quality, mods, desc}
  slot: weapon | armor | accessory
- bones: 魂骨数组，每个 {name, slot, year, mods, desc}
  slot: head | torso | leftArm | rightArm | leftLeg | rightLeg
  year: 年限，100=十年 1000=百年 10000=万年 100000=十万年
- note: 一句话依据（可省略）

mods 只能用下面这些 key，不要自己编：
- 五维：str vit agi spi sou
- 派生：atk def spd hit eva crit critDmg penetration move atkSpd maxHp maxMp maxPoise
- 百分比：名字后加 Pct，如 atkPct critPct critDmgPct defPct spdPct hpPct penetrationPct poiseDmgPct ctrlPct
- 固定值：名字后加 Flat，如 penetrationFlat moveFlat atkSpdFlat

硬性要求：
- **魂技必须一个不漏**：材料里出现几个就写几个，按出现顺序列，不要合并、不要省略、不要写「等」「其他」这类占位
- **双生武魂有两套魂技，两套都要列**；一个单位十几个魂技是正常的，不要因为嫌长就少给
- 技能数量以材料为准，材料没写才留空数组
- **魂技只给名字/类型/属性/说明，不要给倍率、耗魂力、冷却、射程这些数值**，系统按类型套模板
- **不要给力量/体质/敏捷/精神/魂力这类五维数值**，系统按成长表算
- 功法/装备/魂骨的 mods 可以给，但要克制，单项不超过 30
- 材料里没写就按剧情合理推断；实在推不出就只给基础字段

输出格式：
{"units":[{"side":"ally","name":"唐三","lv":29,"quality":"trash","role":"control","martial":"蓝银草","element":"wood",
"skills":[{"name":"缠绕","kind":"control","element":"wood","desc":"蓝银草远程捆缚"}],
"techniques":[{"name":"玄天功","mods":{"strPct":8,"spiPct":15},"desc":"玄门正宗心法"}],
"equipment":[{"name":"精铁剑","slot":"weapon","quality":"normal","mods":{"atk":18},"desc":"普通制式短剑"}],
"bones":[{"name":"千年右臂魂骨","slot":"rightArm","year":1000,"mods":{"str":22},"desc":"力发于臂"}]}]}`;

/* AI 输出 → 内部结构的转换 */

const SKILL_KINDS = ['phys', 'spirit', 'control', 'heal', 'buff', 'debuff', 'shield'];
const KIND_TO_TEMPLATE = {
    phys: 'physSingle',
    spirit: 'spiritSingle',
    control: 'controlPhys',
    heal: 'heal',
    buff: 'buff',
    debuff: 'debuff',
    shield: 'shield',
};
const BONE_SLOTS_AI = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];

function clampAiNum(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
}

// mods 白名单式清洗：key 只允许字母 + 可选 Pct/Flat 后缀，值夹在 ±100
function sanitizeMods(mods) {
    if (!mods || typeof mods !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(mods)) {
        if (!/^[a-zA-Z]{2,20}(Pct|Flat)?$/.test(k)) continue;
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        out[k] = Math.max(-100, Math.min(100, n));
    }
    return out;
}

function aiUid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const EFFECT_TYPES = ['burn', 'bleed', 'stun', 'shield', 'drainMp', 'steal', 'silence', 'debuff', 'buff'];

function normalizeAiEffect(raw) {
    if (!raw || !EFFECT_TYPES.includes(raw.type)) return null;
    const out = {
        type: raw.type,
        value: clampAiNum(raw.value, -100, 100, 0),
        turns: clampAiNum(raw.turns, 1, 5, 2),
        chance: clampAiNum(raw.chance, 1, 100, 100),
        mode: raw.mode === 'flat' ? 'flat' : 'pct',
        label: String(raw.label || raw.type).slice(0, 10),
    };
    if (raw.stat) out.stat = String(raw.stat).slice(0, 10);
    return out;
}

// 魂技：只要名字/类型/属性/说明，数值从模板来
function normalizeAiSkill(raw, fallbackElement) {
    const kind = SKILL_KINDS.includes(raw.kind) ? raw.kind : 'phys';
    const tpl = SKILL_TEMPLATES[KIND_TO_TEMPLATE[kind]] || SKILL_TEMPLATES.physSingle;
    const el = ELEMENTS[raw.element] ? raw.element : (ELEMENTS[fallbackElement] ? fallbackElement : 'metal');
    const effects = Array.isArray(raw.effects) ? raw.effects.map((e) => normalizeAiEffect(e)).filter(Boolean) : [];
    return {
        id: aiUid('ai-skill'),
        name: String(raw.name || '无名魂技').slice(0, 20),
        element: el,
        kind,
        cost: clampAiNum(raw.cost, 1, 40, tpl.cost),
        cd: clampAiNum(raw.cd, 0, 6, tpl.cd || 0),
        power: clampAiNum(raw.power, 0, 3, tpl.power),
        poise: clampAiNum(raw.poise, 0, 80, tpl.poise),
        range: clampAiNum(raw.range, 0, 8, tpl.range),
        aoe: clampAiNum(raw.aoe, 0, 2, tpl.aoe),
        control: raw.control || tpl.control,
        target: kind === 'heal' || kind === 'buff' || kind === 'shield' ? 'ally' : 'enemy',
        effects,
        desc: String(raw.desc || '').slice(0, 80),
    };
}

function normalizeAiTech(raw) {
    return {
        id: aiUid('ai-tech'),
        name: String(raw.name || '无名功法').slice(0, 20),
        rarity: ['green', 'blue', 'purple', 'gold'].includes(raw.rarity) ? raw.rarity : 'blue',
        mods: sanitizeMods(raw.mods),
        desc: String(raw.desc || '').slice(0, 80),
    };
}

function normalizeAiEquip(raw) {
    const slot = ['weapon', 'armor', 'accessory'].includes(raw.slot) ? raw.slot : 'accessory';
    return {
        id: aiUid('ai-eq'),
        name: String(raw.name || '无名装备').slice(0, 20),
        slot,
        quality: QUALITY[raw.quality] ? raw.quality : 'normal',
        mods: sanitizeMods(raw.mods),
        desc: String(raw.desc || '').slice(0, 80),
    };
}

function normalizeAiBone(raw) {
    const slot = BONE_SLOTS_AI.includes(raw.slot) ? raw.slot : 'rightArm';
    return {
        id: aiUid('ai-bone'),
        name: String(raw.name || '无名魂骨').slice(0, 20),
        slot,
        year: clampAiNum(raw.year, 100, 100000, 1000),
        mods: sanitizeMods(raw.mods),
        desc: String(raw.desc || '').slice(0, 80),
    };
}

async function aiParseUnits() {
    if (!aiReady()) { toast('先到设置里启用 AI 并填 API Key'); return; }
    const material = await collectAIContext();
    if (!material.trim()) { toast('没收集到内容，检查「AI 读什么」的勾选'); return; }
    logOnly('[AI] 正在解析…');
    render();
    try {
        const content = await callAI([
            { role: 'system', content: AI_UNIT_PROMPT },
            { role: 'user', content: material.slice(0, 40000) },
        ]);
        const data = extractJson(content);
        if (!data || !Array.isArray(data.units) || !data.units.length) {
            logOnly('[AI] 返回里没找到 units 数组，原始内容：');
            logOnly(String(content).slice(0, 600));
            render();
            return;
        }
        const skillTotal = data.units.reduce((n, u) => n + (Array.isArray(u.skills) ? u.skills.length : 0), 0);
        if (lastAITruncated) {
            logOnly(`[AI] 警告：输出被 max_tokens 截断了（拿到 ${data.units.length} 人 / ${skillTotal} 个魂技）。`);
            logOnly('[AI] 建议：调小「聊天条数」减少材料，或把设置里的 maxTokens 调大。');
        }
        applyAIUnits(data.units);
    } catch (e) {
        logOnly(`[AI] 解析失败：${e.message}`);
        render();
    }
}

// AI 只定品质/等级/类型，五维走成长表，数值不会飞
function applyAIUnits(units) {
    const added = { ally: 0, enemy: 0 };
    for (const u of units) {
        const side = u.side === 'enemy' ? 'enemy' : 'ally';
        const quality = QUALITY[u.quality] ? u.quality : 'normal';
        const role = ROLES[u.role] ? u.role : 'attack';
        const lv = Math.max(1, Math.min(99, Math.round(Number(u.lv) || 1)));
        const element = ELEMENTS[u.element] ? u.element : 'metal';

        const skills = Array.isArray(u.skills) ? u.skills.map((s) => normalizeAiSkill(s, element)) : [];
        const techniques = Array.isArray(u.techniques) ? u.techniques.map((t) => normalizeAiTech(t)) : [];
        const equipment = Array.isArray(u.equipment) ? u.equipment.map((e) => normalizeAiEquip(e)) : [];
        const bones = Array.isArray(u.bones) ? u.bones.map((b) => normalizeAiBone(b)) : [];

        S.units[side].push({
            name: String(u.name || '无名魂师').slice(0, 20),
            lv,
            quality,
            role,
            martial: String(u.martial || '').slice(0, 20),
            element,
            attrs: growthAttrs({ quality, role, lv }),
            rings: ringsForLevel(lv),
            skills,
            techniques,
            equipment,
            bones,
            pos: defaultPos(side, S.units[side].length),
        });
        added[side] += 1;
        logOnly(`[AI] +${side === 'ally' ? '我方' : '敌方'} ${u.name} Lv.${lv} ${QUALITY[quality].name}${ROLES[role].name}`
            + `｜魂技 ${skills.length}｜功法 ${techniques.length}｜装备 ${equipment.length}｜魂骨 ${bones.length}`);
    }
    saveSettings();
    render();
    toast(`AI 加了 我方 ${added.ally} 人 / 敌方 ${added.enemy} 人`);
}

// 按等级发魂环：每 10 级一环
function ringsForLevel(lv) {
    const tiers = [100, 1000, 3000, 20000, 20000, 20000, 20000, 20000, 100000];
    const count = Math.min(9, Math.floor(lv / 10));
    return tiers.slice(0, count).map((year) => ({ year, skills: [] }));
}

/* ---------------- 导入 ---------------- */

function applyParsed(side, unit) {
    S.lastParse = unit;
    const draft = {
        name: unit.name || (side === 'ally' ? '我方单位' : '敌方单位'),
        lv: unit.lv,
        quality: unit.quality,
        role: unit.role,
        martial: unit.martial,
        element: unit.element,
        attrs: unit.attrs,
        rings: unit.rings,
        skills: unit.skills,
        techniques: unit.techniques,
        equipment: unit.equipment,
        bones: unit.bones,
        pos: side === 'ally' ? { x: 4, y: 3 } : { x: 8, y: 3 },
    };
    openEditor(side, -1, draft);
    if (unit.warnings?.length) {
        logOnly(`[导入] ${unit.name || '未命名'}：${summarize(unit)}`);
        for (const w of unit.warnings) logOnly(`[导入] 注意：${w}`);
        render();
    }
}

async function importFromCard(side) {
    const c = ctx();
    if (!c) { toast('拿不到酒馆上下文'); return; }
    const opts = S.settings.sources || DEFAULT_SOURCES;
    const blocks = gatherSources(c, opts);
    let mvuTotal = 0;
    if (opts.mvu) {
        try {
            const mvu = await gatherMvu();
            if (mvu.length) {
                const f = mvu[0].filtered;
                mvuTotal = f.total;
                if (f.hit) {
                    blocks.push({ label: `MVU 变量（命中 ${f.hit}/${f.total} 项）`, text: f.text });
                    logOnly(`[导入] MVU 命中战斗相关字段 ${f.hit}/${f.total} 项`);
                } else {
                    logOnly(`[导入] MVU 共 ${f.total} 项，没找到战斗相关字段（多半是提示词开关，不是角色属性）`);
                }
            } else {
                logOnly('[导入] 没读到 MVU 变量');
            }
        } catch (e) {
            logOnly(`[导入] MVU 读取失败：${e.message}`);
        }
    }
    if (!blocks.length) {
        if (mvuTotal > 0) {
            logOnly('[导入] 数据源里有内容但没有战斗字段 —— 改用「粘贴文本」手贴一段，或换成写了武魂/魂环的卡');
        } else {
            logOnly('[导入] 没读到任何文本，检查设置里的数据源勾选');
        }
        toast('没抽到战斗数据，看看日志');
        render();
        return;
    }
    const text = blocks.map((b) => b.text).join('\n\n');
    logOnly(`[导入] 读入 ${blocks.length} 段，共 ${text.length} 字：${blocks.map((b) => b.label).join('、')}`);
    // 名字兜底用当前角色卡的名字，别用 name2（那通常是人格名）
    const chName = c.characters?.[c.this_chid]?.name || '';
    const unit = parseUnit(text, { name: chName });
    applyParsed(side, unit);
}

function importFromPaste(side) {
    const el = document.createElement('div');
    el.className = 'dlc-modal';
    el.innerHTML = `
      <div class="dlc-modal-box" style="width:640px">
        <div class="dlc-modal-head">粘贴角色文本</div>
        <div class="dlc-form">
          <div class="dlc-note">把角色卡里和战斗有关的部分贴进来：武魂、魂力等级、魂环、魂技、魂骨、功法、五维。</div>
          <textarea class="dlc-textarea" rows="12" placeholder="姓名：唐昊&#10;魂力等级：92级&#10;武魂：昊天锤（极品）&#10;类型：强攻系&#10;属性：金&#10;力量：98 体质：90 敏捷：75 精神：60 魂力：95&#10;第一魂环：百年 第二魂环：千年&#10;第一魂技：昊天护体（护盾）&#10;魂骨：万年右臂魂骨&#10;功法：冲天诀 铁骨功"></textarea>
          <div class="dlc-row">
            <label>加到 <select data-paste-side>
              <option value="ally" ${side !== 'enemy' ? 'selected' : ''}>我方</option>
              <option value="enemy" ${side === 'enemy' ? 'selected' : ''}>敌方</option>
            </select></label>
            <span class="dlc-note">解析完会打开编辑器，阵营还能在那里改</span>
          </div>
        </div>
        <div class="dlc-modal-foot">
          <button class="dlc-btn" data-act="modal-cancel">取消</button>
          <button class="dlc-btn primary" data-act="paste-ok">解析</button>
        </div>
      </div>`;

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) {
            if (e.target === el) closeEditor();
            return;
        }
        const a = btn.getAttribute('data-act');
        if (a === 'modal-cancel') { closeEditor(); return; }
        if (a === 'paste-ok') {
            const ta = el.querySelector('.dlc-textarea');
            const text = ta ? ta.value : '';
            if (!text.trim()) { toast('文本是空的'); return; }
            S.importText = text;
            const targetSide = el.querySelector('[data-paste-side]')?.value || side || 'ally';
            closeEditor();
            const unit = parseUnit(text, {});
            applyParsed(targetSide, unit);
        }
    });

    document.body.appendChild(el);
    S.modalEl = el;
    bindModalEsc();
}

/* ---------------- 编辑器 ---------------- */

function blankUnit(side) {
    return {
        name: side === 'ally' ? '新我方单位' : '新敌方单位',
        lv: 30,
        quality: 'normal',
        role: 'attack',
        martial: '',
        element: 'earth',
        attrs: { str: 12, vit: 12, agi: 12, spi: 12, sou: 12 },
        rings: [{ year: 500, skills: [] }, { year: 3000, skills: [] }],
        techniques: [],
        equipment: ['iron-sword'],
        bones: [],
        skills: ['split-stone', 'flame-burst'],
        pos: side === 'ally' ? { x: 4, y: 3 } : { x: 8, y: 3 },
    };
}

function openEditor(side, index, draft) {
    S.editing = { side, index };
    const cfg = draft || (index < 0 ? blankUnit(side) : S.units[side][index]);
    const c = clone(cfg);
    c.attrs = c.attrs || {};
    c.rings = c.rings || [];
    c.skills = c.skills || [];
    c.techniques = c.techniques || [];
    c.equipment = c.equipment || [];
    c.bones = c.bones || [];
    c.pos = c.pos || { x: side === 'ally' ? 4 : 8, y: 3 };

    // 魂环上挂的魂技并进技能列表：不然预设单位开的头，编辑器里一片空，
    // 看起来像「没技能」，实际开战时由魂环带进去。
    {
        const have = new Set(c.skills.map(idOf));
        for (const r of c.rings) {
            for (const s of (r && r.skills) || []) {
                const id = idOf(s);
                if (id && !have.has(id)) {
                    have.add(id);
                    c.skills.push(typeof s === 'string' ? s : clone(s));
                }
            }
        }
    }

    const ringInputs = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
        const y = c.rings[i]?.year || 0;
        return `<input type="number" class="dlc-num small" data-ring="${i}" value="${y || ''}" placeholder="—" title="第${i + 1}魂环年限">`;
    }).join('');

    const qOpts = Object.values(QUALITY).map((q) =>
        `<option value="${q.id}" ${c.quality === q.id ? 'selected' : ''}>${q.name}</option>`).join('');
    const rOpts = Object.values(ROLES).map((r) =>
        `<option value="${r.id}" ${c.role === r.id ? 'selected' : ''}>${r.name}</option>`).join('');

    // ——— 魂技/魂骨/功法/装备：每个单位各存一份对象副本，改谁的只影响谁 ———
    const KIND_KEY = { skill: 'skills', bone: 'bones', tech: 'techniques', equip: 'equipment' };
    const KIND_RESOLVE = { skill: resolveSkill, bone: resolveBone, tech: resolveTech, equip: resolveEquip };

    const modsText = (mods) => Object.entries(mods || {})
        .map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join(' ') || '无加成';

    const ownDesc = (kind, o) => {
        if (kind === 'skill') return `${ELEMENTS[o.element]?.name || '无'}·${o.cost || 0}魂力·${(o.power ?? 1)}倍·射程${o.range ?? 1}`;
        if (kind === 'bone') return `${BONE_SLOT_NAMES[o.slot] || o.slot || '?'}·${o.year || 0}年`;
        if (kind === 'tech') return modsText(o.mods);
        return `${o.slot || '?'}·${modsText(o.mods)}`;
    };

    const ownBlock = (kind) => {
        const list = c[KIND_KEY[kind]] || [];
        const rows = list.map((raw, i) => {
            const o = KIND_RESOLVE[kind](raw);
            if (!o) return '';
            const priv = typeof raw === 'string' ? '' : ' ·私有';
            return `<div class="dlc-ownrow">
              <span class="dlc-ownname">${esc(o.name || o.id)}</span>
              <em>${esc(ownDesc(kind, o))}${priv}</em>
              <button type="button" class="dlc-mini" data-own-edit="${kind}:${i}">改</button>
              <button type="button" class="dlc-mini danger" data-own-del="${kind}:${i}">×</button>
            </div>`;
        }).join('');

        const haveIds = new Set(list.map(idOf));
        const tmpl = {
            skill: () => allSkills(),
            bone: () => DEFAULT_BONES,
            tech: () => Object.values(TECHNIQUES),
            equip: () => DEFAULT_EQUIPMENT,
        }[kind]();
        const opts = tmpl.filter((t) => !haveIds.has(t.id))
            .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');

        return `<div class="dlc-ownlist">${rows || '<div class="dlc-note">空，用下面的按钮加一个</div>'}</div>
          <div class="dlc-ownadd">
            <button type="button" class="dlc-mini" data-own-new="${kind}">+ 自定义</button>
            <select data-own-tmpl="${kind}"><option value="">+ 从模板添加…</option>${opts}</select>
          </div>`;
    };

    const el = document.createElement('div');
    el.className = 'dlc-modal';
    el.innerHTML = `
      <div class="dlc-modal-box">
        <div class="dlc-modal-head">${index < 0 ? '新增单位' : '编辑单位'}（${side === 'ally' ? '我方' : '敌方'}）</div>
        <div class="dlc-form">
          <div class="dlc-row">
            <label>名字 <input data-f="name" value="${esc(c.name)}"></label>
            <label>等级 <input type="number" class="dlc-num" data-f="lv" value="${c.lv}"></label>
            <label>武魂 <input data-f="martial" value="${esc(c.martial || '')}" placeholder="蓝银草"></label>
          </div>
          <div class="dlc-row">
            <label>阵营 <select data-side-target>
              <option value="ally" ${side !== 'enemy' ? 'selected' : ''}>我方</option>
              <option value="enemy" ${side === 'enemy' ? 'selected' : ''}>敌方</option>
            </select></label>
            <label>品质 <select data-f="quality">${qOpts}</select></label>
            <label>类型 <select data-f="role">${rOpts}</select></label>
            <label>属性 <select data-f="element">${elementOptions(c.element)}</select></label>
          </div>
          <div class="dlc-row">
            <label>站位 X <input type="number" class="dlc-num small" data-pos="x" value="${c.pos.x}"></label>
            <label>站位 Y <input type="number" class="dlc-num small" data-pos="y" value="${c.pos.y}"></label>
            <span class="dlc-note">战场 ${BATTLEFIELD.width}×${BATTLEFIELD.height}</span>
          </div>
          <div class="dlc-attrs">
            ${[['str', '力'], ['vit', '体'], ['agi', '敏'], ['spi', '神'], ['sou', '魂']].map(([k, label]) =>
                `<label>${label}<input type="number" class="dlc-num" data-attr="${k}" value="${c.attrs[k] || 0}"></label>`).join('')}
          </div>
          <div class="dlc-attrbar">
            <button type="button" class="dlc-mini" data-act="attr-roll">按成长表重算</button>
            <span class="dlc-note" data-attr-preview>按「品质 + 类型 + 等级」算裸五维，算完仍可手改</span>
          </div>
          <div class="dlc-section">魂环年限（留空表示没有这一环）</div>
          <div class="dlc-rings">${ringInputs}</div>
          <div class="dlc-section">魂技</div>
          ${ownBlock('skill')}
          <div class="dlc-section">魂骨</div>
          ${ownBlock('bone')}
          <div class="dlc-section">功法</div>
          ${ownBlock('tech')}
          <div class="dlc-section">装备</div>
          ${ownBlock('equip')}
        </div>
        <div class="dlc-modal-foot">
          <button class="dlc-btn" data-act="modal-cancel">取消</button>
          <button class="dlc-btn primary" data-act="modal-save">保存</button>
        </div>
      </div>`;

    el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) {
            // 四类物品的增删改按钮不是 [data-act]，单独处理
            const newBtn = e.target.closest('[data-own-new]');
            if (newBtn) {
                const draft = readEditorForm(el, c);
                closeEditor();
                openItemEditor({ side, index, draft }, newBtn.getAttribute('data-own-new'), -1);
                return;
            }
            const editBtn = e.target.closest('[data-own-edit]');
            if (editBtn) {
                const [kind, i] = editBtn.getAttribute('data-own-edit').split(':');
                const draft = readEditorForm(el, c);
                closeEditor();
                openItemEditor({ side, index, draft }, kind, Number(i));
                return;
            }
            const delBtn = e.target.closest('[data-own-del]');
            if (delBtn) {
                const [kind, i] = delBtn.getAttribute('data-own-del').split(':');
                const draft = readEditorForm(el, c);
                const key = KIND_KEY[kind];
                draft[key] = (draft[key] || []).filter((_, idx) => idx !== Number(i));
                closeEditor();
                openEditor(side, index, draft);
                return;
            }
            if (e.target === el) closeEditor();
            return;
        }
        const a = act.getAttribute('data-act');
        if (a === 'modal-cancel') closeEditor();
        if (a === 'modal-save') saveEditor(el, c);
        if (a === 'attr-roll') {
            const q = el.querySelector('[data-f="quality"]')?.value || 'normal';
            const r = el.querySelector('[data-f="role"]')?.value || 'attack';
            const lv = Number(el.querySelector('[data-f="lv"]')?.value) || 10;
            const target = growthAttrs({ quality: q, role: r, lv });
            const raw = attrsFromTarget(target, q, r);
            for (const k of ['str', 'vit', 'agi', 'spi', 'sou']) {
                const inp = el.querySelector(`[data-attr="${k}"]`);
                if (inp) inp.value = raw[k];
            }
            const pv = el.querySelector('[data-attr-preview]');
            if (pv) {
                pv.textContent = `成品五维 ${['str', 'vit', 'agi', 'spi', 'sou']
                    .map((k) => `${k.toUpperCase()} ${target[k]}`).join(' / ')}`;
            }
            toast(`按 ${QUALITY[q]?.name || q} · ${ROLES[r]?.name || r} · Lv.${lv} 重算`);
        }
    });

    // 从模板添加：复制一份副本塞进这个单位，之后改的只影响它
    el.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-own-tmpl]');
        if (!sel || !sel.value) return;
        const kind = sel.getAttribute('data-own-tmpl');
        const pool = {
            skill: () => allSkills(),
            bone: () => DEFAULT_BONES,
            tech: () => Object.values(TECHNIQUES),
            equip: () => DEFAULT_EQUIPMENT,
        }[kind]();
        const tpl = (pool || []).find((t) => t.id === sel.value);
        if (!tpl) return;
        const draft = readEditorForm(el, c);
        draft[KIND_KEY[kind]] = (draft[KIND_KEY[kind]] || []).concat([clone(tpl)]);
        closeEditor();
        openEditor(side, index, draft);
    });

    document.body.appendChild(el);
    S.modalEl = el;
    bindModalEsc();
}

/* ---------------- 物品编辑：魂技 / 魂骨 / 功法 / 装备 ---------------- */

const ITEM_KEY = { skill: 'skills', bone: 'bones', tech: 'techniques', equip: 'equipment' };
const ITEM_NAME = { skill: '魂技', bone: '魂骨', tech: '功法', equip: '装备' };
const ITEM_RESOLVE = { skill: resolveSkill, bone: resolveBone, tech: resolveTech, equip: resolveEquip };

function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function parseMods(txt) {
    const out = {};
    for (const seg of String(txt || '').split(/[,，;；\s]+/)) {
        const m = seg.match(/^([A-Za-z]+)\s*[=:]\s*(-?\d+(?:\.\d+)?)$/);
        if (m) out[m[1]] = Number(m[2]);
    }
    return out;
}

function modsToText(mods) {
    return Object.entries(mods || {}).map(([k, v]) => `${k}=${v}`).join(', ');
}

// 四类物品共用一个弹窗。存的是这个单位自己的对象副本，改谁不影响谁。
// ctx = { side, index, draft } —— 保存后按草稿重开单位编辑器，免得表单丢掉。
// 技能特效：文本 ↔ 结构。一行一条，冒号分隔（全角半角都认）
function parseEffects(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const raw = line.trim();
        if (!raw) continue;
        const parts = raw.split(/[:：]/).map((s) => s.trim());
        const type = parts[0];
        if (!EFFECT_TYPES.includes(type)) continue;
        const eff = { type, value: 0, turns: 2, chance: 100, mode: 'pct', label: type };
        if (type === 'steal' || type === 'debuff' || type === 'buff') {
            eff.stat = parts[1] || (type === 'steal' ? 'all' : 'atk');
            eff.value = Number(parts[2]);
            if (!Number.isFinite(eff.value)) eff.value = type === 'steal' ? 15 : -15;
            eff.turns = Number(parts[3]) || 2;
        } else if (type === 'silence' || type === 'stun') {
            eff.turns = Number(parts[1]) || (type === 'stun' ? 1 : 2);
        } else {
            eff.value = Number(parts[1]) || 20;
            eff.turns = Number(parts[2]) || 2;
        }
        out.push(eff);
    }
    return out;
}

function effectsToText(effects) {
    if (!Array.isArray(effects) || !effects.length) return '';
    return effects.map((e) => {
        if (e.type === 'steal' || e.type === 'debuff' || e.type === 'buff') {
            return `${e.type}:${e.stat || 'atk'}:${e.value || 0}:${e.turns || 2}`;
        }
        if (e.type === 'silence' || e.type === 'stun') return `${e.type}:${e.turns || 2}`;
        return `${e.type}:${e.value || 0}:${e.turns || 2}`;
    }).join('\n');
}

function openItemEditor(ctx, kind, idx) {
    const key = ITEM_KEY[kind];
    const list = ctx.draft[key] || [];
    const isNew = idx < 0;
    // 列表里可能还存着全局库的 id 字符串（老数据 / 预设单位），先解析成对象再当草稿，
    // 否则 Object.assign(默认值, 'xxx') 会把字符串的字符索引当字段，名字就丢了。
    const raw = isNew ? null : list[idx];
    const base = raw == null ? {} : (typeof raw === 'string' ? (ITEM_RESOLVE[kind](raw) || { id: raw }) : raw);
    const src = isNew ? {} : JSON.parse(JSON.stringify(base));
    const back = () => { closeEditor(); openEditor(ctx.side, ctx.index, ctx.draft); };

    const boneSlotOpts = (cur) => Object.keys(BONE_SLOT_NAMES).map((k) =>
        `<option value="${k}" ${cur === k ? 'selected' : ''}>${BONE_SLOT_NAMES[k]}</option>`).join('');

    const modsRow = (cur) => `
      <div class="dlc-row">
        <label style="flex:1">加成 <input type="text" data-i="mods" value="${esc(modsToText(cur))}" placeholder="atkPct=8, critDmgPct=6, str=5"></label>
      </div>
      <div class="dlc-note">写法 <code>键=数值</code>，逗号分隔。五维直接写 <code>str/vit/agi/spi/sou</code>；百分比加 <code>Pct</code> 后缀（<code>atkPct</code>）；固定值加 <code>Flat</code> 后缀（<code>moveFlat</code>）。</div>`;

    let body = '';
    if (kind === 'skill') {
        const s = Object.assign({
            name: '', element: 'metal', kind: 'phys', power: 1.2, poise: 20,
            cost: 8, cd: 0, range: 1, aoe: 0, control: '', move: '', penetration: 0, desc: '',
        }, src);
        const kindOpts = [
            ['phys', '物理伤害'], ['spirit', '精神伤害'], ['heal', '治疗'],
            ['buff', '增益'], ['debuff', '减益'], ['shield', '护盾'], ['control', '控制'],
        ].map(([v, t]) => `<option value="${v}" ${s.kind === v ? 'selected' : ''}>${t}</option>`).join('');
        const elOpts = elementOptions(s.element);
        const aoeOpts = [[0, '单体'], [1, '敌方全体'], [2, '我方全体']].map(([v, t]) =>
            `<option value="${v}" ${Number(s.aoe) === v ? 'selected' : ''}>${t}</option>`).join('');
        const ctrlOpts = [['', '不控制'], ['bind', '物理束缚（对抗韧性）'], ['illusion', '幻境（对抗精神力）']]
            .map(([v, t]) => `<option value="${v}" ${s.control === v ? 'selected' : ''}>${t}</option>`).join('');
        const moveOpts = [['', '原地'], ['dash', '突进'], ['push', '击退']]
            .map(([v, t]) => `<option value="${v}" ${s.move === v ? 'selected' : ''}>${t}</option>`).join('');

        body = `
          <div class="dlc-row">
            <label>名字 <input type="text" data-i="name" value="${esc(s.name)}" placeholder="如 天罡碎星诀"></label>
            <label>属性 <select data-i="element">${elOpts}</select></label>
            <label>类别 <select data-i="kind">${kindOpts}</select></label>
          </div>
          <div class="dlc-row">
            <label>倍率 <input type="number" step="0.05" class="dlc-num" data-i="power" value="${s.power}"></label>
            <label>耗魂力 <input type="number" class="dlc-num" data-i="cost" value="${s.cost}"></label>
            <label>冷却 <input type="number" class="dlc-num" data-i="cd" value="${s.cd}"></label>
            <label>射程 <input type="number" class="dlc-num" data-i="range" value="${s.range}"></label>
          </div>
          <div class="dlc-row">
            <label>削韧 <input type="number" class="dlc-num" data-i="poise" value="${s.poise}"></label>
            <label>穿透 % <input type="number" class="dlc-num" data-i="penetration" value="${s.penetration || 0}"></label>
            <label>范围 <select data-i="aoe">${aoeOpts}</select></label>
          </div>
          <div class="dlc-row">
            <label>控制 <select data-i="control">${ctrlOpts}</select></label>
            <label>位移 <select data-i="move">${moveOpts}</select></label>
          </div>
          <div class="dlc-note">倍率 = 攻击力的倍数，1.0 约等于一次普攻。射程按格算。控制时长：束缚看对方掉了多少韧性，幻境看双方精神力差。</div>
          <div class="dlc-row">
            <label style="flex:1">说明 <input type="text" data-i="desc" value="${esc(s.desc)}" placeholder="会出现在战报里"></label>
          </div>
          <div class="dlc-row">
            <label style="flex:1">特效
              <textarea data-i="effects" rows="3" placeholder="点下面的按钮添加，也可以手打">${esc(effectsToText(s.effects))}</textarea>
            </label>
          </div>
          <div class="dlc-row">
            <select data-eff-type style="flex:1">
              <option value="stealAll">吸取全属性</option>
              <option value="steal">吸取单项属性</option>
              <option value="drainMp">吸取魂力</option>
              <option value="silence">封印魂技</option>
              <option value="slow">减速（速度 -）</option>
              <option value="haste">加速（速度 +）</option>
              <option value="stun">眩晕</option>
              <option value="burn">灼烧</option>
              <option value="bleed">流血</option>
              <option value="shield">护盾</option>
              <option value="debuff">减益（通用）</option>
            </select>
            <input data-eff-stat placeholder="属性: atk/spi…" style="width:110px">
            <input type="number" data-eff-value placeholder="数值" class="dlc-num" style="width:70px">
            <input type="number" data-eff-turns placeholder="回合" class="dlc-num" style="width:70px">
            <button type="button" class="dlc-mini" data-act="eff-add">+ 加特效</button>
          </div>
          <div class="dlc-note">
            选类型、填数值（吸魂力/灼烧/护盾填百分比，偷属性填 15 就是 ±15%），点「+ 加特效」自动写进去。
            <br>手写也行：<code>steal:all:15:3</code>｜<code>drainMp:30</code>｜<code>silence:2</code>｜<code>stun:1</code>｜<code>burn:5:2</code>｜<code>debuff:spd:-20:2</code>
          </div>`;
    } else if (kind === 'bone') {
        const s = Object.assign({ name: '', slot: 'torso', year: 1000, mods: {} }, src);
        body = `
          <div class="dlc-row">
            <label>名字 <input type="text" data-i="name" value="${esc(s.name)}" placeholder="如 玄水右臂骨"></label>
            <label>部位 <select data-i="slot">${boneSlotOpts(s.slot)}</select></label>
            <label>年限 <input type="number" class="dlc-num" data-i="year" value="${s.year}"></label>
          </div>
          <div class="dlc-note">年限决定档位：百年≈1000 / 千年≈3000 / 万年≈20000 / 十万年≈100000。</div>
          ${modsRow(s.mods)}`;
    } else if (kind === 'tech') {
        const s = Object.assign({ name: '', mods: {}, desc: '' }, src);
        body = `
          <div class="dlc-row">
            <label style="flex:1">名字 <input type="text" data-i="name" value="${esc(s.name)}" placeholder="如 玄天功"></label>
          </div>
          ${modsRow(s.mods)}
          <div class="dlc-row">
            <label style="flex:1">说明 <input type="text" data-i="desc" value="${esc(s.desc)}"></label>
          </div>`;
    } else {
        const s = Object.assign({ name: '', slot: '武器', mods: {} }, src);
        body = `
          <div class="dlc-row">
            <label>名字 <input type="text" data-i="name" value="${esc(s.name)}" placeholder="如 幽冥镰"></label>
            <label>部位 <input type="text" data-i="slot" value="${esc(s.slot)}" placeholder="武器 / 护甲 / 饰品"></label>
          </div>
          ${modsRow(s.mods)}`;
    }

    const el = document.createElement('div');
    el.className = 'dlc-modal';
    el.style.zIndex = '100002';
    el.innerHTML = `
      <div class="dlc-modal-box" style="width:660px">
        <div class="dlc-modal-head">${isNew ? '新建' : '编辑'}${ITEM_NAME[kind]}</div>
        <div class="dlc-form">${body}</div>
        <div class="dlc-modal-foot">
          <button class="dlc-btn" data-act="item-cancel">取消</button>
          <button class="dlc-btn primary" data-act="item-save">保存</button>
        </div>
      </div>`;

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) { if (e.target === el) back(); return; }
        const a = btn.getAttribute('data-act');
        if (a === 'item-cancel') { back(); return; }
        if (a === 'eff-add') {
            const pick = (sel) => el.querySelector(sel);
            const type = pick('[data-eff-type]') ? pick('[data-eff-type]').value : 'stealAll';
            const stat = (pick('[data-eff-stat]') ? pick('[data-eff-stat]').value : '').trim();
            const vRaw = Number(pick('[data-eff-value]') ? pick('[data-eff-value]').value : 0);
            const tRaw = Number(pick('[data-eff-turns]') ? pick('[data-eff-turns]').value : 0);
            const v = Number.isFinite(vRaw) && vRaw !== 0 ? vRaw : 0;
            const t = Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 2;
            let line = '';
            if (type === 'stealAll') line = `steal:all:${v || 15}:${t}`;
            else if (type === 'steal') line = `steal:${stat || 'atk'}:${v || 15}:${t}`;
            else if (type === 'drainMp') line = `drainMp:${v || 20}`;
            else if (type === 'silence') line = `silence:${t}`;
            else if (type === 'slow') line = `debuff:spd:-${Math.abs(v) || 20}:${t}`;
            else if (type === 'haste') line = `debuff:spd:${Math.abs(v) || 20}:${t}`;
            else if (type === 'stun') line = `stun:${t === 2 ? 1 : t}`;
            // 减益统一取负：填 20 和填 -20 都是降低
            else if (type === 'debuff') line = `debuff:${stat || 'atk'}:-${Math.abs(v) || 15}:${t}`;
            else line = `${type}:${v || 20}:${t}`;
            const ta = pick('[data-i="effects"]');
            if (ta) {
                const cur = String(ta.value || '').trimEnd();
                ta.value = cur ? `${cur}\n${line}` : line;
            }
            toast(`加了特效 ${line}`);
            return;
        }
        if (a !== 'item-save') return;

        const g = (n) => el.querySelector(`[data-i="${n}"]`);
        const num = (n, d) => {
            const node = g(n);
            const v = Number(node && node.value);
            return Number.isFinite(v) ? v : d;
        };
        const txt = (n) => {
            const node = g(n);
            return node ? String(node.value || '').trim() : '';
        };

        let item;
        if (kind === 'skill') {
            item = {
                id: isNew ? uid('custom') : (src.id || uid('custom')),
                name: txt('name') || '无名魂技',
                element: g('element').value,
                kind: g('kind').value,
                power: num('power', 1),
                cost: num('cost', 0),
                cd: num('cd', 0),
                range: num('range', 1),
                poise: num('poise', 0),
                penetration: num('penetration', 0),
                aoe: num('aoe', 0),
                control: g('control').value,
                move: g('move').value,
                desc: txt('desc'),
                effects: parseEffects(txt('effects')),
                _custom: true,
            };
        } else if (kind === 'bone') {
            item = {
                id: isNew ? uid('bone') : (src.id || uid('bone')),
                name: txt('name') || '无名魂骨',
                slot: g('slot').value,
                year: num('year', 1000),
                mods: parseMods(txt('mods')),
            };
        } else if (kind === 'tech') {
            item = {
                id: isNew ? uid('tech') : (src.id || uid('tech')),
                name: txt('name') || '无名功法',
                mods: parseMods(txt('mods')),
                desc: txt('desc'),
            };
        } else {
            item = {
                id: isNew ? uid('equip') : (src.id || uid('equip')),
                name: txt('name') || '无名装备',
                slot: txt('slot') || '饰品',
                mods: parseMods(txt('mods')),
            };
        }

        const next = (ctx.draft[key] || []).slice();
        if (isNew) next.push(item);
        else next[idx] = item;
        ctx.draft[key] = next;
        back();
    });

    document.body.appendChild(el);
    S.modalEl = el;
    bindModalEsc();
}

function closeEditor() {
    if (S.modalEl && S.modalEl.parentNode) S.modalEl.parentNode.removeChild(S.modalEl);
    S.modalEl = null;
    S.editing = null;
    if (S.escHandler) {
        document.removeEventListener('keydown', S.escHandler, true);
        S.escHandler = null;
    }
}

// 弹窗统一支持 ESC 关闭（否则遮罩吃点击就能把界面锁死）
function bindModalEsc() {
    if (S.escHandler) document.removeEventListener('keydown', S.escHandler, true);
    S.escHandler = (e) => {
        if (e.key === 'Escape' && S.modalEl) {
            e.preventDefault();
            e.stopPropagation();
            closeEditor();
            render();
        }
    };
    document.addEventListener('keydown', S.escHandler, true);
}

/* ---------------- 设置 ---------------- */

async function probeMvu() {
    logOnly('[探变量] ────────');
    let mvu = [];
    try {
        mvu = await gatherMvu();
    } catch (e) {
        logOnly(`[探变量] 读取失败：${e.message}`);
    }
    if (!mvu.length) {
        const g = window.TavernHelper;
        logOnly(`[探变量] 没读到 MVU 变量（TavernHelper ${g ? '存在' : '不存在'}）`);
        if (g) logOnly(`[探变量] 可用方法：${Object.keys(g).filter((k) => typeof g[k] === 'function').slice(0, 20).join(', ')}`);
    } else {
        for (const line of describeMvu(mvu[0].raw).split('\n')) logOnly(`[探变量] ${line}`);
    }
    render();
}

// 属性下拉：按 tier 分组（五行 / 四象 / 高阶 / 其他），用户自己加的属性归「其他」
function elementOptions(cur) {
    const labels = { basic: '五行', ext: '四象', rare: '高阶' };
    const buckets = {};
    for (const [k, d] of Object.entries(ELEMENTS)) {
        const t = d.tier || 'ext';
        if (!buckets[t]) buckets[t] = [];
        buckets[t].push([k, d]);
    }
    const order = ['basic', 'ext', 'rare', ...Object.keys(buckets).filter((t) => !labels[t])];
    return order.filter((t) => buckets[t] && buckets[t].length).map((t) => {
        const opts = buckets[t].map(([k, d]) =>
            `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
        return labels[t] ? `<optgroup label="${labels[t]}">${opts}</optgroup>` : opts;
    }).join('');
}

// 设置里的「属性与克制」区：直接改运行时表，取消时整表回滚
function renderElementEditor(el) {
    const chipBox = el.querySelector('[data-elem-chips]');
    if (!chipBox) return;
    const chips = Object.entries(ELEMENTS).map(([k, d]) =>
        `<span class="dlc-chip" style="--chip:${d.color || '#9fb3c8'}">${esc(d.name)}<button type="button" data-elem-del="${k}" title="删除这个属性">×</button></span>`);
    chipBox.innerHTML = chips.join('') || '<span class="dlc-note">还没有属性</span>';

    const listBox = el.querySelector('[data-beat-list]');
    const rows = [];
    for (const [a, arr] of Object.entries(ELEMENT_BEATS)) {
        for (const b of arr) {
            if (!ELEMENTS[b]) continue;
            rows.push(`<span class="dlc-beatchip"><b>${esc(ELEMENTS[a]?.name || a)}</b><i>克</i><b>${esc(ELEMENTS[b].name)}</b><button type="button" data-beat-del="${a}|${b}">×</button></span>`);
        }
    }
    listBox.innerHTML = rows.join('') || '<span class="dlc-note">还没有克制关系</span>';

    const opts = Object.entries(ELEMENTS).map(([k, d]) => `<option value="${k}">${esc(d.name)}</option>`).join('');
    const sa = el.querySelector('[data-beat-a]');
    const sb = el.querySelector('[data-beat-b]');
    if (sa) { const v = sa.value; sa.innerHTML = opts; if (v) sa.value = v; }
    if (sb) { const v = sb.value; sb.innerHTML = opts; if (v) sb.value = v; }
}

const ELEM_PALETTE = ['#9be7d0', '#ffe066', '#fff3b0', '#8b7bd8', '#ffd9a0', '#7be8a8', '#a3e635', '#d8b4fe', '#c0c8ff', '#a0a8e8', '#ff5c5c', '#ff9ecb'];

function openSettings() {
    const s = S.settings;
    const src = s.sources || DEFAULT_SOURCES;
    const rules = s.rules || DEFAULT_RULES;
    const ai = aiCfg();
    // 属性表是就地改的，取消时整表回滚
    const elemBackup = elementConfigSnapshot();

    const el = document.createElement('div');
    el.className = 'dlc-modal';
    el.innerHTML = `
      <div class="dlc-modal-box">
        <div class="dlc-modal-head">设置</div>
        <div class="dlc-form">
          <div class="dlc-section">导入数据源</div>
          <div class="dlc-grid">
            <label class="dlc-check"><input type="checkbox" data-src="card" ${src.card ? 'checked' : ''}><span>角色卡文本</span><em>描述 / 性格 / 场景 / 系统提示</em></label>
            <label class="dlc-check"><input type="checkbox" data-src="lorebook" ${src.lorebook ? 'checked' : ''}><span>内嵌世界书</span><em>卡里绑定的条目，文字多但杂</em></label>
            <label class="dlc-check"><input type="checkbox" data-src="mvu" ${src.mvu ? 'checked' : ''}><span>MVU 变量</span><em>走 TavernHelper.getVariables</em></label>
            <label class="dlc-check"><input type="checkbox" data-src="chat" ${src.chat ? 'checked' : ''}><span>聊天记录</span><em>最近 12 条，噪音最大</em></label>
          </div>
          <div class="dlc-section">AI 接入（OpenAI 兼容）</div>
          <div class="dlc-grid">
            <label class="dlc-check"><input type="checkbox" data-ai="enabled" ${ai.enabled ? 'checked' : ''}><span>启用 AI</span><em>关掉就全手动</em></label>
            <label class="dlc-check"><input type="checkbox" data-ai-src="chat" ${ai.sources.chat ? 'checked' : ''}><span>读聊天记录</span><em>最近 N 条</em></label>
            <label class="dlc-check"><input type="checkbox" data-ai-src="character" ${ai.sources.character ? 'checked' : ''}><span>读角色卡</span><em>描述 / 性格 / 场景</em></label>
            <label class="dlc-check"><input type="checkbox" data-ai-src="worldbook" ${ai.sources.worldbook ? 'checked' : ''}><span>读世界书</span><em>条目名列表</em></label>
            <label class="dlc-check"><input type="checkbox" data-ai-src="mvu" ${ai.sources.mvu ? 'checked' : ''}><span>读 MVU 变量</span><em>结构化数据</em></label>
          </div>
          <div class="dlc-row">
            <label style="flex:2">Base URL <input data-ai="baseUrl" value="${esc(ai.baseUrl)}" placeholder="https://api.deepseek.com/v1"></label>
          </div>
          <div class="dlc-row">
            <label style="flex:2">API Key <input type="password" data-ai="apiKey" value="${esc(ai.apiKey)}" placeholder="sk-..."></label>
            <label style="flex:1">模型 <input data-ai="model" value="${esc(ai.model)}" placeholder="deepseek-chat"></label>
          </div>
          <div class="dlc-row">
            <label>温度 <input type="number" step="0.1" class="dlc-num" data-ai="temperature" value="${ai.temperature}"></label>
            <label>聊天条数 <input type="number" class="dlc-num" data-ai="chatCount" value="${ai.chatCount}"></label>
            <label>推演 <select data-ai="mode">
              <option value="off" ${ai.mode === 'off' ? 'selected' : ''}>关（全手动）</option>
              <option value="enemy" ${ai.mode === 'enemy' ? 'selected' : ''}>AI 控敌方</option>
              <option value="auto" ${ai.mode === 'auto' ? 'selected' : ''}>AI 全托管</option>
              <option value="narrator" ${ai.mode === 'narrator' ? 'selected' : ''}>AI 只润色战报</option>
            </select></label>
            <button type="button" class="dlc-mini" data-act="ai-test">测试连接</button>
          </div>
          <div class="dlc-note" data-ai-status>AI 只定品质 / 等级 / 类型，五维仍按成长表算，数值不会飞。</div>

          <div class="dlc-section">战斗规则</div>
          <div class="dlc-row">
            <label>防御常数 K <input type="number" class="dlc-num" data-rule="defenseK" value="${rules.defenseK}"></label>
            <label>穿透上限 % <input type="number" class="dlc-num" data-rule="penCap" value="${rules.penCap}"></label>
            <label>控制上限回合 <input type="number" class="dlc-num" data-rule="controlMaxTurns" value="${rules.controlMaxTurns}"></label>
            <label>行动条系数 <input type="number" step="0.01" class="dlc-num" data-rule="atbSpeed" value="${rules.atbSpeed}"></label>
          </div>
          <div class="dlc-note">K 越大减伤越弱；穿透上限封顶百分比穿透；行动条系数越大出手越频繁（0.08 ≈ 速度 100 一回合一次）。</div>
          <div class="dlc-section">显示与写入</div>
          <div class="dlc-grid">
            <label class="dlc-check"><input type="checkbox" data-opt="showDice" ${s.showDice ? 'checked' : ''}><span>日志显示骰点</span><em>命中 / 暴击的掷骰明细</em></label>
            <label class="dlc-check"><input type="checkbox" data-opt="autoWrite" ${s.autoWrite ? 'checked' : ''}><span>结束自动写入</span><em>打完直接把战报推进聊天</em></label>
          </div>

          <div class="dlc-section">属性</div>
          <div class="dlc-elems" data-elem-chips></div>
          <div class="dlc-row">
            <input data-new-elem placeholder="新属性名，如 冰霜 / 虚空" style="flex:1">
            <button type="button" class="dlc-mini" data-act="elem-add">+ 属性</button>
          </div>

          <div class="dlc-section">克制关系</div>
          <div class="dlc-beats" data-beat-list></div>
          <div class="dlc-row">
            <select data-beat-a style="flex:1"></select>
            <span class="dlc-note" style="flex:0 0 auto">克</span>
            <select data-beat-b style="flex:1"></select>
            <button type="button" class="dlc-mini" data-act="beat-add">+ 克制</button>
          </div>
          <div class="dlc-note">克制 ×1.5，被克 ×0.5；互克（光暗那种）双方都只吃 ×1.5。删属性时它参与的克制对会一起删掉。点「保存」才真正生效。</div>
        </div>
        <div class="dlc-modal-foot">
          <button class="dlc-btn" data-act="modal-cancel">取消</button>
          <button class="dlc-btn primary" data-act="settings-save">保存</button>
        </div>
      </div>`;

    el.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) {
            // 删除属性 / 删除克制对：它们不是 [data-act]，单独处理
            const elemDel = e.target.closest('[data-elem-del]');
            if (elemDel) {
                const id = elemDel.getAttribute('data-elem-del');
                if (Object.keys(ELEMENTS).length <= 1) { toast('至少留一个属性'); return; }
                delete ELEMENTS[id];
                delete ELEMENT_BEATS[id];
                for (const list of Object.values(ELEMENT_BEATS)) {
                    const i = list.indexOf(id);
                    if (i >= 0) list.splice(i, 1);
                }
                renderElementEditor(el);
                return;
            }
            const beatDel = e.target.closest('[data-beat-del]');
            if (beatDel) {
                const [x, y] = beatDel.getAttribute('data-beat-del').split('|');
                const list = ELEMENT_BEATS[x] || [];
                const i = list.indexOf(y);
                if (i >= 0) list.splice(i, 1);
                renderElementEditor(el);
                return;
            }
            if (e.target === el) closeEditor();
            return;
        }
        const a = act.getAttribute('data-act');
        if (a === 'modal-cancel') { applyElementConfig(elemBackup); closeEditor(); return; }
        if (a === 'settings-save') { saveSettingsModal(el); return; }

        if (a === 'ai-test') {
            const st = el.querySelector('[data-ai-status]');
            const prev = S.settings.ai;
            S.settings.ai = readAIFields(el);
            if (st) st.textContent = '测试中…';
            callAI([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 20 })
                .then((t) => { if (st) st.textContent = `通了！模型回：${String(t).trim().slice(0, 40)}`; })
                .catch((e) => { if (st) st.textContent = `失败：${e.message}`; })
                .finally(() => { S.settings.ai = prev; });
            return;
        }

        if (a === 'elem-add') {
            const inp = el.querySelector('[data-new-elem]');
            const name = (inp?.value || '').trim();
            if (!name) { toast('先写个属性名'); return; }
            if (Object.values(ELEMENTS).some((d) => d.name === name)) { toast(`「${name}」已经有了`); return; }
            const id = `el_${Date.now().toString(36)}`;
            ELEMENTS[id] = { id, name, color: ELEM_PALETTE[Object.keys(ELEMENTS).length % ELEM_PALETTE.length], tier: 'ext' };
            ELEMENT_BEATS[id] = [];
            if (inp) inp.value = '';
            renderElementEditor(el);
            toast(`加了属性「${name}」`);
            return;
        }
        if (a === 'beat-add') {
            const a2 = el.querySelector('[data-beat-a]')?.value;
            const b2 = el.querySelector('[data-beat-b]')?.value;
            if (!a2 || !b2) { toast('两个属性都要选'); return; }
            if (a2 === b2) { toast('不能克制自己'); return; }
            if (!ELEMENT_BEATS[a2]) ELEMENT_BEATS[a2] = [];
            if (ELEMENT_BEATS[a2].includes(b2)) { toast('这条已经有了'); return; }
            ELEMENT_BEATS[a2].push(b2);
            renderElementEditor(el);
            return;
        }
    });

    document.body.appendChild(el);
    S.modalEl = el;
    bindModalEsc();
    renderElementEditor(el);
}

// 从设置表单里读出 AI 配置
function readAIFields(el) {
    const ai = {};
    el.querySelectorAll('[data-ai]').forEach((i) => {
        const k = i.getAttribute('data-ai');
        if (i.type === 'checkbox') ai[k] = i.checked;
        else if (i.type === 'number') ai[k] = Number(i.value) || 0;
        else ai[k] = String(i.value || '').trim();
    });
    const src = {};
    el.querySelectorAll('[data-ai-src]').forEach((i) => {
        src[i.getAttribute('data-ai-src')] = i.checked;
    });
    ai.sources = Object.assign({}, DEFAULT_AI.sources, src);
    return Object.assign({}, DEFAULT_AI, ai);
}

function saveSettingsModal(el) {
    // AI 配置
    S.settings.ai = readAIFields(el);

    const sources = {};
    el.querySelectorAll('[data-src]').forEach((i) => {
        sources[i.getAttribute('data-src')] = i.checked;
    });
    S.settings.sources = Object.assign({}, DEFAULT_SOURCES, sources);

    const rules = {};
    el.querySelectorAll('[data-rule]').forEach((i) => {
        const v = Number(i.value);
        if (Number.isFinite(v)) rules[i.getAttribute('data-rule')] = v;
    });
    S.settings.rules = Object.assign({}, DEFAULT_RULES, rules);

    el.querySelectorAll('[data-opt]').forEach((i) => {
        S.settings[i.getAttribute('data-opt')] = i.checked;
    });

    // 属性/克制：这时表已经按用户点击改好了，直接快照存下来
    S.settings.elementConfig = elementConfigSnapshot();

    applyRules();
    saveSettings();
    closeEditor();
    render();
}

// 从编辑器 DOM 收集数据。新建/保存单位都走它，「新建魂技」时也用它暂存当前输入。
function readEditorForm(el, c) {
    const q = (sel) => el.querySelector(sel);
    const keepList = (arr) => (arr || []).map((v) => (typeof v === 'string' ? v : clone(v)));
    const out = {
        name: q('[data-f="name"]').value.trim() || '无名魂师',
        lv: Number(q('[data-f="lv"]').value) || 1,
        quality: q('[data-f="quality"]').value,
        role: q('[data-f="role"]').value,
        martial: q('[data-f="martial"]').value.trim(),
        element: q('[data-f="element"]').value,
        attrs: {},
        rings: [],
        // 这四类直接沿用草稿里的私有数据，不再从勾选框收集
        skills: keepList(c && c.skills),
        techniques: keepList(c && c.techniques),
        equipment: keepList(c && c.equipment),
        bones: keepList(c && c.bones),
        pos: {},
    };
    el.querySelectorAll('[data-attr]').forEach((i) => {
        out.attrs[i.getAttribute('data-attr')] = Number(i.value) || 0;
    });
    el.querySelectorAll('[data-pos]').forEach((i) => {
        out.pos[i.getAttribute('data-pos')] = Number(i.value) || 0;
    });
    el.querySelectorAll('[data-ring]').forEach((i) => {
        const y = Number(i.value);
        // 魂技统一在 skills 列表里管，魂环只留年限，免得同一招被挂两遍
        if (y > 0) out.rings.push({ year: y, skills: [] });
    });
    return out;
}

function saveEditor(el, c) {
    if (!S.editing) return;
    const out = readEditorForm(el, c);
    const { side, index } = S.editing;
    // 编辑器里可以改阵营：保存时把单位挪到目标那一栏
    const targetSide = el.querySelector('[data-side-target]')?.value || side;

    if (index < 0) {
        S.units[targetSide].push(out);
    } else if (targetSide === side) {
        S.units[side][index] = out;
    } else {
        S.units[side].splice(index, 1);
        S.units[targetSide].push(out);
        logOnly(`[编辑] ${out.name} 从${side === 'ally' ? '我方' : '敌方'}调到${targetSide === 'ally' ? '我方' : '敌方'}`);
    }

    saveSettings();
    closeEditor();
    S.battle = null;
    render();
}

/* ---------------- 事件 ---------------- */

function onAction(act, el) {
    logOnly(`[动作] ${act}`);
    switch (act) {
        case 'close':
            if (S.timer) { clearTimeout(S.timer); S.timer = null; }
            S.root.classList.remove('open');
            return;
        case 'start':
            buildBattle();
            return;
        case 'concede': {
            const bb = S.battle;
            if (!bb || bb.finished) { toast('现在没有进行中的斗魂'); return; }
            if (!window.confirm('确定认输？我方全员退出演武场，判负。')) return;
            afterAction(bb.concede('ally'));
            return;
        }
        case 'cancel':
            S.pendingSkill = null;
            render();
            return;
        case 'write':
            flushTexts(true);
            return;
        case 'reset': {
            const total = S.units.ally.length + S.units.enemy.length;
            if (total > 0 && !window.confirm(`重置队伍会把当前 ${total} 个单位（包括 AI 解析出来的）换成预设单位，确定？`)) return;
            S.battle = null;
            S.pendingSkill = null;
            S.pendingTexts = [];
            S.uiLog = [];
            if (S.timer) { clearTimeout(S.timer); S.timer = null; }
            resetToPresets();
            render();
            return;
        }
        case 'seed':
            S.settings.seed = String(Math.floor(Math.random() * 100000));
            toast(`骰子种子：${S.settings.seed}`);
            render();
            return;
        case 'diag':
            runDiagnostics();
            render();
            return;
        case 'settings':
            openSettings();
            return;
        case 'probe':
            probeMvu();
            return;
        case 'import': {
            // 默认加到「我方」：粘贴的多半是自己要用的角色，错了在编辑器里还能换阵营
            const side = el.getAttribute('data-side') || 'ally';
            importFromCard(side);
            return;
        }
        case 'ai-parse':
            aiParseUnits();
            return;
        case 'paste': {
            const side = el.getAttribute('data-side') || 'ally';
            importFromPaste(side);
            return;
        }
        case 'add':
            openEditor(el.getAttribute('data-side'), -1);
            return;
        case 'del': {
            const side = el.getAttribute('data-side');
            const idx = Number(el.getAttribute('data-index'));
            S.units[side].splice(idx, 1);
            saveSettings();
            S.battle = null;
            S.pendingSkill = null;
            render();
            return;
        }
        default:
            return;
    }
}

// 拖拽落点：把地图上的单位挪到指定格
function dropUnitTo(uid, x, y) {
    if (S.battle) { toast('战斗中不能拖拽，点空格移动'); return; }
    const m = /^p-([ae])(\d+)$/.exec(String(uid || ''));
    if (!m) return;
    const side = m[1] === 'a' ? 'ally' : 'enemy';
    const idx = Number(m[2]);
    const u = S.units[side] && S.units[side][idx];
    if (!u) return;
    if (x < 0 || x >= BATTLEFIELD.width || y < 0 || y >= BATTLEFIELD.height) return;
    const taken = [...S.units.ally, ...S.units.enemy].some(
        (o) => o && o !== u && o.pos && o.pos.x === x && o.pos.y === y,
    );
    if (taken) { toast('那格已经有人了'); return; }
    u.pos = { x, y };
    saveSettings();
    render();
}

function bindRoot(root) {
    // 拖动标题栏移动浮窗 / 拖右下角缩放
    let drag = null;
    let resize = null;
    root.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-resize]')) {
            const r = root.getBoundingClientRect();
            resize = { w: r.width, h: r.height, sx: e.clientX, sy: e.clientY };
            root.classList.add('resizing');
            e.preventDefault();
            return;
        }
        if (!e.target.closest('[data-drag]')) return;
        if (e.target.closest('button, input, label, select')) return;
        const r = root.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        root.classList.add('dragging');
        e.preventDefault();
    });
    const onMove = (e) => {
        if (resize) {
            const w = Math.max(520, Math.min(window.innerWidth - 20, resize.w + (e.clientX - resize.sx)));
            const h = Math.max(360, Math.min(window.innerHeight - 40, resize.h + (e.clientY - resize.sy)));
            root.style.width = `${Math.round(w)}px`;
            root.style.height = `${Math.round(h)}px`;
            root.style.maxHeight = 'none';
            return;
        }
        if (!drag) return;
        const w = root.offsetWidth;
        const h = root.offsetHeight;
        const x = Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - drag.dx));
        const y = Math.max(4, Math.min(window.innerHeight - 48, e.clientY - drag.dy));
        root.style.left = `${x}px`;
        root.style.top = `${y}px`;
        root.style.right = 'auto';
    };
    const onUp = () => {
        if (resize) {
            resize = null;
            root.classList.remove('resizing');
            if (S.settings) {
                S.settings.panelSize = { width: root.style.width, height: root.style.height };
                saveSettings();
            }
            return;
        }
        if (!drag) return;
        drag = null;
        root.classList.remove('dragging');
        if (S.settings) {
            S.settings.panelPos = { left: root.style.left, top: root.style.top };
            saveSettings();
        }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    // ESC 关面板（弹窗开着时交给 bindModalEsc 处理，这里不动）
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || S.modalEl) return;
        if (!S.root || !S.root.classList.contains('open')) return;
        S.root.classList.remove('open');
    });
    // 拖拽场上单位摆位（仅战斗前）
    root.addEventListener('dragstart', (e) => {
        const cell = e.target.closest('[data-drag-uid]');
        const uid = cell ? cell.getAttribute('data-drag-uid') : '';
        if (!uid) { e.preventDefault(); return; }
        if (e.dataTransfer) {
            e.dataTransfer.setData('text/plain', uid);
            e.dataTransfer.effectAllowed = 'move';
        }
    });
    root.addEventListener('dragover', (e) => {
        if (!e.target.closest('[data-cell]')) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    root.addEventListener('drop', (e) => {
        const cell = e.target.closest('[data-cell]');
        if (!cell) return;
        e.preventDefault();
        const uid = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
        if (!uid) return;
        const xy = String(cell.getAttribute('data-cell') || '').split(',').map(Number);
        if (xy.length !== 2 || xy.some((n) => !Number.isFinite(n))) return;
        dropUnitTo(uid, xy[0], xy[1]);
    });

    root.addEventListener('click', (e) => {
        const nudgeEl = e.target.closest('[data-nudge]');
        if (nudgeEl) {
            const [side, idx, dir] = nudgeEl.getAttribute('data-nudge').split(':');
            nudgeUnit(side, Number(idx), dir);
            return;
        }
        const editEl = e.target.closest('[data-edit]');
        if (editEl) {
            const [side, idx] = editEl.getAttribute('data-edit').split(':');
            openEditor(side, Number(idx));
            return;
        }
        const cellEl = e.target.closest('[data-cell]');
        if (cellEl) {
            const [x, y] = cellEl.getAttribute('data-cell').split(',').map(Number);
            onCellClick(x, y);
            return;
        }
        const skillEl = e.target.closest('[data-skill]');
        if (skillEl && !skillEl.disabled) {
            onSkill(skillEl.getAttribute('data-skill'));
            return;
        }
        const unitEl = e.target.closest('[data-unit]');
        if (unitEl && S.pendingSkill) {
            onUnitClick(unitEl.getAttribute('data-unit'));
            return;
        }
        const actEl = e.target.closest('[data-act]');
        if (actEl) onAction(actEl.getAttribute('data-act'), actEl);
    });

    root.addEventListener('change', (e) => {
        const t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-toggle') === 'autoWrite') {
            S.settings.autoWrite = !!t.checked;
            saveSettings();
        }
    });

    // 调试：确认点击落点（排查"点了没反应"时打开）
    // 注意：这里绝不能重绘面板，innerHTML 替换会让随后的 click 事件丢掉
    if (S.debugClicks) {
        root.addEventListener('pointerdown', (e) => {
            const t = e.target;
            const tag = t && t.tagName ? t.tagName : '?';
            const cls = t && t.className ? String(t.className).slice(0, 40) : '';
            logOnly(`[点] ${Math.round(e.clientX)},${Math.round(e.clientY)} → ${tag}.${cls}`);
        }, true);
    }
}

/* ---------------- 挂载 ---------------- */

// 打开 / 关闭面板（悬浮球和扩展菜单都用它）
function togglePanel() {
    if (!S.root) buildPanel();
    if (!S.root) return;
    if (S.root.classList.contains('open')) {
        S.root.classList.remove('open');
        return;
    }
    S.root.classList.add('open');
    try {
        renderPanel();
    } catch (e) {
        console.error('[douluo-combat] renderPanel failed', e);
    }
}

// 常驻悬浮球：可拖动，点一下开关面板
function buildFab() {
    if (document.getElementById('dlc-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'dlc-fab';
    fab.type = 'button';
    fab.title = '斗魂演武场（点击打开 / 拖动换位置）';
    fab.textContent = '⚔';
    document.body.appendChild(fab);

    const saved = S.settings && S.settings.fabPos;
    if (saved && saved.left) {
        fab.style.left = saved.left;
        fab.style.top = saved.top;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    }

    let drag = null;
    let moved = false;
    fab.addEventListener('mousedown', (e) => {
        const r = fab.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
        moved = false;
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!drag) return;
        if (!moved && (Math.abs(e.clientX - drag.sx) > 3 || Math.abs(e.clientY - drag.sy) > 3)) moved = true;
        if (!moved) return;
        const x = Math.max(4, Math.min(window.innerWidth - 54, e.clientX - drag.dx));
        const y = Math.max(4, Math.min(window.innerHeight - 54, e.clientY - drag.dy));
        fab.style.left = `${x}px`;
        fab.style.top = `${y}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
        if (!drag) return;
        const wasDrag = moved;
        drag = null;
        if (wasDrag) {
            if (S.settings) {
                S.settings.fabPos = { left: fab.style.left, top: fab.style.top };
                saveSettings();
            }
        } else {
            togglePanel();
        }
    });
}

function buildPanel() {
    if (document.getElementById('dlc-panel')) {
        S.root = document.getElementById('dlc-panel');
        return;
    }
    const root = document.createElement('div');
    root.id = 'dlc-panel';
    document.body.appendChild(root);
    S.root = root;
    // 恢复上次拖动留下的位置和缩放过的大小
    const savedPos = S.settings && S.settings.panelPos;
    if (savedPos && savedPos.left) {
        root.style.left = savedPos.left;
        root.style.top = savedPos.top;
        root.style.right = 'auto';
    }
    const savedSize = S.settings && S.settings.panelSize;
    if (savedSize && savedSize.width) {
        root.style.width = savedSize.width;
        root.style.height = savedSize.height;
        root.style.maxHeight = 'none';
    }
    bindRoot(root);
    try {
        renderPanel();
    } catch (e) {
        console.error('[douluo-combat] renderPanel failed', e);
        root.innerHTML = `
          <div class="dlc-head"><div class="dlc-title">⚔ 斗魂演武场</div></div>
          <div style="padding:16px;color:#ff9b8a;white-space:pre-wrap;font-family:monospace;font-size:12px;overflow:auto">渲染失败：${esc((e && e.stack) || e)}</div>`;
    }
    try {
        const r = root.getBoundingClientRect();
        logOnly(`[布局] 视口 ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} zoom=${Math.round((window.outerWidth / window.innerWidth) * 100) / 100}`);
        logOnly(`[布局] 面板 ${Math.round(r.left)},${Math.round(r.top)} 尺寸 ${Math.round(r.width)}x${Math.round(r.height)} 底边 ${Math.round(r.bottom)}`);
        renderPanel();
    } catch (e) { /* 忽略 */ }
}

function mountSettingsEntry() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;
    if (document.getElementById('dlc-entry')) return true;
    const box = document.createElement('div');
    box.id = 'dlc-entry';
    box.className = 'dlc-entry';
    box.innerHTML = `
      <div class="dlc-entry-head">⚔ 斗魂演武场</div>
      <p class="dlc-note">斗罗斗魂判定台：武魂品质 / 魂环 / 魂技 / 魂骨 / 功法，站位地图，命中·暴击·穿透·削韧·破防·控制，结果可写入正文。</p>
      <button id="dlc-open" class="menu_button">打开斗魂面板</button>`;
    host.appendChild(box);
    const btn = box.querySelector('#dlc-open');
    if (btn) {
        btn.addEventListener('click', () => {
            buildPanel();
            S.root.classList.add('open');
            try {
                renderPanel();
            } catch (e) {
                console.error('[douluo-combat] renderPanel failed', e);
                S.root.innerHTML = `
                  <div class="dlc-head"><div class="dlc-title">⚔ 斗魂演武场</div></div>
                  <div style="padding:16px;color:#ff9b8a;white-space:pre-wrap;font-family:monospace;font-size:12px;overflow:auto">渲染失败：${esc((e && e.stack) || e)}</div>`;
            }
        });
    }
    return true;
}

async function init() {
    await ensureSettings();
    buildPanel();
    buildFab();
    try {
        runDiagnostics();
        render();
    } catch (e) {
        console.warn('[douluo-combat] 自检失败', e);
    }

    if (!mountSettingsEntry()) {
        let tries = 0;
        const t = setInterval(() => {
            tries += 1;
            if (mountSettingsEntry() || tries > 20) clearInterval(t);
        }, 500);
    }

    const c = ctx();
    if (c && c.eventSource && c.eventTypes && c.eventTypes.EXTENSION_SETTINGS_LOADED) {
        c.eventSource.on(c.eventTypes.EXTENSION_SETTINGS_LOADED, mountSettingsEntry);
    }

    const root = document.getElementById('dlc-panel');
    if (root) {
        let dragging = false;
        let ox = 0;
        let oy = 0;
        root.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.dlc-head') || e.target.closest('button')) return;
            dragging = true;
            const rect = root.getBoundingClientRect();
            ox = e.clientX - rect.left;
            oy = e.clientY - rect.top;
            root.style.right = 'auto';
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            root.style.left = `${e.clientX - ox}px`;
            root.style.top = `${e.clientY - oy}px`;
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    }
}

if (typeof jQuery !== 'undefined') {
    jQuery(async () => {
        try {
            await init();
        } catch (e) {
            console.error('[douluo-combat] init failed', e);
        }
    });
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch((e) => console.error(e)));
} else {
    init().catch((e) => console.error(e));
}

export { S };