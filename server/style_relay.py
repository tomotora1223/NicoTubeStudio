"""Standalone 1-file FastAPI community style relay server for NicoTube Studio.

Run with:
    uvicorn style_relay:app --host 0.0.0.0 --port 8787
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

STORE_FILE = Path(__file__).with_name("styles_store.json")
MAX_ENTRIES = 200

app = FastAPI(title="NicoTube Studio Style Relay")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class RelayStylePayload(BaseModel):
    name: str
    author: str = "Anonymous"
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    config: dict[str, Any]


def _load() -> list[dict]:
    if STORE_FILE.exists():
        try:
            data = json.loads(STORE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


@app.get("/styles")
def get_styles() -> list[dict]:
    return _load()


@app.post("/styles")
def post_style(payload: RelayStylePayload) -> dict:
    if not isinstance(payload.config, dict) or not payload.name.strip():
        raise HTTPException(status_code=400, detail="Invalid payload")
    items = _load()
    entry = {
        "id": f"relay-{uuid.uuid4().hex[:10]}",
        "name": payload.name.strip()[:80],
        "author": (payload.author or "Anonymous").strip()[:40],
        "description": payload.description.strip()[:240],
        "tags": [str(t)[:20] for t in payload.tags[:6]],
        "source": "relay",
        "created_at": time.time(),
        "config": payload.config,
    }
    items.insert(0, entry)
    STORE_FILE.write_text(json.dumps(items[:MAX_ENTRIES], ensure_ascii=False, indent=2), encoding="utf-8")
    return entry
