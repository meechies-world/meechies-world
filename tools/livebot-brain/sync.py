# Run after editing worker.js: keeps lib/livebot-brain-src.js (served to unlocked buyers) in step.
import json, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
w = (root / "tools/livebot-brain/worker.js").read_text()
(root / "lib/livebot-brain-src.js").write_text("// Generated from tools/livebot-brain/worker.js by tools/livebot-brain/sync.py — do not edit by hand.\nexport default " + json.dumps(w) + ";\n")
