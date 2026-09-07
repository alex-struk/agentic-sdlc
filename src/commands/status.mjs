// `sdlc status` — regenerate the project's state site from the files on disk.
//
// The site has two renderings of one model. The Markdown pages are the record that lives
// in the repository and reads in a diff. The HTML pages are the view a person reads,
// styled with the B.C. Design System token set. Both are written on every build, from a
// single read of the project (`collect`), so the two can never disagree about a number.
//
// Every stage and every ruling calls this, so it has to be a pure function of the state on
// disk: no timestamps, no generation stamp, nothing that would make a rebuild of an
// unchanged project a diff.
import { join, resolve } from "node:path";
import { writeText } from "../lib/fsx.mjs";
import { COMMANDS } from "../cli.mjs";
import { collect } from "../site/model.mjs";
import { renderMarkdown } from "../site/markdown.mjs";
import { renderHtml } from "../site/html.mjs";
import { installAssets } from "../site/assets.mjs";

export function buildSite(projectDir) {
  projectDir = resolve(projectDir);
  const model = collect(projectDir);
  const pages = [...renderMarkdown(model), ...renderHtml(model)];
  for (const [p, t] of pages) writeText(join(projectDir, p), t);
  const assets = installAssets(projectDir);
  return { pages: pages.map(([p]) => p), assets };
}

COMMANDS.status = async ({ pos }) => {
  const r = buildSite(pos[0] ?? process.cwd());
  console.log([...r.pages, ...r.assets].join("\n"));
  return 0;
};
