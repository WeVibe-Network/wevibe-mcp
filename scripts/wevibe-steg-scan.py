#!/usr/bin/env python3
"""
wevibe-steg-scan — Unicode steganography detection sidecar for WeVibe Network.

Subprocess protocol (ADR-016 pattern):
  - Reads UTF-8 text from stdin (max 1MB).
  - Writes JSON to stdout.
  - Exit 0: scan completed (check "findings" array for detections).
  - Exit 1: error (JSON ErrorResponse on stdout).

AGPL-3.0 isolation: this script runs as a separate process.
It is NOT imported by the Apache 2.0 wevibe-mcp TypeScript code.

Dependencies: pip install stegg
"""

import sys
import json

MAX_INPUT_BYTES = 1_048_576  # 1MB


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            print(
                json.dumps(
                    {
                        "error": "input_too_large",
                        "message": f"Input exceeds {MAX_INPUT_BYTES} byte limit",
                    }
                )
            )
            sys.exit(1)

        if not raw:
            print(json.dumps({"error": "empty_input", "message": "No input received on stdin"}))
            sys.exit(1)

        import analysis_tools as at

        findings: list[dict] = []

        detectors = [
            ("unicode_steg", at.detect_unicode_steg),
            ("homoglyph", at.detect_homoglyph_steg),
            ("confusable_whitespace", at.detect_confusable_whitespace),
            ("variation_selector", at.detect_variation_selector_steg),
            ("combining_mark", at.detect_combining_mark_steg),
            ("whitespace_encoding", at.detect_whitespace_steg),
            ("emoji_steg", at.detect_emoji_steg),
        ]

        decoders = [
            ("braille", at.decode_braille),
            ("directional_override", at.decode_directional_override),
            ("hangul_filler", at.decode_hangul_filler),
            ("math_alphanumeric", at.decode_math_alphanumeric),
            ("emoji_skin_tone", at.decode_emoji_skin_tone),
        ]

        for name, fn in detectors:
            try:
                result = fn(raw)
                suspicious = (
                    result.get("found", False)
                    or result.get("suspicious", False)
                    or result.get("invisible_chars", 0) > 0
                    or (result.get("count", 0) > 0 and name != "whitespace_encoding")
                    or result.get("substitutions", 0) > 0
                )
                if suspicious:
                    findings.append(
                        {
                            "type": "detector",
                            "name": name,
                            "severity": "high"
                            if name in ("unicode_steg", "homoglyph")
                            else "medium",
                            "details": result,
                        }
                    )
            except Exception as e:
                findings.append(
                    {
                        "type": "error",
                        "name": name,
                        "severity": "info",
                        "details": {"error": str(e)},
                    }
                )

        for name, fn in decoders:
            try:
                result = fn(raw)
                decoded = result.get("decoded", "") or result.get("message", "")
                if decoded and len(decoded.strip()) > 0:
                    findings.append(
                        {
                            "type": "decoder",
                            "name": name,
                            "severity": "critical",
                            "details": result,
                        }
                    )
            except Exception:
                pass

        output = {
            "version": "1.0.0",
            "input_bytes": len(raw),
            "findings_count": len(findings),
            "clean": len(findings) == 0,
            "findings": findings,
        }

        print(json.dumps(output))
        sys.exit(0)

    except Exception as e:
        print(
            json.dumps(
                {
                    "error": "scanner_error",
                    "message": str(e),
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
