"""司南基金 后端入口（FastAPI）。

本地启动：
    cd backend
    python -m venv .venv && .venv\\Scripts\\activate   # Windows
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="司南基金 API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://aureliuswu.github.io",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "fund-compass", "version": app.version}
