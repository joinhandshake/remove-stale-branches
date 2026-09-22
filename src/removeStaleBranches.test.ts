import type { Octokit } from "@octokit/core";
import { readBranches } from "./readBranches";
import { readOpenPullRequests } from "./readPullRequests";
import { removeStaleBranches } from "./removeStaleBranches";
import type { Branch, Params } from "./types";

jest.mock("./readBranches", () => ({
  readBranches: jest.fn(),
}));

jest.mock("./readPullRequests", () => ({
  readOpenPullRequests: jest.fn(),
}));

const mockedReadBranches = readBranches as jest.MockedFunction<
  typeof readBranches
>;
const mockedReadOpenPullRequests = readOpenPullRequests as jest.MockedFunction<
  typeof readOpenPullRequests
>;

function staleBranch(branchName: string, commitId: string): Branch {
  return {
    date: Date.now() - 120 * 24 * 60 * 60 * 1000,
    branchName,
    prefix: "refs/heads/",
    commitId,
    openPullRequestNumbers: [],
    hasMoreOpenPullRequests: false,
    author: {
      username: "octocat",
      email: "octocat@example.com",
      belongsToOrganization: false,
    },
    isProtected: false,
  };
}

function params(): Params {
  return {
    isDryRun: false,
    daysBeforeBranchStale: 90,
    daysBeforeBranchDelete: 14,
    staleCommentMessage: "@{author} {branchName}",
    protectedBranchesRegex: "^(main|master)$",
    exemptProtectedBranches: true,
    operationsPerRun: 1,
    operationDelayMs: 0,
    secondaryRateLimitRetries: 0,
    secondaryRateLimitRetryMs: 60000,
    repo: {
      owner: "github",
      repo: "octocat",
    },
    ignoreUnknownAuthors: false,
    defaultRecipient: null,
    remapAuthors: {},
    ignoreBranchesWithOpenPRs: false,
    closeOpenPrsBeforeBranchDelete: false,
    closeStalePullRequests: false,
    stalePullRequestLabel: "stale",
    pullRequestOperationsPerRun: 1,
  };
}

describe("removeStaleBranches", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedReadOpenPullRequests.mockImplementation(async function* () {});
  });

  test("does not count already-marked stale branches toward operations-per-run", async () => {
    const alreadyMarkedBranch = staleBranch("already-marked", "sha-1");
    const unmarkedBranch = staleBranch("unmarked", "sha-2");

    mockedReadBranches.mockImplementation(async function* () {
      yield alreadyMarkedBranch;
      yield unmarkedBranch;
    });

    const request = jest.fn(
      async (route: string, options: { commit_sha?: string }) => {
        if (
          route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments"
        ) {
          if (options.commit_sha === "sha-1") {
            return {
              data: [
                {
                  body: "[stale:already-marked]\r\n\r\nalready marked",
                  created_at: new Date().toISOString(),
                  id: 1,
                },
              ],
            };
          }

          return { data: [] };
        }

        if (
          route === "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments"
        ) {
          return { data: { id: 2 } };
        }

        throw new Error(`unexpected request: ${route}`);
      },
    );

    await removeStaleBranches({ request } as unknown as Octokit, params());

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments",
      expect.objectContaining({
        commit_sha: "sha-2",
      }),
    );
    expect(request).not.toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.anything(),
    );
  });

  test("closes associated open PRs before deleting their stale branch", async () => {
    const branch = {
      ...staleBranch("with-open-pr", "sha-1"),
      openPullRequestNumbers: [42],
    };
    mockedReadBranches.mockImplementation(async function* () {
      yield branch;
    });

    const request = jest.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
        return {
          data: [
            {
              body: "[stale:with-open-pr]\\r\\n\\r\\nalready marked",
              created_at: new Date(
                Date.now() - 15 * 24 * 60 * 60 * 1000,
              ).toISOString(),
              id: 1,
            },
          ],
        };
      }

      return { data: {} };
    });

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeOpenPrsBeforeBranchDelete: true,
    });

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
    expect(request).toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.anything(),
    );

    const closeIndex = request.mock.calls.findIndex(
      ([route]) => route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    );
    const deleteBranchIndex = request.mock.calls.findIndex(
      ([route]) => route === "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
    );
    expect(closeIndex).toBeLessThan(deleteBranchIndex);
  });

  test("preserves the existing behavior unless PR closing is enabled", async () => {
    const branch = {
      ...staleBranch("with-open-pr", "sha-1"),
      openPullRequestNumbers: [42],
    };
    mockedReadBranches.mockImplementation(async function* () {
      yield branch;
    });

    const request = jest.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
        return {
          data: [
            {
              body: "[stale:with-open-pr]\\r\\n\\r\\nalready marked",
              created_at: new Date(
                Date.now() - 15 * 24 * 60 * 60 * 1000,
              ).toISOString(),
              id: 1,
            },
          ],
        };
      }

      return { data: {} };
    });

    await removeStaleBranches({ request } as unknown as Octokit, params());

    expect(request).not.toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.anything(),
    );
  });

  test("does not delete a branch when closing an associated PR fails", async () => {
    const branch = {
      ...staleBranch("with-open-pr", "sha-1"),
      openPullRequestNumbers: [42],
    };
    mockedReadBranches.mockImplementation(async function* () {
      yield branch;
    });

    const request = jest.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
        return {
          data: [
            {
              body: "[stale:with-open-pr]\\r\\n\\r\\nalready marked",
              created_at: new Date(
                Date.now() - 15 * 24 * 60 * 60 * 1000,
              ).toISOString(),
              id: 1,
            },
          ],
        };
      }

      if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
        throw new Error("unable to close PR");
      }

      return { data: {} };
    });

    await expect(
      removeStaleBranches({ request } as unknown as Octokit, {
        ...params(),
        closeOpenPrsBeforeBranchDelete: true,
      }),
    ).rejects.toThrow("unable to close PR");

    expect(request).not.toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.anything(),
    );
  });

  test("does not delete a branch when not all associated open PRs are returned", async () => {
    const branch = {
      ...staleBranch("many-open-prs", "sha-1"),
      hasMoreOpenPullRequests: true,
    };
    mockedReadBranches.mockImplementation(async function* () {
      yield branch;
    });

    const request = jest.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
        return {
          data: [
            {
              body: "[stale:many-open-prs]\\r\\n\\r\\nalready marked",
              created_at: new Date(
                Date.now() - 15 * 24 * 60 * 60 * 1000,
              ).toISOString(),
              id: 1,
            },
          ],
        };
      }
      return { data: {} };
    });

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeOpenPrsBeforeBranchDelete: true,
    });

    expect(request).not.toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.anything(),
    );
  });

  test("still marks a branch stale when it has more open PRs than can be closed", async () => {
    const branch = {
      ...staleBranch("many-open-prs", "sha-1"),
      hasMoreOpenPullRequests: true,
    };
    mockedReadBranches.mockImplementation(async function* () {
      yield branch;
    });

    const request = jest.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments") {
        return { data: [] };
      }
      return { data: {} };
    });

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeOpenPrsBeforeBranchDelete: true,
    });

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments",
      expect.objectContaining({ commit_sha: "sha-1" }),
    );
  });

  test("marks inactive PRs across every base branch before closing them", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
        baseRefName: "release/legacy",
        hasStaleLabel: false,
        staleLabelAppliedAt: null,
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
    });

    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      expect.objectContaining({ issue_number: 42, labels: ["stale"] }),
    );
  });

  test("does not close a PR that reappears after it was labelled in this run", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
        baseRefName: "main",
        hasStaleLabel: false,
        staleLabelAppliedAt: null,
      };
      yield {
        number: 42,
        updatedAt: Date.now(),
        baseRefName: "main",
        hasStaleLabel: true,
        staleLabelAppliedAt: Date.now(),
      };
      yield {
        number: 43,
        updatedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
        baseRefName: "main",
        hasStaleLabel: false,
        staleLabelAppliedAt: null,
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
      pullRequestOperationsPerRun: 2,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      expect.objectContaining({ issue_number: 42, labels: ["stale"] }),
    );
    expect(request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      expect.objectContaining({ issue_number: 43, labels: ["stale"] }),
    );
    expect(request).not.toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.anything(),
    );
  });

  test("closes labelled inactive PRs across every base branch", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
        baseRefName: "release/legacy",
        hasStaleLabel: true,
        staleLabelAppliedAt: null,
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
    });

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
  });

  test("removes the stale label when a PR becomes active again", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now(),
        baseRefName: "release/legacy",
        hasStaleLabel: true,
        staleLabelAppliedAt: null,
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
    });

    expect(request).toHaveBeenCalledWith(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      expect.objectContaining({ issue_number: 42, name: "stale" }),
    );
  });

  test("closes a labelled PR when adding the label was its last update", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now(),
        baseRefName: "release/legacy",
        hasStaleLabel: true,
        staleLabelAppliedAt: Date.now(),
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
    });

    expect(request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
  });

  test("does not mutate pull requests when their operations limit is zero", async () => {
    mockedReadBranches.mockImplementation(async function* () {});
    mockedReadOpenPullRequests.mockImplementation(async function* () {
      yield {
        number: 42,
        updatedAt: Date.now() - 120 * 24 * 60 * 60 * 1000,
        baseRefName: "release/legacy",
        hasStaleLabel: false,
        staleLabelAppliedAt: null,
      };
    });

    const request = jest.fn(async () => ({ data: {} }));

    await removeStaleBranches({ request } as unknown as Octokit, {
      ...params(),
      closeStalePullRequests: true,
      pullRequestOperationsPerRun: 0,
    });

    expect(request).not.toHaveBeenCalled();
  });
});
