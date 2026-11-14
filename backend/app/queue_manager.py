from __future__ import annotations

import asyncio
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from .chat_parser import download_chat_emotes, parse_live_chat_json
from .config import TEMP_DIR, load_settings
from .danmaku_renderer import burn_danmaku_with_ffmpeg
from .ffmpeg_tools import probe_encoders
from .models import JobCreateRequest, JobStatus, OutputMode, QueueJob
from .ytdlp_service import (
    download_thumbnail_image,
    download_video_and_chat,
    sanitize_filename,
    transcode_video_only,
)


class QueueManager:
    def __init__(self) -> None:
        self.jobs: dict[str, QueueJob] = {}
        self.order: list[str] = []
        self._cancel_flags: dict[str, threading.Event] = {}
        self._active_procs: dict[str, set[subprocess.Popen]] = {}
        self._proc_lock = threading.Lock()
        self._listeners: set[Callable[[dict[str, Any]], Coroutine[Any, Any, None]]] = set()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._running_tasks: set[asyncio.Task] = set()
        self._slot_event: Optional[asyncio.Event] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _make_proc_hook(self, jid: str) -> Callable[[subprocess.Popen, bool], None]:
        def hook(proc: subprocess.Popen, register: bool) -> None:
            with self._proc_lock:
                bucket = self._active_procs.setdefault(jid, set())
                if register:
                    bucket.add(proc)
                    ev = self._cancel_flags.get(jid)
                    if ev and ev.is_set():
                        try:
                            proc.kill()
                        except Exception:
                            pass
                else:
                    bucket.discard(proc)
        return hook

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        if self._slot_event is None:
            self._slot_event = asyncio.Event()
            self._slot_event.set()
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = loop.create_task(self._worker_loop())

    def notify_concurrency_changed(self) -> None:
        if self._slot_event is not None:
            self._slot_event.set()

    def add_listener(self, cb: Callable[[dict[str, Any]], Coroutine[Any, Any, None]]) -> None:
        self._listeners.add(cb)

    def remove_listener(self, cb: Callable[[dict[str, Any]], Coroutine[Any, Any, None]]) -> None:
        self._listeners.discard(cb)

    async def broadcast(self, event_type: str, payload: Any) -> None:
        msg = {"type": event_type, "payload": payload}
        dead = []
        for cb in list(self._listeners):
            try:
                await cb(msg)
            except Exception:
                dead.append(cb)
        for d in dead:
            self._listeners.discard(d)

    def _emit_sync(self, event_type: str, payload: Any) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(event_type, payload), self._loop)

    def list_jobs(self) -> list[QueueJob]:
        return [self.jobs[jid] for jid in self.order if jid in self.jobs]

    async def enqueue(self, req: JobCreateRequest) -> QueueJob:
        jid = uuid.uuid4().hex[:12]
        job = QueueJob(
            id=jid,
            status=JobStatus.QUEUED,
            stage_label="待機中",
            progress=0.0,
            created_at=time.time(),
            request=req,
        )
        self.jobs[jid] = job
        self.order.append(jid)
        self._cancel_flags[jid] = threading.Event()
        await self._queue.put(jid)
        await self.broadcast("job_updated", job.model_dump())
        return job

    async def cancel_job(self, jid: str) -> Optional[QueueJob]:
        import sys

        job = self.jobs.get(jid)
        if not job:
            return None
        ev = self._cancel_flags.get(jid)
        if ev:
            ev.set()
        with self._proc_lock:
            procs = list(self._active_procs.get(jid) or ())

        def _kill_proc_tree(proc: subprocess.Popen) -> None:
            pid = getattr(proc, "pid", None)
            if pid and sys.platform == "win32":
                try:
                    subprocess.run(
                        ["taskkill", "/pid", str(pid), "/f", "/t"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        timeout=5,
                    )
                except Exception:
                    pass
            try:
                proc.kill()
            except Exception:
                pass

        for proc in procs:
            asyncio.create_task(asyncio.to_thread(_kill_proc_tree, proc))
        if job.status == JobStatus.QUEUED:
            job.status = JobStatus.CANCELLED
            job.stage_label = "キャンセル済み"
            await self.broadcast("job_updated", job.model_dump())
        elif job.status in (JobStatus.DOWNLOADING, JobStatus.PARSING_CHAT, JobStatus.RENDERING):
            job.stage_label = "キャンセル中..."
            await self.broadcast("job_updated", job.model_dump())
        return job

    async def retry_job(self, jid: str) -> Optional[QueueJob]:
        old = self.jobs.get(jid)
        if not old:
            return None
        old.status = JobStatus.QUEUED
        old.stage_label = "再実行待機中"
        old.progress = 0.0
        old.fps = 0.0
        old.speed = ""
        old.eta_sec = None
        old.error = None
        old.output_files = []
        self._cancel_flags[jid] = threading.Event()
        await self._queue.put(jid)
        await self.broadcast("job_updated", old.model_dump())
        return old

    async def remove_job(self, jid: str) -> bool:
        job = self.jobs.get(jid)
        if not job:
            return False
        if job.status in (JobStatus.DOWNLOADING, JobStatus.PARSING_CHAT, JobStatus.RENDERING):
            await self.cancel_job(jid)
        self.jobs.pop(jid, None)
        self.order = [x for x in self.order if x != jid]
        self._cancel_flags.pop(jid, None)
        await self.broadcast("job_removed", {"id": jid})
        return True

    async def clear_finished(self) -> None:
        to_remove = [
            jid
            for jid, j in self.jobs.items()
            if j.status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
        ]
        for jid in to_remove:
            self.jobs.pop(jid, None)
            self._cancel_flags.pop(jid, None)
        self.order = [x for x in self.order if x in self.jobs]
        await self.broadcast("queue_snapshot", [j.model_dump() for j in self.list_jobs()])

    async def _execute_job_task(self, jid: str, job: QueueJob) -> None:
        try:
            await self._run_job(job)
        except Exception as exc:
            if self._cancel_flags.get(jid) and self._cancel_flags[jid].is_set():
                job.status = JobStatus.CANCELLED
                job.stage_label = "キャンセル済み"
                if not load_settings().keep_temp_files:
                    shutil.rmtree(TEMP_DIR / jid, ignore_errors=True)
                    if (TEMP_DIR / jid).exists():
                        await asyncio.sleep(0.25)
                        shutil.rmtree(TEMP_DIR / jid, ignore_errors=True)
            else:
                job.status = JobStatus.FAILED
                job.stage_label = "エラー"
                job.error = str(exc)
            await self.broadcast("job_updated", job.model_dump())
        finally:
            self._queue.task_done()
            if self._slot_event is not None:
                self._slot_event.set()

    async def _worker_loop(self) -> None:
        while True:
            max_jobs = max(1, min(4, int(load_settings().max_concurrent_jobs or 1)))
            while len(self._running_tasks) >= max_jobs:
                if self._slot_event is not None:
                    self._slot_event.clear()
                    await self._slot_event.wait()
                max_jobs = max(1, min(4, int(load_settings().max_concurrent_jobs or 1)))

            jid = await self._queue.get()
            job = self.jobs.get(jid)
            if not job or job.status == JobStatus.CANCELLED:
                self._queue.task_done()
                continue

            task = asyncio.create_task(self._execute_job_task(jid, job))
            self._running_tasks.add(task)
            task.add_done_callback(self._running_tasks.discard)

    def _unique_output_path(self, base_dir: Path, stem: str, ext: str) -> Path:
        cand = base_dir / f"{stem}.{ext}"
        idx = 2
        while cand.exists():
            cand = base_dir / f"{stem}_{idx}.{ext}"
            idx += 1
        return cand

    async def _run_job(self, job: QueueJob) -> None:
        req = job.request
        cancel_ev = self._cancel_flags[job.id]
        settings = load_settings()
        out_dir = Path(req.output_dir or settings.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        work_dir = TEMP_DIR / job.id
        work_dir.mkdir(parents=True, exist_ok=True)

        need_chat = req.encode.output_mode in (OutputMode.WITH_COMMENTS, OutputMode.BOTH)
        probe = probe_encoders()

        def check_cancel() -> bool:
            return cancel_ev.is_set()

        proc_hook = self._make_proc_hook(job.id)

        # 1. Download video & live chat
        job.status = JobStatus.DOWNLOADING
        job.stage_label = "ダウンロード準備中..."
        job.progress = 0.02
        await self.broadcast("job_updated", job.model_dump())

        last_emit = [0.0]

        def dl_prog(pct: float, label: str) -> None:
            if cancel_ev.is_set():
                return
            now = time.monotonic()
            if now - last_emit[0] < 0.25 and pct < 0.95:
                return
            last_emit[0] = now
            job.progress = pct * (0.45 if need_chat else 0.85)
            job.stage_label = label
            self._emit_sync("job_updated", job.model_dump())

        base_name = sanitize_filename(req.custom_filename or req.title)
        if req.clip_start_sec is not None or req.clip_end_sec is not None:
            s_lbl = int(req.clip_start_sec or 0)
            e_lbl = int(req.clip_end_sec or 0)
            base_name = f"{base_name}_clip_{s_lbl}-{e_lbl}"

        thumb_task: Optional[asyncio.Task[Optional[Path]]] = None
        if req.encode.download_thumbnail:
            thumb_task = asyncio.create_task(
                asyncio.to_thread(
                    download_thumbnail_image,
                    req.url,
                    out_dir,
                    base_name,
                    req.thumbnail,
                )
            )

        source_video, chat_path, clip_offset_sec, clip_duration_sec = await asyncio.to_thread(
            download_video_and_chat,
            req.url,
            work_dir,
            req.encode,
            need_chat,
            req.clip_start_sec,
            req.clip_end_sec,
            dl_prog,
            check_cancel,
            proc_hook,
        )

        if check_cancel():
            if thumb_task and not thumb_task.done():
                thumb_task.cancel()
            raise RuntimeError("Cancelled")

        ext = req.encode.container
        outputs: list[str] = []

        # 2. Produce clean (video_only) output if requested
        if req.encode.output_mode in (OutputMode.VIDEO_ONLY, OutputMode.BOTH):
            suffix = "_clean" if req.encode.output_mode == OutputMode.BOTH else ""
            clean_out = self._unique_output_path(out_dir, f"{base_name}{suffix}", ext)
            job.status = JobStatus.RENDERING
            job.stage_label = "コメントなし動画を出力中..."
            job.progress = 0.50 if req.encode.output_mode == OutputMode.BOTH else 0.88
            await self.broadcast("job_updated", job.model_dump())

            def clean_prog(pct: float, fps: float, speed: str, eta: Optional[int]) -> None:
                if cancel_ev.is_set():
                    return
                if req.encode.output_mode == OutputMode.VIDEO_ONLY:
                    job.progress = 0.45 + pct * 0.54
                else:
                    job.progress = 0.48 + pct * 0.09
                job.fps = round(fps, 1)
                job.speed = speed
                job.eta_sec = eta
                job.stage_label = f"コメントなし動画を出力中 ({pct*100:.1f}%)"
                self._emit_sync("job_updated", job.model_dump())

            await asyncio.to_thread(
                transcode_video_only,
                str(source_video),
                str(clean_out),
                req.encode,
                probe,
                clip_offset_sec,
                clip_duration_sec,
                clean_prog,
                cancel_ev,
                proc_hook,
            )
            outputs.append(str(clean_out))

        # 3. Parse chat & burn danmaku if requested
        if need_chat:
            if not chat_path or not chat_path.exists():
                if req.encode.output_mode == OutputMode.WITH_COMMENTS:
                    fallback_out = self._unique_output_path(out_dir, f"{base_name}_nochat", ext)
                    job.status = JobStatus.RENDERING
                    job.stage_label = "チャットなし動画を出力中..."
                    job.progress = 0.50
                    await self.broadcast("job_updated", job.model_dump())

                    def fallback_prog(pct: float, fps: float, speed: str, eta: Optional[int]) -> None:
                        if cancel_ev.is_set():
                            return
                        job.progress = 0.50 + pct * 0.49
                        job.fps = round(fps, 1)
                        job.speed = speed
                        job.eta_sec = eta
                        job.stage_label = f"チャットなし動画を出力中 ({pct*100:.1f}%)"
                        self._emit_sync("job_updated", job.model_dump())

                    await asyncio.to_thread(
                        transcode_video_only,
                        str(source_video),
                        str(fallback_out),
                        req.encode,
                        probe,
                        clip_offset_sec,
                        clip_duration_sec,
                        fallback_prog,
                        cancel_ev,
                        proc_hook,
                    )
                    outputs.append(str(fallback_out))
                job.stage_label = "完了 (チャット情報なしのため動画のみ出力)"
            else:
                job.status = JobStatus.PARSING_CHAT
                job.stage_label = "チャットデータを解析中..."
                job.progress = 0.48
                await self.broadcast("job_updated", job.model_dump())

                items = await asyncio.to_thread(
                    parse_live_chat_json,
                    chat_path,
                    req.clip_start_sec,
                    req.clip_end_sec,
                    req.comment_style.ng_words,
                    check_cancel,
                )

                if req.comment_style.custom_emotes_enabled and items:
                    def emote_prog(pct: float, label: str) -> None:
                        if cancel_ev.is_set():
                            return
                        job.progress = 0.48 + pct * 0.08
                        job.stage_label = label
                        self._emit_sync("job_updated", job.model_dump())

                    await download_chat_emotes(items, emote_prog, cancel_check=check_cancel)

                if check_cancel():
                    raise RuntimeError("Cancelled")

                job.status = JobStatus.RENDERING
                job.stage_label = f"コメント合成＆エンコード中 ({len(items)}件)..."
                job.progress = 0.58
                await self.broadcast("job_updated", job.model_dump())

                danmaku_suffix = "_danmaku" if req.encode.output_mode == OutputMode.BOTH else ""
                danmaku_out = self._unique_output_path(out_dir, f"{base_name}{danmaku_suffix}", ext)

                def render_prog(pct: float, fps: float, speed: str, eta: Optional[int]) -> None:
                    if cancel_ev.is_set():
                        return
                    job.progress = 0.58 + pct * 0.41
                    job.fps = round(fps, 1)
                    job.speed = speed
                    job.eta_sec = eta
                    job.stage_label = f"コメント合成＆エンコード中 ({pct*100:.1f}%)"
                    self._emit_sync("job_updated", job.model_dump())

                await asyncio.to_thread(
                    burn_danmaku_with_ffmpeg,
                    str(source_video),
                    str(danmaku_out),
                    items,
                    req.comment_style,
                    req.encode,
                    probe,
                    render_prog,
                    cancel_ev,
                    clip_offset_sec,
                    clip_duration_sec,
                    proc_hook,
                )
                outputs.append(str(danmaku_out))

        if thumb_task:
            try:
                thumb_path = await thumb_task
                if thumb_path and thumb_path.exists():
                    outputs.append(str(thumb_path))
            except Exception:
                pass

        if not settings.keep_temp_files:
            shutil.rmtree(work_dir, ignore_errors=True)

        job.status = JobStatus.COMPLETED
        job.progress = 1.0
        job.eta_sec = 0
        if not job.stage_label.startswith("完了"):
            job.stage_label = "完了"
        job.output_files = outputs
        await self.broadcast("job_updated", job.model_dump())
