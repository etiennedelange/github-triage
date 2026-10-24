# Security

GitHub Triage holds a GitHub token for the account it serves and receives its webhooks, so a hole in it can matter.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through [GitHub's advisory form](https://github.com/etiennedelange/github-triage/security/advisories/new) instead. Include what an attacker can do and the steps to reproduce it.

This is a one-person project, so there's no fixed response time. A confirmed issue gets fixed on `main`, and the advisory is published once the fix is deployed.

## Supported versions

Only the latest commit on `main` gets fixes. If you run your own copy, redeploy from `main` to pick up fixes.
