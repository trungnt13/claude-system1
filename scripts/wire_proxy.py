"""Inspect effort changes.

Logs can contain secrets.
"""
import http.client
import http.server
import json
import sys

LOG = sys.argv[2]
UPSTREAM = "api.anthropic.com"
SKIP_HEADERS = {"host", "content-length", "connection", "accept-encoding"}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path.startswith("/v1/messages") and "count_tokens" not in self.path:
            try:
                data = json.loads(body)
                summary = {
                    "path": self.path,
                    "model": data.get("model"),
                    "beta": self.headers.get("anthropic-beta"),
                    "output_config": data.get("output_config"),
                    "thinking": data.get("thinking"),
                    "n_messages": len(data.get("messages", [])),
                    "system_role_messages": [m for m in data.get("messages", []) if m.get("role") == "system"],
                    "other_message_keys": sorted({k for m in data.get("messages", []) for k in m} - {"role", "content"}),
                }
            except ValueError:
                summary = {"path": self.path, "unparsed": True}
            with open(LOG, "a") as log:
                log.write(json.dumps(summary) + "\n")
        upstream = http.client.HTTPSConnection(UPSTREAM, timeout=600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in SKIP_HEADERS}
        upstream.request(self.command, self.path, body=body or None, headers=headers)
        response = upstream.getresponse()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in {"transfer-encoding", "content-length", "connection", "content-encoding"}:
                self.send_header(key, value)
        self.end_headers()
        while chunk := response.read1(65536):
            self.wfile.write(chunk)
            self.wfile.flush()

    do_GET = do_POST
    do_PUT = do_POST
    do_DELETE = do_POST

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
