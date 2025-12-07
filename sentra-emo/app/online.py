import logging
import time
from typing import Any, Dict, List, Tuple

import nlpcloud

from .config import get_nlpcloud_config

logger = logging.getLogger(__name__)

_sentiment_client: Any | None = None

# Token pool for NLP Cloud API (supports multiple API tokens with cooldown on 429)
_token_tokens: List[str] = []
_token_cooldowns: List[float] = []  # epoch seconds until which the token is paused
_token_index: int = 0  # round-robin cursor
_token_cooldown_sec: float = 60.0


def _ensure_sentiment_client() -> Any:
    """Lazily initialize and return the NLP Cloud sentiment client.

    Uses NLP_CLOUD_API_TOKEN / NLP_CLOUD_SENTIMENT_MODEL / NLP_CLOUD_GPU
    from environment via get_nlpcloud_config().
    """
    global _sentiment_client
    if _sentiment_client is not None:
        return _sentiment_client

    cfg = get_nlpcloud_config()
    token = cfg.get("api_token")
    model = cfg.get("sentiment_model")
    gpu = bool(cfg.get("gpu", False))
    if not token or not model:
        raise RuntimeError(
            "NLP Cloud config missing: please set NLP_CLOUD_API_TOKEN and NLP_CLOUD_SENTIMENT_MODEL"
        )

    client = nlpcloud.Client(model, token, gpu=gpu)
    _sentiment_client = client
    logger.info("Initialized NLP Cloud sentiment client model=%s gpu=%s", model, gpu)
    return client


def _extract_label_scores(resp: Any) -> List[Tuple[str, float]]:
    """Extract (label, score) pairs from NLP Cloud sentiment response.

    The typical structure is:
      {"scored_labels": [{"label": "POSITIVE", "score": 0.9}, ...]}
    but we try to be defensive in case of minor variations.
    """
    pairs: List[Tuple[str, float]] = []
    try:
        if isinstance(resp, dict):
            scored = resp.get("scored_labels")
            if isinstance(scored, list) and scored:
                for it in scored:
                    if not isinstance(it, dict):
                        continue
                    label = str(it.get("label", "")).strip()
                    if not label:
                        continue
                    try:
                        score = float(it.get("score", 0.0))
                    except Exception:
                        score = 0.0
                    pairs.append((label, score))
        elif isinstance(resp, list):
            # Fallback: treat list of {label, score} directly
            for it in resp:
                if not isinstance(it, dict):
                    continue
                label = str(it.get("label", "")).strip()
                if not label:
                    continue
                try:
                    score = float(it.get("score", 0.0))
                except Exception:
                    score = 0.0
                pairs.append((label, score))
    except Exception as e:  # noqa: BLE001
        logger.warning("Unexpected NLP Cloud sentiment response format: %r (%s)", resp, e)

    return pairs


def _init_token_pool_if_needed() -> None:
    """Initialize token pool from configuration if not already initialized.

    Uses:
      - NLP_CLOUD_API_TOKEN (comma-separated list)
      - NLP_CLOUD_TOKEN_COOLDOWN_SEC
    via get_nlpcloud_config().
    """
    global _token_tokens, _token_cooldowns, _token_index, _token_cooldown_sec
    if _token_tokens:
        return

    cfg = get_nlpcloud_config()
    tokens_cfg = cfg.get("api_tokens") or []
    tokens: List[str] = [str(t).strip() for t in tokens_cfg if str(t).strip()]
    if not tokens:
        single = cfg.get("api_token")
        if single:
            tokens = [str(single)]
    if not tokens:
        raise RuntimeError("NLP Cloud config missing: please set NLP_CLOUD_API_TOKEN")

    cooldown_val = cfg.get("token_cooldown")
    try:
        _token_cooldown_sec = float(cooldown_val) if cooldown_val is not None else 60.0
    except Exception:
        _token_cooldown_sec = 60.0

    now = time.time()
    _token_tokens = tokens
    _token_cooldowns = [0.0 for _ in tokens]
    _token_index = 0
    logger.info(
        "Initialized NLP Cloud token pool size=%d cooldown=%.1f sec (all available from %.0f)",
        len(_token_tokens),
        _token_cooldown_sec,
        now,
    )


def _pick_token() -> Tuple[str, int]:
    """Pick the next available token according to round-robin and cooldown.

    Raises RuntimeError if all tokens are currently cooling down.
    """
    _init_token_pool_if_needed()
    global _token_index
    n = len(_token_tokens)
    if n == 0:
        raise RuntimeError("NLP Cloud token pool is empty")

    now = time.time()
    start = _token_index
    for i in range(n):
        idx = (start + i) % n
        if _token_cooldowns[idx] <= now:
            _token_index = (idx + 1) % n
            return _token_tokens[idx], idx

    # All tokens are in cooldown
    raise RuntimeError("All NLP Cloud API tokens are cooling down due to rate limiting")


def _mark_token_rate_limited(index: int) -> None:
    """Mark a token as rate-limited, putting it into cooldown window."""
    global _token_cooldowns
    if index < 0 or index >= len(_token_cooldowns):
        return
    now = time.time()
    until = now + max(0.0, _token_cooldown_sec)
    prev = _token_cooldowns[index]
    _token_cooldowns[index] = max(prev, until)
    logger.warning(
        "NLP Cloud token index=%d is rate-limited; cooling down until %.0f (for %.1f sec)",
        index,
        _token_cooldowns[index],
        _token_cooldown_sec,
    )


def _is_rate_limit_error(e: Exception) -> bool:
    """Heuristically detect NLP Cloud rate-limit (429) errors from exception."""
    msg = str(e)
    if "429" in msg and "Too Many Requests" in msg:
        return True
    if "Rate limit" in msg or "maximum number of requests per minute" in msg:
        return True
    # Try to inspect response.status_code if present (requests.HTTPError-like)
    resp = getattr(e, "response", None)
    try:
        code = getattr(resp, "status_code", None)
        if int(code) == 429:  # type: ignore[arg-type]
            return True
    except Exception:
        pass
    return False


def _call_sentiment_api(model: str, text: str) -> Any:
    """Call NLP Cloud sentiment endpoint with token rotation and cooldown.

    This helper:
      - Picks a usable token from the pool (not cooling down)
      - Creates a client for (model, token)
      - Calls client.sentiment(text)
      - On 429: marks the token in cooldown and retries with other tokens
    """
    if not model:
        raise RuntimeError("NLP Cloud model is not configured")
    if not text:
        raise ValueError("text must be non-empty")

    cfg = get_nlpcloud_config()
    gpu = bool(cfg.get("gpu", False))

    _init_token_pool_if_needed()
    last_error: Exception | None = None

    # At most try each token once per call
    n_tokens = max(1, len(_token_tokens))
    for _ in range(n_tokens):
        try:
            token, idx = _pick_token()
        except Exception as e:  # noqa: BLE001
            last_error = e
            break

        client = nlpcloud.Client(model, token, gpu=gpu)
        try:
            return client.sentiment(text)
        except Exception as e:  # noqa: BLE001
            last_error = e
            if _is_rate_limit_error(e):
                _mark_token_rate_limited(idx)
                # Try next available token
                continue
            logger.error("NLP Cloud sentiment API call failed (non-rate-limit) with token index %d: %s", idx, e)
            raise

    if last_error is not None:
        if _is_rate_limit_error(last_error):
            logger.error("NLP Cloud sentiment API call failed: all tokens appear rate-limited: %s", last_error)
        raise last_error

    raise RuntimeError("NLP Cloud sentiment API call failed with no available tokens")


def _derive_sentiment_from_pairs(pairs: List[Tuple[str, float]]) -> Tuple[str, Dict[str, float]]:
    """Convert raw (label, score) pairs into a sentiment distribution.

    This function tries to bucket arbitrary emotion labels into
    positive/negative/neutral when possible, while staying robust for
    generic sentiment models that already return POSITIVE/NEGATIVE/NEUTRAL.
    """
    tmp: Dict[str, float] = {}
    for lbl, s in pairs:
        l = str(lbl).lower().strip()
        key: str | None = None

        # Direct sentiment words
        if "pos" in l or "positive" in l:
            key = "positive"
        elif "neg" in l or "negative" in l:
            key = "negative"
        elif "neu" in l or "neutral" in l:
            key = "neutral"
        else:
            # Map common emotion labels to sentiment buckets, esp. for
            # Distilbert emotion-style models (love/joy/anger/...).
            positive_emotions = {
                "love",
                "joy",
                "amusement",
                "optimism",
                "gratitude",
                "admiration",
                "excitement",
                "desire",
                "pride",
                "relief",
                "happiness",
                "caring",
                "approval",
            }
            negative_emotions = {
                "anger",
                "fear",
                "sadness",
                "disgust",
                "contempt",
                "disappointment",
                "remorse",
                "guilt",
                "embarrassment",
                "grief",
                "nervousness",
                "confusion",
                "disapproval",
            }
            neutral_emotions = {"surprise", "curiosity", "neutral"}

            if l in positive_emotions:
                key = "positive"
            elif l in negative_emotions:
                key = "negative"
            elif l in neutral_emotions:
                key = "neutral"

        if key is None:
            # Fallback: keep original label as a sentiment key
            key = str(lbl)

        try:
            score = float(s)
        except Exception:
            score = 0.0
        if score < 0.0:
            score = 0.0
        tmp[key] = tmp.get(key, 0.0) + score

    if not tmp:
        tmp = {"neutral": 1.0}

    total = sum(tmp.values()) or 1.0
    scores = {k: (v / total) for k, v in tmp.items()}
    label = max(scores.items(), key=lambda x: x[1])[0]
    return label, scores


def analyze_sentiment_nlpcloud(text: str) -> Dict[str, Any]:
    """Call NLP Cloud sentiment API and adapt result to local sentiment dict format.

    Returns a dict with keys:
      - label: str
      - scores: Dict[str, float]
      - raw_model: str
    which matches ModelManager.analyze_sentiment()'s output structure.
    """
    if not text:
        raise ValueError("text must be non-empty")

    cfg = get_nlpcloud_config()
    model = cfg.get("sentiment_model") or ""
    try:
        resp = _call_sentiment_api(model, text)
    except Exception as e:  # noqa: BLE001
        logger.error("NLP Cloud sentiment call failed: %s", e)
        raise

    pairs = _extract_label_scores(resp)
    if not pairs:
        raise RuntimeError(f"Empty sentiment scores from NLP Cloud: {resp!r}")

    label, scores = _derive_sentiment_from_pairs(pairs)

    cfg = get_nlpcloud_config()
    model = cfg.get("sentiment_model") or "nlpcloud"
    return {
        "label": label,
        "scores": scores,
        "raw_model": model,
    }


def analyze_combined_nlpcloud(text: str) -> Tuple[Dict[str, Any], List[Tuple[str, float]]]:
    """Single NLP Cloud call returning both sentiment dict and emotion scores.

    This is used in online backend when sentiment and emotion share the same
    model. It reuses the cached sentiment client created by
    `_ensure_sentiment_client`.
    """
    if not text:
        raise ValueError("text must be non-empty")

    cfg = get_nlpcloud_config()
    model = cfg.get("sentiment_model") or ""
    try:
        resp = _call_sentiment_api(model, text)
    except Exception as e:  # noqa: BLE001
        logger.error("NLP Cloud combined call failed: %s", e)
        raise

    pairs = _extract_label_scores(resp)
    if not pairs:
        raise RuntimeError(f"Empty scores from NLP Cloud: {resp!r}")

    label, scores = _derive_sentiment_from_pairs(pairs)

    cfg = get_nlpcloud_config()
    model = cfg.get("sentiment_model") or "nlpcloud"
    sentiment = {
        "label": label,
        "scores": scores,
        "raw_model": model,
    }
    return sentiment, pairs


def analyze_emotions_nlpcloud(text: str) -> List[Tuple[str, float]]:
    """Call NLP Cloud sentiment API and return raw emotion label-score pairs.

    This reuses the same endpoint as analyze_sentiment_nlpcloud but exposes the
    full distribution (e.g. love/joy/anger/...). It is intended to feed the
    `emotions` field, VAD, and stress computation in online backend mode.
    """
    if not text:
        raise ValueError("text must be non-empty")

    cfg = get_nlpcloud_config()
    model = cfg.get("emotion_model") or cfg.get("sentiment_model")
    if not model:
        raise RuntimeError(
            "NLP Cloud config missing: please set NLP_CLOUD_API_TOKEN and NLP_CLOUD_SENTIMENT_MODEL (and optional NLP_CLOUD_EMOTION_MODEL)"
        )

    try:
        resp = _call_sentiment_api(model, text)
    except Exception as e:  # noqa: BLE001
        logger.error("NLP Cloud emotion call failed: %s", e)
        raise

    pairs = _extract_label_scores(resp)
    if not pairs:
        raise RuntimeError(f"Empty emotion scores from NLP Cloud: {resp!r}")
    return pairs
