from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="BExtractor API")

CLIENT_OUT_DIR = (Path(__file__).resolve().parent / ".." / "client" / "out").resolve()


@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "BExtractor"}


if CLIENT_OUT_DIR.exists():
    app.mount("/_next", StaticFiles(directory=CLIENT_OUT_DIR / "_next"), name="next-static")
    app.mount("/", StaticFiles(directory=CLIENT_OUT_DIR, html=True), name="client")
else:
    @app.get("/")
    def client_not_built() -> dict[str, str]:
        return {
            "message": "BExtractor API is running. Build the Next.js client to serve the web app.",
            "expected_static_dir": str(CLIENT_OUT_DIR),
        }


@app.exception_handler(404)
def spa_fallback(_, __):
    index_file = CLIENT_OUT_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse({"detail": "Not Found"}, status_code=404)
