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
