# coding=utf-8
"""
选题终端后台任务队列

单 worker 串行执行 LLM 类任务（TOP10 打分 / 单条深度研判）：
- 避免 LLM 并发限流（与 ai_filter 管线的 batch_interval 用意一致）
- 幂等提交：同 dedupe_key 且仍在排队/运行中的任务直接复用任务号
- 进度上报：任务函数通过 TaskHandle.set_progress(done, total) 汇报
"""

import threading
import uuid
from collections import deque
from typing import Any, Callable, Dict, Optional


class TaskHandle:
    """单个任务的句柄与状态记录"""

    def __init__(self, task_id: str, kind: str, dedupe_key: str, payload: Any = None):
        self.id = task_id
        self.kind = kind
        self.dedupe_key = dedupe_key
        self.payload = payload          # 任务入参（如 research 的选题 key）
        self.state = "pending"          # pending / running / done / error
        self.progress = {"done": 0, "total": 0}
        self.error = ""
        self.started_at = ""
        self.finished_at = ""

    def set_progress(self, done: int, total: int) -> None:
        if total >= 0:
            self.progress = {"done": max(0, done), "total": total}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "state": self.state,
            "progress": dict(self.progress),
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class TaskQueue:
    """FIFO 单 worker 任务队列（进程内，重启即失；前端以轮询获知结果）"""

    MAX_HISTORY = 200

    def __init__(self, now_func: Callable[[], str] = lambda: ""):
        self._queue: "deque[TaskHandle]" = deque()
        self._registry: Dict[str, TaskHandle] = {}
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._worker: Optional[threading.Thread] = None
        self._now = now_func

    def start(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._worker_loop, name="terminal-tasks", daemon=True)
        self._worker.start()

    def submit(
        self,
        kind: str,
        fn: Callable[[TaskHandle], Any],
        dedupe_key: str = "",
        payload: Any = None,
    ) -> str:
        """
        提交任务。fn(handle) 在 worker 线程中执行（handle.payload 为入参）；
        同 kind + dedupe_key 的 pending/running 任务会被复用（幂等）。
        """
        with self._cond:
            for handle in list(self._queue):
                if handle.kind == kind and handle.dedupe_key == dedupe_key:
                    return handle.id
            handle = TaskHandle(f"t_{uuid.uuid4().hex[:8]}", kind, dedupe_key, payload=payload)
            self._registry[handle.id] = handle
            self._queue.append(handle)
            # 防止历史表无限膨胀：超限时清掉已结束的旧任务
            if len(self._registry) > self.MAX_HISTORY * 2:
                finished = [tid for tid, h in self._registry.items() if h.state in ("done", "error")]
                finished.sort(key=lambda tid: self._registry[tid].finished_at or "")
                for tid in finished[: len(finished) - self.MAX_HISTORY]:
                    self._registry.pop(tid, None)
            self._cond.notify()
        return handle.id

    def get(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            handle = self._registry.get(task_id)
            return handle.to_dict() if handle else None

    def _worker_loop(self) -> None:
        while True:
            with self._cond:
                while not self._queue:
                    self._cond.wait()
                handle = self._queue.popleft()
                handle.state = "running"
                handle.started_at = self._now()
            try:
                fn = self._resolve_job(handle)
                if fn is not None:
                    fn(handle)
                handle.state = "done"
            except Exception as e:  # noqa: BLE001 —— 任务失败不能拖垮 worker
                handle.state = "error"
                handle.error = str(e)
            finally:
                handle.finished_at = self._now()

    def _resolve_job(self, handle: TaskHandle) -> Optional[Callable[[TaskHandle], Any]]:
        """由 server 启动时注入 kind → fn 映射后可解析任务体"""
        fn = getattr(self, "_job_bindings", {}).get(handle.kind)
        return fn


def bind_jobs(queue: TaskQueue, bindings: Dict[str, Callable[[TaskHandle], Any]]) -> None:
    """为队列绑定 kind → 任务函数 的映射"""
    queue._job_bindings = dict(bindings)  # noqa: SLF001 —— 包内装配用
