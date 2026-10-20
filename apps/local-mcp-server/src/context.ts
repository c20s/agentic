import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Project context lookup for the `get_context` tool.
 *
 * Same shape/philosophy as `tool-help.ts`: the tool's own description (sent to
 * the model on every turn) stays a single dense line, while the actual
 * content lives here and is only paid for (in context tokens) on the turns
 * where it's actually fetched.
 *
 * `get_context` with no symbol returns a generic, AGENTS.md-style guideline
 * for how to respond/behave in this repo. The content lives in
 * `prompts/default.md` (edit that file directly, not this one) — it's part
 * of the MCP server itself, not the sandboxed project, so it's loaded
 * relative to this module rather than through the Sandbox.
 *
 * `symbol: "skills"`, `symbol: "<skill-name>"`, and
 * `symbol: "<skill-name>/references/<file>"` are all backed by this same
 * repo's own `.apm/skills/<name>/` (APM-managed skills, deployed the same way
 * `.claude/skills` are) — i.e. THIS `agentic` repo's skills, always,
 * regardless of which project the server's sandbox is currently pointed at.
 * The third form exists because a skill's `SKILL.md` body only *links* to its
 * `references/*.md` files (per the `skill-creator` house style), it never
 * inlines them — so this is how that content actually gets fetched, on
 * demand, instead of being paid for (in context tokens) on every skill read.
 * That's deliberate: these are the MCP server's own bundled skills (same
 * category as `prompts/default.md` and the `skills/review/*` ones), not
 * something that varies per sandboxed project. So they're loaded relative to
 * this module via `import.meta.url`, never through `Sandbox`.
 *
 * Beyond that this is meant to grow into a small lookup table keyed by
 * "symbol" (e.g. `review`, `get_project_overview`) for scripted, on-demand
 * summaries of this repo — but that's intentionally not built yet.
 */
const MCP_SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(MCP_SERVER_DIR, "..", "prompts");
// MCP_SERVER_DIR is apps/local-mcp-server/src -> repo root is three levels up.
const APM_SKILLS_DIR = join(MCP_SERVER_DIR, "..", "..", "..", ".apm", "skills");

function loadPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf-8").trim();
}

export interface ApmSkill {
  name: string;
  description: string;
  body: string;
  /** File names under this skill's references/ dir, e.g. ["typescript.md"]. Empty if none. */
  references: string[];
}

function parseSkillMd(raw: string): { description: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? raw).trim();
  const description =
    frontmatter
      .split("\n")
      .find((line) => line.startsWith("description:"))
      ?.slice("description:".length)
      .trim() ?? "";
  return { description, body };
}

/**
 * Discovers every `.apm/skills/<name>/SKILL.md` in THIS repo (the one
 * `local-mcp-server` itself lives in) — not the sandboxed project the server
 * currently happens to be pointed at. Returns an empty array (not an error)
 * if `.apm/skills` doesn't exist.
 *
 * Exported so other tools (e.g. `review.ts`'s review-context tool) can look
 * up and apply a specific skill by name without duplicating this logic.
 */
export function loadApmSkills(): ApmSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(APM_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const skills: ApmSkill[] = [];
  for (const name of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(APM_SKILLS_DIR, name, "SKILL.md"), "utf-8");
    } catch {
      continue; // not a real skill folder (no SKILL.md) — skip
    }
    const { description, body } = parseSkillMd(raw);
    skills.push({ name, description, body, references: listReferenceFiles(name) });
  }
  return skills;
}

/** Lists `<skill>/references/*.md` file names (not full paths), sorted. Empty array if the dir doesn't exist. */
function listReferenceFiles(skillName: string): string[] {
  try {
    return readdirSync(join(APM_SKILLS_DIR, skillName, "references"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function formatSkillsList(skills: ApmSkill[]): string {
  if (skills.length === 0) {
    return `No skills found under .apm/skills in the local-mcp-server repo.`;
  }
  const lines = skills.map((s) => {
    const refsNote = s.references.length > 0 ? ` [references: ${s.references.join(", ")}]` : "";
    return `- ${s.name}: ${s.description || "(no description)"}${refsNote}`;
  });
  return (
    `Skills bundled with local-mcp-server (.apm/skills in its own repo):\n\n${lines.join("\n")}\n\n` +
    `Call get_context({ symbol: "<skill-name>" }) to read a specific skill's full instructions. ` +
    `If a skill lists references above, call get_context({ symbol: "<skill-name>/references/<file>" }) ` +
    `to read one (e.g. "expert-senior-developer/references/typescript.md").`
  );
}

/** Matches "<skill-name>/references/<file>", capturing the skill name and file name. */
const REFERENCE_SYMBOL_PATTERN = /^([^/]+)\/references\/([^/]+)$/;

export function getContext(symbol: string | undefined): string {
  if (!symbol) return loadPrompt("default.md");

  if (symbol === "skills") {
    return formatSkillsList(loadApmSkills());
  }

  const referenceMatch = symbol.match(REFERENCE_SYMBOL_PATTERN);
  if (referenceMatch) {
    const [, skillName, fileName] = referenceMatch;
    return loadSkillReference(skillName!, fileName!);
  }

  const skills = loadApmSkills();
  const skill = skills.find((s) => s.name === symbol);
  if (skill) {
    const refsNote =
      skill.references.length > 0
        ? `\n\n---\nReferences for this skill (fetch with get_context({ symbol: "${skill.name}/references/<file>" })): ` +
          skill.references.join(", ")
        : "";
    return skill.body + refsNote;
  }

  const available = skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)";
  return (
    `No context entry for "${symbol}" — only the default guideline (no symbol), "skills" (list the ` +
    `skills bundled with local-mcp-server), individual skill names, and "<skill-name>/references/<file>" ` +
    `are implemented so far. Skills available here: ${available}. ` +
    `Fall back to list_dir/search_files/find_files to explore directly.`
  );
}

/** Reads one `<skill-name>/references/<file>` file verbatim, or an error string listing what's actually there. */
function loadSkillReference(skillName: string, fileName: string): string {
  const skills = loadApmSkills();
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) {
    const available = skills.length > 0 ? skills.map((s) => s.name).join(", ") : "(none)";
    return `No skill named "${skillName}". Skills available here: ${available}.`;
  }
  if (!skill.references.includes(fileName)) {
    const available = skill.references.length > 0 ? skill.references.join(", ") : "(none)";
    return `Skill "${skillName}" has no reference file "${fileName}". References it does have: ${available}.`;
  }
  try {
    return readFileSync(join(APM_SKILLS_DIR, skillName, "references", fileName), "utf-8").trim();
  } catch (err) {
    return `Could not read ${skillName}/references/${fileName}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
