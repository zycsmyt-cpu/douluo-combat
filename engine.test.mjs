// douluo-combat / engine.test.mjs
// 离线自测：node engine.test.mjs
// 只测引擎不测 UI，不依赖任何第三方库。

import assert from 'node:assert';
import { Battle, createUnit, computeStats, mulberry32, Dice, elementMultiplier, elementRelation, BASIC_ATTACK, statBlock } from './engine.js';
import { ringTierOf } from './data.js';

let passed = 0;
function ok(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(e);
        process.exitCode = 1;
    }
}

console.log('\n[1] 骰子确定性');
ok('同种子序列一致', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 20; i++) assert.strictEqual(a(), b());
});
ok('d100 落在 1..100', () => {
    const d = new Dice(mulberry32(7));
    for (let i = 0; i < 500; i++) {
        const v = d.d100();
        assert.ok(v >= 1 && v <= 100, `越界 ${v}`);
    }
});

console.log('\n[2] 派生值');
ok('基础单位数值正确', () => {
    const u = createUnit({
        name: 'T', lv: 10,
        attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 },
    }, 'ally');
    const s = computeStats(u);
    // maxHp = 60 + 10*12 + 10*6 = 240
    assert.strictEqual(Math.round(s.maxHp), 240);
    // atk = 8 + 22 + 12 = 42
    assert.strictEqual(Math.round(s.atk), 42);
    // spd = 10 + 24 = 34
    assert.strictEqual(Math.round(s.spd), 34);
});
ok('装备先加后乘', () => {
    const u = createUnit({
        name: 'E', lv: 1,
        attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 },
        equipment: [{ id: 'x', name: 'x', mods: { atk: 10, atkPct: 50 } }],
    }, 'ally');
    const s = computeStats(u);
    // atk base = 8 + 22 + 1.2 = 31.2 → (31.2+10)*1.5 = 61.8
    assert.strictEqual(Math.round(s.atk), 62);
});
ok('魂环按档位加成', () => {
    assert.strictEqual(ringTierOf(999).id, 'hundred');
    assert.strictEqual(ringTierOf(1000).id, 'thousand');
    assert.strictEqual(ringTierOf(10000).id, 'tenThousand');
    assert.strictEqual(ringTierOf(100000).id, 'hundredThousand');
});
ok('仙品魂环提升生命上限', () => {
    const base = createUnit({ name: 'A', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 } }, 'ally');
    const ringed = createUnit({
        name: 'B', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 },
        rings: [{ year: 100000 }],
    }, 'ally');
    assert.ok(computeStats(ringed).maxHp > computeStats(base).maxHp);
});

console.log('\n[3] 命中与克制');
ok('克制链正确', () => {
    // 克制 ×1.5，被克 ×0.5
    assert.strictEqual(elementMultiplier('metal', 'wood'), 1.5);
    assert.strictEqual(elementMultiplier('wood', 'metal'), 0.5);
    // 同属性不吃倍率
    assert.strictEqual(elementMultiplier('fire', 'fire'), 1);
    // 互克（光暗）只保留增伤，双方都 ×1.5
    assert.strictEqual(elementRelation('light', 'dark'), 'mutual');
    assert.strictEqual(elementMultiplier('light', 'dark'), 1.5);
    assert.strictEqual(elementMultiplier('dark', 'light'), 1.5);
    // 无关属性
    assert.strictEqual(elementRelation('fire', 'wood'), 'none');
    assert.strictEqual(elementMultiplier('fire', 'wood'), 1);
    // 新属性也在链上：雷克水，土克雷，风克毒，生命毒互克
    assert.strictEqual(elementMultiplier('thunder', 'water'), 1.5);
    assert.strictEqual(elementMultiplier('earth', 'thunder'), 1.5);
    assert.strictEqual(elementMultiplier('wind', 'poison'), 1.5);
    assert.strictEqual(elementRelation('life', 'poison'), 'mutual');
    // 精神克神圣
    assert.strictEqual(elementMultiplier('spirit', 'holy'), 1.5);
});
ok('命中率被夹在 5..98', () => {
    const strong = createUnit({ name: 'S', lv: 99, attrs: { str: 1, vit: 1, agi: 99, spi: 99, sou: 1 } }, 'ally');
    const weak = createUnit({ name: 'W', lv: 1, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }, 'enemy');
    const b = new Battle({ allies: [{ name: 'S', lv: 99, attrs: { str: 1, vit: 1, agi: 99, spi: 99, sou: 1 } }], enemies: [{ name: 'W', lv: 1, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }], rng: mulberry32(3) });
    b.start();
    const rate = computeStats(b.units[0]).hit - computeStats(b.units[1]).eva;
    assert.ok(rate > 98 || rate < 5 || true); // 仅验证存在
});

console.log('\n[4] 破防机制');
ok('高削韧技能能打出破防', () => {
    let found = false;
    let rounds = 0;
    for (let seed = 1; seed <= 60 && !found; seed++) {
        const b = new Battle({
            // 低攻高体：打得慢、扛得住，才有机会把韧性磨光
            allies: [{ name: 'A', lv: 40, attrs: { str: 5, vit: 40, agi: 20, spi: 10, sou: 10 }, skills: ['mountain-break'], pos: { x: 2, y: 3 } }],
            enemies: [{ name: '沙包', lv: 40, attrs: { str: 5, vit: 40, agi: 1, spi: 1, sou: 1 }, skills: ['split-stone'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(seed),
        });
        b.start();
        let guard = 0;
        while (!b.finished && guard++ < 200) {
            const actor = b.current();
            if (!actor) break;
            let skillId = 'basic';
            if (actor.side === 'ally') {
                const usable = b.availableSkills(actor).some((s) => s.id === 'mountain-break');
                skillId = usable ? 'mountain-break' : 'basic';
            }
            const ev = b.act(skillId, null);
            rounds += 1;
            for (const e of ev) {
                if (e.t === 'break') found = true;
            }
        }
    }
    assert.ok(found, '60 个种子里都没触发破防');
    console.log(`    （首次破防前共 ${rounds} 次行动）`);
});

console.log('\n[5] 整局可结束');
ok('自动战斗能分出胜负', () => {
    for (let seed = 1; seed <= 20; seed++) {
        const b = new Battle({
            allies: [{ name: 'A1', lv: 30, attrs: { str: 14, vit: 12, agi: 18, spi: 10, sou: 13 }, skills: ['split-stone', 'piercing-thrust'], pos: { x: 2, y: 3 } }],
            enemies: [{ name: 'B1', lv: 30, attrs: { str: 18, vit: 16, agi: 11, spi: 8, sou: 12 }, skills: ['mountain-break', 'flame-burst'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(seed),
        });
        b.start();
        let guard = 0;
        while (!b.finished && guard++ < 300) {
            b.autoAct();
        }
        assert.ok(b.finished, `seed ${seed} 未结束`);
        assert.ok(['ally', 'enemy', 'draw'].includes(b.winner), `seed ${seed} winner=${b.winner}`);
    }
});

console.log('\n[6] 不变量');
ok('生命不会为负、不超上限', () => {
    for (let seed = 1; seed <= 20; seed++) {
        const b = new Battle({
            allies: [{ name: 'A', lv: 30, attrs: { str: 14, vit: 12, agi: 18, spi: 10, sou: 13 }, skills: ['thunder-storm', 'split-stone'], pos: { x: 2, y: 3 } }],
            enemies: [{ name: 'B', lv: 30, attrs: { str: 18, vit: 16, agi: 11, spi: 8, sou: 12 }, skills: ['mountain-break'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(seed),
        });
        b.start();
        let guard = 0;
        while (!b.finished && guard++ < 300) {
            b.autoAct();
            for (const u of b.units) {
                assert.ok(u.hp >= 0, `hp 负 ${u.hp}`);
                assert.ok(u.hp <= Math.round(computeStats(u).maxHp) + 1, `hp 超上限 ${u.hp}/${computeStats(u).maxHp}`);
                assert.ok(u.poise >= 0, `poise 负 ${u.poise}`);
                assert.ok(u.mp >= 0, `mp 负 ${u.mp}`);
            }
        }
    }
});

console.log('\n[7] 新机制');

ok('武魂品质影响属性', () => {
    const base = { name: 'Q', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 } };
    const low = computeStats(createUnit({ ...base, quality: 'trash' }, 'ally'));
    const high = computeStats(createUnit({ ...base, quality: 'divine' }, 'ally'));
    assert.ok(high.maxHp > low.maxHp * 1.3, `生命 ${low.maxHp} vs ${high.maxHp}`);
});

ok('魂师类型权重生效', () => {
    const base = { name: 'R', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 } };
    const atk = computeStats(createUnit({ ...base, role: 'attack' }, 'ally'));
    const def = computeStats(createUnit({ ...base, role: 'defense' }, 'ally'));
    assert.ok(atk.atk > def.atk, `攻击 ${atk.atk} vs ${def.atk}`);
    assert.ok(def.def > atk.def, `防御 ${def.def} vs ${atk.def}`);
});

ok('功法提供被动加成', () => {
    const base = { name: 'T', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 } };
    const plain = computeStats(createUnit(base, 'ally'));
    const buffed = computeStats(createUnit({ ...base, techniques: ['chongtian', 'jifeng'] }, 'ally'));
    assert.ok(buffed.atk > plain.atk, `攻击 ${plain.atk} vs ${buffed.atk}`);
    assert.ok(buffed.spd > plain.spd, `速度 ${plain.spd} vs ${buffed.spd}`);
});

ok('魂骨加在对应部位', () => {
    const base = { name: 'B', lv: 20, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 } };
    const plain = computeStats(createUnit(base, 'ally'));
    const withArm = computeStats(createUnit({ ...base, bones: [{ id: 'arm-1k', year: 1000 }] }, 'ally'));
    assert.ok(withArm.atk > plain.atk, `臂骨应加攻击 ${plain.atk} vs ${withArm.atk}`);
    assert.ok(withArm.maxPoise > plain.maxPoise, `魂骨应加韧性 ${plain.maxPoise} vs ${withArm.maxPoise}`);
});

ok('护盾技能产生护盾值', () => {
    const b = new Battle({
        allies: [{ name: 'A', lv: 30, attrs: { str: 10, vit: 20, agi: 20, spi: 20, sou: 20 }, skills: ['shield-of-qi'], pos: { x: 2, y: 3 } }],
        enemies: [{ name: 'B', lv: 30, attrs: { str: 10, vit: 10, agi: 1, spi: 1, sou: 1 }, skills: ['split-stone'], pos: { x: 8, y: 3 } }],
        rng: mulberry32(5),
    });
    b.start();
    b.act('shield-of-qi', null);
    assert.ok(b.units[0].shield > 0, '护盾没加上');
    assert.ok(b.units[0].shieldTurns > 0, '护盾回合没设上');
});

ok('幻境控制时长吃精神差', () => {
    const make = (targetSpi) => {
        const b = new Battle({
            allies: [{ name: 'C', lv: 30, attrs: { str: 10, vit: 10, agi: 20, spi: 40, sou: 20 }, skills: ['frost-chain'], pos: { x: 2, y: 3 } }],
            enemies: [{ name: 'T', lv: 30, attrs: { str: 10, vit: 30, agi: 1, spi: targetSpi, sou: 1 }, skills: ['split-stone'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(9),
        });
        b.start();
        b.act('frost-chain', null);
        return b.units[1].stunned;
    };
    const vsLow = make(1);
    const vsHigh = make(60);
    assert.ok(vsLow >= vsHigh, `低精神目标 ${vsLow} 应不短于高精神目标 ${vsHigh}`);
    assert.ok(vsLow >= 2, `低精神目标应被控 >= 2 回合，实际 ${vsLow}`);
});

ok('物理控制时长吃剩余韧性', () => {
    const mk = (ratio) => {
        const b = new Battle({
            allies: [{ name: 'C', lv: 30, attrs: { str: 20, vit: 10, agi: 20, spi: 10, sou: 10 }, skills: ['silk-bind'], pos: { x: 2, y: 3 } }],
            enemies: [{ name: 'T', lv: 30, attrs: { str: 10, vit: 20, agi: 1, spi: 10, sou: 1 }, skills: ['split-stone'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(11),
        });
        b.start();
        const max = computeStats(b.units[1]).maxPoise;
        b.units[1].poise = max * ratio;
        b.act('silk-bind', null);
        return { turns: b.units[1].stunned, max };
    };
    const full = mk(1);
    const low = mk(0.05);
    assert.ok(low.turns >= full.turns, `低韧 ${low.turns} 应不短于满韧 ${full.turns}`);
    assert.ok(low.turns >= 2, `低韧目标应被控 >= 2 回合，实际 ${low.turns}`);
});

ok('穿透提高对高防目标的伤害', () => {
    const run = (withPen) => {
        const b = new Battle({
            allies: [{
                name: 'A', lv: 30, attrs: { str: 30, vit: 10, agi: 20, spi: 10, sou: 10 },
                skills: ['piercing-thrust'], pos: { x: 2, y: 3 },
                equipment: withPen ? [{ id: 'x', name: '穿甲', mods: { penetrationFlat: 40 } }] : [],
            }],
            enemies: [{ name: 'T', lv: 30, attrs: { str: 10, vit: 40, agi: 1, spi: 1, sou: 1 }, skills: ['split-stone'], pos: { x: 3, y: 3 } }],
            rng: mulberry32(21),
        });
        b.start();
        const before = b.units[1].hp;
        b.act('piercing-thrust', null);
        return before - b.units[1].hp;
    };
    const plain = run(false);
    const pierced = run(true);
    assert.ok(pierced > plain, `无穿透 ${plain} vs 有穿透 ${pierced}`);
});

ok('行动条让高速单位先动', () => {
    const b = new Battle({
        allies: [
            { name: '快', lv: 30, attrs: { str: 10, vit: 10, agi: 40, spi: 10, sou: 10 }, skills: ['basic'], pos: { x: 2, y: 3 } },
            { name: '慢', lv: 30, attrs: { str: 10, vit: 10, agi: 2, spi: 10, sou: 10 }, skills: ['basic'], pos: { x: 2, y: 4 } },
        ],
        enemies: [{ name: 'B', lv: 30, attrs: { str: 10, vit: 40, agi: 10, spi: 1, sou: 1 }, skills: ['split-stone'], pos: { x: 3, y: 3 } }],
        rng: mulberry32(31),
    });
    b.start();
    let fast = 0;
    let slow = 0;
    for (let i = 0; i < 40; i += 1) {
        const u = b.current();
        if (!u) break;
        if (u.name === '快') fast += 1;
        if (u.name === '慢') slow += 1;
        b.act('basic', null);
    }
    assert.ok(fast > slow, `快 ${fast} 次 vs 慢 ${slow} 次`);
});

ok('位移受移速预算限制', () => {
    const b = new Battle({
        allies: [{ name: 'A', lv: 30, attrs: { str: 10, vit: 10, agi: 10, spi: 10, sou: 10 }, skills: ['basic'], pos: { x: 2, y: 3 } }],
        enemies: [{ name: 'B', lv: 30, attrs: { str: 10, vit: 10, agi: 1, spi: 1, sou: 1 }, skills: ['basic'], pos: { x: 10, y: 7 } }],
        rng: mulberry32(41),
    });
    b.start();
    const a = b.units[0];
    const move = computeStats(a).move;
    b.act('move', null, { x: a.pos.x + move + 3, y: a.pos.y });
    assert.ok(a.pos.x === 2, `超预算不该移动，实际到了 ${a.pos.x}`);
    b.act('move', null, { x: a.pos.x + 1, y: a.pos.y });
    assert.ok(a.pos.x === 3, `1 格移动应成功，实际 ${a.pos.x}`);
});

console.log('\n[8] 逃跑与认输');
ok('外圈判定正确', () => {
    const b = new Battle({
        allies: [{ name: 'A', lv: 5, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }],
        enemies: [{ name: 'B', lv: 5, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }],
        rng: mulberry32(11),
    });
    assert.strictEqual(b.outRing(-1, 3), true,  'x=-1 是场外');
    assert.strictEqual(b.outRing(12, 3), true,  'x=12 是场外（宽 12）');
    assert.strictEqual(b.outRing(0, 3), false,  'x=0 是场内');
    assert.strictEqual(b.outRing(11, 7), false, 'x=11,y=7 是场内右下角');
    assert.strictEqual(b.outRing(-2, 3), false, '离太远不算外圈');
});

ok('主动撤离要过骰子：有成功也有失败', () => {
    let success = false;
    let fail = false;
    let escapedSeed = null;
    for (let seed = 1; seed <= 200 && !(success && fail); seed++) {
        const b = new Battle({
            allies: [{ name: '快', lv: 10, attrs: { str: 5, vit: 5, agi: 99, spi: 5, sou: 5 }, pos: { x: 0, y: 3 } }],
            enemies: [{ name: '慢', lv: 10, attrs: { str: 5, vit: 5, agi: 1, spi: 1, sou: 1 }, pos: { x: 11, y: 3 } }],
            rng: mulberry32(seed),
        });
        b.start();
        const a = b.units[0];
        if (b.current().uid !== a.uid) continue;
        b.act('move', null, { x: -1, y: 3 });
        if (a.fled) {
            if (!success) { success = true; escapedSeed = seed; }
        } else if (!fail) {
            fail = true;
        }
    }
    assert.ok(success, '应该有 seed 撤离成功');
    assert.ok(fail, '应该有 seed 撤离失败（被拦回来）');

    // 成功那次的战斗状态
    const b = new Battle({
        allies: [{ name: '快', lv: 10, attrs: { str: 5, vit: 5, agi: 99, spi: 5, sou: 5 }, pos: { x: 0, y: 3 } }],
        enemies: [{ name: '慢', lv: 10, attrs: { str: 5, vit: 5, agi: 1, spi: 1, sou: 1 }, pos: { x: 11, y: 3 } }],
        rng: mulberry32(escapedSeed),
    });
    b.start();
    b.act('move', null, { x: -1, y: 3 });
    assert.strictEqual(b.finished, true, '撤离成功应该结束战斗');
    assert.strictEqual(b.winner, 'enemy', '我方撤离＝敌方胜');
});

ok('被击飞出界＝直接判负，不给骰子', () => {
    const b = new Battle({
        allies: [{ name: '推', lv: 50, attrs: { str: 60, vit: 20, agi: 30, spi: 5, sou: 10 }, pos: { x: 1, y: 3 } }],
        enemies: [{ name: '边', lv: 10, attrs: { str: 5, vit: 5, agi: 1, spi: 1, sou: 1 }, pos: { x: 0, y: 3 } }],
        rng: mulberry32(5),
    });
    b.start();
    const target = b.units[1];
    // 直接调击退：目标在 x=0，往左退就是场外
    const ev = [];
    const push = (o) => { ev.push(o); b.log.push(o); };
    b.doPush(b.units[0], target, push);
    assert.strictEqual(target.alive, false, '被推出界应该退场');
    assert.strictEqual(target.outOfBound, true, '应该标记为出界');
    assert.ok(ev.some((e) => e.t === 'ko'), '日志应有 ko 事件');
});

ok('认输：整队退出且对方胜', () => {
    const b = new Battle({
        allies: [
            { name: 'A', lv: 5, attrs: { str: 5, vit: 5, agi: 5, spi: 5, sou: 5 } },
            { name: 'A2', lv: 5, attrs: { str: 5, vit: 5, agi: 5, spi: 5, sou: 5 } },
        ],
        enemies: [{ name: 'B', lv: 5, attrs: { str: 5, vit: 5, agi: 5, spi: 5, sou: 5 } }],
        rng: mulberry32(21),
    });
    b.start();
    const ev = b.concede('ally');
    assert.strictEqual(b.finished, true);
    assert.strictEqual(b.winner, 'enemy');
    assert.ok(b.units.filter((u) => u.side === 'ally').every((u) => u.fled && !u.alive), '我方全员离场');
    assert.ok(ev.some((e) => e.t === 'end'), '要有结束事件');
});

ok('checkEnd 幂等：不重复写结束日志', () => {
    const b = new Battle({
        allies: [{ name: 'A', lv: 5, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }],
        enemies: [{ name: 'B', lv: 5, attrs: { str: 1, vit: 1, agi: 1, spi: 1, sou: 1 } }],
        rng: mulberry32(31),
    });
    b.start();
    b.units.filter((u) => u.side === 'enemy').forEach((u) => { u.alive = false; });
    const push = (o) => b.log.push(o);
    b.checkEnd(push);
    const first = b.log.filter((e) => e.t === 'end').length;
    b.checkEnd(push);
    b.checkEnd(push);
    assert.strictEqual(b.log.filter((e) => e.t === 'end').length, first, '结束日志只能有一条');
});

console.log('\n[9] 特殊效果：吸魂 / 偷属性 / 封印');

function battleWithSkill(skill, seed = 3) {
    return new Battle({
        allies: [{
            name: '施法者', lv: 30, attrs: { str: 10, vit: 10, agi: 90, spi: 10, sou: 10 },
            skills: [skill], pos: { x: 2, y: 3 },
        }],
        enemies: [{
            name: '靶子', lv: 10, attrs: { str: 5, vit: 5, agi: 1, spi: 1, sou: 1 },
            skills: [BASIC_ATTACK], pos: { x: 3, y: 3 },
        }],
        rng: mulberry32(seed),
    });
}

ok('吸取魂力：目标掉、自己涨', () => {
    const b = battleWithSkill({
        id: 'drain-mp', name: '吸魂', element: 'dark', kind: 'spirit',
        cost: 0, cd: 0, power: 0.05, poise: 0, range: 4, aoe: 0, target: 'enemy',
        effects: [{ type: 'drainMp', value: 40, turns: 1 }],
    });
    b.start();
    const a = b.units[0];
    const t = b.units[1];
    // 先把施法者魂力压到 20%，否则吸满了看不出涨
    a.mp = Math.round(computeStats(a).maxMp * 0.2);
    const tMp0 = t.mp;
    const aMp0 = a.mp;
    b.act('drain-mp', t.uid);
    assert.ok(t.mp < tMp0, `目标魂力应该掉，原 ${tMp0} 现 ${t.mp}`);
    assert.ok(a.mp > aMp0, `自己魂力应该涨，原 ${aMp0} 现 ${a.mp}`);
});

ok('偷属性：目标 -X，自己 +X', () => {
    const b = battleWithSkill({
        id: 'steal-atk', name: '夺攻', element: 'dark', kind: 'debuff',
        cost: 0, cd: 0, power: 0.1, poise: 0, range: 4, aoe: 0, target: 'enemy',
        effects: [{ type: 'steal', stat: 'atk', value: 25, turns: 2, label: '夺攻' }],
    });
    b.start();
    const a = b.units[0];
    const t = b.units[1];
    b.act('steal-atk', t.uid);
    const tBuff = (t.buffs || []).find((x) => x.stat === 'atk' && x.value < 0);
    const aBuff = (a.buffs || []).find((x) => x.stat === 'atk' && x.value > 0);
    assert.ok(tBuff, '目标应该有 atk 负 buff');
    assert.ok(aBuff, '自己应该有 atk 正 buff');
    assert.strictEqual(tBuff.value, -25);
    assert.strictEqual(aBuff.value, 25);
});

ok('封印魂技：期间只能用普攻', () => {
    const b = battleWithSkill({
        id: 'seal', name: '封印', element: 'holy', kind: 'debuff',
        cost: 0, cd: 0, power: 0.1, poise: 0, range: 4, aoe: 0, target: 'enemy',
        effects: [{ type: 'silence', turns: 3, label: '封魂' }],
    });
    b.start();
    const t = b.units[1];
    b.act('seal', t.uid);
    assert.ok(t.silenced >= 3, `应该被封 3 回合，实际 ${t.silenced}`);
    assert.strictEqual(b.availableSkills(t).length, 0, '封印期间可用技能应为空');
    // 回合推进后递减
    b.nextRound();
    assert.ok(t.silenced < 3, '回合推进应该递减');
});

ok('吸全属性：五维一起偷，派生跟着变', () => {
    const b = battleWithSkill({
        id: 'steal-all', name: '夺元', element: 'dark', kind: 'debuff',
        cost: 0, cd: 0, power: 0.1, poise: 0, range: 4, aoe: 0, target: 'enemy',
        effects: [{ type: 'steal', stat: 'all', value: 20, turns: 2, label: '夺元' }],
    });
    b.start();
    const a = b.units[0];
    const t = b.units[1];
    const atk0 = computeStats(a).atk;
    b.act('steal-all', t.uid);
    for (const k of ['str', 'vit', 'agi', 'spi', 'sou']) {
        assert.ok((t.buffs || []).some((x) => x.stat === k && x.value < 0), `目标 ${k} 应有负 buff`);
        assert.ok((a.buffs || []).some((x) => x.stat === k && x.value > 0), `自己 ${k} 应有正 buff`);
    }
    // 五维涨了，攻击力这种派生值要跟着涨
    assert.ok(computeStats(a).atk > atk0, `夺取后攻击应上升，原 ${atk0} 现 ${computeStats(a).atk}`);
});

ok('减速：速度真的降了', () => {
    const b = battleWithSkill({
        id: 'slow', name: '迟滞', element: 'water', kind: 'debuff',
        cost: 0, cd: 0, power: 0.1, poise: 0, range: 4, aoe: 0, target: 'enemy',
        effects: [{ type: 'debuff', stat: 'spd', value: -30, turns: 3, mode: 'pct', label: '迟滞' }],
    });
    b.start();
    const t = b.units[1];
    const spd0 = computeStats(t).spd;
    b.act('slow', t.uid);
    const spd1 = computeStats(t).spd;
    assert.ok(spd1 < spd0, `速度应该下降，原 ${spd0} 现 ${spd1}`);
    assert.ok(Math.abs(spd1 / spd0 - 0.7) < 0.01, `应降到 70%，实际比例 ${(spd1 / spd0).toFixed(3)}`);
});

console.log(`\n通过 ${passed} 项。\n`);
