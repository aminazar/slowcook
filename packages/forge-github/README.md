# @slowcook-ai/forge-github

GitHub `ForgeAdapter` for slowcook. Implements the interface defined in `@slowcook-ai/core`.

## Install

```bash
npm i @slowcook-ai/forge-github
```

## Usage

```ts
import { GitHubAdapter } from "@slowcook-ai/forge-github";

const adapter = new GitHubAdapter({
  owner: "your-org",
  repo: "your-repo",
  token: process.env.GITHUB_TOKEN!,
});

const issue = await adapter.getIssue(15);
await adapter.createIssueComment(15, "slowcook is here to help.");
```

## Auth

Pass a token via the `token` option. Use a classic PAT with `repo` scope for personal use, or the `GITHUB_TOKEN` automatically provided in GitHub Actions (with `contents: write`, `issues: write`, `pull-requests: write` permissions granted to the workflow).

## Git operations

`adapter.git` provides `createBranch`, `stage`, `commit`, `push` — shells out to the local `git` binary in the process's working directory. Replace via the `git` constructor option if you need something different (e.g., isomorphic-git in a browser).

## License

MIT
