/* MafiaDub 0.1-alpha — фронтенд (vanilla JS, без сборки) */

const view = document.getElementById("view");

/* ---------- утилиты ---------- */

async function api(url, opts = {}) {
    const r = await fetch(url, opts);
    if (!r.ok) {
        let msg = r.statusText;
        try { msg = (await r.json()).error || msg; } catch (e) { /* не JSON */ }
        throw new Error(msg);
    }
    return r.json();
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
}

/* ---------- роутинг ---------- */

window.addEventListener("hashchange", render);

function render() {
    const h = location.hash || "#/";
    const parts = h.slice(2).split("/");
    stopRegion();
    stopRecorder(true);
    if (parts[0] === "" ) return renderHome();
    if (parts[0] === "new") return renderNewProject();
    if (parts[0] === "p" && parts[1]) return renderProject(parts[1], parts[2] || "story");
    location.hash = "#/";
}

/* ---------- главная: список проекттов ---------- */

async function renderHome() {
    view.innerHTML = `<h1>Проекты</h1><div class="card">Загрузка…</div>`;
    let projects;
    try { projects = await api("/api/projects"); }
    catch (e) { return view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }

    const rows = projects.map(p => `
        <div class="card">
            <div class="row spread">
                <div>
                    <b>${esc(p.name)}</b>
                    <div class="muted">обновлён: ${esc(p.updated)}</div>
                </div>
                <div class="row">
                    <div class="progressbar"><div style="width:${p.percent}%"></div></div>
                    <span class="muted">${p.done} / ${p.total}</span>
                    <a class="button" href="#/p/${p.id}"><button class="primary">Открыть</button></a>
                    <button class="danger small" onclick="deleteProject('${p.id}')">Удалить</button>
                </div>
            </div>
        </div>`).join("");

    view.innerHTML = `
        <div class="row spread">
            <h1>Проекты</h1>
            <div class="row">
                <a href="#/new"><button class="primary">Создать проект</button></a>
                <button onclick="shutdownApp()">Выход</button>
            </div>
        </div>
        ${rows || `<div class="card muted">Проектов пока нет. Создайте первый!</div>`}`;
}

async function deleteProject(id) {
    if (!confirm("Удалить проект вместе со всеми дублями?")) return;
    await api("/api/projects/" + id, { method: "DELETE" });
    render();
}

async function shutdownApp() {
    await api("/api/shutdown", { method: "POST" });
    view.innerHTML = `<div class="card">MafiaDub остановлен. Можно закрыть вкладку.</div>`;
}

/* ---------- создание проекта ---------- */

let selectedLibrary = null;
let currentLibs = [];

async function renderNewProject() {
    selectedLibrary = null;
    view.innerHTML = `<h1>Новый проект</h1><div class="card">Загрузка…</div>`;
    currentLibs = await api("/api/libraries");

    view.innerHTML = `
        <h1>Новый проект</h1>
        <div class="card">
            <h2>1. Название</h2>
            <input type="text" id="projName" placeholder="Например: Mafia — чешский фандаб">
        </div>
        <div class="card">
            <h2>2. Папка sounds (оригинальные реплики игры)</h2>
            <div id="libList"></div>
            <div class="row" style="margin-top:12px">
                <input type="text" id="libPath" placeholder="C:\\Games\\Mafia\\sounds — путь к папке на диске" style="flex:1">
                <button onclick="addRefLibrary()">Добавить с диска</button>
            </div>
            <div id="libErr" class="err"></div>
        </div>
        <div class="row">
            <a href="#/"><button>Назад</button></a>
            <button class="primary" id="createBtn" onclick="createProject()" disabled>Создать проект</button>
        </div>`;
    drawLibraries();
}

function drawLibraries() {
    const libs = currentLibs;
    const box = document.getElementById("libList");
    if (!libs.length) {
        box.innerHTML = `<div class="muted">Библиотек пока нет — добавьте папку sounds с диска.</div>`;
        return;
    }
    box.innerHTML = libs.map(l => `
        <div class="lib-option ${selectedLibrary === l.id ? "selected" : ""}" data-id="${l.id}">
            <b>${esc(l.name)}</b>
            <span class="muted">— ${l.wav_count} wav, ${l.kind === "copy" ? "копия в программе" : esc(l.path)}</span>
        </div>`).join("");
    box.querySelectorAll(".lib-option").forEach(opt =>
        opt.onclick = () => { selectedLibrary = opt.dataset.id; drawLibraries(); });
    document.getElementById("createBtn").disabled = !selectedLibrary;
}

async function addRefLibrary() {
    const path = document.getElementById("libPath").value.trim();
    const err = document.getElementById("libErr");
    err.textContent = "";
    if (!path) return;
    try {
        await api("/api/libraries/ref", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: path.split(/[\\/]/).filter(Boolean).pop(), path })
        });
        currentLibs = await api("/api/libraries");
        selectedLibrary = currentLibs[currentLibs.length - 1].id;
        drawLibraries();
    } catch (e) { err.textContent = e.message; }
}

async function createProject() {
    const name = document.getElementById("projName").value.trim();
    if (!name) return alert("Введите название проекта");
    const p = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, library_id: selectedLibrary })
    });
    location.hash = "#/p/" + p.id;
}

/* ---------- страница проекта ---------- */

async function renderProject(pid, tab) {
    let project;
    try { project = await api("/api/projects/" + pid); }
    catch (e) { view.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }

    const tabs = `
        <div class="tabs">
            <a href="#/p/${pid}/story" class="${tab === "story" ? "active" : ""}">Сюжет</a>
            <a href="#/p/${pid}/extra" class="${tab === "extra" ? "active" : ""}">Дополнительно</a>
            <a href="#/p/${pid}/export" class="${tab === "export" ? "active" : ""}">Экспорт</a>
            <a href="#/" style="margin-left:auto">← К проектам</a>
        </div>
        <div class="row spread">
            <h1>${esc(project.name)}</h1>
            <div class="row">
                <div class="progressbar"><div style="width:${project.progress.percent}%"></div></div>
                <span class="muted">сюжет: ${project.progress.done} / ${project.progress.total}</span>
            </div>
        </div>`;

    if (tab === "story") return renderStory(pid, tabs);
    if (tab === "export") return renderExport(pid, project, tabs);
    view.innerHTML = tabs + `<div class="card">
        <h2>Дополнительно</h2>
        <p class="muted">Озвучка звуков и реплик вне карты сюжета. Интерфейс в разработке.</p>
    </div>`;
}

/* ---------- экспорт ---------- */

async function renderExport(pid, project, tabs) {
    view.innerHTML = tabs + `
        <div class="card">
            <h2>Экспорт в Fan Dub Mod</h2>
            <p class="muted">Будет создана папка <b>FanDubMod_${esc(project.name)}/sounds</b> —
            полная копия библиотеки sounds проекта, где озвученные реплики заменены вашими дублями.
            Положите её вместо оригинальной папки sounds игры.</p>
            <button class="primary" onclick="startExport('${pid}')">Экспортировать</button>
            <div id="exportStatus" class="statusmsg" style="margin-top:12px"></div>
        </div>`;
}

async function startExport(pid) {
    const status = document.getElementById("exportStatus");
    status.textContent = "Экспорт…";
    const { job_id } = await api(`/api/projects/${pid}/export`, { method: "POST" });
    const poll = setInterval(async () => {
        const job = await api("/api/jobs/" + job_id);
        if (job.state === "running") return;
        clearInterval(poll);
        if (job.state === "error") { status.innerHTML = `<span class="err">${esc(job.error)}</span>`; return; }
        const r = job.result;
        status.innerHTML = `Готово: заменено реплик — <b>${r.replaced}</b>.<br>
            Папка: <code>${esc(r.mod_dir)}</code><br><br>
            <button onclick="openFolder('${esc(r.mod_dir)}')">Открыть папку</button>`;
    }, 1500);
}

async function openFolder(path) {
    await api("/api/open-folder", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
    });
}

/* ---------- сюжет: озвучка ---------- */

const S = {
    pid: null, lines: [], idx: 0, video: null,
    yt: null, ytReady: false, useYT: false,
    hintOn: true, regionTimer: null, hintPlayed: false,
    rec: null, recBusy: false, recBlob: null, recUrl: null,
};

async function renderStory(pid, tabs) {
    S.pid = pid;
    const story = await api(`/api/projects/${pid}/story`);
    S.lines = story.lines;
    S.video = story.video;
    S.idx = S.lines.findIndex(l => !l.status);
    if (S.idx < 0) S.idx = 0;

    const useYT = S.video.type === "youtube" && S.video.video_id && !story.has_local_video;

    view.innerHTML = tabs + `
        <div class="row" style="margin-bottom:10px">
            <label><input type="checkbox" id="hintChk" ${S.hintOn ? "checked" : ""}>
                озвучка-подсказка (оригинал из Sounds)</label>
            <span class="muted">видео: ${useYT ? "YouTube (поток, без скачивания)" : "локальный файл"}</span>
            <span style="flex:1"></span>
            <input type="file" id="videoUpload" accept="video/mp4,video/webm,video/x-matroska" hidden>
            <button class="small" onclick="document.getElementById('videoUpload').click()">Загрузить локальное видео</button>
        </div>
        <div class="story-layout">
            <div class="lines-panel" id="linesPanel"></div>
            <div class="workspace">
                <div class="video-box" id="videoBox">Загрузка видео…</div>
                <div class="line-card" id="lineCard"></div>
                <div class="controls" id="controls"></div>
                <div class="statusmsg" id="statusMsg"></div>
            </div>
        </div>`;

    document.getElementById("hintChk").onchange = e => { S.hintOn = e.target.checked; };
    document.getElementById("videoUpload").onchange = e => uploadVideo(e.target.files[0]);
    drawLinesPanel();
    drawLineCard();
    initPlayer(useYT);
}

function drawLinesPanel() {
    const panel = document.getElementById("linesPanel");
    panel.innerHTML = S.lines.map((l, i) => `
        <div class="line-row ${i === S.idx ? "current" : ""}" data-i="${i}">
            <span class="muted">${i + 1}</span>
            <span class="fid">${esc(l.game_file_id)} · ${fmtTime(l.start_seconds)}–${fmtTime(l.end_seconds)}</span>
            <span class="dot ${l.status || ""}"></span>
        </div>`).join("");
    panel.querySelectorAll(".line-row").forEach(row =>
        row.onclick = () => { S.idx = +row.dataset.i; refreshCurrent(); });
    const cur = panel.querySelector(".line-row.current");
    if (cur) cur.scrollIntoView({ block: "center" });
}

function drawLineCard() {
    const l = S.lines[S.idx];
    const badge = l.status ? `<span class="badge ${l.status}">${
        { dubbed: "озвучено", silence: "тишина", original: "как в игре" }[l.status]}</span>` :
        `<span class="badge">не озвучено</span>`;
    document.getElementById("lineCard").innerHTML = `
        <div class="row spread">
            <div>
                Реплика <b>${S.idx + 1}</b> / ${S.lines.length}
                &nbsp;<span class="fid">${esc(l.game_file_id)}</span> &nbsp;${badge}
            </div>
            <div class="muted">${fmtTime(l.start_seconds)} – ${fmtTime(l.end_seconds)}
                (${l.duration.toFixed(2)} с)</div>
        </div>`;
    document.getElementById("controls").innerHTML = `
        <button onclick="playRegion()">▶ Фрагмент</button>
        <button onclick="playOriginal()">♪ Оригинал</button>
        <span class="sep"></span>
        <button id="recBtn" onclick="toggleRecord()">● Запись</button>
        <button id="playDubBtn" onclick="playDub()" ${(l.has_dub || S.recBlob) ? "" : "disabled"}>▶ Мой дуб</button>
        <input type="file" id="dubFile" accept="audio/*" hidden>
        <button onclick="document.getElementById('dubFile').click()">Загрузить файл</button>
        <span class="sep"></span>
        <button onclick="saveAndNext()" ${S.recBlob ? "" : "disabled"}>💾 Сохранить дуб</button>
        <button onclick="skipLine('silence')">Пропустить: тишина</button>
        <button onclick="pickOriginal()">Пропустить: как в игре</button>
        <button onclick="goBack()">← Назад</button>`;
    document.getElementById("dubFile").onchange = e => uploadDubFile(e.target.files[0]);
}

function refreshCurrent() {
    stopRegion();
    stopRecorder(true);   // при смене реплики незаконченную запись отбрасываем
    clearRecording();
    drawLinesPanel();
    drawLineCard();
    setMsg("");
}

function setMsg(text, isErr = false) {
    const m = document.getElementById("statusMsg");
    if (m) m.innerHTML = isErr ? `<span class="err">${esc(text)}</span>` : esc(text);
}

/* ---------- плеер ---------- */

function initPlayer(useYT) {
    const box = document.getElementById("videoBox");
    if (useYT) {
        S.useYT = true;
        box.innerHTML = `<div id="ytPlayer"></div>`;
        if (!window.YT) {
            const tag = document.createElement("script");
            tag.src = "https://www.youtube.com/iframe_api";
            document.head.appendChild(tag);
        }
        window.onYouTubeIframeAPIReady = () => createYT();
        if (window.YT && YT.Player) createYT();
    } else {
        S.useYT = false;
        box.innerHTML = `<video id="localVideo" src="/api/projects/${S.pid}/video/file"
                          playsinline></video>`;
    }
}

function createYT() {
    S.yt = new YT.Player("ytPlayer", {
        videoId: S.video.video_id,
        playerVars: { rel: 0, modestbranding: 1 },
        events: { onReady: () => { S.ytReady = true; S.yt.mute(); } }
    });
}

function playerTime() {
    if (S.useYT) return S.ytReady && S.yt.getCurrentTime ? S.yt.getCurrentTime() : 0;
    const v = document.getElementById("localVideo");
    return v ? v.currentTime : 0;
}

function playerSeekPlay(from) {
    if (S.useYT) { S.yt.seekTo(from, true); S.yt.playVideo(); }
    else { const v = document.getElementById("localVideo"); v.currentTime = from; v.play(); }
}

function playerPause() {
    if (S.useYT) S.ytReady && S.yt.pauseVideo();
    else { const v = document.getElementById("localVideo"); v && v.pause(); }
}

function playRegion() {
    const l = S.lines[S.idx];
    const from = Math.max(0, l.start_seconds - 0.8);
    const to = l.end_seconds + 0.3;
    stopRegion();
    S.hintPlayed = false;
    playerSeekPlay(from);
    S.regionTimer = setInterval(() => {
        const t = playerTime();
        if (!S.hintPlayed && t >= l.start_seconds) {
            S.hintPlayed = true;
            if (S.hintOn) playOriginal();
        }
        if (t >= to) stopRegion();
    }, 120);
}

function stopRegion() {
    if (S.regionTimer) { clearInterval(S.regionTimer); S.regionTimer = null; }
    if (document.getElementById("localVideo") || S.ytReady) playerPause();
}

function playOriginal() {
    new Audio(`/api/projects/${S.pid}/line/${S.lines[S.idx].game_file_id}/original`).play();
}

function playDub() {
    // сначала — только что записанный (ещё не сохранённый) дубль, иначе — сохранённый на сервере
    const src = S.recUrl
        ? S.recUrl
        : `/api/projects/${S.pid}/line/${S.lines[S.idx].game_file_id}/dub?t=${Date.now()}`;
    new Audio(src).play().catch(e => setMsg("Не удалось воспроизвести: " + e.message, true));
}

/* ---------- запись ---------- */

function releaseStream(stream) {
    // принудительно освобождаем микрофон
    if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) { /* уже остановлена */ } });
}

function clearRecording() {
    if (S.recUrl) URL.revokeObjectURL(S.recUrl);
    S.recUrl = null;
    S.recBlob = null;
}

function setRecBtn(recording) {
    const b = document.getElementById("recBtn");
    if (!b) return;
    b.innerHTML = recording ? '<span class="rec-dot"></span>Стоп' : "● Запись";
}

async function toggleRecord() {
    if (S.recBusy) return;   // идёт обработка предыдущей записи

    // --- Если запись УЖЕ ИДЁТ — останавливаем ---
    if (S.rec && S.rec.recorder.state === "recording") {
        setMsg("Остановка записи…");
        stopRecorder(false);
        return;
    }

    // --- Иначе — начинаем запись ---
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        return setMsg("Нет доступа к микрофону: " + e.message, true);
    }

    clearRecording();
    drawLineCard();   // сбросить «Сохранить дуб» / «Мой дуб» на время новой записи

    const rec = { stream, recorder: null, chunks: [], discard: false, fallback: null };
    try {
        rec.recorder = new MediaRecorder(stream);
    } catch (e) {
        releaseStream(stream);
        return setMsg("Запись не поддерживается в этом браузере: " + e.message, true);
    }
    S.rec = rec;

    rec.recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    };

    rec.recorder.onerror = e => {
        releaseStream(rec.stream);
        if (S.rec === rec) S.rec = null;
        setRecBtn(false);
        setMsg("Ошибка записи: " + ((e.error && e.error.message) || "неизвестная"), true);
    };

    // Вся разблокировка интерфейса — строго здесь
    rec.recorder.onstop = async () => {
        if (rec.fallback) { clearTimeout(rec.fallback); rec.fallback = null; }
        releaseStream(rec.stream);                 // микрофон точно свободен
        if (S.rec === rec) S.rec = null;
        setRecBtn(false);

        if (rec.discard || !document.getElementById("lineCard")) return;   // запись отброшена

        if (!rec.chunks.length) {
            return setMsg("Запись пустая — ничего не записалось. Попробуйте ещё раз.", true);
        }

        const rawBlob = new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" });
        S.recBusy = true;
        setMsg("Обработка записи…");
        try {
            // Браузер пишет webm/opus; переводим в настоящий WAV (mono 22050 Гц, 16 бит)
            S.recBlob = await blobToGameWav(rawBlob);
        } catch (e) {
            console.warn("WAV-конвертация не удалась, оставляю исходный формат:", e);
            S.recBlob = rawBlob;
        } finally {
            S.recBusy = false;
        }
        if (!document.getElementById("lineCard")) { clearRecording(); return; }
        S.recUrl = URL.createObjectURL(S.recBlob);
        drawLineCard();
        setMsg(`Запись готова (${(S.recBlob.size / 1024).toFixed(0)} КБ). Прослушайте («▶ Мой дуб») и сохраните.`);
    };

    try {
        rec.recorder.start();
    } catch (e) {
        releaseStream(stream);
        S.rec = null;
        return setMsg("Не удалось начать запись: " + e.message, true);
    }
    setRecBtn(true);
    setMsg("Идёт запись…");
}

// Остановка записи. discard=true — выбросить результат (смена реплики/страницы)
function stopRecorder(discard) {
    const rec = S.rec;
    if (!rec) return;
    if (discard) rec.discard = true;

    if (rec.recorder.state !== "inactive") {
        try {
            rec.recorder.stop();   // onstop сработает сам
        } catch (e) {
            releaseStream(rec.stream);
            S.rec = null;
            setRecBtn(false);
            return;
        }
        // страховка: если onstop по какой-то причине не пришёл — не зависаем
        rec.fallback = setTimeout(() => {
            if (S.rec === rec) {
                releaseStream(rec.stream);
                S.rec = null;
                setRecBtn(false);
                setMsg("Запись остановлена, но данные не получены. Попробуйте ещё раз.", true);
            }
        }, 4000);
    } else {
        releaseStream(rec.stream);
        S.rec = null;
    }
}

/* ---- кодирование в WAV на стороне браузера (не зависит от ffmpeg на сервере) ---- */

async function blobToGameWav(blob) {
    const data = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let decoded;
    try { decoded = await ctx.decodeAudioData(data); }
    finally { ctx.close(); }

    const rate = 22050;
    const length = Math.max(1, Math.ceil(decoded.duration * rate));
    const off = new OfflineAudioContext(1, length, rate);   // 1 канал = автоматический даунмикс в моно
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return encodeWav(rendered.getChannelData(0), rate);
}

function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const dv = new DataView(buf);
    const wr = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
    wr(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true);
    wr(8, "WAVE"); wr(12, "fmt ");
    dv.setUint32(16, 16, true);          // размер блока fmt
    dv.setUint16(20, 1, true);           // PCM
    dv.setUint16(22, 1, true);           // моно
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true);    // байт/сек
    dv.setUint16(32, 2, true);           // выравнивание
    dv.setUint16(34, 16, true);          // 16 бит
    wr(36, "data"); dv.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
        const x = Math.max(-1, Math.min(1, samples[i]));
        dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
}

/* ---------- сохранение дубля ---------- */

// Отправка аудио на сервер: сырые байты в теле запроса, имя файла — в query (как ждёт web.py)
async function postDub(pid, fid, blob, filename) {
    return api(`/api/projects/${pid}/line/${encodeURIComponent(fid)}/dub?filename=${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: blob
    });
}

async function saveAndNext() {
    if (!S.recBlob) return;
    const idx = S.idx;
    const fid = S.lines[idx].game_file_id;
    const ext = S.recBlob.type === "audio/wav" ? "wav" : "webm";
    setMsg("Сохранение дубля…");
    try {
        await postDub(S.pid, fid, S.recBlob, "rec." + ext);
    } catch (e) {
        return setMsg("Не удалось сохранить: " + e.message, true);
    }
    S.lines[idx].status = "dubbed";
    S.lines[idx].has_dub = true;
    clearRecording();
    nextLine();
}

async function uploadDubFile(file) {
    if (!file) return;
    const idx = S.idx;
    const fid = S.lines[idx].game_file_id;
    setMsg("Загрузка файла…");
    try {
        await postDub(S.pid, fid, file, file.name);
    } catch (e) {
        return setMsg("Не удалось загрузить: " + e.message, true);
    }
    S.lines[idx].status = "dubbed";
    S.lines[idx].has_dub = true;
    clearRecording();
    nextLine();
}

/* ---------- навигация по таймлайну ---------- */

async function skipLine(status) {
    const fid = S.lines[S.idx].game_file_id;
    await api(`/api/projects/${S.pid}/line/${fid}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
    });
    S.lines[S.idx].status = status;
    S.lines[S.idx].has_dub = false;
    nextLine();
}

async function pickOriginal() {
    const fid = S.lines[S.idx].game_file_id;
    await api(`/api/projects/${S.pid}/line/${fid}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "original" })
    });
    S.lines[S.idx].status = "original";
    playRegion(); // смотрим/слушаем фрагмент как в игре
    setTimeout(() => { nextLine(); }, (S.lines[S.idx].duration + 1.6) * 1000);
}

function nextLine() {
    if (S.idx < S.lines.length - 1) {
        S.idx++;
        refreshCurrent();
        const left = S.lines.filter(l => !l.status).length;
        if (left === 0) setMsg("🎉 Сюжет полностью озвучен! Можно экспортировать в Fan Dub Mod.");
    } else {
        drawLinesPanel();
        drawLineCard();
        const left = S.lines.filter(l => !l.status).length;
        setMsg(left === 0 ? "🎉 Сюжет полностью озвучен!" : "Это была последняя реплика. Осталось без статуса: " + left);
    }
}

function goBack() {
    if (S.idx > 0) { S.idx--; refreshCurrent(); }
}

/* ---------- видео ---------- */

async function uploadVideo(file) {
    if (!file) return;
    setMsg("Загрузка видео… (для 3.5-часового файла это займёт время)");
    try {
        await api(`/api/projects/${S.pid}/video/local?filename=${encodeURIComponent(file.name)}`,
            { method: "POST", body: file });
        location.reload();
    } catch (e) { setMsg(e.message, true); }
}

// первый рендер при загрузке страницы
render();
