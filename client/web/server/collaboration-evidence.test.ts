import { describe, expect, it } from 'vitest';
import { validateQualityEvidence } from './collaboration-evidence';

describe('validateQualityEvidence', () => {
  it('rejects LGTM-only review evidence', () => {
    expect(validateQualityEvidence('role-code-reviewer', '# 审查\n\nLGTM')).toEqual(expect.arrayContaining([
      expect.stringContaining('审查范围'),
      expect.stringContaining('需求符合性'),
      expect.stringContaining('测试充分性'),
    ]));
  });

  it('accepts a review report that covers every required dimension', () => {
    const report = [
      '# 代码审查报告',
      '## 审查范围',
      '- 文件：src/login.ts',
      '- Diff：R002 相对 R001',
      '## 需求符合性\n符合',
      '## 逻辑正确性\n通过',
      '## 回归风险\n已检查密码登录',
      '## 错误处理\n覆盖错误验证码',
      '## 安全性\n未发现新增风险',
      '## 可维护性\n结构清晰',
      '## 测试充分性\n已有单元与集成测试',
    ].join('\n');

    expect(validateQualityEvidence('role-code-reviewer', report)).toEqual([]);
  });

  it('requires reproducible execution evidence from testers', () => {
    const report = [
      '# 测试报告',
      '## 实际命令\nnpm test',
      '## 测试环境\nmacOS',
      '## 退出码\n0',
      '## 关键输出\n全部通过',
      '## 业务验收结果\n符合预期',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual([
      expect.stringContaining('证据路径'),
    ]);
  });

  it('rejects empty review sections instead of accepting marker-only evidence', () => {
    const report = [
      '# 代码审查报告',
      '## 审查范围',
      '## 需求符合性',
      '## 逻辑正确性',
      '## 回归风险',
      '## 错误处理',
      '## 安全性',
      '## 可维护性',
      '## 测试充分性',
    ].join('\n');

    expect(validateQualityEvidence('role-code-reviewer', report)).toEqual(expect.arrayContaining([
      expect.stringContaining('审查范围'),
      expect.stringContaining('测试充分性'),
    ]));
  });

  it('treats unexecuted or failing test commands as unverified', () => {
    const report = [
      '# 测试报告',
      '## 实际命令\n未执行',
      '## 测试环境\nmacOS 15',
      '## 退出码\n1',
      '## 关键输出\n构建失败',
      '## 业务验收结果\n未验证',
      '## 证据路径\nlogs/test.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual(expect.arrayContaining([
      expect.stringContaining('未执行等于未验证'),
      expect.stringContaining('退出码 0'),
      expect.stringContaining('不能签署测试通过'),
    ]));
  });

  it('rejects softened placeholder wording such as 尚未运行 or 尚未完成', () => {
    const report = [
      '# 测试报告',
      '实际命令：尚未运行测试',
      '测试环境：尚未准备',
      '退出码：0',
      '关键输出：尚未产生',
      '业务验收结果：尚未完成',
      '证据路径：logs/future.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a partial business acceptance result even when commands exit successfully', () => {
    const report = [
      '# 测试报告',
      '实际命令：npm test',
      '测试环境：macOS 15 / Node 24',
      '退出码：0',
      '关键输出：自动化用例执行完成',
      '业务验收结果：部分通过，仍有两项未验收',
      '证据路径：logs/partial.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual(expect.arrayContaining([
      expect.stringContaining('尚未通过'),
    ]));
  });

  it('does not mistake 所有验收项未通过 for an explicit pass', () => {
    const report = [
      '# 测试报告',
      '实际命令：npm test',
      '测试环境：macOS 15 / Node 24',
      '退出码：0',
      '关键输出：命令执行完成',
      '业务验收结果：所有验收项未通过',
      '证据路径：logs/failed.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual(expect.arrayContaining([
      expect.stringContaining('尚未通过'),
    ]));
  });

  it('does not accept a negated sentence merely because it contains 所有 and 通过', () => {
    const report = [
      '# 测试报告',
      '实际命令：npm test',
      '测试环境：macOS 15 / Node 24',
      '退出码：0',
      '关键输出：命令执行完成',
      '业务验收结果：所有验收项不是通过状态',
      '证据路径：logs/not-passed.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual(expect.arrayContaining([
      expect.stringContaining('必须明确写明全部通过或符合预期'),
    ]));
  });

  it('accepts non-placeholder tester evidence with a successful exit code', () => {
    const report = [
      '# 测试报告',
      '实际命令：npm test',
      '测试环境：macOS 15 / Node 24',
      '退出码：0',
      '关键输出：429 tests passed',
      '业务验收结果：全部验收标准通过',
      '证据路径：logs/test.log',
    ].join('\n');

    expect(validateQualityEvidence('role-tester', report)).toEqual([]);
  });
});
