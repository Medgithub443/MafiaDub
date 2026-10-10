"""Конвертация аудио через ffmpeg (если доступен)."""

import shutil
import subprocess
from pathlib import Path

FFMPEG = shutil.which("ffmpeg")

# путь к ffmpeg.exe рядом с exe (Inno Setup может положить его в {app})
BUNDLED_FFMPEG = None


def _ffmpeg_bin():
    if FFMPEG:
        return FFMPEG
    if BUNDLED_FFMPEG and Path(BUNDLED_FFMPEG).exists():
        return str(BUNDLED_FFMPEG)
    return None


def set_bundled_ffmpeg(path):
    global BUNDLED_FFMPEG
    BUNDLED_FFMPEG = path


def to_game_wav(src: Path, dest: Path) -> Path:
    """Привести любой аудиофайл к формату игры: mono 22050 Гц 16-bit WAV.

    Без ffmpeg — копирует исходник, но только если это уже WAV.
    Иначе (webm/mp3/ogg...) без ffmpeg получился бы «битый» .wav, поэтому
    выбрасываем понятную ошибку.
    """
    dest = dest.with_suffix(".wav")
    bin_ = _ffmpeg_bin()
    if bin_:
        result = subprocess.run(
            [bin_, "-y", "-v", "error", "-i", str(src),
             "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(dest)],
            capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError("ffmpeg не смог обработать файл: " + (result.stderr or "").strip()[-300:])
    else:
        if Path(src).suffix.lower() != ".wav":
            raise RuntimeError("ffmpeg не найден: можно загружать только WAV-файлы.")
        shutil.copy2(src, dest)
    return dest
