from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .musicxml import ScoreFormatError


LOCAL_ENV_FILE = Path(__file__).resolve().parent.parent / ".env.local"


def _load_local_env() -> None:
    """Load local secrets without exposing them to the frontend or Git."""
    if not LOCAL_ENV_FILE.exists():
        return
    try:
        lines = LOCAL_ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        name = name.strip()
        value = value.strip().strip("\"'")
        if name and value:
            os.environ.setdefault(name, value)


_load_local_env()


@dataclass(frozen=True)
class ModelDefinition:
    id: str
    provider: str
    provider_label: str
    name: str
    description: str
    status: str = "stable"


MODEL_CATALOG = (
    ModelDefinition(
        id="deterministic-score-parser",
        provider="built-in",
        provider_label="内置 Agent",
        name="确定性乐谱解析",
        description="音符识别、左右手判断和 CDEFGAB 标注",
    ),
    ModelDefinition(
        id="gemini-3.7-flash",
        provider="google-ai-studio",
        provider_label="Google AI Studio",
        name="Gemini 3.7 Flash",
        description="最新的多模态与 Agent 工作流模型",
    ),
    ModelDefinition(
        id="gemini-3.6-flash",
        provider="google-ai-studio",
        provider_label="Google AI Studio",
        name="Gemini 3.6 Flash",
        description="速度与多模态能力平衡的 Agent 模型",
    ),
    ModelDefinition(
        id="gemini-3.5-flash",
        provider="google-ai-studio",
        provider_label="Google AI Studio",
        name="Gemini 3.5 Flash",
        description="面向日常任务的稳定通用模型",
    ),
    ModelDefinition(
        id="gemini-3.5-flash-lite",
        provider="google-ai-studio",
        provider_label="Google AI Studio",
        name="Gemini 3.5 Flash-Lite",
        description="高吞吐、低成本的轻量模型",
    ),
)

_active_model_id = os.getenv("AI_PIANO_MODEL", MODEL_CATALOG[0].id)
_runtime_google_api_key: str | None = None


def _definition(model_id: str) -> ModelDefinition:
    model = next((item for item in MODEL_CATALOG if item.id == model_id), None)
    if model is None:
        raise ScoreFormatError("不支持的模型")
    return model


def google_api_key() -> str | None:
    return _runtime_google_api_key or os.getenv("GEMINI_API_KEY")


def list_models() -> dict:
    configured = google_api_key() is not None
    return {
        "active_model_id": _active_model_id,
        "google_configured": configured,
        "models": [
            {
                "id": model.id,
                "provider": model.provider,
                "provider_label": model.provider_label,
                "name": model.name,
                "description": model.description,
                "status": model.status,
                "configured": model.provider != "google-ai-studio" or configured,
            }
            for model in MODEL_CATALOG
        ],
    }


def configure_model(model_id: str, api_key: str | None = None) -> dict:
    global _active_model_id, _runtime_google_api_key

    model = _definition(model_id)
    if model.provider == "google-ai-studio":
        if api_key is not None:
            cleaned_key = api_key.strip()
            _runtime_google_api_key = cleaned_key or None
        if google_api_key() is None:
            raise ScoreFormatError("请先配置 Google AI Studio API Key")

    _active_model_id = model.id
    return list_models()


def validate_model_selection(model_id: str) -> str:
    model = _definition(model_id)
    if model.provider == "google-ai-studio" and google_api_key() is None:
        raise ScoreFormatError("请先配置 Google AI Studio API Key")
    return model.id


def _extract_generate_content_text(payload: dict) -> str:
    for candidate in payload.get("candidates", []):
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            if part.get("text"):
                return str(part["text"])
    return ""


def test_model(model_id: str, prompt: str, api_key: str | None = None) -> dict:
    model = _definition(model_id)
    if model.provider == "built-in":
        return {
            "model_id": model.id,
            "provider": model.provider,
            "text": "内置确定性 Agent 已就绪，可执行乐谱解析和 CDEFGAB 标注。",
        }

    key = api_key.strip() if api_key and api_key.strip() else google_api_key()
    if not key:
        raise ScoreFormatError("请先配置 Google AI Studio API Key")
    if not prompt.strip():
        raise ScoreFormatError("测试提示词不能为空")

    request = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model.id}:generateContent",
        data=json.dumps(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt.strip()}],
                    }
                ]
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )

    try:
        with urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", {})
            message = detail.get("message", str(exc))
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = str(exc)
        raise ScoreFormatError(f"Google AI Studio 请求失败：{message}") from exc
    except URLError as exc:
        raise ScoreFormatError(f"无法连接 Google AI Studio：{exc.reason}") from exc

    text = _extract_generate_content_text(payload)
    if not text:
        raise ScoreFormatError("Google AI Studio 没有返回文本结果")
    return {"model_id": model.id, "provider": model.provider, "text": text}


def active_model_id() -> str:
    return _active_model_id
