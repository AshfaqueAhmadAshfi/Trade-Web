"""Real multi-worker session persistence without provider requests or credentials."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from backend import webauth
from backend.session_store import SessionStore
from backend.cache_io import write_json


class PassengerSessionTests(unittest.TestCase):
    def test_another_worker_accepts_session_logout_revokes_it_and_rotation_invalidates_it(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            "SOFTRADEX_PASSENGER": "1", "SOFTRADEX_AUTH_DB": str(Path(folder)/"auth.sqlite3"),
            "SOFTRADEX_DASHBOARD_PASSWORD": "isolated-test-password",
        }):
            token = webauth.login({}.get)
            script = "import sys;from backend import webauth;assert webauth.session_valid(sys.stdin.read())"
            result = subprocess.run([sys.executable,"-c",script], input=token, text=True,
                                    capture_output=True, timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            db=sqlite3.connect(Path(folder)/"auth.sqlite3")
            self.assertNotIn(token,str(db.execute("SELECT * FROM sessions").fetchall()))
            db.close()
            with patch.dict(os.environ,{"SOFTRADEX_DASHBOARD_PASSWORD":"changed-test-password"}):
                self.assertFalse(webauth.session_valid(token))
            result=subprocess.run([sys.executable,"-c","import sys;from backend import webauth;webauth.logout(sys.stdin.read())"],
                                  input=token,text=True,capture_output=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertFalse(webauth.session_valid(token))

    def test_expiry_and_concurrent_limits_are_shared(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"auth.sqlite3"
            first,second=SessionStore(path),SessionStore(path)
            first.issue("one","proof",1000,60,64)
            self.assertEqual(second.proof("one",1059),"proof")
            self.assertIsNone(second.proof("one",1060))
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda i:SessionStore(path).issue(str(i),"proof",2000,60,8),range(20)))
            self.assertEqual(first.count(2001),8)
            self.assertEqual(first.count(2060),0)

    def test_login_failures_are_shared_and_window_resets(self):
        with tempfile.TemporaryDirectory() as folder:
            first=SessionStore(Path(folder)/"auth.sqlite3")
            second=SessionStore(first.path)
            for i in range(8):
                (first if i%2 else second).failure("peer",1000+i,300,300,8,2048)
            self.assertTrue(second.blocked("peer",1100))
            self.assertFalse(first.blocked("peer",1307))
            first.success("peer")
            self.assertFalse(second.blocked("peer",1100))
            first.failure("peer",2000,300,300,8,2048)
            second.failure("peer",2400,300,300,8,2048)
            self.assertFalse(first.blocked("peer",2401))

    def test_parallel_cache_writers_never_share_temporary_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"cache.json"
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda i:write_json(path,{"worker":i,"rows":list(range(100))}),range(20)))
            import json
            self.assertEqual(json.loads(path.read_text())["rows"],list(range(100)))
            self.assertEqual(list(Path(folder).glob("*.tmp")),[])
