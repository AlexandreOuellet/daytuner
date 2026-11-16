# Deploying DayTuner

One container runs the web interface, its API and the daily scheduler, with one SQLite file on a volume.

## The image

Each version is published to GitHub's container registry for `linux/amd64` and `linux/arm64`:

```
docker pull ghcr.io/alexandreouellet/daytuner:1.0.0-rc.1
```

Tags: the exact version (`1.0.0`, `1.0.0-rc.1`), `1.0` and `1` for final releases, `latest` for the newest final release (never
an RC), and `sha-<commit>`. Pin an exact version for anything you rely on. To build it yourself instead, see [`build.md`](build.md).

DayTuner is a companion to a [Tunarr](https://github.com/chrisbenincasa/tunarr) server: it reads Tunarr's library and writes
channel lineups to it over Tunarr's HTTP API. It needs to reach Tunarr, and nothing else needs to reach DayTuner except you.

## Docker

```
docker run -d --name daytuner -p 127.0.0.1:8420:8420 -v daytuner:/config \
  -e TUNARR_URL=http://tunarr:8000 -e TZ=America/Toronto ghcr.io/alexandreouellet/daytuner:1.0.0-rc.1
```

Or with Compose:

```yaml
services:
  daytuner:
    image: ghcr.io/alexandreouellet/daytuner:1.0.0-rc.1
    restart: unless-stopped
    ports: ["127.0.0.1:8420:8420"]
    volumes: ["daytuner:/config"]
    environment:
      TUNARR_URL: http://tunarr:8000
      TZ: America/Toronto
volumes:
  daytuner:
```

Open <http://127.0.0.1:8420>. Every setting is in [`configure.md`](configure.md).

## Put authentication in front of it

**DayTuner has no login of its own.** Anyone who can reach its port can change your schedules and, once writing is switched on,
your Tunarr lineups. Do one of these:

- publish the port only to yourself (`127.0.0.1:8420`, as above), or a private network;
- or put it behind a reverse proxy that authenticates users (Authelia, Authentik, oauth2-proxy, Caddy or nginx with basic auth, and
  so on), and do not expose the container's port any other way.

The health check, `GET /api/health`, answers without touching Tunarr and is safe to leave open for an orchestrator.

## Kubernetes

[`deploy/kubernetes.example.yaml`](../deploy/kubernetes.example.yaml) has a volume, a deployment and a service. Notes:

- **One replica only.** The SQLite file has one owner. Use the `Recreate` strategy.
- The process runs as a non-root user, so give the pod `securityContext: { fsGroup: 1000 }` or the volume will not be writable
  ("unable to open database file").
- The example has no ingress. Exposing it, with authentication in front, is part of your cluster's own configuration.
- Memory: about 1 GiB is plenty for a large library.

## Writing to Tunarr

Writing is **off** until you set `DAYTUNER_ALLOW_WRITES=1`. Until then DayTuner plans, previews and edits staging, and cannot write.
Turn it on only once you trust a plan, or against a copy of your Tunarr first: it appends to a channel's lineup and an appended
lineup cannot be undone (a schedule can be rolled back, and the lineup re-planned from the new revision, but what was written stays).
With writing on, each channel runs daily (see [`configure.md`](configure.md)), and missed runs are made up after a restart.

## Ad and filler clips

DayTuner never opens a clip file. It reads Tunarr's filler lists (names, clip ids, lengths) over the API and writes lineup items
that point at those clips. **Tunarr** has to be able to play them: the folder holding your ad and filler clips must be mounted into
the Tunarr container at the path its filler list uses. DayTuner needs no setting for it. Without that mount, a schedule and its
guide are right and the programs play, but each break fails to play its clips (the timeline carries on and the next program
starts on time).

## Backups and updates

All state (shows' places, schedule revisions, staged slots, the commit log, cached chapters) is in `/config/daytuner.db`: back
that file up. The image holds no state: pull or build a new one and restart; an older database is upgraded when it opens.
