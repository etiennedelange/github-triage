// GraphQL fragments shared by the inbox query (Next server) and the Hub Durable Object's
// single-item refetches, so both parse into exactly the same shapes via `@/lib/triage`.

const ITEM_FIELDS = `
  number title url createdAt updatedAt state
  author { login }
  repository { nameWithOwner isArchived }
  labels(first: 5) { nodes { name color } }
  comments { totalCount }`;

export const ITEM_FRAGMENTS = `
fragment PR on PullRequest {
  __typename ${ITEM_FIELDS}
  isDraft reviewDecision mergeable additions deletions
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } }
  }
}
fragment Issue on Issue {
  __typename ${ITEM_FIELDS}
  assignees(first: 3) { nodes { login } }
}`;
