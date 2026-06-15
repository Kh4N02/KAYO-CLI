'use strict';

const {
  visibleLen,
  sectionTitle,
  formatTitleCell,
  formatIdxCell,
  statusBadge,
  qualityBadge,
  channelLabel,
  categoryLabel,
  isNavRow,
  C,
  colorEnabled,
} = require('./ui');

const COLUMN_STYLE = {
  Idx: (v, row) => formatIdxCell(v, row),
  Status: (v, row) => (isNavRow(row) ? '' : statusBadge(v)),
  Quality: (v, row) => (isNavRow(row) ? '' : qualityBadge(v)),
  Channel: (v, row) => (isNavRow(row) ? '' : channelLabel(v, row?.sport || row?.Sport)),
  Title: (v) => formatTitleCell(v),
  Category: (v, row) => categoryLabel(v || row?.Category, row?.sport),
  Section: (v, row) => formatTitleCell(v || row?.Section),
  'Local Time': (v, row) => {
    if (isNavRow(row) || !v) return '';
    return colorEnabled() ? `${C.gray}${v}${C.reset}` : v;
  },
  'Asset ID': (v, row) => {
    if (isNavRow(row) || !v) return '';
    return colorEnabled() ? `${C.dim}${v}${C.reset}` : v;
  },
};

function colWidths(rows, cols) {
  const widths = cols.map((c) => visibleLen(c));
  for (const row of rows) {
    cols.forEach((c, i) => {
      const raw = row[c] ?? '';
      const styled = styleCell(c, raw, row);
      widths[i] = Math.max(widths[i], visibleLen(styled));
    });
  }
  return widths.map((w, i) => Math.max(w, visibleLen(cols[i])));
}

function styleCell(col, value, row) {
  const fn = COLUMN_STYLE[col];
  if (fn) return fn(value, row);
  return String(value ?? '');
}

function padCell(styled, width) {
  const vis = visibleLen(styled);
  if (vis >= width) return styled;
  return styled + ' '.repeat(width - vis);
}

function renderTable(title, columns, rows) {
  const widths = colWidths(rows, columns);
  const top = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const mid = top;
  const bot = top;

  const border = (s) => (colorEnabled() ? `${C.gray}${s}${C.reset}` : s);
  const headerCells = columns.map((c, i) => padCell(
    colorEnabled() ? `${C.bold}${C.brightWhite}${c}${C.reset}` : c,
    widths[i],
  ));

  const lines = [
    sectionTitle(title).trimEnd(),
    border(top),
    border(`| ${headerCells.join(' | ')} |`),
    border(mid),
  ];

  for (const row of rows) {
    const cells = columns.map((c, i) => padCell(styleCell(c, row[c], row), widths[i]));
    lines.push(border(`| ${cells.join(' | ')} |`));
  }

  lines.push(border(bot));
  return lines.join('\n');
}

module.exports = { renderTable };
