const REVIEW_MARKERS = [
  '审查范围',
  '需求符合性',
  '逻辑正确性',
  '回归风险',
  '错误处理',
  '安全性',
  '可维护性',
  '测试充分性',
] as const;

const TEST_MARKERS = [
  '实际命令',
  '测试环境',
  '退出码',
  '关键输出',
  '业务验收结果',
  '证据路径',
] as const;

const PLACEHOLDER_PATTERN = /^(?:[-*]\s*)?(?:\[[^\]]*\]|待补充|待填写|待执行|待验证|未执行|未验证|未准备|未完成|尚未.*|还未.*|暂无|无|n\/?a|todo|tbd)[。.!！]?$/i;
const UNVERIFIED_PATTERN = /(?:未执行|待执行|待验证|未验证|未准备|未完成|尚未|还未|未曾|没有(?:运行|执行)|部分通过|未通过|没通过|无法通过|未验收|待验收|仍有|剩余|不通过|失败)/i;
const EXPLICIT_PASS_PATTERN = /^(?:[-*]\s*)?(?:全部(?:验收标准|验收项|测试项)?通过|全量通过|所有验收项通过|逐项验收通过|验收通过|符合预期|通过全部(?:验收标准|验收项|测试项)?)(?:[：:，,。；;\s]|$)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionContent(markdown: string, marker: string): string | undefined {
  const heading = new RegExp(`^#{1,6}\\s*${escapeRegExp(marker)}\\s*$`, 'm');
  const match = heading.exec(markdown);
  if (match) {
    const bodyStart = match.index + match[0].length;
    const remainder = markdown.slice(bodyStart).replace(/^\r?\n/, '');
    const nextHeading = /^#{1,6}\s+/m.exec(remainder);
    return (nextHeading ? remainder.slice(0, nextHeading.index) : remainder).trim();
  }
  const field = new RegExp(`^(?:[-*]\\s*)?${escapeRegExp(marker)}\\s*[：:]\\s*(.*)$`, 'm')
    .exec(markdown);
  return field?.[1]?.trim();
}

function validateSections(markdown: string, markers: readonly string[], label: string): string[] {
  return markers.flatMap(marker => {
    const value = sectionContent(markdown, marker);
    if (value === undefined) return [`${label}证据缺少「${marker}」`];
    if (!value || PLACEHOLDER_PATTERN.test(value)) return [`${label}证据中的「${marker}」没有实际内容`];
    return [];
  });
}

export function validateQualityEvidence(roleId: string, markdown: string): string[] {
  const content = markdown.trim();
  if (roleId === 'role-code-reviewer') {
    return validateSections(content, REVIEW_MARKERS, '代码审查');
  }
  if (roleId === 'role-tester') {
    const errors = validateSections(content, TEST_MARKERS, '测试');
    const command = sectionContent(content, '实际命令');
    if (command && UNVERIFIED_PATTERN.test(command)) {
      errors.push('测试证据必须记录真实执行的命令，未执行等于未验证');
    }
    const environment = sectionContent(content, '测试环境');
    if (environment && UNVERIFIED_PATTERN.test(environment)) {
      errors.push('测试环境尚未准备，不能签署测试通过');
    }
    const exitCode = sectionContent(content, '退出码');
    const codes = exitCode?.match(/(?<![\w.-])-?\d+(?![\w.-])/g)?.map(Number) ?? [];
    if (exitCode && (codes.length === 0 || codes.some(code => code !== 0))) {
      errors.push('测试通过证据必须包含退出码 0，非零退出码不能签署通过');
    }
    const result = sectionContent(content, '业务验收结果');
    if (result && UNVERIFIED_PATTERN.test(result)) {
      errors.push('业务验收结果尚未通过，不能签署测试通过');
    } else if (result && !EXPLICIT_PASS_PATTERN.test(result)) {
      errors.push('业务验收结果必须明确写明全部通过或符合预期');
    }
    return errors;
  }
  return [];
}
