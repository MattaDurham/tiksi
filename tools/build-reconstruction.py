#!/usr/bin/env python3
"""Build the macOS-native, local-only photogrammetry worker for one Tiksi instance."""
import argparse
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path(__file__).resolve().parents[1] / ".tiksi-state")
    args = parser.parse_args()
    if platform.system() != "Darwin": parser.exit(2, "Apple Object Capture requires a supported Mac. Export a model from Polycam and import GLB/OBJ instead.\n")
    swift = shutil.which("swiftc")
    if not swift: parser.exit(2, "Install Apple's Xcode Command Line Tools with xcode-select --install, then run this command again.\n")
    binary = args.state_dir.resolve() / "bin" / "object-capture"
    binary.parent.mkdir(parents=True, exist_ok=True)
    temporary = binary.with_suffix(".building")
    source = Path(__file__).resolve().parents[1] / "server" / "native" / "ObjectCapture.swift"
    try:
        subprocess.run([swift, "-O", "-parse-as-library", str(source), "-o", str(temporary)], check=True, timeout=180)
        subprocess.run([str(temporary), "--check"], check=True, timeout=30)
        temporary.replace(binary)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        temporary.unlink(missing_ok=True)
        print(f"The native engine could not be built or is unsupported: {error}", file=sys.stderr)
        return 1
    print(f"Local reconstruction engine ready: {binary}")
    return 0


if __name__ == "__main__": sys.exit(main())
