# dht_server.py — returns {"ts": <ms>, "temp_c": <float>} at /api/dht
import json, time, math, random
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
  import Adafruit_DHT
  HAVE_DHT = True
except Exception:
  HAVE_DHT = False

SENSOR = getattr(Adafruit_DHT, "DHT11", None) if HAVE_DHT else None
GPIO_PIN = 4   # BCM pin
PORT = 5002
ALLOWED_ORIGIN = "*"

def read_temp_c():
  if HAVE_DHT and SENSOR:
    hum, temp = Adafruit_DHT.read_retry(SENSOR, GPIO_PIN)
    if temp is not None:
      return float(temp)
  # fallback simulate ~27±2°C
  t = time.time()
  return 27 + 2*math.sin(t/30) + (random.random()-0.5)*0.3

class Handler(BaseHTTPRequestHandler):
  def _cors(self):
    self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
    self.send_header("Access-Control-Allow-Headers", "content-type")
    self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

  def do_OPTIONS(self):
    self.send_response(204); self._cors(); self.end_headers()

  def do_GET(self):
    if self.path != "/api/dht":
      self.send_response(404); self._cors(); self.end_headers(); return
    ts = int(time.time()*1000)
    temp_c = read_temp_c()
    payload = {"ts": ts, "temp_c": round(temp_c, 2)}
    self.send_response(200); self._cors(); self.end_headers()
    self.wfile.write(json.dumps(payload).encode())

def main():
  print(f"DHT server on http://localhost:{PORT}/api/dht")
  HTTPServer(("", PORT), Handler).serve_forever()

if __name__ == "__main__":
  main()
