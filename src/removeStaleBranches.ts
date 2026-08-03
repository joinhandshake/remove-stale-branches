import * as core from "@actions/core";
import type { Octokit } from "@octokit/core";
import { addDays } from "date-fns";
import { formatISO } from "date-fns/formatISO";
import { subDays } from "date-fns/subDays";
import { TaggedCommitComments } from "./commitComments";
import { readBranches } from "./readBranches";
import { readOpenPullRequests } from "./readPullRequests";
import type { Branch, Params, PullRequest } from "./types";

type BranchFilters = {
  staleCutoff: number;
  authorsRegex: RegExp | null;
  allowedBranchesRegex: RegExp | null;
  deniedBranchesRegex: RegExp | null;
  removeCutoff: number;
  exemptProtectedBranches: boolean;
};

type GitHubRequestError = {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | number | undefined>;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSecondaryRateLimitError(error: unknown): boolean {
  const requestError = error as GitHubRequestError;
  const message = requestError.message?.toLowerCase() ?? "";
  return (
    (requestError.status === 403 || requestError.status === 429) &&
    message.includes("secondary rate limit")
  );
}

function getRetryAfterMs(error: unknown): number | null {
  const requestError = error as GitHubRequestError;
  const retryAfterHeader = requestError.response?.headers?.["retry-after"];
  if (retryAfterHeader === undefined) {
    return null;
  }

  const retryAfterSeconds = Number.parseInt(String(retryAfterHeader), 10);
  if (Number.isNaN(retryAfterSeconds) || retryAfterSeconds < 0) {
    return null;
  }

  return retryAfterSeconds * 1000;
}

async function waitAfterWriteOperation(params: Params): Promise<void> {
  if (params.operationDelayMs <= 0) {
    return;
  }

  console.log(
    `-> waiting ${params.operationDelayMs}ms before the next write operation`,
  );
  await sleep(params.operationDelayMs);
}

async function runWriteOperation<T>(
  params: Params,
  operation: () => Promise<T>,
): Promise<T> {
  let retries = 0;

  while (true) {
    try {
      const result = await operation();
      await waitAfterWriteOperation(params);
      return result;
    } catch (error) {
      if (
        !isSecondaryRateLimitError(error) ||
        retries >= params.secondaryRateLimitRetries
      ) {
        throw error;
      }

      retries++;
      const retryDelayMs =
        getRetryAfterMs(error) ?? params.secondaryRateLimitRetryMs;
      console.log(
        `-> hit a secondary rate limit, retrying in ${retryDelayMs}ms (${retries}/${params.secondaryRateLimitRetries})`,
      );
      await sleep(retryDelayMs);
    }
  }
}

async function processBranch(
  plan: Plan,
  branch: Branch,
  commitComments: TaggedCommitComments,
  params: Params,
) {
  console.log(
    `-> branch was last updated by ${
      branch.author?.username || branch.author?.email || "(unknown user)"
    } on ${formatISO(branch.date)}`,
  );

  if (plan.action === "skip") {
    console.log(plan.reason);
    return;
  }

  if (plan.action === "mark stale") {
    let author = "";
    console.log(`-> branch will be removed on ${formatISO(plan.cutoffTime)}`);
    if (!branch.author?.username) {
      author = params.defaultRecipient || "";
    } else if (params.remapAuthors[branch.author.username]) {
      author = params.remapAuthors[branch.author.username];
    } else {
      author = branch.author.username;
    }
    console.log(`-> marking branch as stale (notifying: ${author})`);

    if (params.isDryRun) {
      console.log("-> (doing nothing because of dry run flag)");
      return;
    }

    const commentTag = `stale:${branch.branchName}`;
    return await runWriteOperation(params, () =>
      commitComments.addCommitComments({
        commentTag,
        commitSHA: branch.commitId,
        commentBody: TaggedCommitComments.formatCommentMessage(
          params.staleCommentMessage,
          branch,
          params,
          params.repo,
          author,
        ),
      }),
    );
  }

  console.log(
    `-> branch was marked stale on ${formatISO(plan.lastCommentTime)}`,
  );

  if (plan.action === "keep stale") {
    console.log(`-> branch will be removed on ${formatISO(plan.cutoffTime)}`);
    return;
  }

  if (plan.action === "remove") {
    console.log(
      `-> branch was slated for deletion on ${formatISO(plan.cutoffTime)}`,
    );
    if (
      params.closeOpenPrsBeforeBranchDelete &&
      branch.openPullRequestNumbers.length > 0
    ) {
      console.log(
        `-> closing ${branch.openPullRequestNumbers.length} associated open PR(s) before removing branch`,
      );
    }
    console.log("-> removing branch");
    if (params.isDryRun) {
      console.log("-> (doing nothing because of dry run flag)");
      return;
    }

    if (params.closeOpenPrsBeforeBranchDelete) {
      for (const pullNumber of branch.openPullRequestNumbers) {
        await runWriteOperation(params, () =>
          commitComments.closePullRequest(pullNumber),
        );
      }
    }

    await runWriteOperation(params, () => commitComments.deleteBranch(branch));

    for (const comment of plan.comments) {
      await runWriteOperation(params, () =>
        commitComments.deleteCommitComments({ commentId: comment.id }),
      );
    }
  }
}

type Plan =
  | { action: "skip"; reason: string }
  | { action: "mark stale"; cutoffTime: number }
  | { action: "keep stale"; lastCommentTime: number; cutoffTime: number }
  | {
      action: "remove";
      lastCommentTime: number;
      cutoffTime: number;
      comments: Comment[];
    };

export function countsTowardOperationsLimit(plan: Plan): boolean {
  return plan.action === "mark stale" || plan.action === "remove";
}

function skip(reason: string): Plan {
  return {
    action: "skip",
    reason: reason,
  };
}

type Comment = { created_at: string; id: number };

type PullRequestPlan = "skip" | "mark stale" | "clear stale" | "close";

const STALE_LABEL_UPDATE_GRACE_MS = 60_000;

function planPullRequestAction(
  pullRequest: PullRequest,
  staleCutoff: number,
): PullRequestPlan {
  if (!pullRequest.hasStaleLabel) {
    return pullRequest.updatedAt >= staleCutoff ? "skip" : "mark stale";
  }

  if (
    pullRequest.updatedAt < staleCutoff ||
    (pullRequest.staleLabelAppliedAt !== null &&
      pullRequest.updatedAt <=
        pullRequest.staleLabelAppliedAt + STALE_LABEL_UPDATE_GRACE_MS)
  ) {
    return "close";
  }

  return "clear stale";
}

async function processStalePullRequests(
  octokit: Octokit,
  headers: Record<string, string>,
  repo: Params["repo"],
  staleCutoff: number,
  commitComments: TaggedCommitComments,
  params: Params,
): Promise<void> {
  if (!params.closeStalePullRequests) {
    return;
  }
  if (params.pullRequestOperationsPerRun === 0) {
    console.log(
      "Skipping stale pull request processing: operations limit is 0",
    );
    return;
  }

  let mutatedPullRequests = 0;
  for await (const pullRequest of readOpenPullRequests(
    octokit,
    headers,
    repo,
    params.stalePullRequestLabel,
  )) {
    const plan = planPullRequestAction(pullRequest, staleCutoff);
    if (plan === "skip") {
      continue;
    }

    const action =
      plan === "close"
        ? "closing"
        : plan === "clear stale"
          ? "removing stale label from"
          : "marking as stale";
    console.log(
      `-> ${action} PR #${pullRequest.number} targeting ${pullRequest.baseRefName}`,
    );
    if (!params.isDryRun) {
      if (plan === "close") {
        await runWriteOperation(params, () =>
          commitComments.closePullRequest(pullRequest.number),
        );
      } else if (plan === "clear stale") {
        await runWriteOperation(params, () =>
          commitComments.removePullRequestLabel(
            pullRequest.number,
            params.stalePullRequestLabel,
          ),
        );
      } else {
        await runWriteOperation(params, () =>
          commitComments.addPullRequestLabel(
            pullRequest.number,
            params.stalePullRequestLabel,
          ),
        );
      }
    }

    mutatedPullRequests++;
    if (mutatedPullRequests >= params.pullRequestOperationsPerRun) {
      console.log(
        `Stopping after ${mutatedPullRequests} mutated pull requests`,
      );
      return;
    }
  }
}

async function getCommitCommentsForBranch(
  commitComments: TaggedCommitComments,
  branch: Branch,
): Promise<Comment[]> {
  const commentTag = `stale:${branch.branchName}`;
  return await commitComments.getCommitCommentsWithTag({
    commentTag,
    commitSHA: branch.commitId,
  });
}

async function planBranchAction(
  now: number,
  branch: Branch,
  filters: BranchFilters,
  commitComments: TaggedCommitComments,
  params: Params,
): Promise<Plan> {
  if (
    branch.author &&
    params.protectedOrganizationName &&
    branch.author.belongsToOrganization
  ) {
    return skip(
      `author ${branch.author.username} belongs to protected organization ${params.protectedOrganizationName}`,
    );
  }
  if (!branch.author?.username && !params.ignoreUnknownAuthors) {
    return skip(
      `unable to determine username of author for branch ${branch.branchName}`,
    );
  }

  if (
    branch.openPullRequestNumbers.length > 0 &&
    params.ignoreBranchesWithOpenPRs
  ) {
    return skip(`branch ${branch.branchName} has open PRs`);
  }

  if (
    filters.authorsRegex &&
    branch.author?.username &&
    filters.authorsRegex.test(branch.author.username)
  ) {
    return skip(`author ${branch.author.username} is exempted`);
  }

  if (
    filters.allowedBranchesRegex &&
    !filters.allowedBranchesRegex.test(branch.branchName)
  ) {
    return skip(`branch ${branch.branchName} is outside of branch selection`);
  }
  if (filters.deniedBranchesRegex?.test(branch.branchName)) {
    return skip(`branch ${branch.branchName} is exempted`);
  }

  if (filters.exemptProtectedBranches && branch.isProtected) {
    return skip(`branch ${branch.branchName} is protected`);
  }

  if (branch.date >= filters.staleCutoff) {
    return skip(
      `branch ${branch.branchName} was updated recently (${formatISO(
        branch.date,
      )})`,
    );
  }

  const comments = await getCommitCommentsForBranch(commitComments, branch);
  if (comments.length === 0 && params.daysBeforeBranchDelete !== 0) {
    return {
      action: "mark stale",
      cutoffTime: addDays(now, params.daysBeforeBranchDelete).getTime(),
    };
  }

  const latestStaleComment = comments.reduce((latestDate, comment) => {
    const commentDate = Date.parse(comment.created_at);
    return Math.max(commentDate, latestDate);
  }, 0);

  const cutoffTime = addDays(
    latestStaleComment,
    params.daysBeforeBranchDelete,
  ).getTime();
  if (latestStaleComment >= filters.removeCutoff) {
    return {
      action: "keep stale",
      cutoffTime,
      lastCommentTime: latestStaleComment,
    };
  }

  const removalPlan: Plan = {
    action: "remove",
    comments,
    cutoffTime,
    lastCommentTime: latestStaleComment,
  };
  if (params.closeOpenPrsBeforeBranchDelete && branch.hasMoreOpenPullRequests) {
    return skip(
      `branch ${branch.branchName} has more associated open PRs than can be closed safely in one run`,
    );
  }

  return removalPlan;
}

function logActionRunConfiguration(
  params: Params,
  staleCutoff: number,
  removeCutoff: number,
) {
  if (params.isDryRun) {
    console.log("Running in dry-run mode. No branch will be removed.");
  }

  console.log(
    `Branches updated before ${formatISO(staleCutoff)} will be marked as stale`,
  );

  if (params.daysBeforeBranchDelete === 0) {
    console.log(
      "Branches will be instantly removed due to days-before-branch-delete being set to 0.",
    );
  } else {
    console.log(
      `Branches marked stale before ${formatISO(removeCutoff)} will be removed`,
    );
  }
}

export async function removeStaleBranches(
  octokit: Octokit,
  params: Params,
): Promise<void> {
  const headers: { [key: string]: string } = params.githubToken
    ? {
        "Content-Type": "application/json",
        Authorization: `bearer ${params.githubToken}`,
      }
    : {};

  const now = new Date();
  const staleCutoff = subDays(now, params.daysBeforeBranchStale).getTime();
  const removeCutoff = subDays(now, params.daysBeforeBranchDelete).getTime();
  const authorsRegex = params.protectedAuthorsRegex
    ? new RegExp(params.protectedAuthorsRegex)
    : null;
  const allowedBranchesRegex = params.selectedBranchesRegex
    ? new RegExp(params.selectedBranchesRegex)
    : null;
  const deniedBranchesRegex = params.protectedBranchesRegex
    ? new RegExp(params.protectedBranchesRegex)
    : null;
  const repo = params.repo;

  const filters: BranchFilters = {
    staleCutoff,
    authorsRegex,
    allowedBranchesRegex,
    deniedBranchesRegex,
    removeCutoff,
    exemptProtectedBranches: params.exemptProtectedBranches,
  };
  const commitComments = new TaggedCommitComments(repo, octokit, headers);
  let mutatedBranches = 0;
  const summary: Record<Plan["action"], number> & { scanned: number } = {
    remove: 0,
    "mark stale": 0,
    "keep stale": 0,
    skip: 0,
    scanned: 0,
  };

  if (params.ignoreUnknownAuthors && !params.defaultRecipient) {
    console.error(
      "When ignoring unknown authors, you must specify a default recipient",
    );
    return;
  }

  logActionRunConfiguration(params, staleCutoff, removeCutoff);

  const icons: Record<Plan["action"], string> = {
    remove: "❌",
    "mark stale": "⚰️",
    "keep stale": "😐",
    skip: "✅",
  } as const;

  for await (const branch of readBranches(
    octokit,
    headers,
    repo,
    params.protectedOrganizationName,
  )) {
    summary.scanned++;
    const plan = await planBranchAction(
      now.getTime(),
      branch,
      filters,
      commitComments,
      params,
    );
    summary[plan.action]++;
    core.startGroup(`${icons[plan.action]} branch ${branch.branchName}`);
    try {
      await processBranch(plan, branch, commitComments, params);

      if (countsTowardOperationsLimit(plan)) {
        mutatedBranches++;
      }
    } finally {
      core.endGroup();
    }

    if (mutatedBranches >= params.operationsPerRun) {
      console.log(`Stopping after ${mutatedBranches} mutated branches`);
      break;
    }
  }

  await processStalePullRequests(
    octokit,
    headers,
    repo,
    staleCutoff,
    commitComments,
    params,
  );

  const actionSummary = [
    `${summary.scanned} scanned`,
    `${icons.skip} ${summary.skip} skipped`,
    `${icons["mark stale"]} ${summary["mark stale"]} marked stale`,
    `${icons["keep stale"]} ${summary["keep stale"]} kept stale`,
    `${icons.remove} ${summary.remove} removed`,
  ].join(", ");
  console.log(`Summary:  ${actionSummary}`);
}
