import type { Octokit } from "@octokit/core";
import type { PullRequest, Repo } from "./types";

const GRAPHQL_QUERY = `query ($repo: String!, $owner: String!, $after: String) {
  repository(name: $repo, owner: $owner) {
    pullRequests(
      first: 100,
      after: $after,
      states: OPEN,
      orderBy: { field: UPDATED_AT, direction: ASC },
    ) {
      nodes {
        number
        updatedAt
        baseRefName
        labels(first: 100) {
          nodes {
            name
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

type PullRequestNode = {
  number: number;
  updatedAt: string;
  baseRefName: string;
  labels: {
    nodes: Array<{
      name: string;
    }>;
  };
};

type QueryResult = {
  repository: {
    pullRequests: {
      nodes: PullRequestNode[];
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
};

export async function* readOpenPullRequests(
  octokit: Octokit,
  headers: Record<string, string>,
  repo: Repo,
): AsyncGenerator<PullRequest> {
  let after: string | null = null;

  while (true) {
    const result: QueryResult = await octokit.graphql<QueryResult>(
      GRAPHQL_QUERY,
      {
        ...repo,
        after,
        headers,
      },
    );
    const pullRequests = result.repository.pullRequests;
    const { nodes, pageInfo } = pullRequests;

    for (const pullRequest of nodes) {
      yield {
        number: pullRequest.number,
        updatedAt: Date.parse(pullRequest.updatedAt),
        baseRefName: pullRequest.baseRefName,
        labels: pullRequest.labels.nodes.map(({ name }) => name),
      };
    }

    if (!pageInfo.hasNextPage) {
      return;
    }
    after = pageInfo.endCursor;
  }
}
