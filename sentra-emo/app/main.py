import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import time
from typing import List, Optional

from .schemas import AnalyzeRequest, AnalyzeResponse, LabelScore, SentimentResult, VADResult, PADResult, StressResult, BatchAnalyzeRequest, UserState
from .models import ModelManager
from .analysis import emotions_to_vad, derive_stress, init_vad_mapper, get_vad_status, canonicalize_distribution, normalize_distribution
from .config import get_device_report, use_emotion_label_alias, get_emo_backend, get_online_provider, get_nlpcloud_config, get_emotion_min_score
from .user_store import get_store

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

models = ModelManager()

_metrics = {
    "start_time": time.perf_counter(),
    "inference_latencies_ms": [],  # type: List[float]
    "inference_count": 0,
    "error_count": 0,
    "emotion_top1_scores": [],  # type: List[float]
    "emotion_top1_times": [],  # type: List[float]
}


def _record_latency_ms(ms: float) -> None:
    _metrics["inference_count"] += 1
    buf: List[float] = _metrics["inference_latencies_ms"]
    buf.append(float(ms))
    # cap buffer size to avoid unbounded growth
    if len(buf) > 2000:
        del buf[: len(buf) - 1000]


def _percentile(values: List[float], q: float):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    idx = int(q * (n - 1))
    idx = max(0, min(idx, n - 1))
    return float(s[idx])


def _record_emotion_top1(score: float) -> None:
    _metrics["emotion_top1_scores"].append(float(score))
    _metrics["emotion_top1_times"].append(float(time.perf_counter()))
    if len(_metrics["emotion_top1_scores"]) > 2000:
        del _metrics["emotion_top1_scores"][: len(_metrics["emotion_top1_scores"]) - 1000]
        del _metrics["emotion_top1_times"][: len(_metrics["emotion_top1_times"]) - 1000]


def _analyze_sentiment_with_backend(text: str):
    """Select sentiment backend according to configuration.

    - EMO_BACKEND=local: always use local ModelManager
    - EMO_BACKEND=online and EMO_ONLINE_PROVIDER=nlpcloud: always use NLP Cloud
    - EMO_BACKEND=auto and EMO_ONLINE_PROVIDER=nlpcloud: prefer local, fallback to NLP Cloud
    """
    mode = get_emo_backend()
    provider = get_online_provider()

    # Online only
    if mode == "online" and provider == "nlpcloud":
        from .online import analyze_sentiment_nlpcloud

        return analyze_sentiment_nlpcloud(text)

    # Auto: prefer local, fallback to online
    if mode == "auto" and provider == "nlpcloud":
        try:
            return models.analyze_sentiment(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("Local sentiment failed in auto mode, falling back to NLP Cloud: %s", e)
            from .online import analyze_sentiment_nlpcloud

            return analyze_sentiment_nlpcloud(text)

    # Default: local backend
    return models.analyze_sentiment(text)


def _analyze_emotions_with_backend(text: str):
    """Select emotion backend according to configuration.

    - EMO_BACKEND=local: always use local ModelManager (Chinese-Emotion-Small).
    - EMO_BACKEND=online and EMO_ONLINE_PROVIDER=nlpcloud: use NLP Cloud
      zho_Hans/distilbert-base-uncased-emotion distribution directly.
    - EMO_BACKEND=auto and EMO_ONLINE_PROVIDER=nlpcloud: prefer local, fallback
      to NLP Cloud on failure.
    """
    mode = get_emo_backend()
    provider = get_online_provider()

    # Online only
    if mode == "online" and provider == "nlpcloud":
        from .online import analyze_emotions_nlpcloud

        return analyze_emotions_nlpcloud(text)

    # Auto: prefer local, fallback to online
    if mode == "auto" and provider == "nlpcloud":
        try:
            return models.analyze_emotions(text)
        except Exception as e:  # noqa: BLE001
            logger.warning("Local emotions failed in auto mode, falling back to NLP Cloud: %s", e)
            from .online import analyze_emotions_nlpcloud

            return analyze_emotions_nlpcloud(text)

    # Default: local backend
    return models.analyze_emotions(text)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    try:
        emo_pipe, emo_mid = models.ensure_emotion()
        labels = []
        try:
            id2label = getattr(emo_pipe.model.config, "id2label", None)
            if isinstance(id2label, dict) and id2label:
                numeric_keys = [k for k in id2label.keys() if isinstance(k, int) or (isinstance(k, str) and str(k).isdigit())]
                if numeric_keys:
                    idxs = sorted([int(k) for k in id2label.keys()])
                    labels = [str(id2label[i]) for i in idxs]
                else:
                    labels = [str(v) for v in id2label.values()]
        except Exception:
            labels = []
        init_vad_mapper(emo_mid, labels if labels else None)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Startup VAD init skipped: {e}")

    try:
        models.ensure_sentiment()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Startup sentiment preload skipped: {e}")

    # Log device report once at startup
    try:
        dev = get_device_report()
        logger.info(
            "Device decision: using=%s index=%s name=%s cuda_available=%s count=%s (mode=%s selector=%s)",
            dev.get("using"),
            dev.get("index"),
            dev.get("device_name"),
            dev.get("cuda_available"),
            dev.get("cuda_device_count"),
            dev.get("mode"),
            dev.get("selector"),
        )
    except Exception:
        pass

    yield
    # Teardown (nothing for now)


app = FastAPI(title="Sentra Emo: 文本情绪/情感/VAD/PAD/压力分析", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/analyze", response_model=AnalyzeResponse, response_model_exclude_none=True)
async def analyze(req: AnalyzeRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")

    t0 = time.perf_counter()
    try:
        backend_mode = get_emo_backend()
        provider = get_online_provider()

        # Ensure emotion model and VAD mapper only when using local backend.
        if not (backend_mode == "online" and provider == "nlpcloud"):
            emo_pipe, emo_mid = models.ensure_emotion()
            labels = []
            try:
                id2label = getattr(emo_pipe.model.config, "id2label", None)
                if isinstance(id2label, dict) and id2label:
                    numeric_keys = [k for k in id2label.keys() if isinstance(k, int) or (isinstance(k, str) and str(k).isdigit())]
                    if numeric_keys:
                        idxs = sorted([int(k) for k in id2label.keys()])
                        labels = [str(id2label[i]) for i in idxs]
                    else:
                        labels = [str(v) for v in id2label.values()]
            except Exception:
                labels = []
            init_vad_mapper(emo_mid, labels if labels else None)

        # Online+NLP Cloud 优化：若情感和情绪使用同一模型，只发一次 HTTP 请求
        sentiment = None
        emotions_pairs = None
        if backend_mode == "online" and provider == "nlpcloud":
            cfg = get_nlpcloud_config()
            sent_model = cfg.get("sentiment_model")
            emo_model = cfg.get("emotion_model")
            same_model = (emo_model is None) or (emo_model == sent_model)
            if same_model:
                from .online import analyze_combined_nlpcloud

                sentiment, emotions_pairs = analyze_combined_nlpcloud(text)

        if sentiment is None or emotions_pairs is None:
            sentiment = _analyze_sentiment_with_backend(text)
            emotions_pairs = _analyze_emotions_with_backend(text)
        if use_emotion_label_alias():
            canon_pairs = canonicalize_distribution(emotions_pairs)
        else:
            canon_pairs = emotions_pairs

        # 应用情绪最小分数阈值过滤（仅当配置 > 0 时生效）
        min_score = get_emotion_min_score()
        if min_score > 0.0:
            filtered = [(k, float(vv)) for k, vv in canon_pairs if float(vv) >= min_score]
            # 只有在仍有剩余标签时才替换，避免全部被过滤导致信息丢失
            if filtered:
                canon_pairs = filtered
                canon_pairs = normalize_distribution(canon_pairs)
        v, a, d = emotions_to_vad(canon_pairs)
        stress, level = derive_stress(v, a, canon_pairs)

        user_state: Optional[UserState] = None
        if (req.userid or "").strip():
            try:
                user_state = get_store().update_user(
                    userid=req.userid.strip(),
                    username=(req.username or "").strip() or None,
                    text=text,
                    sentiment_label=str(sentiment.get("label")) if isinstance(sentiment, dict) else None,
                    vad=VADResult(valence=float(v), arousal=float(a), dominance=float(d), method="emotion_mapping"),
                    stress=StressResult(score=float(stress), level=level),
                    emotions=[LabelScore(label=k, score=float(vv)) for k, vv in canon_pairs],
                )
            except Exception:
                user_state = None

        # Decide emotion model name for telemetry field
        emotion_model_name = models._emotion_model_id or "unknown"
        if backend_mode in {"online", "auto"} and provider == "nlpcloud":
            cfg = get_nlpcloud_config()
            emotion_model_name = (
                cfg.get("emotion_model")
                or cfg.get("sentiment_model")
                or emotion_model_name
            )

        resp = AnalyzeResponse(
            sentiment=SentimentResult(**sentiment),
            emotions=[LabelScore(label=k, score=float(v)) for k, v in canon_pairs],
            vad=VADResult(valence=float(v), arousal=float(a), dominance=float(d), method="emotion_mapping"),
            pad=PADResult(pleasure=float(v), arousal=float(a), dominance=float(d)),
            stress=StressResult(score=float(stress), level=level),
            models={
                "sentiment": sentiment.get("raw_model", "unknown"),
                "emotion": emotion_model_name,
            },
            user=user_state,
        )
        dt_ms = (time.perf_counter() - t0) * 1000.0
        _record_latency_ms(dt_ms)
        try:
            sent_label = getattr(resp.sentiment, "label", None)
            vad_v = float(getattr(resp.vad, "valence", 0.0))
            vad_a = float(getattr(resp.vad, "arousal", 0.0))
            vad_d = float(getattr(resp.vad, "dominance", 0.0))
            stress_level = getattr(resp.stress, "level", None)
        except Exception:
            sent_label, stress_level, vad_v, vad_a, vad_d = None, None, 0.0, 0.0, 0.0
        try:
            if canon_pairs:
                _record_emotion_top1(float(canon_pairs[0][1]))
        except Exception:
            pass
        logger.info(
            "Analyze OK in %.1f ms | sent=%s stress=%s V=%.2f A=%.2f D=%.2f text_len=%d",
            dt_ms,
            sent_label,
            stress_level,
            vad_v,
            vad_a,
            vad_d,
            len(text),
        )
        return resp
    except Exception as e:  # noqa: BLE001
        dt_ms = (time.perf_counter() - t0) * 1000.0
        _record_latency_ms(dt_ms)
        _metrics["error_count"] += 1
        logger.exception("Analyze error in %.1f ms: %s", dt_ms, e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze/batch", response_model=List[AnalyzeResponse], response_model_exclude_none=True)
async def analyze_batch(req: BatchAnalyzeRequest):
    texts = [str(t or "").strip() for t in (req.texts or [])]
    texts = [t for t in texts if t]
    if not texts:
        raise HTTPException(status_code=400, detail="texts 不能为空且需包含至少一条非空文本")

    backend_mode = get_emo_backend()
    provider = get_online_provider()

    # Preload local models and initialize VAD mapper only when backend is local/auto.
    if not (backend_mode == "online" and provider == "nlpcloud"):
        try:
            emo_pipe, emo_mid = models.ensure_emotion()
            labels = []
            try:
                id2label = getattr(emo_pipe.model.config, "id2label", None)
                if isinstance(id2label, dict) and id2label:
                    numeric_keys = [k for k in id2label.keys() if isinstance(k, int) or (isinstance(k, str) and str(k).isdigit())]
                    if numeric_keys:
                        idxs = sorted([int(k) for k in id2label.keys()])
                        labels = [str(id2label[i]) for i in idxs]
                    else:
                        labels = [str(v) for v in id2label.values()]
            except Exception:
                labels = []
            init_vad_mapper(emo_mid, labels if labels else None)
        except Exception as e:  # noqa: BLE001
            logger.exception("Batch startup VAD init failed: %s", e)
            raise HTTPException(status_code=500, detail=str(e))

        try:
            models.ensure_sentiment()
        except Exception as e:  # noqa: BLE001
            logger.exception("Batch sentiment preload failed: %s", e)
            raise HTTPException(status_code=500, detail=str(e))

    results: List[AnalyzeResponse] = []
    use_alias = use_emotion_label_alias()
    for text in texts:
        t0 = time.perf_counter()
        try:
            sentiment = None
            emotions_pairs = None
            if backend_mode == "online" and provider == "nlpcloud":
                cfg = get_nlpcloud_config()
                sent_model = cfg.get("sentiment_model")
                emo_model = cfg.get("emotion_model")
                same_model = (emo_model is None) or (emo_model == sent_model)
                if same_model:
                    from .online import analyze_combined_nlpcloud

                    sentiment, emotions_pairs = analyze_combined_nlpcloud(text)

            if sentiment is None or emotions_pairs is None:
                sentiment = _analyze_sentiment_with_backend(text)
                emotions_pairs = _analyze_emotions_with_backend(text)
            if use_alias:
                canon_pairs = canonicalize_distribution(emotions_pairs)
            else:
                canon_pairs = emotions_pairs

            min_score = get_emotion_min_score()
            if min_score > 0.0:
                filtered = [(k, float(vv)) for k, vv in canon_pairs if float(vv) >= min_score]
                if filtered:
                    canon_pairs = filtered
                    canon_pairs = normalize_distribution(canon_pairs)
            v, a, d = emotions_to_vad(canon_pairs)
            stress, level = derive_stress(v, a, canon_pairs)

            user_state: Optional[UserState] = None
            if (getattr(req, "userid", None) or "").strip():
                try:
                    user_state = get_store().update_user(
                        userid=req.userid.strip(),
                        username=(getattr(req, "username", None) or "").strip() or None,
                        text=text,
                        sentiment_label=str(sentiment.get("label")) if isinstance(sentiment, dict) else None,
                        vad=VADResult(valence=float(v), arousal=float(a), dominance=float(d), method="emotion_mapping"),
                        stress=StressResult(score=float(stress), level=level),
                        emotions=[LabelScore(label=k, score=float(vv)) for k, vv in canon_pairs],
                    )
                except Exception:
                    user_state = None

            # Decide emotion model name for telemetry field
            emotion_model_name = models._emotion_model_id or "unknown"
            if backend_mode in {"online", "auto"} and provider == "nlpcloud":
                cfg = get_nlpcloud_config()
                emotion_model_name = (
                    cfg.get("emotion_model")
                    or cfg.get("sentiment_model")
                    or emotion_model_name
                )

            resp = AnalyzeResponse(
                sentiment=SentimentResult(**sentiment),
                emotions=[LabelScore(label=k, score=float(vv)) for k, vv in canon_pairs],
                vad=VADResult(valence=float(v), arousal=float(a), dominance=float(d), method="emotion_mapping"),
                pad=PADResult(pleasure=float(v), arousal=float(a), dominance=float(d)),
                stress=StressResult(score=float(stress), level=level),
                models={
                    "sentiment": sentiment.get("raw_model", "unknown"),
                    "emotion": emotion_model_name,
                },
                user=user_state,
            )
            dt_ms = (time.perf_counter() - t0) * 1000.0
            _record_latency_ms(dt_ms)
            try:
                if canon_pairs:
                    _record_emotion_top1(float(canon_pairs[0][1]))
            except Exception:
                pass
            logger.info(
                "Analyze(batch) OK in %.1f ms | text_len=%d",
                dt_ms,
                len(text),
            )
            results.append(resp)
        except Exception as e:  # noqa: BLE001
            dt_ms = (time.perf_counter() - t0) * 1000.0
            _record_latency_ms(dt_ms)
            _metrics["error_count"] += 1
            logger.exception("Analyze(batch) error in %.1f ms: %s", dt_ms, e)
            raise HTTPException(status_code=500, detail=str(e))

    return results


@app.get("/user/{userid}", response_model=UserState, response_model_exclude_none=True)
async def get_user(userid: str):
    u = get_store().load_user(userid)
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    return u


@app.get("/user/{userid}/events")
async def get_user_events(userid: str, limit: int = 200, start: str | None = None, end: str | None = None):
    return get_store().list_events(userid, limit=limit, start=start, end=end)


@app.get("/user/{userid}/analytics")
async def get_user_analytics(userid: str, days: int = 30, start: str | None = None, end: str | None = None):
    """Get user emotion analytics summary. If start/end are provided (ISO), they override days."""
    return get_store().get_analytics(userid, days=days, start=start, end=end)


@app.post("/user/{userid}/export")
async def export_user_data(userid: str):
    """Export user events to Parquet format for visualization tools."""
    try:
        parquet_path = get_store().export_user_parquet(userid)
        return {"status": "success", "path": str(parquet_path), "format": "parquet"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models")
async def models_status():
    """Return available models, selected models, and VAD mapping/alias sources and unknown-labels info."""
    try:
        status = models.get_status()
        status["backend"] = get_emo_backend()
    except Exception as e:  # pragma: no cover
        status = {"error": str(e)}
    try:
        vad = get_vad_status()
    except Exception as e:  # pragma: no cover
        vad = {"error": str(e)}
    return {"models": status, "vad": vad}


@app.get("/metrics")
async def metrics():
    lat = _metrics["inference_latencies_ms"]
    avg = (sum(lat) / len(lat)) if lat else None
    es = _metrics["emotion_top1_scores"]
    et = _metrics["emotion_top1_times"]
    now = float(time.perf_counter())
    def _recent(vals: List[float], times: List[float], window_sec: float):
        if not vals or not times:
            return {"avg": None, "p50": None, "p95": None, "p99": None, "count": 0}
        sel = [v for v, t in zip(vals, times) if (now - t) <= window_sec]
        if not sel:
            return {"avg": None, "p50": None, "p95": None, "p99": None, "count": 0}
        a = sum(sel) / len(sel)
        return {"avg": float(a), "p50": _percentile(sel, 0.50), "p95": _percentile(sel, 0.95), "p99": _percentile(sel, 0.99), "count": len(sel)}
    return {
        "uptime_sec": (time.perf_counter() - _metrics["start_time"]),
        "inference_count": _metrics["inference_count"],
        "error_count": _metrics["error_count"],
        "inference_latency_ms": {
            "avg": float(avg) if avg is not None else None,
            "p50": _percentile(lat, 0.50),
            "p95": _percentile(lat, 0.95),
            "p99": _percentile(lat, 0.99),
        },
        "model_load_sec": models.get_status(),
        "device": get_device_report(),
        "emotion_top1_score": {
            "avg": (sum(es) / len(es)) if es else None,
            "p50": _percentile(es, 0.50),
            "p95": _percentile(es, 0.95),
            "p99": _percentile(es, 0.99),
            "count": len(es),
        },
        "emotion_top1_score_recent": {
            "60s": _recent(es, et, 60.0),
            "300s": _recent(es, et, 300.0),
        },
    }
