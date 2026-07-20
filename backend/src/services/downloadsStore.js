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

// Postgres-backed implementation over a `query(text, params)` function (db.js).
function createStore(query) {
  return {
    // Record a download the moment it starts, so the row exists (as
    // `downloading`) even if the client never comes back for the SSE.
    async insert({ downloadId, userId, url, title, thumbnail, type, filesize, kept }) {
      await query(
        `INSERT INTO downloads
           (download_id, user_id, url, title, thumbnail, type, filesize, status, kept)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'downloading', $8)
         ON CONFLICT (download_id) DO NOTHING`,
        [downloadId, userId, url, title, thumbnail, type, filesize ?? null, !!kept],
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
    // size used at insert time came from the untrusted client-supplied estimate).
    async markComplete(downloadId, { filename, filesize }) {
      await query(
        `UPDATE downloads
            SET status = 'complete', filename = $2, filesize = coalesce($3, filesize)
          WHERE download_id = $1`,
        [downloadId, filename ?? null, filesize ?? null],
      );
    },

    async markFailed(downloadId) {
      await query("UPDATE downloads SET status = 'failed' WHERE download_id = $1", [downloadId]);
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
    // and would be expired the moment it landed. `graceMs` spares rows younger
    // than that window, which is always longer than a sweep takes.
    async expireMissing(presentIds, graceMs = 0) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET expired = true, expired_at = now()
          WHERE NOT expired
            AND NOT moved
            AND status = 'complete'
            AND created_at < now() - ($2::bigint * interval '1 ms')
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

    async expireForUser(downloadId, userId) {
      const { rowCount } = await query(
        `UPDATE downloads
            SET expired = true, expired_at = now()
          WHERE download_id = $1 AND user_id = $2`,
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
  };
}

// In-memory implementation with the identical interface, for unit tests (no
// Postgres). Rows are kept in the same snake_case shape so both impls share
// toApiRow and can't drift in what they expose.
function createMemoryStore({ rows = [] } = {}) {
  const byId = new Map(rows.map((r) => [r.download_id, r]));

  return {
    async insert({ downloadId, userId, url, title, thumbnail, type, filesize, kept }) {
      if (byId.has(downloadId)) return;
      byId.set(downloadId, {
        download_id: downloadId,
        user_id: userId,
        url,
        title,
        thumbnail,
        type,
        filename: null,
        filesize: filesize ?? null,
        status: 'downloading',
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
    async usageForUser(userId) {
      let used = 0;
      for (const r of byId.values()) {
        if (r.user_id === userId && countsTowardUsage(r)) used += Number(r.filesize || 0);
      }
      return used;
    },
    async markComplete(downloadId, { filename, filesize }) {
      const row = byId.get(downloadId);
      if (!row) return;
      row.status = 'complete';
      row.filename = filename ?? null;
      if (filesize !== null && filesize !== undefined) row.filesize = filesize;
    },
    async markFailed(downloadId) {
      const row = byId.get(downloadId);
      if (row) row.status = 'failed';
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
          new Date(row.created_at).getTime() < cutoff &&
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
      if (!row || row.user_id !== userId) return false;
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
    // Test-only escape hatch.
    _rows: byId,
  };
}

module.exports = { createStore, createMemoryStore, toApiRow };
