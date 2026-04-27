# Operating guide — SSH preview deploy

> Setup steps for the consumer's box that hosts mockup preview deploys, used by `slowcook preview deploy/teardown` and the `slowcook-preview-deploy.yml` / `slowcook-preview-teardown.yml` workflows. Ships in slowcook 0.16-α.5.

Slowcook is **stateless** with respect to hosting. Every consumer provides their own SSH-reachable box; slowcook ships the CLI tooling that talks to it. This document is the box-side recipe.

If you don't want to run a preview box at all, the mock app is also runnable locally: `cd mock && npm run dev` after `slowcook init mock`. The preview deploy is an ergonomic addition for PMs reviewing mockup PRs without needing to checkout branches.

## What you get

When the workflow runs on a `slowcook-mockup` PR:

1. The CI runner SSHes into your box.
2. Builds the mock app's Docker image remotely.
3. Picks a free port from the configured range.
4. Runs the container with `--restart unless-stopped`.
5. Posts a comment on the PR with the live URL.

When the PR closes, the teardown workflow stops + removes the container and cleans up the staging directory.

## Pre-requisites on the box

| Component | Purpose |
|---|---|
| **Docker engine** | Builds + runs the mock app's container per PR |
| **A non-root deploy user in the `docker` group** | The user CI SSHes in as |
| **A reverse proxy with wildcard subdomain TLS** | Maps the URL pattern in `url_template` to the container's host port |
| **A wildcard DNS record** | E.g. `*.preview.example.com` → box IP |

A Caddy config is the easiest way to satisfy the reverse proxy + wildcard cert requirements, because Caddy auto-provisions Let's Encrypt certs for any domain you mention. nginx + certbot also works but is more setup.

## Step-by-step setup

### 1. Provision a deploy user

```bash
sudo useradd -m -s /bin/bash slowcook-deploy
sudo usermod -aG docker slowcook-deploy
sudo mkdir -p /opt/slowcook-preview
sudo chown slowcook-deploy:slowcook-deploy /opt/slowcook-preview
```

### 2. Generate an SSH key pair (run on a workstation, NOT the box)

```bash
ssh-keygen -t ed25519 -f slowcook-preview-key -N "" -C "slowcook-preview"
# Two files:
#   slowcook-preview-key       (private — keep on workstation, paste into GitHub secret)
#   slowcook-preview-key.pub   (public  — copy to the box)
```

Append the public key to the deploy user's `authorized_keys` on the box:

```bash
# on the box:
sudo -u slowcook-deploy mkdir -p ~slowcook-deploy/.ssh
sudo -u slowcook-deploy chmod 700 ~slowcook-deploy/.ssh
sudo -u slowcook-deploy tee -a ~slowcook-deploy/.ssh/authorized_keys < /tmp/slowcook-preview-key.pub
sudo -u slowcook-deploy chmod 600 ~slowcook-deploy/.ssh/authorized_keys
```

Verify connectivity from your workstation:

```bash
ssh -i slowcook-preview-key slowcook-deploy@<box-host> 'docker ps && id && ls -la /opt/slowcook-preview'
```

You should see `groups=...,docker,...` in the `id` output and an empty `/opt/slowcook-preview/`.

### 3. Add the private key as a GitHub secret

In the consumer repo's GitHub settings → Secrets and variables → Actions → New repository secret:

- **Name:** `SLOWCOOK_PREVIEW_SSH_KEY`
- **Value:** the entire contents of `slowcook-preview-key` (including the `-----BEGIN OPENSSH PRIVATE KEY-----` and trailing newline)

The workflow stages this into `~/.ssh/id_slowcook_preview` on the runner before invoking the CLI.

### 4. Run a reverse proxy with wildcard TLS

The simplest setup with [Caddy](https://caddyserver.com/) — install per the docs, then a `Caddyfile` like:

```caddyfile
*.preview.example.com {
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}   # or whatever DNS provider
  }

  @mock host_regexp ^mock-(\d+)\.preview\.example\.com$
  handle @mock {
    reverse_proxy 127.0.0.1:{re.host_regexp.1}
  }
}
```

This pattern matches `mock-4015.preview.example.com` and proxies to `127.0.0.1:4015`. With wildcard DNS pointed at the box, every mockup-PR URL the workflow generates resolves automatically; Caddy handles the cert.

If you don't want wildcard DNS, you can also use port-only URLs (e.g., `http://box.example.com:4015`) — set the `url_template` accordingly:

```yaml
url_template: "http://box.example.com:{port}"
```

This skips the reverse proxy entirely. Less polish, but valid for internal teams.

### 5. Open the port range in the firewall

Whatever port range you pick in `.brewing/preview.yaml#preview.port_range`, make sure inbound TCP is allowed on the box. With `ufw`:

```bash
sudo ufw allow 4000:4099/tcp
```

(Skip if you're going through Caddy on 443 — only the proxy port needs to be open externally.)

## Configure the consumer repo

### `.brewing/preview.yaml`

```yaml
preview:
  type: ssh
  host: box.example.com
  user: slowcook-deploy
  key_secret: SLOWCOOK_PREVIEW_SSH_KEY   # GitHub Actions secret name
  port: 22                               # SSH port (default 22)
  port_range: [4000, 4099]
  url_template: "https://mock-{port}.preview.example.com"
  remote_root: /opt/slowcook-preview
  mock_dir: mock                         # optional; default "mock"
```

| Field | Meaning |
|---|---|
| `type` | Currently must be `"ssh"`. Other deploy types may ship later. |
| `host` | The SSH hostname. Resolves via the runner's DNS. |
| `user` | The non-root deploy user (matches step 1). |
| `key_secret` | The repo-secret NAME (not value) that holds the private key. |
| `port` | SSH port. Defaults to 22. |
| `port_range` | Inclusive `[lo, hi]` Docker host ports allocated per PR. |
| `url_template` | The URL the proxy serves. Must contain literal `{port}`. |
| `remote_root` | Absolute path on the box where slowcook stages PR builds. |
| `mock_dir` | Path within the consumer's repo to the mock app. Defaults to `mock`. |

### Workflow templates

`slowcook init` (0.16+) writes:

- `.github/workflows/slowcook-preview-deploy.yml` — fires on `pull_request: [opened, reopened, synchronize, labeled]` when the PR carries the `slowcook-mockup` label.
- `.github/workflows/slowcook-preview-teardown.yml` — fires on `pull_request: [closed]`.

Both workflows expect:

- `SLOWCOOK_PREVIEW_SSH_KEY` repo secret (the deploy user's private key).
- `.brewing/preview.yaml` checked into the repo.
- The mock app present at `${preview.mock_dir}/Dockerfile` (created by `slowcook init mock`).

## Manual operations

### Trigger a deploy by hand

```bash
gh workflow run slowcook-preview-deploy.yml -F pr=<PR_NUMBER>
```

### Trigger a teardown (also frees the docker image)

```bash
gh workflow run slowcook-preview-teardown.yml -F pr=<PR_NUMBER> -F prune_image=true
```

### Inspect what's running on the box

```bash
ssh slowcook-deploy@box.example.com 'docker ps --filter label=slowcook.pr'
```

Slowcook labels every preview container with `slowcook.pr=<PR_NUMBER>` so you can grep for them without snagging unrelated containers.

### Nuke ALL stale preview containers + images (use sparingly)

```bash
ssh slowcook-deploy@box.example.com '
  docker ps -aq --filter label=slowcook.pr | xargs -r docker rm -f
  docker images -q "slowcook-mock-pr-*" | xargs -r docker rmi -f
  rm -rf /opt/slowcook-preview/pr-*
'
```

## Capacity planning

Per-PR resource ballpark:

- **Disk on box:** ~250 MB image + ~100 MB extracted source per PR.
- **RAM:** ~80 MB per running Next.js container, idle.
- **CPU:** Negligible idle; spikes on PR-update rebuilds (~30–60 s each).

A box with 4 GB RAM + 50 GB disk handles ~30 concurrent previews comfortably; anything larger should consider:

- Tighter port range (clamp concurrent count by limiting how many ports CI can grab).
- Adding `--memory 256m` to the `docker run` invocation in `deploy.ts` (would need a new `.brewing/preview.yaml` field).
- Auto-prune of containers that haven't been hit in N hours (cron + `docker ps --filter` + `docker container inspect` for last access; not yet a slowcook command).

## Troubleshooting

### "Permission denied (publickey)"

The CI runner's SSH key isn't authorized on the box. Re-check:

1. Did you paste the **whole** private key into the GitHub secret, including the trailing newline?
2. Does `~slowcook-deploy/.ssh/authorized_keys` on the box have the matching public key on a single line?
3. Is the deploy user's `~/.ssh` mode `700` and `authorized_keys` mode `600`?

Sanity check from the workstation that holds the private key:

```bash
ssh -i slowcook-preview-key -v slowcook-deploy@box.example.com 'echo ok'
```

The `-v` output names the auth methods tried — look for the line starting `Authentications that can continue:` and `Offering public key:`.

### "docker: Error response from daemon: ... permission denied"

The deploy user isn't in the `docker` group. After `usermod -aG docker slowcook-deploy`, the deploy user's existing SSH sessions still see the old groups; reconnect (or `sudo systemctl restart sshd`).

### "No free port in range 4000..4099 on <host>"

Either the port range is too narrow for your active PR count, or stale containers are squatting on ports. Run the "nuke" command above, or widen `port_range`.

### The PR comment never appears, but `docker ps` shows the container running

The CLI can't reach the GitHub API. Confirm `GITHUB_TOKEN` is in scope (it should be by default in `pull_request` workflows). Inspect the workflow logs for the `(skipped PR comment: ...)` line — that's the diagnostic.

### Caddy can't get a cert / `ERR_CERT_AUTHORITY_INVALID`

Wildcard certs from Let's Encrypt require DNS-01 challenge (Caddy can't do HTTP-01 for a wildcard). Make sure your Caddyfile's `tls` block names a DNS provider plugin and you've installed it. Common providers: `caddy-dns/cloudflare`, `caddy-dns/route53`, `caddy-dns/digitalocean`. Build a custom Caddy with the plugin via [xcaddy](https://github.com/caddyserver/xcaddy).

## Brew workflow changes for 0.16

Slowcook 0.16-α.10 gates `slowcook-brew-auto.yml` on **both** the mockup PR AND the tests PR being merged on main for the same `story-N`. When both halves arrive, it dispatches `slowcook-brew.yml` with the new `mode` input:

- **`mode: plate`** — both halves merged. Brew runs in narrow plate-mode (UI is frozen; brew writes data layer + handlers + migrations only).
- **`mode: legacy`** — only the tests PR merged + no mockup PR ever existed. Brew runs in legacy mode against the spec alone (backend-only / non-UI stories).

For plate-mode runs, `slowcook port --story <id>` must run **before** `slowcook brew` so the deterministic `mock/` → `src/` copy lands first. The recommended brew workflow snippet:

```yaml
# .github/workflows/slowcook-brew.yml — consumer-maintained.
on:
  workflow_dispatch:
    inputs:
      story_id:    { required: true,  type: string }
      budget_usd:  { required: false, type: string, default: "10" }
      max_iterations: { required: false, type: string, default: "10" }
      model:       { required: false, type: string, default: "claude-sonnet-4-6" }
      mode:        { required: false, type: string, default: "legacy" }
                   # ^^ "plate" when both halves merged; "legacy" otherwise.

jobs:
  brew:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      # ...resolve pin, setup-node, install deps...

      # NEW for 0.16-α.10 — port before brew when in plate-mode.
      - name: slowcook port (mode=plate only)
        if: github.event.inputs.mode == 'plate'
        run: npx --yes "$SLOWCOOK_CLI" port --story "${{ inputs.story_id }}"

      - name: Commit ported files
        if: github.event.inputs.mode == 'plate'
        run: |
          git config user.name "slowcook-port[bot]"
          git config user.email "slowcook-port@users.noreply.github.com"
          git add src/
          if ! git diff --cached --quiet; then
            git commit -m "port: copy mock/ → src/ for story-${{ inputs.story_id }}"
          fi

      - name: Run brew
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx --yes "$SLOWCOOK_CLI" brew \
            --story "${{ inputs.story_id }}" \
            --mode "${{ inputs.mode }}" \
            --budget-usd "${{ inputs.budget_usd }}" \
            --max-iterations "${{ inputs.max_iterations }}" \
            --model "${{ inputs.model }}"
```

Until you adopt this snippet, the `mode` input is silently ignored by older brew workflows + brew runs in its default mode. Stories without a mockup PR still work via the `mode: legacy` branch the auto-trigger picks.

## See also

- [`docs/plans/0.16-mock-app.md`](./plans/0.16-mock-app.md) — the architecture this fits into.
- `slowcook preview --help` — CLI reference.
- `slowcook port --help` — deterministic mock → src copy.
- `slowcook init mock --help` — scaffolds the mock app whose Dockerfile this guide assumes exists.
