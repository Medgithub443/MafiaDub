"""Хранилище данных MafiaDub: проекты, библиотеки звуков, фоновые задачи.

Структура data_dir:
    sound_map.json      — карта реплик (копируется из assets при первом запуске)
    libraries.json      — реестр библиотек sounds
    libraries/<id>/sounds/              — библиотеки, загруженные в программу
    projects/<id>/
        project.json    — метаданные проекта и статусы реплик
        map.json        — снимок карты реплик на момент создания проекта
        dubs/<file_id>.wav
        video/<файл>    — локальное видео без звука (опционально)
        export/         — результаты экспорта Fan Dub Mod
"""

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

LINE_STATUSES = ("dubbed", "silence", "original")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', "_", name).strip()
    return name or "project"


class JobManager:
    """Простые фоновые задачи (копирование библиотеки, экспорт)."""

    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()

    def start(self, kind, fn):
        job_id = uuid.uuid4().hex[:12]
        with self.lock:
            self.jobs[job_id] = {"id": job_id, "kind": kind, "state": "running",
                                 "result": None, "error": None}
        def run():
            try:
                result = fn()
                with self.lock:
                    self.jobs[job_id]["state"] = "done"
                    self.jobs[job_id]["result"] = result
            except Exception as e:  # noqa: BLE001 — задача не должна падать молча
                with self.lock:
                    self.jobs[job_id]["state"] = "error"
                    self.jobs[job_id]["error"] = str(e)
        threading.Thread(target=run, daemon=True).start()
        return job_id

    def get(self, job_id):
        with self.lock:
            return self.jobs.get(job_id)


class Storage:
    def __init__(self, data_dir: Path, bundled_assets: Path):
        self.data_dir = Path(data_dir)
        self.projects_dir = self.data_dir / "projects"
        self.libraries_dir = self.data_dir / "libraries"
        self.map_file = self.data_dir / "sound_map.json"
        self.libraries_file = self.data_dir / "libraries.json"
        self.bundled_assets = Path(bundled_assets)
        for d in (self.data_dir, self.projects_dir, self.libraries_dir):
            d.mkdir(parents=True, exist_ok=True)
        if not self.map_file.exists():
            shutil.copy2(self.bundled_assets / "sound_map.json", self.map_file)
        if not self.libraries_file.exists():
            self._save_json(self.libraries_file, [])

    # --- утилиты -----------------------------------------------------------
    @staticmethod
    def _save_json(path: Path, obj):
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def load_map(self):
        return json.loads(self.map_file.read_text(encoding="utf-8"))

    # --- библиотеки sounds ---------------------------------------------------
    def list_libraries(self):
        libs = json.loads(self.libraries_file.read_text(encoding="utf-8"))
        for lib in libs:
            if lib["kind"] == "copy":
                lib["path"] = str(self.libraries_dir / lib["id"] / "sounds")
            lib["exists"] = Path(lib["path"]).is_dir()
            lib["wav_count"] = self._count_wavs(lib) if lib["exists"] else 0
        return libs

    @staticmethod
    def _count_wavs(lib):
        try:
            return sum(1 for f in Path(lib["path"]).iterdir()
                       if f.suffix.lower() == ".wav")
        except OSError:
            return 0

    def get_library(self, lib_id):
        for lib in self.list_libraries():
            if lib["id"] == lib_id:
                return lib
        return None

    def add_library_ref(self, name, path):
        """Зарегистрировать существующую папку на диске (без копирования)."""
        path = Path(path)
        if not path.is_dir():
            raise ValueError(f"Папка не найдена: {path}")
        if not any(f.suffix.lower() == ".wav" for f in path.iterdir()):
            raise ValueError(f"В папке нет WAV-файлов: {path}")
        libs = json.loads(self.libraries_file.read_text(encoding="utf-8"))
        lib = {"id": uuid.uuid4().hex[:12], "name": name, "kind": "ref",
               "path": str(path.resolve()), "added": _now()}
        libs.append(lib)
        self._save_json(self.libraries_file, libs)
        return lib

    def add_library_copy(self, name, src_path):
        """Подготовить копирование папки в data_dir/libraries.

        Возвращает (lib, do_copy) — do_copy запускается в фоне вызывающим кодом.
        """
        src_path = Path(src_path)
        if not src_path.is_dir():
            raise ValueError(f"Папка не найдена: {src_path}")
        libs = json.loads(self.libraries_file.read_text(encoding="utf-8"))
        lib = {"id": uuid.uuid4().hex[:12], "name": name, "kind": "copy",
               "path": None, "added": _now()}
        libs.append(lib)
        self._save_json(self.libraries_file, libs)
        dest = self.libraries_dir / lib["id"] / "sounds"

        def do_copy():
            shutil.copytree(src_path, dest)
            return {"library_id": lib["id"], "path": str(dest)}

        return lib, do_copy

    # --- проекты -------------------------------------------------------------
    def create_project(self, name, library_id):
        lib = self.get_library(library_id)
        if lib is None:
            raise ValueError("Библиотека не найдена")
        if not lib["exists"]:
            raise ValueError("Папка библиотеки недоступна: " + lib["path"])
        project_id = uuid.uuid4().hex[:12]
        pdir = self.projects_dir / project_id
        (pdir / "dubs").mkdir(parents=True)
        (pdir / "video").mkdir()
        shutil.copy2(self.map_file, pdir / "map.json")
        game_map = json.loads((pdir / "map.json").read_text(encoding="utf-8"))
        video_url = game_map.get("meta", {}).get("youtube_source_video", "")
        project = {
            "id": project_id,
            "name": name,
            "created": _now(),
            "updated": _now(),
            "library_id": library_id,
            "library_path": lib["path"],
            "video": {"type": "youtube", "url": video_url,
                      "video_id": self._extract_video_id(video_url)},
            "lines": {},
        }
        self._save_json(pdir / "project.json", project)
        return project

    @staticmethod
    def _extract_video_id(url):
        m = re.search(r"[?&]v=([\w-]{6,})", url or "")
        if m:
            return m.group(1)
        m = re.search(r"youtu\.be/([\w-]{6,})", url or "")
        return m.group(1) if m else None

    def project_dir(self, project_id):
        pdir = self.projects_dir / project_id
        if not pdir.is_dir():
            raise ValueError("Проект не найден")
        return pdir

    def load_project(self, project_id):
        pdir = self.project_dir(project_id)
        return json.loads((pdir / "project.json").read_text(encoding="utf-8"))

    def save_project(self, project):
        pdir = self.project_dir(project["id"])
        project["updated"] = _now()
        self._save_json(pdir / "project.json", project)

    def list_projects(self):
        result = []
        for pdir in sorted(self.projects_dir.iterdir()):
            if not (pdir / "project.json").exists():
                continue
            project = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
            game_map = json.loads((pdir / "map.json").read_text(encoding="utf-8"))
            total = game_map["meta"]["total_matched_lines"]
            done = sum(1 for v in project["lines"].values()
                       if v.get("status") in LINE_STATUSES)
            result.append({
                "id": project["id"], "name": project["name"],
                "created": project["created"], "updated": project["updated"],
                "total": total, "done": done,
                "percent": round(100 * done / total) if total else 0,
            })
        return result

    def delete_project(self, project_id):
        shutil.rmtree(self.project_dir(project_id))

    def find_game_wav(self, project, file_id):
        """Найти WAV в библиотеке проекта (пробуем оба регистра расширения)."""
        base = Path(project["library_path"])
        for name in (file_id + ".WAV", file_id + ".wav"):
            p = base / name
            if p.exists():
                return p
        return None
