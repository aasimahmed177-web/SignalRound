"""Run with the optional parser virtualenv; all fixtures are offline."""
import json
import subprocess
import sys
import unittest
from pathlib import Path


class OfflineParserTests(unittest.TestCase):
    def extract(self, html, selector="body", limit=2):
        result = subprocess.run(
            [sys.executable, "-I", str(Path(__file__).with_name("scrapling-extract.py"))],
            input=json.dumps({"html": html, "selector": selector, "limit": limit}),
            text=True, capture_output=True, timeout=10, check=True,
            env={"LANG": "C.UTF-8"},
        )
        return json.loads(result.stdout)

    def test_text_excludes_scripts_and_styles(self):
        result = self.extract("<body>Hello <b>world</b><script>secret()</script><style>hidden</style></body>")
        self.assertEqual(result, {"ok": True, "items": ["Hello world"], "truncated": False})

    def test_external_file_entity_is_not_expanded(self):
        fixture = Path(__file__).with_name("requirements-scrapling.txt").as_uri()
        result = self.extract(f'<!DOCTYPE html [<!ENTITY probe SYSTEM "{fixture}">]><html><body>&probe;</body></html>')
        self.assertTrue(result["ok"])
        self.assertNotIn("scrapling==", " ".join(result["items"]))

    def test_invalid_css_is_a_structured_error(self):
        self.assertEqual(self.extract("<body>text</body>", "["), {"ok": False, "code": "invalid_selector"})

    def test_match_cap_is_reported(self):
        result = self.extract("<p>One</p><p>Two</p>", "p", 1)
        self.assertEqual(result, {"ok": True, "items": ["One"], "truncated": True})


if __name__ == "__main__":
    unittest.main()
