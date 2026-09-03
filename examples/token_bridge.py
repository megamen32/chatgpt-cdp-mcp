#!/usr/bin/env python3
"""curl_cffi bridge for the ChatGPT token driver (CHATGPT_TOKEN_FETCH_COMMAND).

Reads one JSON request per stdin line: {"url": "...", "headers": {...}}
Answers one JSON line per request:  {"status": 200, "body": "..."}

Run with the same python that has curl_cffi installed:
    pip install curl_cffi
    python3 examples/token_bridge.py
"""

import json
import sys

from curl_cffi import requests as cffi_requests

session = cffi_requests.Session(impersonate="chrome", timeout=60)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    try:
        response = session.get(request["url"], headers=request.get("headers", {}))
        envelope = {"status": response.status_code, "body": response.text}
    except Exception as error:  # transport-level failure
        envelope = {"status": 0, "body": f"bridge error: {error}"}
    print(json.dumps(envelope, ensure_ascii=False), flush=True)
