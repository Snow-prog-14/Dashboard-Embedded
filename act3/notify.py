# notify.py — stdlib-only email notifier (with /health and /test)
import base64, json, os, re, smtplib, ssl, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from email.message import EmailMessage

# --- Configure via env or edit defaults ---
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))     # 587 (STARTTLS) or 465 (SSL)
SMTP_USER = os.getenv("SMTP_USER", "you@example.com")
SMTP_PASS = os.getenv("SMTP_PASS", "app_password_or_smtp_key")
MAIL_FROM = os.getenv("MAIL_FROM", f"Motion Monitor <{SMTP_USER}>")
MAIL_TO   = os.getenv("MAIL_TO", "you@example.com")
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
COOLDOWN_MS = int(os.getenv("COOLDOWN_MS", "120000"))  # 2 min
SMTP_DEBUG = int(os.getenv("SMTP_DEBUG", "0"))
PORT = int(os.getenv("PORT", "5001"))

_last_sent_at = 0

def parse_data_url(data_url: str):
  if data_url.startswith("data:"):
    header, b64 = data_url.split(",", 1)
    m = re.match(r"data:(image/[^;]+);base64", header)
    mime = m.group(1) if m else "image/jpeg"
  else:
    b64, mime = data_url, "image/jpeg"
  data = base64.b64decode(b64)
  main, sub = mime.split("/", 1)
  return data, main, sub

def send_email(ts_ms: int, img_data_url: str, intensity: float, pir: int):
  img_bytes, mime_main, mime_sub = parse_data_url(img_data_url)
  when_iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts_ms / 1000))
  subject = f"[Motion] PIR:{'ON' if pir else 'OFF'} Intensity:{intensity:.2f} @ {when_iso}"

  msg = EmailMessage()
  msg["From"] = MAIL_FROM
  msg["To"] = MAIL_TO
  msg["Subject"] = subject
  msg.set_content(f"Motion detected.\n\nPIR: {pir}\nIntensity: {intensity:.3f}\nTime: {when_iso}\n")
  msg.add_alternative(
    f"<p><b>Motion detected</b></p><ul>"
    f"<li>PIR: {pir}</li><li>Intensity: {intensity:.3f}</li><li>Time: {when_iso}</li>"
    f"</ul><p>See attached snapshot.</p>", subtype="html"
  )
  msg.add_attachment(img_bytes, maintype=mime_main, subtype=mime_sub, filename=f"capture-{ts_ms}.{mime_sub}")

  if SMTP_PORT == 465:
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context()) as s:
      s.set_debuglevel(SMTP_DEBUG); s.login(SMTP_USER, SMTP_PASS); s.send_message(msg)
  else:
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
      s.set_debuglevel(SMTP_DEBUG); s.ehlo(); s.starttls(context=ssl.create_default_context())
      s.login(SMTP_USER, SMTP_PASS); s.send_message(msg)

class Handler(BaseHTTPRequestHandler):
  def _cors(self):
    self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
    self.send_header("Access-Control-Allow-Headers", "content-type")
    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

  def do_OPTIONS(self):
    self.send_response(204); self._cors(); self.end_headers()

  def do_GET(self):
    if self.path == "/health":
      self.send_response(200); self._cors(); self.end_headers()
      self.wfile.write(json.dumps({"ok": True, "time": int(time.time()*1000)}).encode()); return
    if self.path == "/test":
      try:
        now_ms = int(time.time()*1000)
        sample_b64 = ("/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEA8QDw8QDw8QDw8PDw8PDw8PFREWFhURFRUY"
                      "HSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0t"
                      "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAKcBNwMBIgACEQEDEQH/xAAX"
                      "AAADAQAAAAAAAAAAAAAAAAQBAgUG/8QAFxEBAQEBAAAAAAAAAAAAAAAAAQACIf/aAAwDAQACEQMR"
                      "AAAArwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
                      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/EABYRAAMAAAAAAAAAAAAAAAAAAAABIf/a"
                      "AAgBAQABBQK9H//EABYRAAMAAAAAAAAAAAAAAAAAAAABIf/aAAgBAgEBPwK0H//EABYRAQEBAAAA"
                      "AAAAAAAAAAAAAAABIf/aAAgBAwEBPwK0H//Z")
        send_email(now_ms, "data:image/jpeg;base64,"+sample_b64, 0.0, 0)
        self.send_response(200); self._cors(); self.end_headers()
        self.wfile.write(b'{"ok":true,"sent":"test"}'); return
      except Exception as e:
        self.send_response(500); self._cors(); self.end_headers()
        self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode()); return
    self.send_response(404); self._cors(); self.end_headers()

  def do_POST(self):
    if self.path != "/notify":
      self.send_response(404); self._cors(); self.end_headers(); return
    length = int(self.headers.get("Content-Length", "0"))
    raw = self.rfile.read(length) if length > 0 else b"{}"
    try:
      data = json.loads(raw.decode("utf-8"))
    except Exception:
      self.send_response(400); self._cors(); self.end_headers()
      self.wfile.write(b'{"ok":false,"error":"bad json"}'); return

    ts = int(data.get("ts", 0))
    imageData = data.get("imageData", "")
    intensity = float(data.get("intensity", 0.0))
    pir = 1 if data.get("pir") else 0

    if not ts or not imageData:
      self.send_response(400); self._cors(); self.end_headers()
      self.wfile.write(b'{"ok":false,"error":"missing ts or imageData"}'); return

    global _last_sent_at
    now_ms = int(time.time() * 1000)
    if now_ms - _last_sent_at < COOLDOWN_MS:
      self.send_response(429); self._cors(); self.end_headers()
      payload = {"ok": False, "error": "cooldown", "nextAllowed": _last_sent_at + COOLDOWN_MS}
      self.wfile.write(json.dumps(payload).encode()); return

    try:
      send_email(ts, imageData, intensity, pir)
      _last_sent_at = now_ms
      self.send_response(200); self._cors(); self.end_headers()
      self.wfile.write(b'{"ok":true}')
    except Exception as e:
      self.send_response(500); self._cors(); self.end_headers()
      self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

def main():
  print(f"Notifier listening on http://localhost:{PORT}/notify")
  HTTPServer(("", PORT), Handler).serve_forever()

if __name__ == "__main__":
  main()
