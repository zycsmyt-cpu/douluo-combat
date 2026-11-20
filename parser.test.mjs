// douluo-combat / parser.test.mjs
// 解析器离线自测：node parser.test.mjs

import assert from 'node:assert';
import { parseUnit, inferTemplate, buildSkills, summarize, candidateNames } from './parser.js';
import { findSkill } from './data.js';

let passed = 0;
function ok(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

const SAMPLE = `# 唐三

武魂：蓝银皇（极品）
魂师类型：控制系
属性：木
魂力等级：52级
力量：68  体质：75  敏捷：82  精神：96  魂力：90
魂环配置：黄黄紫紫黑

第一魂技：缠绕（束缚）
第二魂技：寄生
第三魂技：蛛网束缚
第四魂技：蓝银霸王枪
第五魂技：蓝银领域

魂骨：万年右臂魂骨
功法：凝神诀
装备：精铁剑
`;

console.log('\n[1] 完整卡解析');
ok('抽到名字、等级、品质、类型', () => {
    const u = parseUnit(SAMPLE);
    assert.strictEqual(u.name, '唐三');
    assert.strictEqual(u.lv, 52);
    assert.strictEqual(u.quality, 'epic');
    assert.strictEqual(u.role, 'control');
});

ok('抽到武魂与属性', () => {
    const u = parseUnit(SAMPLE);
    assert.ok(u.martial.includes('蓝银'), `武魂=${u.martial}`);
    assert.strictEqual(u.element, 'wood');
});

ok('抽到五维', () => {
    const u = parseUnit(SAMPLE);
    assert.strictEqual(u.attrs.str, 68);
    assert.strictEqual(u.attrs.vit, 75);
    assert.strictEqual(u.attrs.agi, 82);
    assert.strictEqual(u.attrs.spi, 96);
    assert.strictEqual(u.attrs.sou, 90);
});

ok('魂环按颜色解析成 5 环', () => {
    const u = parseUnit(SAMPLE);
    assert.strictEqual(u.rings.length, 5, `实际 ${u.rings.length}`);
    assert.strictEqual(u.rings[0].year, 500);
    assert.strictEqual(u.rings[2].year, 3000);
    assert.strictEqual(u.rings[4].year, 35000);
});

ok('魂技被抽出来并挂到魂环上', () => {
    const u = parseUnit(SAMPLE);
    assert.strictEqual(u.skills.length, 5, `实际 ${u.skills.length}`);
    const names = u.skills.map((id) => findSkill(id)?.name);
    assert.deepStrictEqual(names.slice(0, 2), ['缠绕', '寄生']);
    assert.strictEqual(u.rings.filter((r) => r.skills.length).length, 5);
});

ok('魂技按关键词分到不同模板', () => {
    const u = parseUnit(SAMPLE);
    const wrap = findSkill(u.skills[0]);
    assert.strictEqual(wrap.kind, 'control', `缠绕应是控制，实际 ${wrap.kind}`);
    const spear = findSkill(u.skills[3]);
    assert.strictEqual(spear.kind, 'phys', `蓝银霸王枪应是物理，实际 ${spear.kind}`);
});

ok('魂骨与功法、装备', () => {
    const u = parseUnit(SAMPLE);
    assert.strictEqual(u.bones.length, 1);
    assert.strictEqual(u.bones[0].slot, 'rightArm');
    assert.deepStrictEqual(u.techniques, ['jingshen']);
    assert.deepStrictEqual(u.equipment, ['iron-sword']);
});

console.log('\n[2] 缺字段兜底');
ok('没写等级时按魂环数推', () => {
    const u = parseUnit('武魂：镰刀\n魂环配置：黄黄紫');
    assert.ok(u.lv >= 40 && u.lv <= 60, `lv=${u.lv}`);
    assert.ok(u.warnings.length > 0);
});

ok('没写五维时按等级估算', () => {
    const u = parseUnit('魂力等级：30级\n武魂：铁锤');
    const keys = ['str', 'vit', 'agi', 'spi', 'sou'];
    for (const k of keys) assert.ok(u.attrs[k] > 0, `${k}=${u.attrs[k]}`);
    assert.ok(u.warnings.some((w) => w.includes('五维')));
});

ok('空文本不崩', () => {
    const u = parseUnit('');
    assert.ok(u.attrs);
    assert.strictEqual(u.rings.length, 0);
});

console.log('\n[3] 模板推断');
ok('关键词映射到模板', () => {
    assert.strictEqual(inferTemplate('焚天烈焰').template, 'spiritMulti');
    assert.strictEqual(inferTemplate('寒冰锥').template, 'spiritSingle');
    assert.strictEqual(inferTemplate('金身护体').template, 'shield');
    assert.strictEqual(inferTemplate('春风化雨').template, 'heal');
    assert.strictEqual(inferTemplate('千丝缠').template, 'controlPhys');
    assert.strictEqual(inferTemplate('梦魇之瞳').template, 'controlPsy');
    assert.strictEqual(inferTemplate('雷神之锤').template, 'spiritSingle');
});

ok('未知名字回落到单体物理', () => {
    assert.strictEqual(inferTemplate('幽冥').template, 'physSingle');
});

ok('批量构建技能不重复', () => {
    const a = buildSkills([{ name: '焚天', note: '' }]);
    const b = buildSkills([{ name: '焚天', note: '' }]);
    assert.strictEqual(a.skills[0], b.skills[0]);
    assert.strictEqual(b.registered.length, 0, '第二次不该重复注册');
});

console.log('\n[4] 其他');
ok('summarize 输出可读摘要', () => {
    const u = parseUnit(SAMPLE);
    const s = summarize(u);
    assert.ok(s.includes('Lv.52'));
    assert.ok(s.includes('极品'));
    assert.ok(s.includes('控制系'));
});

ok('candidateNames 能抓标题', () => {
    const names = candidateNames('# 唐三\n\n姓名：小舞\n');
    assert.ok(names.includes('唐三') || names.includes('小舞'));
});

console.log(`\n通过 ${passed} 项。\n`);
