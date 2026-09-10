# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

root = Path(SPECPATH).resolve().parent.parent

a = Analysis(
    [str(root / "engine" / "app.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[
        (str(root / "frontend"), "frontend"),
        (str(root / "samples"), "samples"),
    ],
    hiddenimports=["engine", "engine.cfg", "engine.parser", "engine.trace", "engine.tracer"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="CFlow",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
)
