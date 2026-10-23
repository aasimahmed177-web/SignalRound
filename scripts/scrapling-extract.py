"""Offline HTML/CSS parser. No fetchers, browser, URLs, or adaptive storage."""
import json
import sys


def extract():
    raw = sys.stdin.buffer.read(12_100_001)
    if len(raw) > 12_100_000:
        return {"ok": False, "code": "invalid_input"}
    try:
        data = json.loads(raw)
        html, selector, limit = data["html"], data["selector"], data["limit"]
        if (not isinstance(html, str) or len(html.encode("utf-8")) > 2_000_000
                or not isinstance(selector, str) or not 1 <= len(selector) <= 500
                or type(limit) is not int or not 1 <= limit <= 25):
            return {"ok": False, "code": "invalid_input"}
    except (ValueError, TypeError, KeyError):
        return {"ok": False, "code": "invalid_input"}
    try:
        from scrapling.parser import Selector
    except ImportError:
        return {"ok": False, "code": "missing_package"}
    try:
        page = Selector(content=html, adaptive=False, huge_tree=False)
        matches = page.css(selector)
        items = []
        truncated = len(matches) > limit
        for match in matches[:limit]:
            text = str(match.get_all_text(separator=" ", strip=True))
            # JS validates UTF-16 length; cap by code units, not Python code points.
            encoded = text.encode("utf-16-le")
            truncated = truncated or len(encoded) > 8000
            items.append(encoded[:8000].decode("utf-16-le", errors="ignore"))
        return {"ok": True, "items": items, "truncated": truncated}
    except Exception:
        return {"ok": False, "code": "invalid_selector"}


if __name__ == "__main__":
    print(json.dumps(extract(), ensure_ascii=True))
