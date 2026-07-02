import { readBranches } from "./readBranches";
import { removeStaleBranches } from "./removeStaleBranches";
import { Branch, Params } from "./types";

jest.mock("./readBranches", () => ({
  readBranches: jest.fn(),
}));

const mockedReadBranches = readBranches as jest.MockedFunction<
  typeof readBranches
>;

function staleBranch(branchName: string, commitId: string): Branch {
  return {
    date: Date.now() - 120 * 24 * 60 * 60 * 1000,
    branchName,
    prefix: "refs/heads/",
    commitId,
    openPrs: true,
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
  };
}

describe("removeStaleBranches", () => {
  beforeEach(() => {
    jest.resetAllMocks();
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
          route ===
          "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments"
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
          route ===
          "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments"
        ) {
          return { data: { id: 2 } };
        }

        throw new Error(`unexpected request: ${route}`);
      },
    );

    await removeStaleBranches({ request } as any, params());

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
});
