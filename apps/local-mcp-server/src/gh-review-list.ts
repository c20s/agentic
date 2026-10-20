import { z } from "zod";
import { getReviewList, renderReviewList } from "gh-review-list";
import type { ToolDefinition } from "./tools";

const ghReviewListSchema = z.object({
  refresh: z
    .boolean()
    .optional()
    .describe("Bypass the on-disk cache and re-fetch everything from GitHub via `gh`."),
  json: z
    .boolean()
    .optional()
    .describe("Return raw structured JSON instead of the rendered table."),
});

export const ghReviewListTool: ToolDefinition<typeof ghReviewListSchema> = {
  name: "gh_review_list",
  description:
    "Lists open GitHub PRs that need attention: your own (assigned + review-requested) and your " +
    "team's (for review), enriched with review/comment status and priority. Backed by the `gh` CLI " +
    "and cached on disk (see ~/.config/c20s/prs.json for config, cacheTtlSeconds for TTL). " +
    "Pass refresh:true to force a re-fetch.",
  inputSchema: ghReviewListSchema,
  handler: async ({ refresh, json }) => {
    const result = await getReviewList({ refresh });
    if (json) return JSON.stringify(result, null, 2);
    return renderReviewList(result);
  },
};
