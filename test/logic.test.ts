import {
  analyzeProject,
  describeOverride,
  mergeOverride,
  normalizeOverrides,
  previewRuleImpact,
  transcribeLine,
} from '../src/braille';
import { createInitialProject } from '../src/sample';

// 极简断言助手，避免引入测试框架依赖
function assert(ok: unknown, message: string): void {
  if (!ok) throw new Error(`断言失败：${message}`);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`断言失败：${message}\n  期望：${JSON.stringify(expected)}\n  实际：${JSON.stringify(actual)}`);
  }
}
function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

const state = createInitialProject();
const ueb = state.ruleSets.find((set) => set.id === 'ueb-teaching')!;

// 1. 行级例外：停用 the 后，该行不再出现缩写 ⠮（更短的 th 缩写会接管）
const withContraction = transcribeLine('the seed', ueb).map((t) => t.braille).join('');
const withoutContraction = transcribeLine('the seed', ueb, false, [{ ruleId: 'contraction-the', enabled: false }]).map((t) => t.braille).join('');
assert(withContraction.includes('⠮'), '全局应使用 the 缩写');
assert(!withoutContraction.includes('⠮'), '行级例外应停用 the 缩写');
assert(withoutContraction.includes('⠹'), '停用 the 后应落到 th 缩写');

// 2. 行级例外：覆盖输出
const customOutput = transcribeLine('the seed', ueb, false, [{ ruleId: 'contraction-the', output: '⠠⠞' }]);
assert(customOutput.map((t) => t.braille).join('').includes('⠠⠞'), '行级例外应覆盖输出');
assert(customOutput.find((t) => t.ruleId === 'contraction-the')?.overridden, '被例外覆盖的 token 应有 overridden 标记');

// 3. 影响预览：全局停用 the。第 1 行已有相同例外，不应再出现；第 4 行含 The，应出现且位置正确
const impact = previewRuleImpact(state, 'contraction-the', { enabled: false });
const impactedIds = impact.map((item) => item.lineId);
assert(!impactedIds.includes('line-1'), '已有相同例外的行不应受全局停用影响');
assert(impactedIds.includes('line-4'), '第 4 行应受影响');
const line4 = impact.find((item) => item.lineId === 'line-4')!;
assertEqual(line4.lineIndex, 3, '第 4 行的下标应为 3');
assertEqual(line4.changes[0].start, 0, '变化应定位在 The 的起始位置');
assertEqual(line4.changes[0].text, 'The', '变化文本应为 The');
assertEqual(line4.changes[0].before, '⠮', '同一 token 的盲文不应被重复累计');
assertEqual(line4.changes[0].after, '⠹⠑', '停用 the 后 Th 落到 th 缩写');

// 4. 影响预览：修改输出。第 1 行的例外已整条停用该规则，不再受输出修改影响；第 4 行受影响
const outputImpact = previewRuleImpact(state, 'contraction-the', { output: '⠠⠮' });
assert(!outputImpact.some((item) => item.lineId === 'line-1'), '已停用该规则的行不应受输出修改影响');
assert(outputImpact.some((item) => item.lineId === 'line-4'), '使用该规则的行应受输出修改影响');

// 5. mergeOverride + normalizeOverrides
const merged = mergeOverride([], 'contraction-the', { enabled: false });
assertDeepEqual(merged, [{ ruleId: 'contraction-the', enabled: false }], '应新增例外');
const mergedTwice = mergeOverride(merged, 'contraction-the', { output: '⠠⠞' });
assertDeepEqual(mergedTwice, [{ ruleId: 'contraction-the', enabled: false, output: '⠠⠞' }], '同一规则的例外应合并');
// 与全局值一致的字段应被清理；全部一致时整条例外移除
const normalized = normalizeOverrides(ueb, [{ ruleId: 'contraction-the', enabled: true, output: '⠠⠞' }]);
assertDeepEqual(normalized, [{ ruleId: 'contraction-the', output: '⠠⠞' }], '与全局一致的字段应被清理');
const fullyRedundant = normalizeOverrides(ueb, [{ ruleId: 'contraction-the', enabled: true }]);
assertDeepEqual(fullyRedundant, [], '与全局完全一致的例外应移除');
// 规则集中没有的规则（切换规则集后）应原样保留
const kept = normalizeOverrides(ueb, [{ ruleId: 'rule-from-other-set', enabled: false }]);
assertDeepEqual(kept, [{ ruleId: 'rule-from-other-set', enabled: false }], '其他规则集的例外应保留');

// 6. analyzeProject 保留行级例外（重新检查 / 切换规则集后例外不丢）
const rechecked = analyzeProject(state);
assertDeepEqual(rechecked.lines[0].overrides, [{ ruleId: 'contraction-the', enabled: false }], '重新检查后例外应保持');
const switched = analyzeProject({ ...state, activeRuleSetId: 'spelling-first', issues: [] });
assertDeepEqual(switched.lines[0].overrides, [{ ruleId: 'contraction-the', enabled: false }], '切换规则集后例外应保持');
const back = analyzeProject({ ...switched, activeRuleSetId: 'ueb-teaching' });
assert(!back.lines[0].tokens.map((t) => t.braille).join('').includes('⠮'), '切回后例外仍应生效');

// 7. 例外描述
assertEqual(describeOverride({ ruleId: 'contraction-the', enabled: false }, ueb), '「the」 此行停用', '例外描述应可读');

// 8. 草稿序列化：例外可随 localStorage 草稿往返
const roundTripped = JSON.parse(JSON.stringify(state));
assertDeepEqual(roundTripped.lines[0].overrides, [{ ruleId: 'contraction-the', enabled: false }], '例外应随草稿序列化往返');

console.log('✓ 全部核心逻辑断言通过');
