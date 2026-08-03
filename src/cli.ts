import process from "node:process";
import { Octokit } from "@octokit/core";
import { removeStaleBranches } from "./removeStaleBranches";

const octokit = new Octokit({
  options: {
    auth: process.env.GITHUB_TOKEN,
  },
});

const timer = setTimeout(() => {}, 120000);
removeStaleBranches(octokit, {
  isDryRun: true,
  daysBeforeBranchStale: 60,
  daysBeforeBranchDelete: 7,
  staleCommentMessage:
    "{author} Your branch [{branchName}]({branchUrl}) hasn't been updated in the last {daysBeforeBranchStale} days and is marked as stale. It will be removed in a week.\r\nIf you want to keep this branch around, delete this comment or add new commits to this branch.",
  protectedBranchesRegex: "^(main|master)$",
  operationsPerRun: 10,
  operationDelayMs: 0,
  secondaryRateLimitRetries: 0,
  secondaryRateLimitRetryMs: 60000,
  githubToken: process.env.GITHUB_TOKEN || "",
  exemptProtectedBranches: true,
  ignoreUnknownAuthors: false,
  defaultRecipient: null,
  repo: {
    owner: "github",
    repo: "octocat",
  },
  ignoreBranchesWithOpenPRs: false,
  closeOpenPrsBeforeBranchDelete: false,
  closeStalePullRequests: false,
  stalePullRequestLabel: "stale",
  pullRequestOperationsPerRun: 10,
  remapAuthors: {},
})
  .then(() => clearTimeout(timer))
  .catch((e) => console.log(e));
