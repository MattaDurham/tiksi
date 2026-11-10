// Splits the browser suites into N groups of about equal running time, so CI can run the
// groups side by side on separate machines instead of one 35-45 minute queue.
//
// Times come from scripts/e2e-durations.json: seconds per suite, the slower of Linux and macOS
// on a passing CI run. They only balance the groups; a suite missing from the file counts as
// DEFAULT_SECONDS. FIRST_GROUP_EXTRA is work group 1 carries before its suites; the syntax and
// unit checks moved to the Linux quick job, so today it is none.

export const DEFAULT_SECONDS = 60;
// The suites whose phone checks also run on Safari's engine (node scripts/e2e.mjs --webkit);
// each reads E2E_BROWSER=webkit.
export const WEBKIT_SUITES = ['e2e-field-view.mjs'];
export const FIRST_GROUP_EXTRA = 0;

export function parseGroup(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text || ''));
  if (!match) throw new Error(`Group must look like 2/4, not "${text}"`);
  const index = Number(match[1]), count = Number(match[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`Group ${text} is out of range`);
  return { index, count };
}

// Longest suite first, each onto the group with the least time so far. Ties go to the lower
// group and names are sorted first, so every machine computes the same split.
export function groupSuites(files, durations = {}, count = 1) {
  const groups = Array.from({ length: count }, (_, i) => ({ files: [], seconds: i === 0 && count > 1 ? FIRST_GROUP_EXTRA : 0 }));
  const seconds = file => durations[file.replace(/\.mjs$/, '')] ?? DEFAULT_SECONDS;
  const ordered = [...files].sort().sort((a, b) => seconds(b) - seconds(a));
  for (const file of ordered) {
    const target = groups.reduce((best, group) => (group.seconds < best.seconds ? group : best), groups[0]);
    target.files.push(file);
    target.seconds += seconds(file);
  }
  for (const group of groups) group.files.sort();
  return groups;
}
