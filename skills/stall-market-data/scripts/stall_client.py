#!/usr/bin/env python3
"""Read STALL discovery data or request an unsigned HTTP x402 quote."""

import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://the-stall.intuitek.ai"


def get(path, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "stall-public-client/3.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def parse_json(raw):
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def catalog():
    status, _, raw = get("/catalog")
    if status != 200:
        raise SystemExit(f"catalog returned HTTP {status}")
    data = parse_json(raw)
    print(json.dumps(data.get("capabilities", []), indent=2))


def quote(capability, arguments):
    status, headers, raw = get(f"/cap/{capability}", arguments)
    if status != 402:
        print(raw.decode(errors="replace"))
        raise SystemExit(f"expected an unsigned 402 quote, received HTTP {status}")

    encoded = next(
        (value for key, value in headers.items() if key.lower() == "payment-required"),
        None,
    )
    if encoded:
        challenge = json.loads(base64.b64decode(encoded))
    else:
        challenge = parse_json(raw)
    if not challenge:
        raise SystemExit("payment challenge was not valid JSON")
    print(json.dumps({"payment_made": False, "challenge": challenge}, indent=2))
    raise SystemExit(2)


def parse_arguments(values):
    output = {}
    index = 0
    while index < len(values):
        name = values[index]
        if not name.startswith("--") or index + 1 >= len(values):
            raise SystemExit("arguments must use --name value pairs")
        output[name[2:]] = values[index + 1]
        index += 2
    return output


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "caps":
        catalog()
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "quote":
        quote(sys.argv[2], parse_arguments(sys.argv[3:]))
        return
    raise SystemExit("usage: stall_client.py caps | quote <capability> [--name value ...]")


if __name__ == "__main__":
    main()
