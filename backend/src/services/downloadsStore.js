// Data-access layer for download history (the `downloads` table), following the
// same shape as authStore.js: `createStore(db.query)` in production,
// `createMemoryStore()` in tests, both behind one interface so routes never
// touch Postgres directly.
//
// The table is the source of truth for a user's history; the media files still
// live on disk (utils/storage.js). Every user-facing method takes a `userId` and
// scopes its WHERE clause to it — that scoping is the authorization boundary
// that keeps one user from reading or deleting another's downloads. The few
// server-internal methods (markComplete/markFailed/markExpired/markMoved) are
// driven by background workers that already own the id and have no request user;
// those workers take the store as an argument (see cleanup.js / cloud/jobs.js),
// so there is exactly one way to get a store and nothing reaches for Postgres in
// unit tests.

// Shape a `downloads` row into the JSON the API (and therefore the frontend)
// speaks. Single place the DB column names are translated, so the wire contract
// can't drift per route. `size` (not `filesize`) preserves the field name the
// old metadata.json listing used, which the UI already renders.
function toApiRow(row) {
  return {
    downloadId: row.download_id,
    url: row.url,
    sourceKey: row.source_key || null,
    title: row.title,
    thumbnail: row.thumbnail,
    type: row.type,
    filename: row.filename,
    // bigint arrives from pg as a string; the UI does arithmetic on it.
    size: row.filesize === null || row.filesize === undefined ? null : Number(row.filesize),
    status: row.status,
    kept: !!row.kept,
    expired: !!row.expired,
    expiredAt: row.expired_at ? new Date(row.expired_at).toISOString() : undefined,
    // The UI treats `moved` as the cloud-link object (truthy = "Moved" card), so
    // a moved row surfaces its provider info and a normal row surfaces nothing.
    moved: row.moved ? row.moved_info || {} : undefined,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}

// Which rows occupy the quota: those whose media is gone (expired, moved to the
// user's own cloud) or never landed (failed) don't count; an in-flight
// `downloading` row does, so parallel starts can't race past the cap. Written
// twice — once as SQL, once as JS — so keep the two adjacent: they are one rule
// and must be changed together or the pg and memory stores silently disagree.
const USAGE_WHERE_SQL = "NOT expired AND NOT moved AND coalesce(status, '') <> 'failed'";
const countsTowardUsage = (r) => !r.expired && !r.moved && r.status !== 'failed';

// Which rows a freshly-completed download for the same URL may replace. Same
// two-impl rule as above — see supersedeForUser for why moved and in-flight
// rows are spared, and keep these two lines adjacent.
const SUPERSEDABLE_SQL = "NOT moved AND coalesce(status, '') <> 'downloading'";
const isSupersedable = (r) => !r.moved && r.status !== 'downloading';

// Does a candidate row share the fresh download's canonical video identity
// (0XC-117)? When BOTH sides carry a `source_key`, that's the match — it's
// stable across every URL form the same video can be pasted as, so a
// differing `url` no longer defeats the match. Whenever either side lacks a
// key (a pre-migration row, or an extractor that returned no id), fall back
// to exact `url` equality, exactly as before this ticket. Written once here
// and mirrored in SQL in `createStore.supersedeForUser` — keep both in step.
const sharesSource = (row, freshSourceKey, freshUrl) =>
  freshSourceKey && row.source_key
    ? row.source_key === freshSourceKey
    : !!freshUrl && row.url === freshUrl;

// Whether this row's media is actually on our disk right now — i.e. whether a
// `filename` is worth handing out. False while still downloading, after a
// failure, once moved to the user's own cloud, and once expired. Lives here with
// the other lifecycle predicates so a new terminal status is handled in one file.
// Unlike its two neighbours (raw DB rows only) this is safe on EITHER shape: the
// three fields it reads keep their names through toApiRow, and `moved` stays
// truthy there as `moved_info || {}`. Its caller passes a toApiRow output.
const hasLocalMedia = (r) => r.status === 'complete' && !r.moved && !r.expired;

// Postgres-backed implementation over a `query(text, params)` function (db.js).
function createStore(query) {
  return {
    // Record a download the moment it starts, so the row exists (as
    // `downloading`) even if the client never comes back for the SSE.
    async insert({ downloadId, userId, url, title, thumbnail, type, filesize, kept, sourceKey }) {
      await query(
        `INSERT INTO downloads
           (download_id, user_id, url, title, thumbnail, type, filesize, status, kept, source_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'downloading', $8, $9)
         ON CONFLICT (download_id) DO NOTHING`,
        [
          downloadId,
          userId,
          url,
          title,
          thumbnail,
          type,
          filesize ?? null,
          !!kept,
          sourceKey ?? null,
        ],
      );
    },

    async listByUser(userId) {
      const { rows } = await query(
        'SELECT * FROM downloads WHERE user_id = $1 ORDER BY created_at DESC',
        [userId],
      );
      return rows.map(toApiRow);
    },

    async findForUser(downloadId, userId) {
      const { rows } = await query(
        'SELECT * FROM downloads WHERE download_id = $1 AND user_id = $2',
        [downloadId, userId],
      );
      return rows[0] ? toApiRow(rows[0]) : null;
    },

    // Unscoped lookup — no `user_id` filter. Only for the public per-item
    // metadata endpoint (0XC-112), which deliberately resolves a download for
    // anyone holding its unguessable id; the route projects the result down to
    // a public-safe subset before it ever reaches a response.
    async findById(downloadId) {
      const { rows } = await query('SELECT * FROM downloads WHERE download_id = $1', [downloadId]);
      return rows[0] ? toApiRow(rows[0]) : null;
    },

    // Bytes currently counting against the user's quota.
    async usageForUser(userId) {
      const { rows } = await query(
        `SELECT coalesce(sum(filesize), 0) AS used
           FROM downloads
          WHERE user_id = $1 AND ${USAGE_WHERE_SQL}`,
        [userId],
      );
      return Number(rows[0]?.used || 0);
    },

    // The job finished: record the real filename and the ACTUAL byte size (the
    // size used at insert time came from the untrusted client-supplied
    // estimate). `onlyIfDownloading` is for the cleanup sweep's reconcile
    // (see cleanup.js): a `downloading` row whose completion hook's write was
    // lost even though the job actually finished — the media is already on
    // disk. With it set, this is a no-op (returns false) unless the row is
    // still `downloading`, so calling it on an already-resolved row changes
    // nothing. Without it (the normal completion path), it always applies and
    // the return value is unused.
    async markComplete(downloadId, { filename, filesize }, { onlyIfDownloading = false } = {}) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET status = 'complete',
                completed_at = now(),
                filename = $2,
                filesize = coalesce($3, filesize)
          WHERE download_id = $1 ${onlyIfDownloading ? "AND status = 'downloading'" : ''}`,
        [downloadId, filename ?? null, filesize ?? null],
      );
      return rowCount > 0;
    },

    async markFailed(downloadId) {
      await query("UPDATE downloads SET status = 'failed' WHERE download_id = $1", [downloadId]);
    },

    // The small, normally-empty set of rows the cleanup sweep's reconcile
    // needs to even consider — lets it skip stat-ing and updating every live
    // download on disk each hour and only look at ones that could possibly be
    // stranded. See cleanup.js.
    async downloadingIds() {
      const { rows } = await query(
        "SELECT download_id FROM downloads WHERE status = 'downloading'",
      );
      return rows.map((r) => r.download_id);
    },

    // Reconcile history against the filesystem: every completed, still-live row
    // whose media is NOT in `presentIds` has lost its files (aged out by the
    // sweep, removed by the standalone cleanup CLI, or deleted by hand) and is
    // therefore expired. Driving this off "what's actually on disk" rather than
    // "what this run just expired" keeps the table honest no matter who removed
    // the files. Used by the hourly sweep, across all users.
    //
    // `presentIds` is a snapshot of the directory, so a download that COMPLETES
    // while the sweep is running is absent from it through no fault of its own —
    // and would be expired the moment it landed. `graceMs` spares rows that
    // finished within that window, which is always longer than a sweep takes.
    // Measured from COMPLETION, not creation: a download that ran for longer
    // than the grace period would otherwise be born already past it.
    async expireMissing(presentIds, graceMs = 0) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET expired = true, expired_at = now()
          WHERE NOT expired
            AND NOT moved
            AND status = 'complete'
            AND coalesce(completed_at, created_at) < now() - ($2::bigint * interval '1 ms')
            AND NOT (download_id = ANY($1::uuid[]))`,
        [presentIds || [], Math.max(0, Math.floor(graceMs))],
      );
      return rowCount;
    },

    async markMoved(downloadId, movedInfo) {
      await query('UPDATE downloads SET moved = true, moved_info = $2 WHERE download_id = $1', [
        downloadId,
        movedInfo ? JSON.stringify(movedInfo) : null,
      ]);
    },

    // Every `kept` download's id, across all users — the cleanup sweep's
    // exclusion set. A directory the sweep would otherwise age out is never
    // touched while its row says `kept`, no matter how stale it looks on disk.
    async keptIds() {
      const { rows } = await query('SELECT download_id FROM downloads WHERE kept', []);
      return rows.map((r) => r.download_id);
    },

    // Retire `downloading` rows that can no longer be running. The job registry
    // is in-memory, so a restart mid-download strands its row — and a stranded
    // row would count against the user's quota forever. Called by the hourly
    // sweep with a window far longer than any real download.
    async failStale(olderThanMs) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET status = 'failed'
          WHERE status = 'downloading' AND created_at < now() - ($1::bigint * interval '1 ms')`,
        [Math.max(0, Math.floor(olderThanMs))],
      );
      return rowCount;
    },

    // Expire = the media is gone but the row stays (re-downloadable). Only a
    // COMPLETED download can be expired: expiring one that is still running
    // would exclude it from the quota forever, since the job's markComplete
    // then writes the real size onto an already-expired row and expireMissing
    // (WHERE NOT expired) can never reconcile it back. An in-flight download is
    // stopped with the cancel route instead, which deletes the row outright.
    async expireForUser(downloadId, userId) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET expired = true, expired_at = now()
          WHERE download_id = $1 AND user_id = $2 AND status = 'complete'`,
        [downloadId, userId],
      );
      return rowCount > 0;
    },

    async setKeptForUser(downloadId, userId, kept) {
      const { rowCount } = await query(
        'UPDATE downloads SET kept = $3 WHERE download_id = $1 AND user_id = $2',
        [downloadId, userId, !!kept],
      );
      return rowCount > 0;
    },

    async deleteForUser(downloadId, userId) {
      const { rowCount } = await query(
        'DELETE FROM downloads WHERE download_id = $1 AND user_id = $2',
        [downloadId, userId],
      );
      return rowCount > 0;
    },

    // One row per canonical video identity (0XC-10, refined by 0XC-117): a
    // download that just COMPLETED replaces the same user's older rows for the
    // same video — matched on `source_key` when both sides have one, else on
    // the raw `url` (see `sharesSource` above). Returns the superseded ids so
    // the caller can remove their media too. Two rows are deliberately spared:
    //   - `moved` — the media is in the user's own cloud and the row still
    //     carries the "Open in Dropbox/Drive" link, which a re-download doesn't
    //     supersede.
    //   - `downloading` — a concurrent job for the same video. Deleting its row
    //     would orphan a running job (and strand its partial files).
    // Expired, failed and live completed rows all go. `SUPERSEDABLE_SQL` and
    // `isSupersedable` are one rule written twice — keep them adjacent.
    async supersedeForUser({ downloadId, userId, url, sourceKey }) {
      if (!url) return [];
      const key = sourceKey ?? null;
      const { rows } = await query(
        `DELETE FROM downloads
          WHERE user_id = $1
            AND download_id <> $2
            AND ${SUPERSEDABLE_SQL}
            AND CASE WHEN $3::text IS NOT NULL AND source_key IS NOT NULL
                     THEN source_key = $3
                     ELSE url = $4
                END
          RETURNING download_id`,
        [userId, downloadId, key, url],
      );
      return rows.map((r) => r.download_id);
    },
  };
}

// In-memory implementation with the identical interface, for unit tests (no
// Postgres). Rows are kept in the same snake_case shape so both impls share
// toApiRow and can't drift in what they expose.
function createMemoryStore({ rows = [] } = {}) {
  const byId = new Map(rows.map((r) => [r.download_id, r]));

  return {
    async insert({ downloadId, userId, url, title, thumbnail, type, filesize, kept, sourceKey }) {
      if (byId.has(downloadId)) return;
      byId.set(downloadId, {
        download_id: downloadId,
        user_id: userId,
        url,
        source_key: sourceKey ?? null,
        title,
        thumbnail,
        type,
        filename: null,
        filesize: filesize ?? null,
        status: 'downloading',
        completed_at: null,
        expired: false,
        expired_at: null,
        moved: false,
        moved_info: null,
        kept: !!kept,
        created_at: new Date(),
      });
    },
    async listByUser(userId) {
      return [...byId.values()]
        .filter((r) => r.user_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(toApiRow);
    },
    async findForUser(downloadId, userId) {
      const row = byId.get(downloadId);
      return row && row.user_id === userId ? toApiRow(row) : null;
    },
    async findById(downloadId) {
      const row = byId.get(downloadId);
      return row ? toApiRow(row) : null;
    },
    async usageForUser(userId) {
      let used = 0;
      for (const r of byId.values()) {
        if (r.user_id === userId && countsTowardUsage(r)) used += Number(r.filesize || 0);
      }
      return used;
    },
    async markComplete(downloadId, { filename, filesize }, { onlyIfDownloading = false } = {}) {
      const row = byId.get(downloadId);
      if (!row) return false;
      if (onlyIfDownloading && row.status !== 'downloading') return false;
      row.status = 'complete';
      row.completed_at = new Date();
      row.filename = filename ?? null;
      if (filesize !== null && filesize !== undefined) row.filesize = filesize;
      return true;
    },
    async markFailed(downloadId) {
      const row = byId.get(downloadId);
      if (row) row.status = 'failed';
    },
    async downloadingIds() {
      return [...byId.values()].filter((r) => r.status === 'downloading').map((r) => r.download_id);
    },
    async expireMissing(presentIds, graceMs = 0) {
      const present = new Set(presentIds || []);
      const cutoff = Date.now() - Math.max(0, graceMs);
      let n = 0;
      for (const row of byId.values()) {
        if (
          !row.expired &&
          !row.moved &&
          row.status === 'complete' &&
          new Date(row.completed_at || row.created_at).getTime() < cutoff &&
          !present.has(row.download_id)
        ) {
          row.expired = true;
          row.expired_at = new Date();
          n++;
        }
      }
      return n;
    },
    async markMoved(downloadId, movedInfo) {
      const row = byId.get(downloadId);
      if (!row) return;
      row.moved = true;
      row.moved_info = movedInfo || null;
    },
    async keptIds() {
      return [...byId.values()].filter((r) => r.kept).map((r) => r.download_id);
    },
    async failStale(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      let n = 0;
      for (const row of byId.values()) {
        if (row.status === 'downloading' && new Date(row.created_at).getTime() < cutoff) {
          row.status = 'failed';
          n++;
        }
      }
      return n;
    },
    async expireForUser(downloadId, userId) {
      const row = byId.get(downloadId);
      if (!row || row.user_id !== userId || row.status !== 'complete') return false;
      row.expired = true;
      row.expired_at = new Date();
      return true;
    },
    async setKeptForUser(downloadId, userId, kept) {
      const row = byId.get(downloadId);
      if (!row || row.user_id !== userId) return false;
      row.kept = !!kept;
      return true;
    },
    async deleteForUser(downloadId, userId) {
      const row = byId.get(downloadId);
      if (!row || row.user_id !== userId) return false;
      byId.delete(downloadId);
      return true;
    },
    async supersedeForUser({ downloadId, userId, url, sourceKey }) {
      if (!url) return [];
      const gone = [];
      for (const row of byId.values()) {
        if (
          row.user_id === userId &&
          row.download_id !== downloadId &&
          isSupersedable(row) &&
          sharesSource(row, sourceKey, url)
        ) {
          gone.push(row.download_id);
        }
      }
      for (const id of gone) byId.delete(id);
      return gone;
    },
    // Test-only escape hatch.
    _rows: byId,
  };
}

module.exports = { createStore, createMemoryStore, toApiRow, hasLocalMedia };
