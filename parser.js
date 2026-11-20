// douluo-combat / parser.js
// 从酒馆文本里抽斗罗数据：先正则，正则拿不到的再靠关键词兜底，最后交给 UI 手动改。
// 只读文本，不写任何宿主状态。

import {
    QUALITY,
    ROLES,
    ELEMENTS,
    RING_TIERS,
    SKILL_TEMPLATES,
    SKILL_KEYWORDS,
    TECHNIQUES,
    DEFAULT_EQUIPMENT,
    DEFAULT_BONES,
    findSkill,
    registerSkills,
    growthAttrs,
    ATTR_ORDER,
} from './data.js';

/* ---------------- 小工具 ---------------- */

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNum(s) {
    if (!s) return 0;
    const t = String(s).trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (t === '十') return 10;
    if (t.length === 1) return CN_NUM[t] || 0;
    // 十一 ~ 十九 / 二十 ~ 九十九
    const m = t.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
    return 0;
}

function firstMatch(text, patterns) {
    for (const re of patterns) {
        const m = String(text).match(re);
        if (m) return m;
    }
    return null;
}

/* ---------------- 规则表 ---------------- */

const QUALITY_WORDS = [
    ['神级', 'divine'], ['绝世', 'divine'], ['超级', 'epic'], ['极品', 'epic'], ['上品', 'epic'],
    ['良品', 'fine'], ['中品', 'fine'], ['普通', 'normal'], ['下品', 'normal'], ['废', 'trash'],
];

const QUALITY_LETTERS = [
    ['SSS', 'divine'], ['SS', 'epic'], ['S', 'epic'], ['A', 'fine'], ['B', 'normal'], ['C', 'trash'], ['D', 'trash'],
];

const ROLE_WORDS = [
    ['强攻', 'attack'], ['敏攻', 'agility'], ['控制', 'control'], ['防御', 'defense'],
    ['辅助', 'support'], ['食物', 'food'], ['双生', 'twin'],
];

const ELEMENT_WORDS = [
    ['金', 'metal'], ['锐', 'metal'], ['剑', 'metal'], ['锤', 'metal'], ['枪', 'metal'], ['刃', 'metal'], ['铁', 'metal'],
    ['木', 'wood'], ['草', 'wood'], ['藤', 'wood'], ['蓝银', 'wood'], ['竹', 'wood'], ['森', 'wood'],
    ['水', 'water'], ['冰', 'water'], ['霜', 'water'], ['寒', 'water'], ['雪', 'water'], ['海', 'water'],
    ['火', 'fire'], ['焰', 'fire'], ['炎', 'fire'], ['赤', 'fire'], ['焚', 'fire'],
    ['土', 'earth'], ['岩', 'earth'], ['石', 'earth'], ['龟', 'earth'], ['熊', 'earth'], ['地', 'earth'],
    ['风', 'wind'], ['气', 'wind'],
    ['雷', 'thunder'], ['电', 'thunder'],
    ['神圣', 'holy'], ['圣光', 'holy'], ['圣', 'holy'],
    ['光明', 'light'], ['光', 'light'],
    ['暗', 'dark'], ['影', 'dark'], ['黑', 'dark'],
    ['生命', 'life'], ['生灵', 'life'],
    ['毒', 'poison'],
    ['精神', 'spirit'], ['魂', 'spirit'],
    ['时间', 'time'],
    ['空间', 'space'],
    ['毁灭', 'destroy'], ['灭', 'destroy'],
];

const RING_COLORS = {
    白: 50, 黄: 500, 紫: 3000, 黑: 35000, 红: 120000, 金: 300000,
};

/* ---------------- 行式文本解析 ---------------- */
// 支持这种一行一单位的写法（豆包/表格导出的常见格式）：
//   唐三:Lv.29,控制系,蓝银草,废武魂,str=7.88,vit=7.88,agi=11.25,spi=18.00,sou=11.25,功法=玄天功(str=2,vit=2,atkPct=5)
//   魂技1:缠绕,木,控制,倍率0.3,耗魂力6,冷却2,削韧15,穿透0,射程3,范围单体,控制=束缚,位移=原地,说明=...
//   玄技:紫极魔瞳,精神,探测/精神伤害,倍率0.7,耗魂力8,冷却3,削韧18,穿透0,射程4,范围3×3群体,...

const ROW_HEAD = /^([^\s:：,，]{1,16})\s*[:：]\s*(.*)$/;
const ROW_ITEM = /^(魂技|玄技|魂骨|功法|装备|秘技|绝技)(\d*)\s*[:：]\s*(.+)$/;
const ROW_LV = /^(?:Lv\.?|lv\.?|等级)\s*(\d{1,3})$/i;

// 只按半角逗号切，括号内的不动（功法=玄天功(str=2,vit=2) 这种）
function splitFields(s) {
    const out = [];
    let buf = '';
    let depth = 0;
    for (const ch of String(s)) {
        if (ch === '(' || ch === '（') depth += 1;
        else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
        // 只切半角逗号：说明里的全角逗号是正文，不能当分隔符
        if (ch === ',' && depth === 0) {
            if (buf.trim()) out.push(buf.trim());
            buf = '';
            continue;
        }
        buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
}

function kvOf(field) {
    let m = String(field).match(/^([^=＝]{1,10})[=＝]\s*(.*)$/);
    if (m) return { k: m[1].trim(), v: m[2].trim() };
    // 「倍率0.3」「范围自身」「位移原地」这种键名+值、没有等号的写法
    m = String(field).match(/^(倍率|耗魂力|魂力消耗|冷却|削韧|穿透|射程|范围|控制|位移|说明|属性)\s*[:：]?\s*(.+)$/);
    if (m) return { k: m[1], v: m[2].trim() };
    return { k: '', v: String(field).trim() };
}

// 长词排前面：新解析是按「字段包含关键词」匹配的，'圣光' 必须先于 '光'
const ROW_ELEM = [
    ['圣光', 'holy'], ['神圣', 'holy'],
    ['光明', 'light'], ['光', 'light'],
    ['雷', 'thunder'], ['电', 'thunder'],
    ['风', 'wind'], ['气', 'wind'],
    ['暗', 'dark'], ['影', 'dark'],
    ['生命', 'life'],
    ['毒', 'poison'],
    ['精神', 'spirit'],
    ['时间', 'time'], ['空间', 'space'],
    ['毁灭', 'destroy'],
    ['金', 'metal'], ['锐', 'metal'], ['铁', 'metal'],
    ['木', 'wood'], ['草', 'wood'], ['藤', 'wood'],
    ['水', 'water'], ['冰', 'water'], ['霜', 'water'],
    ['火', 'fire'], ['炎', 'fire'], ['焰', 'fire'],
    ['土', 'earth'], ['岩', 'earth'], ['石', 'earth'],
];

const ROW_KIND = [
    ['控制', 'control'], ['束缚', 'control'], ['致盲', 'control'],
    ['减益', 'debuff'], ['削弱', 'debuff'], ['中毒', 'debuff'],
    ['增益', 'buff'], ['强化', 'buff'], ['辅助', 'buff'],
    ['治疗', 'heal'], ['回复', 'heal'], ['恢复', 'heal'],
    ['护盾', 'shield'], ['防御', 'shield'],
    ['探测', 'mental'], ['精神', 'mental'], ['幻', 'mental'],
    ['物理', 'phys'], ['攻击', 'phys'],
];

const ROW_CONTROL = [
    ['束缚', 'root'], ['定身', 'root'], ['缠绕', 'root'],
    ['致盲', 'blind'], ['眩晕', 'stun'], ['昏迷', 'stun'], ['晕', 'stun'],
    ['沉默', 'silence'], ['封印', 'silence'],
    ['减速', 'slow'], ['冻结', 'freeze'], ['冰封', 'freeze'],
    ['不控制', ''], ['无', ''],
];

const ROW_MOVE = [
    ['原地', 'none'], ['不动', 'none'],
    ['机动', 'blink'], ['瞬移', 'blink'], ['闪烁', 'blink'],
    ['突进', 'dash'], ['冲锋', 'dash'], ['接近', 'dash'],
    ['击退', 'knockback'], ['推开', 'knockback'],
];

function pickFrom(list, text, dflt = null) {
    for (const [k, v] of list) if (String(text).includes(k)) return v;
    return dflt;
}

function toNum(v, dflt = 0) {
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : dflt;
}

/**
 * 解析「一行一单位」的结构化文本。
 * 命中返回完整 unit，不命中返回 null（交给老的宽松解析）。
 */
export function parseRowUnit(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;

    // 至少得有一行长得像「魂技N:」或「玄技:」，否则不当结构化文本
    const itemLines = lines.filter((l) => ROW_ITEM.test(l));
    const headLine = lines.find((l) => ROW_HEAD.test(l) && !ROW_ITEM.test(l) && /,|，/.test(l));
    if (!headLine && !itemLines.length) return null;

    const out = {
        name: '',
        lv: 0,
        quality: 'normal',
        role: 'attack',
        martial: '',
        element: 'earth',
        attrs: {},
        rings: [],
        skills: [],
        techniques: [],
        equipment: [],
        bones: [],
        evidence: {},
        warnings: [],
    };
    const ev = out.evidence;

    /* --- 头部行 --- */
    let headFields = [];
    if (headLine) {
        const hm = headLine.match(ROW_HEAD);
        out.name = hm[1].trim();
        headFields = splitFields(hm[2]);
    }

    const loose = [];      // 认不出类型的字段，最后当武魂名兜底
    for (const f of headFields) {
        const lvM = f.match(ROW_LV);
        if (lvM) { out.lv = Number(lvM[1]); ev.lv = f; continue; }

        const roleHit = ['强攻', '敏攻', '控制', '防御', '辅助', '食物', '双生']
            .find((w) => f === `${w}系` || f === w || f === `${w}系魂师`);
        if (roleHit) { out.role = ROLE_WORDS.find(([w]) => w === roleHit)?.[1] || out.role; ev.role = f; continue; }

        const qHit = QUALITY_WORDS.find(([w]) => f === w || f === `${w}武魂`);
        if (qHit) { out.quality = qHit[1]; ev.quality = qHit[0]; continue; }

        const at = f.match(/^(str|vit|agi|spi|sou)\s*[=＝]\s*([\d.]+)$/i);
        if (at) { out.attrs[at[1].toLowerCase()] = Number(at[2]); ev[`attr_${at[1]}`] = f; continue; }

        const tech = f.match(/^功法\s*[=＝:：]\s*([^\s(（]+)\s*(?:[(（]([^)）]*)[)）])?/);
        if (tech) {
            const mods = {};
            if (tech[2]) {
                for (const seg of splitFields(tech[2])) {
                    const m = seg.match(/^([A-Za-z]+\w*)\s*[=＝]\s*(-?[\d.]+)$/);
                    if (m) mods[m[1]] = Number(m[2]);
                }
            }
            out.techniques.push({
                id: `parsed-tech-${slug(tech[1])}`,
                name: tech[1].trim(),
                mods,
                desc: '',
            });
            ev.techniques = f;
            continue;
        }

        loose.push(f);
    }

    // 认不出的字段里，挑一个最像武魂名的
    if (!out.martial && loose.length) {
        out.martial = loose.find((x) => !/[=＝]/.test(x)) || loose[0];
        ev.martial = out.martial;
    }

    /* --- 技能 / 魂骨 / 装备 行 --- */
    for (const line of lines) {
        const m = line.match(ROW_ITEM);
        if (!m) continue;
        const kindWord = m[1];
        const fields = splitFields(m[3]);
        if (!fields.length) continue;

        if (kindWord === '魂骨') {
            const slotWord = fields.find((f) => /头部|躯干|左臂|右臂|左腿|右腿/.test(f)) || '';
            const slot = { 头部: 'head', 躯干: 'torso', 左臂: 'leftArm', 右臂: 'rightArm', 左腿: 'leftLeg', 右腿: 'rightLeg' }[slotWord] || 'torso';
            const yearF = fields.find((f) => /年/.test(f)) || '';
            const year = /十万年/.test(yearF) ? 100000 : /万年/.test(yearF) ? 20000 : /千年/.test(yearF) ? 3000 : 1000;
            out.bones.push({ id: `parsed-bone-${slot}`, name: fields[0], slot, year, mods: {} });
            continue;
        }
        if (kindWord === '装备') {
            out.equipment.push({ id: `parsed-eq-${slug(fields[0])}`, name: fields[0], slot: '饰品', mods: {} });
            continue;
        }
        if (kindWord === '功法') {
            const mods = {};
            for (const f of fields.slice(1)) {
                const { k, v } = kvOf(f);
                if (k && /^[A-Za-z]/.test(k)) mods[k] = toNum(v);
            }
            out.techniques.push({ id: `parsed-tech-${slug(fields[0])}`, name: fields[0], mods, desc: '' });
            continue;
        }

        // 魂技 / 玄技 / 秘技 / 绝技
        const sk = { id: '', name: fields[0], element: null, kind: 'phys' };
        const rest = fields.slice(1);
        // 前两个位置固定是「属性」「类别」，但有的写法会省略属性
        // 属性和类别是可选的，而且属性位置偶尔放「风」这种五行外的词。
        // 规则：从头开始收集最多两个「不像 kv」的字段，第一个当属性、第二个当类别。
        let idx = 0;
        // 「控制」「范围」这类词既可能是类别值、也可能是键名，所以只有跟了 = 或数字才算 kv
        const looksKv = (s) => /[=＝]/.test(s)
            || /^(倍率|耗魂力|魂力消耗|冷却|削韧|穿透|射程)\s*[:：]?\s*[\d.]/.test(s);
        const head = [];
        while (idx < rest.length && head.length < 2 && !looksKv(rest[idx])) {
            head.push(rest[idx]);
            idx += 1;
        }
        if (head[0]) {
            const e = ROW_ELEM.find(([w]) => head[0].includes(w));
            if (e) sk.element = e[1];
        }
        const kindHit = head.map((h) => pickFrom(ROW_KIND, h, null)).find(Boolean);
        if (kindHit) sk.kind = kindHit;

        let power = 0, cost = 0, cd = 0, poise = 0, pen = 0, range = 1;
        let target = 'enemy', aoe = false, control = '', move = 'none', desc = '';

        for (const f of rest.slice(idx)) {
            const { k, v } = kvOf(f);
            if (!k) { if (!desc) desc = v; continue; }
            if (/^倍率$/.test(k)) power = toNum(v);
            else if (/^(耗魂力|魂力消耗)$/.test(k)) cost = toNum(v);
            else if (/^冷却$/.test(k)) cd = toNum(v);
            else if (/^削韧$/.test(k)) poise = toNum(v);
            else if (/^穿透$/.test(k)) pen = toNum(v);
            else if (/^射程$/.test(k)) range = toNum(v);
            else if (/^范围$/.test(k)) {
                if (/自身/.test(v)) { target = 'self'; }
                else if (/我方|友方/.test(v)) { target = 'allAlly'; }
                else if (/群体|全体|面积|\d+[×x*]\d+/.test(v)) { aoe = true; target = 'allEnemy'; }
                else { target = 'enemy'; }
            } else if (/^控制$/.test(k)) control = pickFrom(ROW_CONTROL, v, '');
            else if (/^位移$/.test(k)) {
                move = pickFrom(ROW_MOVE, v, 'none');
                const mm = v.match(/(\d+)\s*格/);
                if (mm) sk.moveRange = Number(mm[1]);
            } else if (/^说明$/.test(k)) desc = v;
            else if (/^属性$/.test(k)) {
                const e = ROW_ELEM.find(([w]) => v.includes(w));
                if (e) sk.element = e[1];
            }
        }

        sk.id = `parsed-${slug(sk.name)}-${out.skills.length}`;
        sk.power = power;
        sk.cost = cost;
        sk.cd = cd;
        sk.poise = poise;
        sk.penetration = pen;
        sk.range = range;
        sk.aoe = aoe;
        sk.target = target;
        sk.move = move;
        sk.desc = desc;
        sk._parsed = true;
        if (control) { sk.control = control; sk.controlTurns = 1; }
        if (sk.kind === 'heal' && aoe) sk.target = 'allAlly';
        if (sk.kind === 'buff' || sk.kind === 'shield') sk.target = sk.target === 'enemy' ? 'self' : sk.target;
        out.skills.push(sk);
    }

    if (!out.skills.length && !out.martial && !out.lv) return null;

    /* --- 五维没给就按成长表补 --- */
    if (!Object.keys(out.attrs).length) {
        out.attrs = attrsFromGrowthFallback(out);
        out.warnings.push('没写五维数值，已按「品质 + 系别 + 等级」成长表计算');
    } else {
        // 缺哪项补哪项
        const base = growthAttrs({ quality: out.quality, role: out.role, lv: out.lv || 10 });
        for (const k of ATTR_ORDER) if (out.attrs[k] == null) out.attrs[k] = base[k];
    }

    /* --- 等级兜底 --- */
    if (!out.lv) {
        out.lv = Math.min(99, Math.max(10, out.skills.length * 10 + 9));
        out.warnings.push(`没写等级，按 ${out.skills.length} 个魂技推成 ${out.lv} 级`);
    }

    /* --- 魂环：没写就按等级推 --- */
    if (!out.rings.length) {
        const n = Math.min(9, Math.max(1, Math.floor(out.lv / 10)));
        // 斗罗的常见配置：一环百年、二环千年、三环再千年、四到八环万年、九环十万年
        const yearByOrder = [100, 1000, 3000, 20000, 20000, 20000, 20000, 20000, 100000];
        for (let i = 0; i < n; i += 1) out.rings.push({ year: yearByOrder[i] || 100, skills: [] });
        if (n) ev.rings = `按 ${out.lv} 级推 ${n} 环`;
    }
    // 魂技挂到魂环上（只影响展示，战斗走 skills 列表）
    out.rings.forEach((r, i) => {
        const s = out.skills[i];
        if (s && !r.skills.length) r.skills = [s.id];
    });

    /* --- 元素兜底 --- */
    if (!out.element || out.element === 'earth') {
        out.element = pickFrom(ROW_ELEM, out.martial, 'earth') || 'earth';
    }

    if (!out.name) out.warnings.push('没解析到名字');
    return out;
}

// 用成长表算一组裸五维（直接当 attrs 用，不再做品质二次缩放）
function attrsFromGrowthFallback(u) {
    const target = growthAttrs({ quality: u.quality, role: u.role, lv: u.lv || 10 });
    // computeStats 还会乘 role.attrs 和 quality.mul，这里除回去保证最终值等于成长表
    const q = QUALITY[u.quality] || QUALITY.normal;
    const w = ROLES[u.role]?.attrs || ROLES.attack.attrs;
    const out = {};
    for (const k of ATTR_ORDER) {
        const denom = (w[k] ?? 1) * q.mul;
        out[k] = denom ? Math.round((target[k] / denom) * 100) / 100 : 0;
    }
    return out;
}

/* ---------------- 单位抽取 ---------------- */

export function parseUnit(text, hints = {}) {
    const src = String(text || '');

    // 先试「一行一单位」的结构化写法；命中就直接用，别让宽松正则再猜一遍
    const row = parseRowUnit(src);
    if (row) {
        if (hints.name) row.name = String(hints.name).trim();
        if (!row.name) row.name = hints.name || '无名魂师';
        return row;
    }

    const ev = {};
    const out = {
        name: '',
        lv: 0,
        quality: 'normal',
        role: 'attack',
        martial: '',
        element: 'earth',
        attrs: {},
        rings: [],
        skills: [],
        techniques: [],
        equipment: [],
        bones: [],
        evidence: ev,
        warnings: [],
    };

    /* --- 名字 --- */
    const nm = firstMatch(src, [
        /(?:姓名|名字|角色名)[:：]\s*([^\s，,。；;\n]{1,20})/,
        /^#+\s*([^\n#]{1,20})/m,
    ]);
    if (nm) { out.name = nm[1].trim(); ev.name = nm[0]; }
    if (!out.name && hints.name) out.name = String(hints.name).trim();

    /* --- 等级 --- */
    const lvM = firstMatch(src, [
        /魂力(?:等级)?[:：\s]*(\d{1,3})\s*级/,
        /魂力(?:等级)?[:：\s]*(\d{1,3})(?!\s*[%％])/,
        /(\d{1,3})\s*级(?:魂师|大魂师|魂尊|魂宗|魂王|魂帝|魂圣|魂斗罗|封号斗罗|魂灵|魂士)/,
        /(?:等级|级别|Lv)[:：.\s]*(\d{1,3})/i,
    ]);
    if (lvM) { out.lv = Number(lvM[1]); ev.lv = lvM[0]; }

    /* --- 武魂 --- */
    const wm = firstMatch(src, [
        /武魂[:：]\s*([^\s，,。；;、\n|｜]{1,20})/,
        /武魂[是为]\s*([^\s，,。；;、\n|｜]{1,20})/,
        /拥有([^\s，,。；;、\n]{2,12})武魂/,
    ]);
    if (wm) {
        // 武魂名后面常跟「（极品）」这类品质注解：品质从原文读，名字剥掉括号
        const raw = wm[1].trim();
        out.martial = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
        ev.martial = wm[0];
        ev.martialRaw = raw;
    }

    /* --- 品质 --- */
    const qScope = ev.martialRaw || src.slice(0, 400);
    for (const [word, id] of QUALITY_WORDS) {
        if (qScope.includes(word)) { out.quality = id; ev.quality = word; break; }
    }
    if (!ev.quality) {
        const qm = firstMatch(qScope, [/品质[:：]?\s*([A-Z]{1,3})/, /(?:^|[\s（(])([A-Z]{1,3})(?:级|武魂|品质)/]);
        if (qm) {
            const hit = QUALITY_LETTERS.find(([k]) => k === qm[1]);
            if (hit) { out.quality = hit[1]; ev.quality = qm[0]; }
        }
    }

    /* --- 魂师类型 --- */
    for (const [word, id] of ROLE_WORDS) {
        if (src.includes(`${word}系`) || src.includes(word)) { out.role = id; ev.role = word; break; }
    }

    /* --- 元素 --- */
    const em = firstMatch(src, [
        /(金|木|水|火|土)(?:属性|系|元素)/,
        /属性[:：]\s*(金|木|水|火|土)/,
    ]);
    if (em) { out.element = ELEMENT_WORDS.find(([w]) => w === em[1])?.[1] || 'earth'; ev.element = em[0]; }
    else {
        for (const [word, id] of ELEMENT_WORDS) {
            if ((out.martial && out.martial.includes(word)) || src.slice(0, 200).includes(word)) {
                out.element = id; ev.element = word; break;
            }
        }
    }

    /* --- 五维 --- */
    const attrMap = [
        ['str', ['力量', '力', '力量值']],
        ['vit', ['体质', '体', '体魄']],
        ['agi', ['敏捷', '敏', '速度', '身法']],
        ['spi', ['精神', '神', '精神力']],
        ['sou', ['魂力值', '魂力', '魂', '魂力上限']],
    ];
    const found = {};
    for (const [key, words] of attrMap) {
        for (const w of words) {
            const re = new RegExp(`${w}(?:值|属性)?\\s*[:：]\\s*(\\d{1,4})`);
            const m = src.match(re);
            if (m) { found[key] = Number(m[1]); ev[`attr_${key}`] = m[0]; break; }
        }
    }
    if (Object.keys(found).length) {
        out.attrs = found;
    } else {
        // 没有明确数值：按等级与类型给一套合理底子
        const lv = out.lv || 20;
        const base = 6 + Math.floor(lv * 0.45);
        const role = ROLES[out.role] || ROLES.attack;
        out.attrs = {
            str: Math.round(base * role.attrs.str),
            vit: Math.round(base * role.attrs.vit),
            agi: Math.round(base * role.attrs.agi),
            spi: Math.round(base * role.attrs.spi),
            sou: Math.round(base * role.attrs.sou),
        };
        out.warnings.push('五维没找到数值，已按等级与类型估算');
    }

    /* --- 魂环 --- */
    // 形式一：白黄紫黑 / 黄黄紫紫黑黑
    const colorLine = firstMatch(src, [
        /魂环(?:配置)?[:：\s]*([白黄紫红黑金]{2,12})/,
        /([白黄紫红黑金]{3,12})(?=\s*(?:魂环|$|\n))/,
    ]);
    if (colorLine) {
        const chars = colorLine[1].split('');
        for (const ch of chars) {
            const year = RING_COLORS[ch];
            if (year) out.rings.push({ year, skills: [] });
        }
        ev.rings = colorLine[0];
    }
    // 形式二：逐条列出「第X魂环：万年」
    if (!out.rings.length) {
        const re = /第?([一二三四五六七八九十\d]{1,3})\s*[个道]?魂环[^\n]{0,12}?(十年|百年|千年|万年|十万年)/g;
        let m;
        const list = [];
        while ((m = re.exec(src))) {
            const idx = cnToNum(m[1]) || list.length + 1;
            const tier = RING_TIERS.find((t) => t.name.startsWith(m[2]));
            list.push({ idx, year: tier ? tier.min + 1 : 500 });
        }
        if (list.length) {
            list.sort((a, b) => a.idx - b.idx);
            out.rings = list.map((r) => ({ year: r.year, skills: [] }));
            ev.rings = `第X魂环 ×${list.length}`;
        }
    }
    // 形式三：直接写年限 例如「魂环：3000年」
    if (!out.rings.length) {
        const re = /(\d{2,6})\s*年(?:魂环|魂兽)/g;
        let m;
        while ((m = re.exec(src))) out.rings.push({ year: Number(m[1]), skills: [] });
        if (out.rings.length) ev.rings = '数字年限';
    }

    /* --- 魂技 --- */
    const skillRe = /第([一二三四五六七八九十\d]{1,3})\s*[个道]?魂技\s*[:：\s-]*([^\s，,。；;、\n（(]{2,16})(?:\s*[（(]([^）)\n]{0,20})[）)])?/g;
    const found2 = [];
    let sm;
    while ((sm = skillRe.exec(src))) {
        found2.push({
            idx: cnToNum(sm[1]) || found2.length + 1,
            name: sm[2].trim(),
            note: (sm[3] || '').trim(),
        });
    }
    if (!found2.length) {
        const re2 = /魂技\s*[:：]\s*([^\s，,。；;、\n]{2,16})/g;
        let m2;
        while ((m2 = re2.exec(src))) found2.push({ idx: found2.length + 1, name: m2[1].trim(), note: '' });
    }
    if (found2.length) ev.skills = `${found2.length} 个魂技`;

    const built = buildSkills(found2, out.martial, out.element);
    out.skills = built.skills;

    // 魂技按顺序分给魂环
    out.rings.forEach((r, i) => {
        const sid = out.skills[i];
        if (sid) r.skills = [sid];
    });
    // 环数不够就补环
    while (out.rings.length < out.skills.length) {
        const idx = out.rings.length;
        out.rings.push({ year: (RING_TIERS[Math.min(idx + 1, RING_TIERS.length - 1)].min) + 1, skills: [out.skills[idx]] });
    }

    /* --- 魂骨 --- */
    const bonePatterns = [
        /([头部躯干左右臂腿四肢全身]{2,4})\s*(千年|万年|十万年)\s*(?:级别?的?)?魂骨/g,
        /(千年|万年|十万年)\s*([头部躯干左右臂腿四肢全身]{2,4})?\s*(?:级别?的?)?魂骨/g,
    ];
    const boneHits = [];
    for (const re of bonePatterns) {
        const r = new RegExp(re.source, 'g');
        let m;
        while ((m = r.exec(src))) {
            const parts = m.slice(1).filter(Boolean);
            const slotWord = parts.find((p) => /[头部躯干左右臂腿]/.test(p)) || '';
            const tierWord = parts.find((p) => /千年|万年/.test(p)) || '';
            if (!tierWord) continue;
            boneHits.push({ index: m.index, slotWord, tierWord });
        }
    }
    boneHits.sort((a, b) => a.index - b.index);

    const boneSlots = ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
    const slotMap = {
        头部: 'head', 躯干: 'torso', 左臂: 'leftArm', 右臂: 'rightArm',
        左腿: 'leftLeg', 右腿: 'rightLeg',
    };
    let bi = 0;
    const seenSlots = new Set();
    for (const hit of boneHits) {
        let slot = slotMap[hit.slotWord] || boneSlots[bi % boneSlots.length];
        if (seenSlots.has(slot)) continue;
        seenSlots.add(slot);
        const tier = hit.tierWord === '十万年' ? 120000 : hit.tierWord === '万年' ? 20000 : 3000;
        out.bones.push({
            id: `parsed-bone-${slot}`,
            name: `${hit.tierWord}${hit.slotWord || ''}魂骨`,
            slot,
            year: tier,
            mods: {},
        });
        bi += 1;
    }
    if (out.bones.length) ev.bones = `${out.bones.length} 块魂骨`;

    /* --- 功法 --- */
    for (const tech of Object.values(TECHNIQUES)) {
        if (src.includes(tech.name)) out.techniques.push(tech.id);
    }
    // 卡里常写「修习XX」但不在库里，记下来当提示
    const techM = firstMatch(src, [/修(?:习|练)[了]?([^\s，,。；;\n]{2,8})/]);
    if (techM && !out.techniques.length) out.warnings.push(`提到功法「${techM[1]}」，不在功法库里，需要手动加`);
    if (out.techniques.length) ev.techniques = `${out.techniques.length} 门功法`;

    /* --- 装备 --- */
    for (const eq of DEFAULT_EQUIPMENT) {
        if (src.includes(eq.name)) out.equipment.push(eq.id);
    }

    /* --- 收尾 --- */
    if (!out.lv) {
        out.lv = Math.min(99, Math.max(10, out.rings.length * 10 + 10));
        out.warnings.push(`没写魂力等级，按 ${out.rings.length} 个魂环推成 ${out.lv} 级`);
    }
    if (!out.skills.length) {
        out.warnings.push('没解析到魂技，先用普通攻击顶上，建议手动补');
    }
    if (!out.martial) out.warnings.push('没解析到武魂名');

    return out;
}

/* ---------------- 魂技名 → 机制参数 ---------------- */

export function inferTemplate(name, note = '') {
    const text = `${name} ${note}`;
    for (const rule of SKILL_KEYWORDS) {
        if (rule.keys.some((k) => text.includes(k))) return rule;
    }
    return { template: 'physSingle', element: null };
}

export function buildSkills(list, martial = '', defaultElement = 'earth') {
    const skills = [];
    const registered = [];
    list.forEach((item, i) => {
        const id = `parsed-${slug(item.name)}-${i}`;
        const exist = findSkill(id);
        if (exist) { skills.push(id); return; }

        const guess = inferTemplate(item.name, item.note);
        const tpl = SKILL_TEMPLATES[guess.template] || SKILL_TEMPLATES.physSingle;
        const element = guess.element || defaultElement;

        // 魂环档位越高，倍率略强
        const ringBoost = 1;

        const skill = {
            id,
            name: item.name,
            element,
            kind: tpl.kind,
            cost: tpl.cost,
            cd: tpl.cd,
            power: tpl.power ? Math.round(tpl.power * ringBoost * 100) / 100 : 0,
            poise: tpl.poise,
            range: tpl.range,
            aoe: tpl.aoe,
            target: tpl.kind === 'heal' ? 'ally'
                : tpl.kind === 'buff' ? 'self'
                : tpl.kind === 'shield' ? 'self'
                : tpl.aoe ? 'allEnemy' : 'enemy',
            effects: [],
            desc: item.note || `（解析自文本，机制按关键词推断：${guess.template}）`,
            _parsed: true,
            _template: guess.template,
        };
        if (tpl.control) { skill.control = tpl.control; skill.controlTurns = 1; }
        if (tpl.move) skill.move = tpl.move;
        if (tpl.shieldPct) { skill.shieldPct = tpl.shieldPct; skill.shieldTurns = 3; }
        if (tpl.penetration) skill.penetration = tpl.penetration;
        if (tpl.kind === 'heal' && tpl.aoe) skill.target = 'allAlly';

        registered.push(skill);
        skills.push(id);
    });
    if (registered.length) registerSkills(registered);
    return { skills, registered };
}

function slug(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

/* ---------------- 从宿主取文本 ---------------- */

// 默认只读"稳定"来源：角色卡文本 + MVU 变量。
// 世界书和聊天记录噪音大，默认关掉，可在面板里逐项打开。
export const DEFAULT_SOURCES = { card: true, mvu: true, lorebook: false, chat: false };

export function gatherSources(c, opts = {}) {
    const o = { ...DEFAULT_SOURCES, ...opts };
    const blocks = [];
    if (!c) return blocks;
    const seen = new Set();

    const push = (label, text, kind) => {
        if (!text) return;
        const t = String(text).trim();
        if (!t || seen.has(t)) return;
        seen.add(t);
        blocks.push({ label, text: t, kind });
    };

    // 1. 当前角色卡文本
    if (o.card) {
        try {
            const chid = c.this_chid;
            const chars = c.characters || [];
            const ch = chid != null && chid !== 'undefined' ? chars[chid] : null;
            if (ch) {
                const nm = ch.name || '?';
                push(`角色卡「${nm}」· 描述`, ch.description, 'card');
                push(`角色卡「${nm}」· 性格`, ch.personality, 'card');
                push(`角色卡「${nm}」· 场景`, ch.scenario, 'card');
                push(`角色卡「${nm}」· 系统提示`, ch.system_prompt || ch.systemPrompt, 'card');
            }
        } catch (e) {
            blocks.push({ label: '角色卡读取失败', text: String(e?.message || e), kind: 'error' });
        }

        // 部分宿主只暴露 getCharacterCardFields
        try {
            if (typeof c.getCharacterCardFields === 'function') {
                const f = c.getCharacterCardFields();
                if (f) {
                    push('卡字段 · 描述', f.description, 'card');
                    push('卡字段 · 性格', f.personality, 'card');
                    push('卡字段 · 场景', f.scenario, 'card');
                }
            }
        } catch { /* 忽略 */ }

        // 内嵌世界书属于卡的一部分，跟 card 一起开关
        if (o.lorebook) {
            try {
                const chid = c.this_chid;
                const ch = c.characters?.[chid];
                const entries = ch?.data?.character_book?.entries || ch?.character_book?.entries || [];
                for (const e of entries) {
                    const title = e.comment || e.name || '';
                    if (e.content) push(`内嵌世界书「${title || '未命名'}」`, e.content, 'lorebook');
                }
            } catch { /* 忽略 */ }
        }
    }

    // 2. 聊天记录（默认关）
    if (o.chat) {
        try {
            const chat = c.chat || [];
            const tail = chat.slice(-12).map((m) => m?.mes || '').filter(Boolean).join('\n');
            push('最近 12 条对话', tail, 'chat');
        } catch { /* 忽略 */ }
    }

    return blocks;
}

/* ---------------- MVU 变量 ---------------- */

export function flattenVars(obj, prefix = '', out = [], depth = 0) {
    if (depth > 6) return out;
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            flattenVars(v, key, out, depth + 1);
        } else if (Array.isArray(v)) {
            if (!v.length) continue;
            if (v.every((x) => x == null || typeof x !== 'object')) {
                out.push(`${key}: ${v.join(' / ')}`);
            } else {
                v.forEach((x, i) => flattenVars(x, `${key}[${i}]`, out, depth + 1));
            }
        } else if (v != null && v !== '') {
            out.push(`${key}: ${v}`);
        }
    }
    return out;
}

export function mvuApi() {
    const g = window.TavernHelper;
    if (!g) return null;
    const fns = ['getVariables', 'getChatVariables', 'getMessageVariables', 'getAllVariables']
        .filter((k) => typeof g[k] === 'function');
    return fns.length ? { g, fns } : null;
}

// 只认这些 key（展平后 "路径.字段: 值" 里的字段部分）。
// MVU 里往往塞了几百项提示词开关，全丢给正则会误判成属性。
const BATTLE_KEY = /魂力|魂环|武魂|魂技|魂骨|功法|魂力等级|等级|境界|修为|力量|体质|敏捷|精神|生命|气血|攻击|防御|速度|命中|闪避|暴击|爆伤|韧性|移速|攻速|穿透|护盾|属性|品质|年限|岁|系$/;

export function filterBattleVars(text) {
    const lines = String(text || '').split('\n');
    const hit = [];
    for (const l of lines) {
        const i = l.indexOf(':');
        const key = i > 0 ? l.slice(0, i) : l;
        if (BATTLE_KEY.test(key)) hit.push(l);
    }
    return { text: hit.join('\n'), hit: hit.length, total: lines.length };
}

export async function gatherMvu() {
    const out = [];
    const api = mvuApi();
    if (!api) return out;
    const { g } = api;
    const call = async (fn, arg) => {
        try {
            if (typeof g[fn] === 'function') return await g[fn](arg);
        } catch { /* 忽略 */ }
        return null;
    };

    let vars = await call('getVariables', { type: 'chat' });
    if (!vars) vars = await call('getVariables', { type: 'message', message_id: 'latest' });
    if (!vars) vars = await call('getChatVariables');
    if (!vars) vars = await call('getVariables');

    if (!vars || typeof vars !== 'object') return out;
    const flat = flattenVars(vars);
    if (flat.length) {
        const filtered = filterBattleVars(flat.join('\n'));
        out.push({ label: 'MVU 变量', text: flat.join('\n'), kind: 'mvu', raw: vars, filtered });
    }
    return out;
}

// 给"探变量"按钮用：先列顶层分组，再摊开小分组，方便判断角色数据埋在哪一层
export function describeMvu(vars) {
    if (!vars) return '无 MVU 变量';
    const lines = [];
    let total = 0;
    for (const [k, v] of Object.entries(vars)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const flat = flattenVars(v);
            total += flat.length;
            lines.push(`${k}：对象，${flat.length} 项`);
            if (flat.length <= 16) for (const f of flat) lines.push(`  ${f}`);
            else lines.push(`  ${flat.slice(0, 6).join(' / ')} …`);
        } else if (Array.isArray(v)) {
            total += v.length;
            lines.push(`${k}：数组，${v.length} 项`);
        } else {
            total += 1;
            lines.push(`${k}：${v}`);
        }
    }
    if (!lines.length) return 'MVU 变量为空';
    return `MVU 顶层 ${Object.keys(vars).length} 组，共 ${total} 项\n${lines.slice(0, 50).join('\n')}${lines.length > 50 ? '\n…' : ''}`;
}

export async function gatherWorldbook(c, name) {
    const out = [];
    if (!c || typeof c.loadWorldInfo !== 'function' || !name) return out;
    try {
        const data = await c.loadWorldInfo(name);
        const entries = data?.entries || {};
        for (const k of Object.keys(entries)) {
            const e = entries[k];
            const content = e?.content || '';
            if (content) out.push({ label: `世界书「${name}」· ${e.comment || k}`, text: content, kind: 'lorebook' });
        }
    } catch (e) {
        out.push({ label: `世界书「${name}」读取失败`, text: String(e?.message || e), kind: 'error' });
    }
    return out;
}

/* ---------------- 批量：找文本里所有可能的魂师 ---------------- */

export function candidateNames(text) {
    const names = new Set();
    const re = /(?:姓名|名字)[:：]\s*([^\s，,。；;\n]{1,16})/g;
    let m;
    while ((m = re.exec(text))) names.add(m[1].trim());
    // 标题行
    const re2 = /^#{2,4}\s*([^\n#]{1,20})$/gm;
    while ((m = re2.exec(text))) {
        const t = m[1].trim();
        if (t && !/^[\d\s.、]+/.test(t) === false) names.add(t);
    }
    return [...names].slice(0, 12);
}

/* ---------------- 摘要（给 UI 显示） ---------------- */

export function summarize(unit) {
    const parts = [];
    parts.push(`Lv.${unit.lv}`);
    parts.push(QUALITY[unit.quality]?.name || unit.quality);
    parts.push(ROLES[unit.role]?.name || '无类型');
    if (unit.martial) parts.push(unit.martial);
    parts.push(`${ELEMENTS[unit.element]?.name || '?'}属性`);
    parts.push(`${unit.rings.length} 环`);
    parts.push(`${unit.skills.length} 技`);
    if (unit.bones.length) parts.push(`${unit.bones.length} 魂骨`);
    if (unit.techniques.length) parts.push(`${unit.techniques.length} 功法`);
    return parts.join('｜');
}
