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
          totalCount
          nodes {
            name
          }
        }
        timelineItems(last: 100, itemTypes: [LABELED_EVENT]) {
          nodes {
            ... on LabeledEvent {
              createdAt
              label {
                name
              }
            }
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
    totalCount: number;
    nodes: Array<{
      name: string;
    }>;
  };
  timelineItems: {
    nodes: Array<{
      createdAt: string;
      label: {
        name: string;
      } | null;
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
  staleLabel: string,
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
      const labels = pullRequest.labels.nodes.map(({ name }) => name);
      const hasStaleLabel =
        labels.includes(staleLabel) ||
        (pullRequest.labels.totalCount > labels.length &&
          (await hasPullRequestLabel(
            octokit,
            headers,
            repo,
            pullRequest.number,
            staleLabel,
          )));
      yield {
        number: pullRequest.number,
        updatedAt: Date.parse(pullRequest.updatedAt),
        baseRefName: pullRequest.baseRefName,
        hasStaleLabel,
        staleLabelAppliedAt: findLatestLabelEvent(
          pullRequest.timelineItems.nodes,
          staleLabel,
        ),
      };
    }

    if (!pageInfo.hasNextPage) {
      return;
    }
    after = pageInfo.endCursor;
  }
}

async function hasPullRequestLabel(
  octokit: Octokit,
  headers: Record<string, string>,
  repo: Repo,
  pullNumber: number,
  label: string,
): Promise<boolean> {
  for (let page = 1; ; page++) {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        headers,
        ...repo,
        issue_number: pullNumber,
        page,
        per_page: 100,
      },
    );
    if (data.some(({ name }) => name === label)) {
      return true;
    }
    if (data.length < 100) {
      return false;
    }
  }
}

function findLatestLabelEvent(
  events: PullRequestNode["timelineItems"]["nodes"],
  label: string,
): number | null {
  return events.reduce<number | null>((latest, event) => {
    if (event.label?.name !== label) {
      return latest;
    }
    const eventTime = Date.parse(event.createdAt);
    return latest === null || eventTime > latest ? eventTime : latest;
  }, null);
}
