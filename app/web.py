"""HTTP API и раздача фронтенда."""

import json
import os
import re
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import audio, exporter
from .storage import JobManager, LINE_STATUSES, Storage, _safe_name


def create_app(storage: Storage, static_dir: Path) -> FastAPI:
    app = FastAPI(title="MafiaDub", docs_url=None, redoc_url=None, openapi_url=None)
    jobs = JobManager()

    # --- проекты -------------------------------------------------------------
    @app.get("/api/projects")
    def list_projects():
        return storage.list_projects()

    @app.post("/api/projects")
    async def create_project(request: Request):
        body = await request.json()
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "Введите название проекта")
        try:
            project = storage.create_project(name, body.get("library_id"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        return project

    @app.get("/api/projects/{pid}")
    def get_project(pid: str):
        try:
            project = storage.load_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        pdir = storage.project_dir(pid)
        game_map = json.loads((pdir / "map.json").read_text(encoding="utf-8"))
        total = game_map["meta"]["total_matched_lines"]
        done = sum(1 for v in project["lines"].values()
                   if v.get("status") in LINE_STATUSES)
        project["progress"] = {"total": total, "done": done,
                               "percent": round(100 * done / total) if total else 0}
        project["has_local_video"] = any((pdir / "video").iterdir())
        return project

    @app.delete("/api/projects/{pid}")
    def delete_project(pid: str):
        try:
            storage.delete_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        return {"ok": True}

    @app.get("/api/projects/{pid}/story")
    def get_story(pid: str):
        """Карта реплик + статусы для раздела «Сюжет»."""
        try:
            project = storage.load_project(pid)
            pdir = storage.project_dir(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        game_map = json.loads((pdir / "map.json").read_text(encoding="utf-8"))
        lines = []
        for entry in game_map["sound_map"]:
            fid = entry["game_file_id"]
            line = project["lines"].get(fid, {})
            lines.append({**entry,
                          "status": line.get("status"),
                          "has_dub": bool(line.get("file"))})
        return {
            "video": project["video"],
            "has_local_video": any((pdir / "video").iterdir()),
            "total": game_map["meta"]["total_matched_lines"],
            "done": sum(1 for l in lines if l["status"] in LINE_STATUSES),
            "lines": lines,
        }

    # --- статусы и дубли -------------------------------------------------------
    @app.post("/api/projects/{pid}/line/{fid}/status")
    async def set_status(pid: str, fid: str, request: Request):
        body = await request.json()
        status = body.get("status")
        if status not in (*LINE_STATUSES, None):
            raise HTTPException(400, f"Неизвестный статус: {status}")
        try:
            project = storage.load_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        if status is None:
            project["lines"].pop(fid, None)
        else:
            line = project["lines"].setdefault(fid, {})
            line["status"] = status
            if status != "dubbed":
                line.pop("file", None)
        storage.save_project(project)
        return {"ok": True, "status": status}

    @app.post("/api/projects/{pid}/line/{fid}/dub")
    async def upload_dub(pid: str, fid: str, request: Request):
        """Сырые байды аудио (webm/wav/...) -> конвертация в dubs/<fid>.wav."""
        if not re.fullmatch(r"[\w-]+", fid):
            raise HTTPException(400, "Некорректный file_id")
        try:
            project = storage.load_project(pid)
            pdir = storage.project_dir(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        data = await request.body()
        if not data:
            raise HTTPException(400, "Пустой файл")
        suffix = Path(request.query_params.get("filename", "rec.webm")).suffix or ".webm"
        fd, tmp_name = tempfile.mkstemp(suffix=suffix)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as f:   # fd закрывается сразу — на Windows файл не остаётся заблокированным
                f.write(data)
            try:
                # конвертация (ffmpeg) — в отдельном потоке, чтобы не вешать сервер
                dub_path = await run_in_threadpool(
                    audio.to_game_wav, tmp, pdir / "dubs" / (fid + ".wav"))
            except (RuntimeError, OSError) as e:
                raise HTTPException(400, str(e))
            except Exception as e:  # noqa: BLE001 — например, ffmpeg вернул ошибку
                raise HTTPException(400, "Не удалось обработать аудио: " + str(e))
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except PermissionError:
                pass  # Windows иногда держит файл; мусор в Temp безвреден
        line = project["lines"].setdefault(fid, {})
        line["status"] = "dubbed"
        line["file"] = f"dubs/{dub_path.name}"
        storage.save_project(project)
        return {"ok": True, "file": line["file"]}

    @app.get("/api/projects/{pid}/line/{fid}/original")
    def get_original(pid: str, fid: str):
        try:
            project = storage.load_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        wav = storage.find_game_wav(project, fid)
        if wav is None:
            raise HTTPException(404, "Файл не найден в библиотеке: " + fid)
        return FileResponse(wav)

    @app.get("/api/projects/{pid}/line/{fid}/dub")
    def get_dub(pid: str, fid: str):
        try:
            project = storage.load_project(pid)
            pdir = storage.project_dir(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        line = project["lines"].get(fid, {})
        dub = pdir / line.get("file", "")
        if not dub.exists():
            raise HTTPException(404, "Дубль не найден")
        return FileResponse(dub)

    # --- видео -----------------------------------------------------------------
    @app.post("/api/projects/{pid}/video/local")
    async def upload_video(pid: str, request: Request):
        """Заливка локального видео без звука (потоково, на диск)."""
        try:
            pdir = storage.project_dir(pid)
            project = storage.load_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        filename = _safe_name(Path(request.query_params.get("filename", "video.mp4")).name)
        if not filename.lower().endswith((".mp4", ".webm", ".mkv")):
            raise HTTPException(400, "Поддерживаются mp4/webm/mkv")
        vdir = pdir / "video"
        for old in vdir.iterdir():
            old.unlink()
        target = vdir / filename
        with target.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        project["video"] = {"type": "local", "file": filename}
        storage.save_project(project)
        return {"ok": True, "file": filename}

    @app.post("/api/projects/{pid}/video/youtube")
    async def set_youtube(pid: str, request: Request):
        body = await request.json()
        url = body.get("url", "")
        m = re.search(r"[?&]v=([\w-]{6,})", url) or re.search(r"youtu\.be/([\w-]{6,})", url)
        if not m:
            raise HTTPException(400, "Не распознана ссылка YouTube")
        try:
            project = storage.load_project(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        project["video"] = {"type": "youtube", "url": url, "video_id": m.group(1)}
        storage.save_project(project)
        return {"ok": True}

    @app.get("/api/projects/{pid}/video/file")
    def get_video_file(pid: str):
        try:
            pdir = storage.project_dir(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        for f in (pdir / "video").iterdir():
            return FileResponse(f)
        raise HTTPException(404, "Локальное видео не загружено")

    # --- библиотеки ------------------------------------------------------------
    @app.get("/api/libraries")
    def list_libraries():
        return storage.list_libraries()

    @app.post("/api/libraries/ref")
    async def add_library_ref(request: Request):
        body = await request.json()
        try:
            lib = storage.add_library_ref(body.get("name") or "Библиотека",
                                          body.get("path"))
            return storage.get_library(lib["id"])
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/libraries/copy")
    async def add_library_copy(request: Request):
        """Скопировать папку sounds в программу (из другого источника на диске)."""
        body = await request.json()
        try:
            lib, do_copy = storage.add_library_copy(body.get("name") or "Библиотека",
                                                    body.get("path"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        job_id = jobs.start("library-copy", do_copy)
        return {"library": lib, "job_id": job_id}

    @app.post("/api/libraries/{lib_id}/upload")
    async def library_upload(lib_id: str, request: Request):
        """Потоковая заливка одного WAV в библиотеку (из браузера, webkitdirectory)."""
        lib = storage.get_library(lib_id)
        if lib is None:
            raise HTTPException(404, "Библиотека не найдена")
        filename = _safe_name(Path(request.query_params.get("filename", "")).name)
        if not filename.lower().endswith(".wav"):
            raise HTTPException(400, "Только WAV")
        target = Path(lib["path"]) / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        return {"ok": True}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "Задача не найдена")
        return job

    # --- экспорт и системное -----------------------------------------------------
    @app.post("/api/projects/{pid}/export")
    def start_export(pid: str):
        try:
            storage.project_dir(pid)
        except ValueError as e:
            raise HTTPException(404, str(e))
        job_id = jobs.start("export", lambda: exporter.export_fan_dub_mod(storage, pid))
        return {"job_id": job_id}

    @app.post("/api/open-folder")
    async def open_folder(request: Request):
        path = Path((await request.json()).get("path", ""))
        if not path.is_dir():
            raise HTTPException(400, "Папка не найдена")
        if os.name == "nt":
            os.startfile(str(path))  # noqa: S606
        return {"ok": True}

    @app.post("/api/shutdown")
    def shutdown():
        threading.Timer(0.8, lambda: os._exit(0)).start()
        return {"ok": True}

    @app.exception_handler(Exception)
    async def on_error(request: Request, exc: Exception):
        status = exc.status_code if isinstance(exc, HTTPException) else 500
        detail = exc.detail if isinstance(exc, HTTPException) else f"{type(exc).__name__}: {exc}"
        return JSONResponse({"error": str(detail)}, status_code=status)

    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
    return app
