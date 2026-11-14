"""Release boundary: local credentials/state stay out, assets have content versions."""
import hashlib
import json
from pathlib import Path
import re
import unittest
from urllib.parse import unquote, urlsplit

from tools.build_cpanel import release_files


class CPanelPackageTests(unittest.TestCase):
    def test_release_contains_only_deployment_files_and_matching_asset_hashes(self):
        files = release_files(Path(__file__).resolve().parent.parent)
        for name in files:
            self.assertFalse(name.startswith(('data/','config/','tests/','reports/','.git/','.venv/')))
            self.assertNotIn(name,{'.env','start.bat','setup.bat'})
        self.assertIn('backend/session_store.py',files)
        self.assertIn('passenger_wsgi.py',files)
        manifest=json.loads(files['release-manifest.json'])
        for name,entry in manifest['files'].items():
            self.assertEqual(entry['sha256'],hashlib.sha256(files[name]).hexdigest())
        for url in re.findall(r'(?:src|href)="(/static/[^"]+)"',files['web/index.html'].decode()):
            parsed=urlsplit(url)
            content=files['web/'+unquote(parsed.path[len('/static/'):])]
            self.assertEqual(parsed.query,'v='+hashlib.sha256(content).hexdigest()[:12])
