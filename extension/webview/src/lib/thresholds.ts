// Single source of truth for the green/yellow/red thresholds used by every
// resource gauge in the sidebar (CPU/RAM/DISK bars, per-process CPU, totals).
// Changing these here changes them everywhere.
//
// Always consume via `style={{ color: thresholdColor(pct) }}` or
// `style={{ backgroundColor: thresholdColor(pct) }}`. Do NOT build a Tailwind
// class string at runtime (`bg-[color:...]`) — Tailwind's static analyzer
// only sees literal class names in source, so dynamic class strings silently
// fail to emit any CSS and the bar renders blank.

const GREEN = 'var(--vscode-charts-green, #89d185)';
const YELLOW = 'var(--vscode-charts-yellow, #cca700)';
const RED = 'var(--vscode-charts-red, #f14c4c)';

export function thresholdColor(pct: number): string {
  if (pct >= 85) return RED;
  if (pct >= 60) return YELLOW;
  return GREEN;
}
