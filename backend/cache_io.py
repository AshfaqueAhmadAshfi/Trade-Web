"""Atomic JSON cache replacement, safe across Passenger workers."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time

_WRITE_LOCK = threading.Lock()


def write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK:
        descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False)
            for attempt in range(5):
                try:
                    os.replace(temporary, path)
                    break
                except PermissionError:
                    if os.name != "nt" or attempt == 4:
                        raise
                    time.sleep(0.02 * (attempt + 1))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
