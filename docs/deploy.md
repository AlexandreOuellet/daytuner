# Running DayTuner

One container runs the web interface, its API and the daily scheduler, with one SQLite file on a volume.

## Build and run

```
docker build -t daytuner .
docker run -d --name daytuner -p 127.0.0.1:8420:8420 -v daytuner:/config \
  -e TUNARR_URL=http://tunarr:8000 daytuner
```

Open <http://127.0.0.1:8420>. Settings, all environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `TUNARR_URL` | Where Tunarr is. Required. | |
| `DAYTUNER_ALLOW_WRITES` | `1` lets this container write lineups to Tunarr and run the daily scheduler. Without it DayTuner plans, previews and edits staging, and cannot write. | off |
| `DAYTUNER_DB` | The SQLite file | `/config/daytuner.db` |
| `DAYTUNER_HOST`, `DAYTUNER_PORT` | Where it listens | `0.0.0.0`, `8420` in the image |
| `DAYTUNER_UI_DIR` | The built pages | `/app/apps/ui/dist` |

**There is no login.** Anyone who can reach the port can change your schedules and, with writing on, your lineups. Publish it
only to yourself (`-p 127.0.0.1:8420:8420`), or behind your own authentication.

## First steps

Add a channel from a channel file (see `schedules/example.yaml`), either with the command line in the container or through the API:

```
docker cp my-channel.yaml daytuner:/config/my-channel.yaml
docker exec daytuner daytuner channel add /config/my-channel.yaml --floor 7d --step 24h
docker exec daytuner daytuner channel adopt-history "My Channel" --yes   # start the shows where the lineup already is
```

`docker exec daytuner daytuner` with no arguments prints every command. The state (shows' places, staged slots, revisions,
the commit log, cached chapters) is in the volume: back up `/config/daytuner.db`.

## Writing to Tunarr

Leave writing off while you look around. Turn it on (`DAYTUNER_ALLOW_WRITES=1`) only for a Tunarr you have a copy of, or once you
trust a plan: DayTuner appends to a channel's lineup and never changes its start time, but an appended lineup cannot be undone. With
writing on, each channel is run daily at its own time (default 03:00 in its schedule's zone; change it with
`POST /api/channels/:name/settings`), and missed runs are made up after a restart.

## Kubernetes

[`deploy/kubernetes.example.yaml`](../deploy/kubernetes.example.yaml) has a volume, a deployment (one replica: the database has one
owner) and a service. Add an ingress with your own authentication in front.

## Updating

The image holds no state. Pull or build a new one and restart; a database from an older version is upgraded when it opens.
