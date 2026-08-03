import type { Octokit } from "@octokit/core";
import { readOpenPullRequests } from "./readPullRequests";

test("reads the stale label beyond the first 100 labels", async () => {
  const octokit = {
    graphql: jest.fn(async () => ({
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 42,
              updatedAt: "2026-01-01T00:00:00Z",
              baseRefName: "release/legacy",
              labels: {
                totalCount: 101,
                nodes: Array.from({ length: 100 }, (_, index) => ({
                  name: `label-${index}`,
                })),
              },
              timelineItems: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })),
    request: jest.fn(async () => ({ data: [{ name: "stale" }] })),
  } as unknown as Octokit;

  const pullRequests = [];
  for await (const pullRequest of readOpenPullRequests(
    octokit,
    {},
    { owner: "github", repo: "octocat" },
    "stale",
  )) {
    pullRequests.push(pullRequest);
  }

  expect(pullRequests).toEqual([
    expect.objectContaining({ number: 42, hasStaleLabel: true }),
  ]);
});
