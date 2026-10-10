"""Экспорт проекта в Fan Dub Mod: папка sounds = копия библиотеки,
где озвученные реплики заменены дублями."""

import shutil
from pathlib import Path

from .storage import _safe_name


def export_fan_dub_mod(storage, project_id) -> dict:
    project = storage.load_project(project_id)
    pdir = storage.project_dir(project_id)
    lib_path = Path(project["library_path"])
    if not lib_path.is_dir():
        raise ValueError("Папка библиотеки проекта недоступна: " + str(lib_path))

    out_root = pdir / "export"
    out_root.mkdir(exist_ok=True)
    mod_dir = out_root / f"FanDubMod_{_safe_name(project['name'])}"
    sounds_out = mod_dir / "sounds"
    if mod_dir.exists():
        shutil.rmtree(mod_dir)
    shutil.copytree(lib_path, sounds_out)

    replaced, missing_dub = 0, 0
    for fid, line in project["lines"].items():
        if line.get("status") != "dubbed":
            continue
        dub = pdir / line.get("file", "")
        target = None
        for name in (fid + ".WAV", fid + ".wav"):
            if (sounds_out / name).exists():
                target = sounds_out / name
                break
        if target is None:
            target = sounds_out / (fid + ".WAV")
        if dub.exists():
            shutil.copy2(dub, target)
            replaced += 1
        else:
            missing_dub += 1

    return {
        "mod_dir": str(mod_dir),
        "sounds_dir": str(sounds_out),
        "replaced": replaced,
        "missing_dubs": missing_dub,
    }
