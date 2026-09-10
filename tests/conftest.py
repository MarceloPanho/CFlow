from pathlib import Path
import os

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session", autouse=True)
def _chdir_root():
    prev = Path.cwd()
    os.chdir(ROOT)
    yield
    os.chdir(prev)
