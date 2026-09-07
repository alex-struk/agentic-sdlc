// The state site's stylesheet. Structure and information design come from the pipeline's
// own interface prototype — a dark masthead over a fixed side navigation, stat tiles, a
// coverage board of lifecycle bars, hairline tables with small-caps headers. Colour,
// type, spacing and borders come entirely from the B.C. Design System token set in
// `tokens.mjs`. No resolved value appears below: every declaration names a token, so a
// token release changes the site by regenerating one file.
//
// Accessibility commitments this file is responsible for keeping: a visible focus ring on
// every interactive element, status never carried by colour alone (each chip and bar
// segment is labelled in text as well), a skip link to the main content, tables that
// scroll inside their own box so the page never scrolls sideways, and a layout that
// reflows to a single column at narrow widths and under heavy zoom.
import { TOKENS } from "./tokens.mjs";

// Only the four faces the site actually sets: regular and bold, upright and italic. The
// light weights in the distribution are never asked for here, and shipping a face nothing
// references would put a quarter of a megabyte in the project repository for nothing.
// woff2 only, for the same reason — every browser that can render this site supports it.
export const FONT_FACES = [
  ["BCSans-Regular", 400, "normal"],
  ["BCSans-Italic", 400, "italic"],
  ["BCSans-Bold", 700, "normal"],
  ["BCSans-BoldItalic", 700, "italic"],
];

// One stylesheet serves every page at every depth. A `url()` inside CSS resolves against
// the stylesheet's own location rather than the document's, so the font paths below are
// correct from `site/index.html` and `site/criteria/users.html` alike — which is also what
// lets the site work opened from a local file as well as served from a root.
export function stylesheet() {
  const faces = FONT_FACES.map(([file, weight, style]) => `@font-face {
  font-family: "BC Sans";
  src: url("fonts/${file}.woff2") format("woff2");
  font-weight: ${weight};
  font-style: ${style};
  font-display: swap;
}`).join("\n");

  return `${faces}

:root {
${TOKENS}
  --sdlc-sidebar-width: 15rem;
  --sdlc-measure: 46rem;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font: var(--typography-regular-small-body);
  font-family: "BC Sans", "Noto Sans", Verdana, Arial, sans-serif;
  color: var(--typography-color-primary);
  background: var(--surface-color-background-light-gray);
}
h1, h2, h3, h4, h5, h6 { margin: 0; font-weight: var(--typography-font-weights-bold); }
p { margin: 0 0 var(--layout-margin-small); }
a { color: var(--typography-color-link); }
a:hover { text-decoration: none; }
:focus-visible {
  outline: var(--layout-border-width-medium) solid var(--surface-color-border-active);
  outline-offset: var(--layout-padding-hair);
}
code, pre, .mono {
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
code { font-size: 0.9em; }
pre {
  background: var(--surface-color-background-white);
  border: var(--layout-border-width-small) solid var(--surface-color-border-default);
  padding: var(--layout-padding-medium);
  overflow-x: auto;
  margin: 0 0 var(--layout-margin-medium);
}
pre code { font-size: var(--typography-font-size-label); }

.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--surface-color-background-white);
  color: var(--typography-color-link);
  padding: var(--layout-padding-small) var(--layout-padding-medium);
  z-index: 10;
}
.skip:focus { left: 0; }

/* ===== masthead ===== */
.masthead {
  background: var(--surface-color-background-dark-blue);
  border-bottom: var(--layout-border-width-large) solid var(--theme-gold-100);
  color: var(--typography-color-primary-invert);
  padding: var(--layout-padding-medium) var(--layout-padding-large);
  display: flex;
  align-items: baseline;
  gap: var(--layout-margin-medium);
  flex-wrap: wrap;
}
.masthead .wordmark {
  font-size: var(--typography-font-size-large-body);
  font-weight: var(--typography-font-weights-bold);
}
.masthead .wordmark a { color: var(--typography-color-primary-invert); text-decoration: none; }
.masthead .project { color: var(--typography-color-secondary-invert); }
.masthead .spacer { flex: 1 1 auto; }
.masthead .profile {
  font-size: var(--typography-font-size-label);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--theme-gold-100);
}

/* ===== shell ===== */
.shell { display: flex; align-items: flex-start; }
.sidebar {
  width: var(--sdlc-sidebar-width);
  flex: none;
  background: var(--surface-color-background-white);
  border-right: var(--layout-border-width-small) solid var(--surface-color-border-default);
  padding: var(--layout-padding-medium) 0 var(--layout-padding-xlarge);
  position: sticky;
  top: 0;
  max-height: 100vh;
  overflow-y: auto;
}
.sidebar h2 {
  font-size: var(--typography-font-size-label);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--typography-color-secondary);
  padding: var(--layout-padding-medium) var(--layout-padding-medium) var(--layout-padding-xsmall);
}
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar a {
  display: block;
  padding: var(--layout-padding-xsmall) var(--layout-padding-medium);
  color: var(--typography-color-primary);
  text-decoration: none;
  border-left: var(--layout-border-width-large) solid transparent;
}
.sidebar a:hover { background: var(--surface-color-secondary-hover); }
.sidebar a[aria-current="page"] {
  border-left-color: var(--theme-gold-100);
  font-weight: var(--typography-font-weights-bold);
  background: var(--surface-color-background-light-blue);
}
.sidebar .count { color: var(--typography-color-secondary); font-size: var(--typography-font-size-label); }

main { flex: 1 1 auto; min-width: 0; padding: var(--layout-padding-large); }
.page-head { margin-bottom: var(--layout-margin-large); }
.page-head h1 { font-size: var(--typography-font-size-h3); line-height: var(--typography-line-heights-dense); }
.page-head .lede {
  color: var(--typography-color-secondary);
  max-width: var(--sdlc-measure);
  margin-top: var(--layout-margin-xsmall);
}
section { margin-bottom: var(--layout-margin-xlarge); }
section > h2 {
  font-size: var(--typography-font-size-h5);
  margin-bottom: var(--layout-margin-small);
  padding-bottom: var(--layout-padding-xsmall);
  border-bottom: var(--layout-border-width-medium) solid var(--surface-color-background-dark-blue);
}
.note {
  border-left: var(--layout-border-width-large) solid var(--theme-gold-100);
  background: var(--surface-color-background-white);
  padding: var(--layout-padding-small) var(--layout-padding-medium);
  color: var(--typography-color-secondary);
  max-width: var(--sdlc-measure);
  margin-bottom: var(--layout-margin-medium);
}

/* ===== stat tiles ===== */
.stats { display: flex; flex-wrap: wrap; gap: var(--layout-margin-small); list-style: none; margin: 0 0 var(--layout-margin-large); padding: 0; }
.stat {
  background: var(--surface-color-background-white);
  border: var(--layout-border-width-small) solid var(--surface-color-border-default);
  padding: var(--layout-padding-medium);
  min-width: 9.5rem;
  flex: 1 1 9.5rem;
}
.stat.lead { border-top: var(--layout-border-width-large) solid var(--theme-gold-100); }
.stat .value { display: block; font-size: var(--typography-font-size-h4); font-weight: var(--typography-font-weights-bold); line-height: var(--typography-line-heights-xdense); }
.stat .label { display: block; color: var(--typography-color-secondary); font-size: var(--typography-font-size-label); }

/* ===== tables ===== */
.scroll { overflow-x: auto; background: var(--surface-color-background-white); border: var(--layout-border-width-small) solid var(--surface-color-border-default); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: var(--layout-padding-small); border-bottom: var(--layout-border-width-small) solid var(--surface-color-border-default); vertical-align: top; }
th {
  font-size: var(--typography-font-size-label);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--typography-color-secondary);
  border-bottom: var(--layout-border-width-medium) solid var(--surface-color-background-dark-blue);
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

/* ===== coverage board ===== */
.board td.domain { font-weight: var(--typography-font-weights-bold); white-space: nowrap; }
.bar { display: flex; height: var(--layout-padding-small); min-width: 8rem; background: var(--surface-color-secondary-pressed); }
.bar span { display: block; }
.bar .seg-accepted { background: var(--theme-blue-100); }
.bar .seg-implemented { background: var(--theme-blue-80); }
.bar .seg-verified { background: var(--support-border-color-success); }
.bar .seg-monitored { background: var(--theme-gold-100); }
.bar .seg-proposed { background: var(--theme-blue-40); }
.bar .seg-obsolete { background: var(--typography-color-disabled); }
.bar-key { list-style: none; display: flex; flex-wrap: wrap; gap: var(--layout-margin-medium); padding: 0; margin: var(--layout-margin-small) 0 0; font-size: var(--typography-font-size-label); color: var(--typography-color-secondary); }
.bar-key .swatch { display: inline-block; width: 0.75rem; height: 0.75rem; margin-right: var(--layout-margin-xsmall); vertical-align: -1px; }

/* ===== chips ===== */
.chip {
  display: inline-block;
  font-size: var(--typography-font-size-label);
  font-weight: var(--typography-font-weights-bold);
  padding: var(--layout-padding-hair) var(--layout-padding-small);
  border: var(--layout-border-width-small) solid var(--surface-color-border-medium);
  background: var(--surface-color-background-white);
  white-space: nowrap;
}
.chip.approve { background: var(--support-surface-color-success); border-color: var(--support-border-color-success); }
.chip.return { background: var(--support-surface-color-danger); border-color: var(--support-border-color-danger); }
.chip.escalated { background: var(--support-surface-color-warning); border-color: var(--support-border-color-warning); }
.chip.open { background: var(--support-surface-color-info); border-color: var(--support-border-color-info); }
.chip.pass { background: var(--support-surface-color-success); border-color: var(--support-border-color-success); }
.chip.fail { background: var(--support-surface-color-danger); border-color: var(--support-border-color-danger); }
.chip.stale, .chip.unbound { background: var(--support-surface-color-warning); border-color: var(--support-border-color-warning); }
.chip.muted { color: var(--typography-color-secondary); }

/* ===== criterion cards ===== */
.criterion {
  background: var(--surface-color-background-white);
  border: var(--layout-border-width-small) solid var(--surface-color-border-default);
  border-left: var(--layout-border-width-large) solid var(--theme-blue-100);
  padding: var(--layout-padding-medium);
  margin-bottom: var(--layout-margin-small);
}
.criterion.is-obsolete { border-left-color: var(--typography-color-disabled); }
.criterion.is-not-testable { border-left-color: var(--support-border-color-warning); }
.criterion > header { display: flex; gap: var(--layout-margin-small); align-items: baseline; flex-wrap: wrap; margin-bottom: var(--layout-margin-xsmall); }
.criterion .id {
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  font-weight: var(--typography-font-weights-bold);
  background: var(--theme-gold-100);
  padding: var(--layout-padding-hair) var(--layout-padding-small);
}
.criterion .statement { font-size: var(--typography-font-size-body); line-height: var(--typography-line-heights-xdense); max-width: var(--sdlc-measure); }
.criterion dl { display: grid; grid-template-columns: 8rem 1fr; gap: var(--layout-margin-xsmall) var(--layout-margin-small); margin: var(--layout-margin-small) 0 0; font-size: var(--typography-font-size-label); }
.criterion dt { color: var(--typography-color-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
.criterion dd { margin: 0; overflow-wrap: anywhere; }

/* ===== filters ===== */
.filters { display: flex; flex-wrap: wrap; gap: var(--layout-margin-xsmall); margin-bottom: var(--layout-margin-medium); }
.filters button {
  font: inherit;
  font-size: var(--typography-font-size-label);
  padding: var(--layout-padding-xsmall) var(--layout-padding-small);
  border: var(--layout-border-width-small) solid var(--surface-color-border-medium);
  background: var(--surface-color-secondary-button-default);
  color: var(--typography-color-primary);
  cursor: pointer;
}
.filters button:hover { background: var(--surface-color-secondary-button-hover); }
.filters button[aria-pressed="true"] {
  background: var(--surface-color-primary-button-default);
  border-color: var(--surface-color-primary-button-default);
  color: var(--typography-color-primary-invert);
}

/* ===== entries (journal, runs, proposals) ===== */
.entry {
  background: var(--surface-color-background-white);
  border: var(--layout-border-width-small) solid var(--surface-color-border-default);
  padding: var(--layout-padding-medium) var(--layout-padding-large);
  margin-bottom: var(--layout-margin-medium);
}
.entry > header { border-bottom: var(--layout-border-width-small) solid var(--surface-color-border-default); padding-bottom: var(--layout-padding-small); margin-bottom: var(--layout-margin-small); }
.entry h2, .entry h3 { font-size: var(--typography-font-size-h5); }
.entry .meta { color: var(--typography-color-secondary); font-size: var(--typography-font-size-label); }
.body { max-width: var(--sdlc-measure); }
.body h2, .body h3, .body h4 { margin: var(--layout-margin-medium) 0 var(--layout-margin-xsmall); font-size: var(--typography-font-size-large-body); }
.body ul, .body ol { margin: 0 0 var(--layout-margin-small); padding-left: var(--layout-padding-large); }
.body li { margin-bottom: var(--layout-margin-hair); }
.body blockquote {
  margin: 0 0 var(--layout-margin-small);
  padding-left: var(--layout-padding-medium);
  border-left: var(--layout-border-width-large) solid var(--surface-color-border-default);
  color: var(--typography-color-secondary);
}
.body .scroll { margin-bottom: var(--layout-margin-medium); }

footer.site {
  border-top: var(--layout-border-width-small) solid var(--surface-color-border-default);
  padding: var(--layout-padding-medium) var(--layout-padding-large);
  color: var(--typography-color-secondary);
  font-size: var(--typography-font-size-label);
}

@media (max-width: 55rem) {
  .shell { display: block; }
  .sidebar { width: auto; position: static; max-height: none; border-right: 0; border-bottom: var(--layout-border-width-small) solid var(--surface-color-border-default); }
  .criterion dl { grid-template-columns: 1fr; }
  .criterion dt { margin-top: var(--layout-margin-xsmall); }
}
@media print {
  .sidebar, .filters, .skip { display: none; }
  body { background: var(--surface-color-background-white); }
}
`;
}
