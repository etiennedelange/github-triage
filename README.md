# GitHub Triage

An app for triaging GitHub issues and pull requests.

## Development

Open the repository in its dev container (VS Code: **Dev Containers: Clone Repository in Container Volume**). The container provides Node.js 24, pnpm via Corepack, the GitHub CLI and Claude Code. Claude's configuration lives in a per-container volume, so run `claude` once to sign in and `gh auth login` to authenticate the GitHub CLI.
