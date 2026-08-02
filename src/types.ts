export type Branch = {
  date: number;
  branchName: string;
  prefix: string;
  commitId: string;
  openPullRequestNumbers: number[];
  hasMoreOpenPullRequests: boolean;
  author: {
    username: string | null;
    email: string | null;
    belongsToOrganization: boolean;
  } | null;
  isProtected: boolean;
};

export type Repo = {
  repo: string;
  owner: string;
};

export type PullRequest = {
  number: number;
  updatedAt: number;
  baseRefName: string;
  labels: string[];
};

export type Params = {
  githubToken?: string;
  isDryRun: boolean;
  daysBeforeBranchStale: number;
  daysBeforeBranchDelete: number;
  staleCommentMessage: string;
  selectedBranchesRegex?: string;
  protectedBranchesRegex?: string;
  protectedAuthorsRegex?: string;
  protectedOrganizationName?: string;
  exemptProtectedBranches: boolean;
  operationsPerRun: number;
  operationDelayMs: number;
  secondaryRateLimitRetries: number;
  secondaryRateLimitRetryMs: number;
  repo: Repo;
  ignoreUnknownAuthors: boolean;
  defaultRecipient: string | null;
  remapAuthors: { [key: string]: string };
  ignoreBranchesWithOpenPRs: boolean;
  closeOpenPrsBeforeBranchDelete: boolean;
  closeStalePullRequests: boolean;
  stalePullRequestLabel: string;
  pullRequestOperationsPerRun: number;
};
