"""Local ForgeLab workspace server.

Serves the browser workspace and keeps provider credentials on the local
machine. The browser never receives API keys and hardware is never executed
through these endpoints.
"""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
LANDING = ROOT / "landing"
ALLOWED_EXTENSIONS = {".ino", ".cpp", ".h", ".py", ".json", ".csv", ".pdf", ".md", ".txt"}
SOURCE_FILES = {
    "firmware.ino": ROOT / "initial_firmware.ino",
    "hal_mcu.h": ROOT / "firmware" / "include" / "hal_mcu.h",
    "platformio.ini": ROOT / "firmware" / "platformio.ini",
    "sequence_engine.py": ROOT / "core" / "sequence_engine.py",
    "analysis_pipeline.py": ROOT / "industrial_control_builder" / "analysis" / "pipeline.py",
    "instrument_config.json": ROOT / "import_data" / "master_elements.json",
    "calibration.csv": ROOT / "sequence_data.csv",
    "run-notes.md": ROOT / "industrial_build_spec.md",
}


def read_context() -> str:
    sections = []
    total_chars = 0
    max_total_chars = 32000
    for name, path in SOURCE_FILES.items():
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            sections.append(f"FILE {name}: unavailable ({exc})")
            continue
        remaining = max_total_chars - total_chars
        if remaining <= 0:
            break
        excerpt = content[:min(6000, remaining)]
        sections.append(f"FILE {name}\n{excerpt}")
        total_chars += len(excerpt)
    return "\n\n".join(sections)


class ForgeLabHandler(BaseHTTPRequestHandler):
    server_version = "ForgeLabLocal/1.0"

    def log_message(self, format, *args):
        sys.stderr.write(f"[ForgeLab] {format % args}\n")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8765")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8765")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/workspace":
            self.send_json(200, {"files": self.workspace_files()})
            return
        if path.startswith("/api/file/"):
            name = path.removeprefix("/api/file/")
            self.send_file_content(name)
            return
        self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if path == "/api/chat":
            self.handle_chat(raw)
            return
        if path == "/api/upload":
            self.handle_upload(raw)
            return
        self.send_json(404, {"error": "Unknown ForgeLab endpoint."})

    def workspace_files(self):
        files = []
        for name, path in SOURCE_FILES.items():
            files.append({"name": name, "source": str(path.relative_to(ROOT)), "readOnly": True})
        return files

    def send_file_content(self, name: str):
        path = SOURCE_FILES.get(name)
        if path is None:
            self.send_json(404, {"error": f"File is not part of the workspace context: {name}"})
            return
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            self.send_json(500, {"error": f"Could not read {name}: {exc}"})
            return
        self.send_json(200, {"name": name, "source": str(path.relative_to(ROOT)), "content": content, "readOnly": True})

    def handle_chat(self, raw: bytes):
        try:
            request = json.loads(raw.decode("utf-8"))
            prompt = str(request.get("prompt", "")).strip()
            conversation = request.get("conversation", [])
            provider_name = str(request.get("provider", "ollama")).strip().lower()
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError) as exc:
            self.send_json(400, {"error": f"Invalid chat request: {exc}"})
            return
        if not prompt:
            self.send_json(400, {"error": "A prompt is required."})
            return
        try:
            from industrial_control_builder.ai_orchestrator.llm_provider import create_provider
            provider = create_provider(provider_name)
            system = (
                "You are ForgeLab, a cautious agentic engineering assistant. "
                "Use the supplied repository context for the generic 16-bit I/O spectroscopy system. "
                "Explain files, propose safe patches, and draft artifacts. Never claim execution, flashing, "
                "or verification. Existing source is read-only; every change is a reviewable draft. "
                'Return JSON with keys "dsl" and "explanation". If the user asks for code or an artifact, '
                "put the complete proposed draft in explanation and summarize the file name."
            )
            user = f"User request:\n{prompt}\n\nAuthoritative workspace context:\n{read_context()}"
            result = provider.create_plan(system, user, conversation if isinstance(conversation, list) else [])
            response = {"message": result.get("explanation", ""), "dsl": result.get("dsl", ""), "provider": provider_name}
            if prompt.lower().find("artifact") >= 0 or prompt.lower().find("generate") >= 0:
                artifact = provider.generate_artifact("firmware or integration artifact", ".draft", prompt, read_context())
                response["artifact"] = artifact
            self.send_json(200, response)
        except Exception as exc:
            self.send_json(502, {"error": f"Agent provider failed: {exc}"})

    def handle_upload(self, raw: bytes):
        try:
            request = json.loads(raw.decode("utf-8"))
            name = Path(str(request.get("name", ""))).name
            content = str(request.get("content", ""))
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError) as exc:
            self.send_json(400, {"error": f"Invalid upload request: {exc}"})
            return
        if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
            self.send_json(415, {"error": "Unsupported file type."})
            return
        self.send_json(200, {"name": name, "content": content[:16000], "readOnly": True, "source": "browser upload"})

    def serve_static(self, path: str):
        if path == "/favicon.ico":
            candidate = ROOT / "spectra.jpg"
            content = candidate.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/spectra.jpg":
            candidate = ROOT / "spectra.jpg"
            content = candidate.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        relative = "index.html" if path in {"", "/"} else path.lstrip("/")
        candidate = (LANDING / relative).resolve()
        if LANDING not in candidate.parents and candidate != LANDING:
            self.send_error(403)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        content = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"ForgeLab workspace: http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), ForgeLabHandler).serve_forever()
