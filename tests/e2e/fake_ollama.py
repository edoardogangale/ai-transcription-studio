"""Finto server compatibile con Ollama per i collaudi (NON è un LLM): corregge 'parola0' -> 'Parola0' (solo maiuscola: le cifre non vanno mai toccate) e segna come
fuori tema le righe che contengono 'parolina'. Serve a verificare l'interfaccia e le protezioni, non la qualità dell'AI."""
import json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._send({"models": [{"name": "qwen3:4b"}]} if self.path == "/api/tags" else {}, 200 if self.path == "/api/tags" else 404)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/pull":
            self.send_response(200); self.end_headers()
            for done in (0, 400, 1000):
                self.wfile.write((json.dumps({"status": "pulling", "digest": "d", "total": 1000, "completed": done}) + "\n").encode()); self.wfile.flush()
            self.wfile.write(b'{"status":"success"}\n'); return
        user = body["messages"][1]["content"]; out = []
        for n, text in re.findall(r"^\[(\d+)\] (.*)$", user.split("Righe da correggere:")[1], flags=re.M):
            out.append({"n": int(n), "text": text.replace("parola0", "Parola0", 1), "off_topic": "parolina" in text})
        self._send({"message": {"content": json.dumps({"lines": out})}})

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
