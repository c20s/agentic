import { loadConfig, CONFIG_PATH } from "./config";
import { withCache } from "./cache";
import * as gh from "./gh";
import type { Config, EnrichedPullRequest, PullRequest, ReviewListResult } from "./types";

export { loadConfig, CONFIG_PATH };
export * from "./types";

/** Bump whenever ReviewListResult's shape changes, so stale on-disk cache entries from an older
 *  version are treated as a miss instead of being handed back as-is and breaking downstream code. */
const CACHE_SCHEMA_VERSION = 3;

export interface GetReviewListOptions {
  /** Path to the config file. Defaults to ~/.config/c20s/prs.json. */
  configPath?: string;
  /** Bypass the cache and re-fetch everything from GitHub. */
  refresh?: boolean;
  /** Override cacheTtlSeconds from config (e.g. 0 to force no caching). */
  cacheTtlSeconds?: number;
}

function repoString(repository: gh.GhSearchPr["repository"]): string {
  if (typeof repository === "string") return repository;
  if (repository.nameWithOwner) return repository.nameWithOwner;
  if (repository.owner?.login) return `${repository.owner.login}/${repository.name}`;
  return repository.name;
}

function authorLogin(author: gh.GhSearchPr["author"]): string {
  return typeof author === "string" ? author : author.login;
}

function toPullRequest(raw: gh.GhSearchPr, source: PullRequest["source"]): PullRequest {
  return {
    number: raw.number,
    repository: repoString(raw.repository),
    title: raw.title,
    author: authorLogin(raw.author),
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    source,
  };
}

function dedupe(prs: PullRequest[]): PullRequest[] {
  const seen = new Map<string, PullRequest>();
  for (const pr of prs) {
    const key = `${pr.repository}#${pr.number}`;
    if (!seen.has(key)) seen.set(key, pr);
  }
  return [...seen.values()];
}

/** 1=needs re-review, 2=not yet reviewed, 3=changes requested, 4=commented but not updated, 5=approved. */
function computePriority(pr: {
  reviewDecision: string | null;
  commentedByMe: boolean;
  updatedSinceMyComment: boolean;
}): number {
  if (pr.commentedByMe && pr.updatedSinceMyComment) return 1;
  if (pr.reviewDecision === "APPROVED") return 5;
  if (pr.commentedByMe) return 4;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return 3;
  return 2;
}

async function enrich(login: string, prs: PullRequest[]): Promise<EnrichedPullRequest[]> {
  return Promise.all(
    prs.map(async (pr) => {
      const [reviewDecision, latest, comments] = await Promise.all([
        gh.viewPrReviewDecision(pr.repository, pr.number),
        gh.prLatestCommitInfo(pr.repository, pr.number),
        gh.prReviewComments(pr.repository, pr.number),
      ]);

      const myComments = comments.filter((c) => c.user.login === login);
      const commentedByMe = myComments.length > 0;
      const lastCommentAt = myComments.length
        ? Math.max(...myComments.map((c) => new Date(c.created_at).getTime()))
        : 0;
      const updatedSinceMyComment = commentedByMe && new Date(latest.updatedAt).getTime() > lastCommentAt;

      const enrichment = { reviewDecision, commentedByMe, updatedSinceMyComment };
      return {
        ...pr,
        ...enrichment,
        priority: computePriority(enrichment),
      };
    })
  );
}

function sortByNumber(prs: EnrichedPullRequest[]): EnrichedPullRequest[] {
  return [...prs].sort((a, b) => a.number - b.number);
}

function sortByAuthor(prs: EnrichedPullRequest[]): EnrichedPullRequest[] {
  return [...prs].sort((a, b) => a.author.localeCompare(b.author) || a.number - b.number);
}

/** `--archived=false` unless the config opts into including archived repos' PRs. */
function archivedArgs(config: Config): string[] {
  return config.includeArchived ? [] : ["--archived=false"];
}

async function fetchMine(config: Config): Promise<PullRequest[]> {
  const archived = archivedArgs(config);
  const [assigned, reviewRequested] = await Promise.all([
    gh.searchPrs(["--assignee", "@me", "--state", "open", ...archived]),
    gh.searchPrs(["--review-requested", "@me", "--state", "open", ...archived]),
  ]);
  return dedupe([
    ...assigned.map((p) => toPullRequest(p, "assigned")),
    ...reviewRequested.map((p) => toPullRequest(p, "review-requested")),
  ]);
}

async function fetchAuthored(config: Config): Promise<PullRequest[]> {
  const authored = await gh.searchPrs(["--author", "@me", "--state", "open", ...archivedArgs(config)]);
  return dedupe(authored.map((p) => toPullRequest(p, "authored")));
}

async function fetchTeam(config: Config, excludeLogins: Set<string>): Promise<PullRequest[]> {
  const memberLists = await Promise.all(
    config.teams.map((slug) => {
      const [org, team] = slug.split("/");
      if (!org || !team) throw new Error(`Invalid team slug "${slug}", expected "org/team".`);
      return gh.teamMembers(org, team);
    })
  );
  const authors = new Set([...memberLists.flat(), ...config.extraAuthors]);

  const repoArgs = config.repos.flatMap((r) => ["--repo", r]);
  const archived = archivedArgs(config);
  const authorSearches = [...authors].map((author) =>
    gh.searchPrs(["--author", author, "--state", "open", ...repoArgs, ...archived])
  );
  const extraSearches = config.extraSearchQueries.map((q) =>
    gh.searchPrs([...q.split(" ").filter(Boolean), "--state", "open", ...repoArgs, ...archived])
  );

  const results = await Promise.all([...authorSearches, ...extraSearches]);
  const prs = results.flat().map((p) => toPullRequest(p, "search"));
  const deduped = dedupe(prs);
  return deduped.filter((pr) => !excludeLogins.has(`${pr.repository}#${pr.number}`));
}

/**
 * Builds the full review list (mine + team), enriched with review/comment status and priority.
 * Results are cached on disk (keyed by login + config) for `cacheTtlSeconds` (from config, overridable).
 */
export async function getReviewList(options: GetReviewListOptions = {}): Promise<ReviewListResult> {
  const config = await loadConfig(options.configPath);
  const ttl = options.cacheTtlSeconds ?? config.cacheTtlSeconds;
  const login = await gh.currentUser();

  const cacheKey = JSON.stringify({ v: CACHE_SCHEMA_VERSION, login, config });
  const { value, fromCache } = await withCache(
    cacheKey,
    ttl,
    async () => {
      const [minePrs, authoredPrs] = await Promise.all([fetchMine(config), fetchAuthored(config)]);
      const [enrichedMine, enrichedAuthored] = await Promise.all([
        enrich(login, minePrs),
        enrich(login, authoredPrs),
      ]);
      const mine = sortByNumber(enrichedMine);
      const authored = sortByNumber(enrichedAuthored);

      const excludeKeys = new Set([
        ...mine.map((pr) => `${pr.repository}#${pr.number}`),
        ...authored.map((pr) => `${pr.repository}#${pr.number}`),
      ]);
      const teamPrs = await fetchTeam(config, excludeKeys);
      const team = sortByAuthor(await enrich(login, teamPrs));

      return {
        generatedAt: new Date().toISOString(),
        login,
        mine,
        authored,
        team,
      };
    },
    { refresh: options.refresh }
  );

  return { ...value, fromCache };
}
