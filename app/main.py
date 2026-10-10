"""Точка входа MafiaDub: локальный сервер + автооткрытие браузера."""

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

import uvicorn

from .storage import Storage
from .web import create_app


def bundled_dir() -> Path:
    """Папка со static/ и assets/ (в exe — временная папка PyInstaller)."""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent.parent


def default_data_dir() -> Path:
    env = os.environ.get("MAFIADUB_DATA")
    if env:
        return Path(env)
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "MafiaDub"


def find_free_port(preferred=8471):
    for port in range(preferred, preferred + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("Не найден свободный порт")


def main():
    ap = argparse.ArgumentParser(prog="MafiaDub")
    ap.add_argument("--data-dir", default=None, help="папка данных (по умолчанию %LOCALAPPDATA%/MafiaDub)")
    ap.add_argument("--port", type=int, default=0, help="порт (по умолчанию — первый свободный от 8471)")
    ap.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    args = ap.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    storage = Storage(data_dir, bundled_dir() / "assets")
    app = create_app(storage, bundled_dir() / "static")
    port = args.port or find_free_port()

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    print(f"MafiaDub запущен: http://127.0.0.1:{port}  (данные: {data_dir})")
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
