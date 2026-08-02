import * as core from "@actions/core";
import * as github from "@actions/github";
import { removeStaleBranches } from "./removeStaleBranches";

function getNonNegativeIntegerInput(inputName: string): number {
  const value = Number.parseInt(
    core.getInput(inputName, { required: false }),
    10,
  );

  if (Number.isNaN(value) || value < 0) {
    throw new Error(`${inputName} must be a non-negative integer`);
  }

  return value;
}

async function run(): Promise<void> {
  const githubToken = core.getInput("github-token", { required: true });
  const octokit = github.getOctokit(githubToken);
  const isDryRun = core.getBooleanInput("dry-run", { required: false });
  const repositoryInput = core.getInput("repository", { required: false });
  const repo = repositoryInput
    ? {
        owner: repositoryInput.split("/")[0],
        repo: repositoryInput.split("/")[1],
      }
    : github.context.repo;
  const protectedOrganizationName = core.getInput("exempt-organization", {
    required: false,
  });
  const selectedBranchesRegex = core.getInput("restrict-branches-regex", {
    required: false,
  });
  const protectedBranchesRegex = core.getInput("exempt-branches-regex", {
    required: false,
  });
  const protectedAuthorsRegex = core.getInput("exempt-authors-regex", {
    required: false,
  });
  const exemptProtectedBranches = core.getBooleanInput(
    "exempt-protected-branches",
    {
      required: false,
    },
  );
  const staleCommentMessage = core.getInput("stale-branch-message", {
    required: false,
  });
  const daysBeforeBranchStale = Number.parseInt(
    core.getInput("days-before-branch-stale", { required: false }),
    10,
  );
  const daysBeforeBranchDelete = Number.parseInt(
    core.getInput("days-before-branch-delete", { required: false }),
    10,
  );
  const operationsPerRun = Number.parseInt(
    core.getInput("operations-per-run", { required: false }),
    10,
  );
  const operationDelayMs = getNonNegativeIntegerInput("operation-delay-ms");
  const secondaryRateLimitRetries = getNonNegativeIntegerInput(
    "secondary-rate-limit-retries",
  );
  const secondaryRateLimitRetryMs = getNonNegativeIntegerInput(
    "secondary-rate-limit-retry-ms",
  );

  const defaultRecipient =
    core.getInput("default-recipient", { required: false }) ?? "";

  const remapAuthorsInput = core.getInput("remap-authors", { required: false });
  const remapAuthors = remapAuthorsInput ? JSON.parse(remapAuthorsInput) : {};
  if (
    !remapAuthors ||
    Array.isArray(remapAuthors) ||
    typeof remapAuthors !== "object"
  ) {
    throw new Error("unexpected input: remap-authors is not a json object");
  }

  const ignoreUnknownAuthors = core.getBooleanInput("ignore-unknown-authors", {
    required: false,
  });

  const ignoreBranchesWithOpenPRs = core.getBooleanInput(
    "ignore-branches-with-open-prs",
    { required: false },
  );
  const closeOpenPrsBeforeBranchDelete = core.getBooleanInput(
    "close-open-prs-before-branch-delete",
    { required: false },
  );
  const closeStalePullRequests = core.getBooleanInput(
    "close-stale-pull-requests",
    { required: false },
  );
  const stalePullRequestLabel = core.getInput("stale-pull-request-label", {
    required: false,
  });
  const pullRequestOperationsPerRun = getNonNegativeIntegerInput(
    "pull-request-operations-per-run",
  );

  return removeStaleBranches(octokit, {
    isDryRun,
    repo,
    daysBeforeBranchStale,
    daysBeforeBranchDelete,
    staleCommentMessage,
    selectedBranchesRegex,
    protectedBranchesRegex,
    protectedAuthorsRegex,
    protectedOrganizationName,
    exemptProtectedBranches,
    operationsPerRun,
    operationDelayMs,
    secondaryRateLimitRetries,
    secondaryRateLimitRetryMs,
    defaultRecipient,
    remapAuthors,
    ignoreUnknownAuthors,
    ignoreBranchesWithOpenPRs,
    closeOpenPrsBeforeBranchDelete,
    closeStalePullRequests,
    stalePullRequestLabel,
    pullRequestOperationsPerRun,
  });
}

run();
