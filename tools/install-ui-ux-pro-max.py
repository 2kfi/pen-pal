#!/usr/bin/env python3
"""
Install ui-ux-pro-max into the GLOBAL OpenCode skills directory.

Upstream's own CLI (`npx ui-ux-pro-max-cli init --ai opencode`) writes to a
project's .opencode/skills. We want it available in every project, so this does
the same job against ~/.config/opencode/skills.

SKILL.md is rendered from the repo's own templates rather than downloaded
pre-rendered, so the result is exactly what upstream would produce for OpenCode.

Usage: python3 tools/install-ui-ux-pro-max.py
"""

import io
import json
import os
import re
import shutil
import sys
import tarfile
import urllib.request

REPO = "nextlevelbuilder/ui-ux-pro-max-skill"
BRANCH = "main"
DEST = os.path.expanduser("~/.config/opencode/skills/ui-ux-pro-max")
API = f"https://api.github.com/repos/{REPO}"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "penpal-skill-installer"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def render(template: str, platform: dict) -> str:
    """Expand the small Handlebars subset upstream uses."""
    quick_reference = platform["sections"]["quickReference"]

    def block(text: str, tag: str, keep: bool) -> str:
        # Matches {{#TAG}}...{{/TAG}}, tolerating surrounding whitespace.
        pattern = re.compile(r"\{\{#" + tag + r"\}\}(.*?)\{\{/" + tag + r"\}\}", re.S)
        return pattern.sub(lambda m: m.group(1) if keep else "", text)

    out = template
    out = block(out, "QR", quick_reference)
    out = block(out, "NOQR", not quick_reference)
    out = out.replace("{{TITLE}}", platform["title"].replace("-", " ").title())
    out = out.replace("{{DESCRIPTION}}", platform["description"])
    out = out.replace("{{QUICK_REFERENCE}}", "")
    return out


def main() -> int:
    if not shutil.which("python3"):
        print("python3 is required", file=sys.stderr)
        return 1

    os.makedirs(DEST, exist_ok=True)

    print("fetching platform template...")
    platform = json.loads(get(f"{RAW}/src/ui-ux-pro-max/templates/platforms/opencode.json"))

    print("downloading repo tarball...")
    tar_bytes = get(f"https://codeload.github.com/{REPO}/tar.gz/refs/heads/{BRANCH}")

    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tar:
        members = tar.getmembers()

        wanted = []
        for m in members:
            parts = m.name.split("/")
            if len(parts) < 2:
                continue
            # <repo>-main/src/ui-ux-pro-max/{data,scripts,docs}/...
            if "src/ui-ux-pro-max/" not in m.name:
                continue
            rel = m.name.split("src/ui-ux-pro-max/", 1)[1]
            if rel.split("/")[0] not in {"data", "scripts"}:
                continue
            wanted.append((m, rel))

        print(f"extracting {len(wanted)} files...")
        for member, rel in wanted:
            target = os.path.join(DEST, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            src = tar.extractfile(member)
            if src is None:
                continue
            with open(target, "wb") as fh:
                fh.write(src.read())

    print("rendering SKILL.md...")
    template = get(f"{RAW}/src/ui-ux-pro-max/templates/base/skill-content.md").decode("utf-8")
    with open(os.path.join(DEST, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(render(template, platform))

    with open(os.path.join(DEST, "LICENSE"), "wb") as fh:
        fh.write(get(f"{RAW}/LICENSE"))

    # Report
    total = 0
    count = 0
    for root, _, files in os.walk(DEST):
        for name in files:
            count += 1
            total += os.path.getsize(os.path.join(root, name))

    print(f"\ninstalled to {DEST}")
    print(f"  {count} files, {total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())