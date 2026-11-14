"""Shared dashboard sessions for Passenger workers; no live DB connection is kept."""
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3


class SessionStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    digest TEXT PRIMARY KEY, proof TEXT NOT NULL,
                    created REAL NOT NULL, expires REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS failures (
                    ip TEXT PRIMARY KEY, count INTEGER NOT NULL,
                    blocked REAL NOT NULL, first REAL NOT NULL
                );
            """)
        if os.name != "nt":
            self.path.chmod(0o600)

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def issue(self, digest, proof, now, ttl, maximum):
        with self._connection(write=True) as db:
            db.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
            count = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            if count >= maximum:
                db.execute("DELETE FROM sessions WHERE digest IN "
                           "(SELECT digest FROM sessions ORDER BY created LIMIT ?)",
                           (count - maximum + 1,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)",
                       (digest, proof, now, now + ttl))

    def proof(self, digest, now):
        with self._connection() as db:
            row = db.execute("SELECT proof FROM sessions WHERE digest=? AND expires>?",
                             (digest, now)).fetchone()
        return row[0] if row else None

    def revoke(self, digest):
        with self._connection(write=True) as db:
            db.execute("DELETE FROM sessions WHERE digest=?", (digest,))

    def count(self, now):
        with self._connection() as db:
            return db.execute("SELECT COUNT(*) FROM sessions WHERE expires>?", (now,)).fetchone()[0]

    def blocked(self, ip, now):
        with self._connection() as db:
            row = db.execute("SELECT blocked FROM failures WHERE ip=?", (ip,)).fetchone()
        return bool(row and row[0] > now)

    def failure(self, ip, now, window, block, limit, maximum):
        with self._connection(write=True) as db:
            db.execute("DELETE FROM failures WHERE blocked<=? AND first+?<=?",
                       (now, window, now))
            row = db.execute("SELECT count, blocked, first FROM failures WHERE ip=?", (ip,)).fetchone()
            count, blocked, first = row or (0, 0, now)
            if blocked > now:
                return
            if now - first >= window:
                count, first = 0, now
            count += 1
            if count >= limit:
                count, blocked = 0, now + block
            if row is None and db.execute("SELECT COUNT(*) FROM failures").fetchone()[0] >= maximum:
                db.execute("DELETE FROM failures WHERE ip IN "
                           "(SELECT ip FROM failures ORDER BY first LIMIT 1)")
            db.execute("INSERT OR REPLACE INTO failures VALUES (?, ?, ?, ?)",
                       (ip, count, blocked, first))

    def success(self, ip):
        with self._connection(write=True) as db:
            db.execute("DELETE FROM failures WHERE ip=?", (ip,))
