/**
 * Minimal glob matching (supports **, *, ?, {a,b} alternation) against
 * forward-slash paths. Kept dependency-free; good enough for the
 * include/exclude settings this extension exposes.
 */

const regexCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) {
    return cached;
  }
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; bare `**` matches anything
        if (glob[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        const parts = glob
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^${}()|[\]\\?*]/g, '\\$&'));
        re += '(?:' + parts.join('|') + ')';
        i = end + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  const compiled = new RegExp('^' + re + '$');
  regexCache.set(glob, compiled);
  return compiled;
}

/** Normalize a filesystem path for glob matching. */
export function toGlobPath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/');
}

/** True if `path` (forward-slash) matches `glob`. Globs without a leading slash or `**` match anywhere in the path. */
export function matchesGlob(path: string, glob: string): boolean {
  const normalizedGlob = glob.replace(/\\/g, '/');
  // Relative-looking globs (no leading / or **) should match against path suffixes too.
  const effective =
    normalizedGlob.startsWith('/') || normalizedGlob.startsWith('**')
      ? normalizedGlob
      : '**/' + normalizedGlob;
  return globToRegExp(effective).test(path) || globToRegExp(normalizedGlob).test(path);
}

export function matchesAnyGlob(fsPath: string, globs: readonly string[]): boolean {
  const p = toGlobPath(fsPath);
  return globs.some((g) => matchesGlob(p, g));
}
