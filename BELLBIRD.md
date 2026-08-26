# Bellbird Code

Bellbird Code is Bellbird's maintained product fork of
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code).

## Purpose

- provide a controlled, reproducible Bellbird Code build;
- apply Bellbird's product name and official bird mark without renaming upstream
  compatibility identifiers;
- preserve secure self-hosted access through private network boundaries;
- develop narrowly scoped fixes that can be proposed upstream when appropriate;
- keep the recovery and rollback paths independent from the application runtime.

## Branding contract

- The web sidebar presents the product as **Bellbird Code** and uses the official
  Bellbird bird mark stored in `assets/bellbird/logo-onedrive.png`.
- Sidebar-facing cloud labels use **Bellbird Connect**. Internal `T3` identifiers
  and protocol paths remain unchanged for upstream compatibility.
- Browser and PWA metadata use Bellbird-named asset URLs
  (`/bellbird-favicon*`, `/bellbird-apple-touch-icon.png`, and
  `/bellbird-mark.png`) so an upstream favicon cached under a legacy URL cannot
  survive a product upgrade.

## Branch and release policy

- `main` is the Bellbird integration branch;
- `upstream/main` is the source of upstream updates;
- product changes use short-lived branches and pull requests;
- deployments are pinned to a full commit SHA and built before installation;
- Bellbird-specific changes must include tests and operational documentation.

## Security boundaries

- Never commit credentials, pairing codes, provider state, transcripts, logs, or
  generated deployment data.
- The application backend must bind to loopback. Remote access must be provided by
  an authenticated private-network proxy; public Funnel exposure is not supported.
- Production or pilot deployment changes require an explicit backup, health check,
  and rollback path.

## Upstream synchronization

Fetch upstream changes with:

```bash
git fetch upstream
```

Review upstream changes before merging or rebasing them into a Bellbird branch.
Do not force-push the Bellbird integration branch.
