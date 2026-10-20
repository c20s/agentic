export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/** Why a PR landed in the list + its current state, used to compute priority/icons. */
export interface PrEnrichment {
  reviewDecision: ReviewDecision;
  /** Has the current user left a review comment on this PR at all? */
  commentedByMe: boolean;
  /** PR was updated (new commit) after the current user's last comment. */
  updatedSinceMyComment: boolean;
}

export interface PullRequest {
  number: number;
  repository: string; // "owner/repo"
  title: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Why this PR is in the list: assigned to me, requested for review, authored by me, or via a team/author search. */
  source: "assigned" | "review-requested" | "authored" | "search";
}

export interface EnrichedPullRequest extends PullRequest, PrEnrichment {
  /** 1 = needs re-review (updated after my comment), 2 = not yet reviewed, 3 = changes requested,
   *  4 = commented but not updated since, 5 = approved. Lower = more urgent. */
  priority: number;
}

export interface ReviewListResult {
  generatedAt: string;
  login: string;
  mine: EnrichedPullRequest[];
  authored: EnrichedPullRequest[];
  team: EnrichedPullRequest[];
  fromCache: boolean;
}

export interface Config {
  /** GitHub org/team slugs ("org/team") whose members' PRs should be listed, besides "mine". */
  teams: string[];
  /** Extra `gh search prs` query fragments to OR into the team/search PR list. */
  extraSearchQueries: string[];
  /** Repos to limit searches to, e.g. ["owner/repo"]. Empty = no restriction. */
  repos: string[];
  /** Individual GitHub logins whose PRs should always be included, in addition to team members. */
  extraAuthors: string[];
  /** Include PRs from archived repositories. Default false — archived repos are filtered out. */
  includeArchived: boolean;
  /** Cache time-to-live in seconds. 0 disables caching. */
  cacheTtlSeconds: number;
}

export const DEFAULT_CONFIG: Config = {
  teams: [],
  extraSearchQueries: [],
  repos: [],
  extraAuthors: [],
  includeArchived: false,
  cacheTtlSeconds: 120,
};
