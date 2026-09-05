import base64
import os
from functools import wraps

from flask import Flask, jsonify, render_template, request, Response

from jishe_meter import query_meter, read_meter

app = Flask(__name__)

DASHBOARD_USER = os.getenv("DASHBOARD_USER", "")
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "")


def _authorized() -> bool:
    """HTTP Basic authentication. Disabled only when credentials are unset."""
    if not DASHBOARD_USER or not DASHBOARD_PASSWORD:
        return True

    auth = request.authorization
    return bool(
        auth
        and auth.username == DASHBOARD_USER
        and auth.password == DASHBOARD_PASSWORD
    )


def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        if not _authorized():
            return Response(
                "Authentication required",
                401,
                {"WWW-Authenticate": 'Basic realm="Jishe Meter"'},
            )
        return func(*args, **kwargs)

    return wrapper


@app.get("/")
@require_auth
def index():
    return render_template("index.html")


@app.get("/api/status")
@require_auth
def api_status():
    try:
        return jsonify({"ok": True, "data": query_meter()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.post("/api/read")
@require_auth
def api_read():
    try:
        read_result = read_meter()
        latest = query_meter()
        return jsonify({
            "ok": True,
            "read": read_result,
            "data": latest,
        })
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.get("/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=False)
