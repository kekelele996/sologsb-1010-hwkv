import type {
  BrailleToken,
  ProofIssue,
  ProjectState,
  RuleOverride,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 用行级例外覆盖规则集，得到该行的有效规则集。 */
function applyOverrides(ruleSet: RuleSet, overrides: RuleOverride[]): RuleSet {
  if (overrides.length === 0) return ruleSet;
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => {
      const override = overrides.find((item) => item.ruleId === rule.id);
      if (!override) return rule;
      return {
        ...rule,
        enabled: override.enabled ?? rule.enabled,
        source: override.source ?? rule.source,
        output: override.output ?? rule.output,
      };
    }),
  };
}

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false, overrides: RuleOverride[] = []): BrailleToken[] {
  const effective = applyOverrides(ruleSet, overrides);
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(effective, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(effective, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(effective, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(effective, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(effective, char, 'punctuation') ?? activeRule(effective, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', effective.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
    });
  }

  if (overrides.length > 0) {
    const overriddenIds = new Set(overrides.map((item) => item.ruleId));
    for (const token of tokens) {
      if (token.ruleId && overriddenIds.has(token.ruleId)) token.overridden = true;
    }
  }

  return tokens;
}

function issue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const tokenText = line.tokens.map((token) => token.braille).join('');
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const nextLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (hasContinuation) {
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(issue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

export function analyzeProject(state: ProjectState): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues, line.overrides ?? []);
    const analyzed = analyzeLine({ ...line, tokens }, state.lines[index - 1]);
    nextLines.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  return {
    ...state,
    lines: nextLines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

export interface RuleImpactChange {
  /** 在原文中的起止位置（字符下标） */
  start: number;
  end: number;
  text: string;
  before: string;
  after: string;
}

export interface RuleImpactLine {
  lineId: string;
  lineIndex: number;
  source: string;
  changes: RuleImpactChange[];
}

interface TokenSpan {
  start: number;
  end: number;
  braille: string;
}

function tokenSpans(tokens: BrailleToken[]): TokenSpan[] {
  return tokens
    .filter((token) => token.text.length > 0)
    .map((token) => ({ start: token.offset, end: token.offset + token.text.length, braille: token.braille }));
}

/** 按原文区间对齐两份转写结果，合并相邻差异，得到“位置 + 前后盲文”的变化列表。 */
function diffTokenStreams(source: string, before: BrailleToken[], after: BrailleToken[]): RuleImpactChange[] {
  const beforeSpans = tokenSpans(before);
  const afterSpans = tokenSpans(after);
  const cuts = new Set<number>();
  [...beforeSpans, ...afterSpans].forEach((span) => {
    cuts.add(span.start);
    cuts.add(span.end);
  });
  const points = [...cuts].sort((a, b) => a - b);
  const brailleOver = (spans: TokenSpan[], start: number, end: number) =>
    spans.filter((span) => span.start <= start && span.end >= end).map((span) => span.braille).join('');

  // 先找出所有有差异的原子区间
  const differing: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (brailleOver(beforeSpans, start, end) !== brailleOver(afterSpans, start, end)) {
      differing.push({ start, end });
    }
  }

  // 相邻区间合并成一个变化区域，再按区域统计覆盖它的 token（每个 token 只算一次）
  const changes: RuleImpactChange[] = [];
  for (const part of differing) {
    const last = changes.at(-1);
    if (last && last.end === part.start) {
      last.end = part.end;
    } else {
      changes.push({ start: part.start, end: part.end, text: '', before: '', after: '' });
    }
  }
  const brailleOf = (spans: TokenSpan[], start: number, end: number) =>
    spans.filter((span) => span.start < end && span.end > start).map((span) => span.braille).join('');
  for (const change of changes) {
    change.text = source.slice(change.start, change.end);
    change.before = brailleOf(beforeSpans, change.start, change.end);
    change.after = brailleOf(afterSpans, change.start, change.end);
  }
  return changes;
}

/**
 * 预览一次规则修改的影响范围：逐行对比修改前后的转写，
 * 返回所有会变化的行及行内位置。行级例外照常参与，因此已用例外
 * 抵消该修改的行不会出现在结果里。
 */
export function previewRuleImpact(state: ProjectState, ruleId: string, patch: Partial<TranscriptionRule>): RuleImpactLine[] {
  const ruleSet = state.ruleSets.find((set) => set.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const patched = updateRuleInSet(ruleSet, ruleId, patch);
  const items: RuleImpactLine[] = [];

  state.lines.forEach((line, index) => {
    const continues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const overrides = line.overrides ?? [];
    const before = transcribeLine(line.source, ruleSet, continues, overrides);
    const after = transcribeLine(line.source, patched, continues, overrides);
    const changes = diffTokenStreams(line.source, before, after);
    if (changes.length > 0) {
      items.push({ lineId: line.id, lineIndex: index, source: line.source, changes });
    }
  });

  return items;
}

/** 把一次规则修改合并进某行的例外表（同一条规则只保留一条例外）。 */
export function mergeOverride(overrides: RuleOverride[], ruleId: string, patch: Partial<TranscriptionRule>): RuleOverride[] {
  const index = overrides.findIndex((item) => item.ruleId === ruleId);
  const merged: RuleOverride = { ...(index >= 0 ? overrides[index] : { ruleId }) };
  if (patch.enabled !== undefined) merged.enabled = patch.enabled;
  if (patch.source !== undefined) merged.source = patch.source;
  if (patch.output !== undefined) merged.output = patch.output;
  const next = [...overrides];
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return next;
}

/** 清理与规则集全局值一致的冗余例外；规则集中暂时没有的规则（如切换规则集后）原样保留。 */
export function normalizeOverrides(ruleSet: RuleSet, overrides: RuleOverride[]): RuleOverride[] {
  return overrides
    .map((override) => {
      const rule = ruleSet.rules.find((item) => item.id === override.ruleId);
      if (!rule) return override;
      const cleaned: RuleOverride = { ruleId: override.ruleId };
      if (override.enabled !== undefined && override.enabled !== rule.enabled) cleaned.enabled = override.enabled;
      if (override.source !== undefined && override.source !== rule.source) cleaned.source = override.source;
      if (override.output !== undefined && override.output !== rule.output) cleaned.output = override.output;
      return cleaned;
    })
    .filter((override) => override.enabled !== undefined || override.source !== undefined || override.output !== undefined);
}

/** 供校对区展示的例外描述，如「the」此行停用。 */
export function describeOverride(override: RuleOverride, ruleSet: RuleSet): string {
  const rule = ruleSet.rules.find((item) => item.id === override.ruleId);
  const name = rule ? `「${rule.source}」` : '（其他规则集的规则）';
  const parts: string[] = [];
  if (override.enabled !== undefined) parts.push(override.enabled ? '此行启用' : '此行停用');
  if (override.output !== undefined) parts.push(`输出改为 ${override.output}`);
  if (override.source !== undefined) parts.push(`匹配改为 ${override.source}`);
  return `${name} ${parts.join('，')}`;
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
  };
}

export function outputText(state: ProjectState): string {
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${line.tokens.map((token) => token.braille).join('')}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}
