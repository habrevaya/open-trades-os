# Files, copies and restores

Where a deployment keeps photographs and documents, how to move them, and what a
self hoster needs to know about the copies each company takes and restores.

## Where files are kept

Postgres, unless you say otherwise. Every photograph, signature, document and
call recording is a row in `stored_file` with its bytes beside it, which is right
for a contractor with a few gigabytes: one database to back up and nothing else
to run. A deployment with more than that keeps them in an S3 compatible bucket:

| Variable | Default | What it is |
|---|---|---|
| `FILE_STORAGE` | `postgres` | `postgres` or `s3`: where a file stored from now on goes |
| `FILE_STORAGE_S3_ENDPOINT` | | The service's address, such as `https://s3.us-east-1.amazonaws.com`, an R2 or B2 endpoint, or `http://minio:9000` |
| `FILE_STORAGE_S3_BUCKET` | | The bucket |
| `FILE_STORAGE_S3_REGION` | `us-east-1` | The bucket's region |
| `FILE_STORAGE_S3_PREFIX` | none | A folder inside the bucket |
| `FILE_STORAGE_S3_ACCESS_KEY_ID` | | The key id |
| `FILE_STORAGE_S3_SECRET_ACCESS_KEY` | | The secret key |
| `FILE_STORAGE_S3_PATH_STYLE` | `true` | `false` for a service that wants `bucket.endpoint` addresses |

Set the same variables on the web app, the worker and anything else that runs
the API, because each row says where its own bytes are and every process has to
be able to read either kind. Half of the bucket's settings is refused with the
names of the missing ones, at the first upload, rather than quietly filling the
database.

Changing `FILE_STORAGE` moves nothing on its own. New files go to the new place;
existing ones stay readable where they are.

## Moving files that are already stored

```
pnpm --filter @opentradesos/api move-files              # to wherever FILE_STORAGE says
pnpm --filter @opentradesos/api move-files -- --to postgres
pnpm --filter @opentradesos/api move-files -- --dry-run
```

Run it with the app's settings while the app is in use. Each file is moved in a
transaction of its own: its bytes are hashed and checked against the checksum
taken when they were stored, copied, read back from where they went and checked
again, and only then does the row change. The app reads each file from wherever
its row says, so at every moment a file is readable from exactly one place.
Stopping it is safe and running it again carries on. A file that fails a check
is left where it is and listed at the end, and the command exits non zero.

It needs the role the worker uses (`WORKER_DATABASE_URL`, or `DATABASE_URL` in
development), because finding which companies have files is a question across
companies.

Moving home deletes each object only after its row says the bytes are back in
Postgres; an object that could not be deleted is listed for you to remove.

## Removed files

A retention purge or a deleted call recording empties a file's row at once. When
the bytes are in a bucket, the object is deleted by the worker's next sweep
(every ten minutes), under the row's lock, so a file stored again in the
meantime keeps its object.

## A company's copies and restores

Take a copy downloads either a zip of spreadsheets or one newline delimited data
file; Backups writes the zip to the company's own bucket on a schedule (see "Copies
of each company" in `worker.md`). Both are read back by Restore a copy at
`/setup/restore`, into a new, empty company, from an upload or from a bucket.

An upload is spooled to the server's temporary folder and read from there, and
deleted afterwards. The largest upload taken is 20 GB, or `RESTORE_UPLOAD_MAX_BYTES`.
Behind a proxy or load balancer, its request size and time limits apply first; a
copy too large for them is restored from a bucket instead, which the server reads
itself. A restore runs while the request waits, so a very large one wants a
proxy timeout of several minutes.

The secret names a restored company's connections read, and the bucket secret a
backup destination names, are listed on the restore's report: put those secrets
in the NEW company's own secrets under the same names (Settings, Integrations,
or `OTS_SECRET__<new company id>__<name>` with `SECRET_STORE=environment`). A
secret is always read from the company whose bucket or connection names it,
never from a bare server variable, so naming `AUTH_SECRET` reads the company's
own secret of that name and not the server's.
