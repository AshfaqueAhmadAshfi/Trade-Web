"""Run the complete offline backend and frontend suites.

Install development packages with: python -m pip install -r requirements-dev.txt
Run: python tests/run_tests.py

The retained adapter tests use fakes. No terminal connection, production
settings, provider request or order is needed.
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    if importlib.util.find_spec("pytest") is None:
        print("Install development dependencies: python -m pip install -r requirements-dev.txt")
        return 2
    python_result = subprocess.run([sys.executable, "-m", "pytest", "tests", "-q", "--tb=short"], cwd=ROOT)
    try:
        files = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests").glob("*.test.cjs"))
        javascript_result = subprocess.run(["node", "--test", *files], cwd=ROOT)
    except FileNotFoundError:
        print("Node.js is required to run the frontend suite.")
        return 2
    return 1 if python_result.returncode or javascript_result.returncode else 0


if __name__ == "__main__":
    raise SystemExit(main())
