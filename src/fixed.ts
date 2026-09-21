/**
 * 固定分支（发布层级）的自动识别。
 *
 * 这是 git-tree/backend/repo.py 的 `_suggest_fixed` 的等价物，但有一处**有意的改进**：
 *
 * 网页版有侧边栏可以手工勾选，所以它只做精确名字匹配就够了；插件里没有那个侧边栏，
 * 认不出来就等于没有固定分支——而固定分支一旦缺失，承载轨道（"改动怎么往上传"的那条
 * 淡虚线）就全没了，版本树会少一半信息。
 *
 * 所以这里除了精确匹配，还做**前缀匹配**：`gitTree.fixedPrefixes` 里配了 `release`，
 * 就能认出 `release20260919` / `release20261010` 这类带日期的发版分支，
 * 而且它们会被排到 `release` 该在的层级上，而不是堆到末尾。
 */

import { DEFAULT_FIXED, RefInfo } from './repo';

export interface SuggestOptions {
  /** 精确匹配之外，还认这些前缀。 */
  prefixes?: readonly string[];
  /** 上限，防止一个畸形仓库里冒出几十条"固定分支"。 */
  max?: number;
}

/**
 * 从本地分支里挑出固定分支，**顺序即发布层级**（越靠前越底层）。
 *
 * 排序规则：先看它落在 `DEFAULT_FIXED` 的哪一层（前缀匹配的落在前缀那一层），
 * 同层再按名字排。这样 `master → dev → uat → release` 的层级不会被日期分支打乱。
 *
 * 一条都认不出来时返回空数组——**不**像网页版那样退化成"随便挑两个分支"，
 * 那会把普通开发分支冒充成发布层，比空着更误导。调用方应该给用户一个提示。
 */
export function suggestFixed(
  refs: readonly RefInfo[],
  head: string | null,
  options: SuggestOptions = {},
): string[] {
  const prefixes = options.prefixes ?? [];
  const max = options.max ?? 12;

  const names = refs.filter((r) => !r.remote).map((r) => r.name);
  if (!names.length) return [];

  const tierOf = (name: string): number => {
    const exact = DEFAULT_FIXED.indexOf(name);
    if (exact >= 0) return exact;
    let best = Number.POSITIVE_INFINITY;
    for (const prefix of prefixes) {
      if (!prefix || !name.startsWith(prefix)) continue;
      const idx = DEFAULT_FIXED.indexOf(prefix);
      best = Math.min(best, idx >= 0 ? idx : DEFAULT_FIXED.length);
    }
    return best;
  };

  const picked = new Set<string>();
  if (head && names.includes(head)) picked.add(head);
  for (const name of names) {
    if (Number.isFinite(tierOf(name))) picked.add(name);
  }
  if (!picked.size) return [];

  const ordered = [...picked].sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return ordered.slice(0, max);
}

/**
 * 最终用哪套固定分支：显式配置优先，否则自动识别。
 *
 * 返回 `source` 是为了在界面上说清楚"这是你配的、还是我猜的"——猜错的时候
 * 用户才知道该去改 `gitTree.fixedBranches`。
 */
export function resolveFixed(
  configured: readonly string[],
  refs: readonly RefInfo[],
  head: string | null,
  options: SuggestOptions & { auto?: boolean } = {},
): { fixed: string[]; source: 'configured' | 'auto' | 'none' } {
  const explicit = configured.map((s) => s.trim()).filter(Boolean);
  if (explicit.length) {
    const known = new Set(refs.map((r) => r.name));
    // 保留用户给的名字里确实存在的，顺序照旧
    return { fixed: explicit.filter((name) => known.has(name)), source: 'configured' };
  }
  if (options.auto === false) return { fixed: [], source: 'none' };
  const auto = suggestFixed(refs, head, options);
  return { fixed: auto, source: auto.length ? 'auto' : 'none' };
}
