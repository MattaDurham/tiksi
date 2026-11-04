#!/usr/bin/env python3
"""Install the photo-placement runtime (NumPy + OpenCV) into ignored instance state, without changing system Python."""
import argparse
from pathlib import Path
import shutil
import subprocess
PACKAGES=('numpy==2.3.5','opencv-python-headless==4.13.0.92')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state-dir',type=Path,default=Path(__file__).resolve().parent.parent/'.tiksi-state')
parser.add_argument('--python',default=shutil.which('python3.13') or shutil.which('python3.12') or 'python3')
args=parser.parse_args();venv=args.state_dir/'photo-placement/venv'
subprocess.run([args.python,'-m','venv',str(venv)],check=True)
subprocess.run([str(venv/'bin/python'),'-m','pip','install','--disable-pip-version-check',*PACKAGES],check=True)
subprocess.run([str(venv/'bin/python'),'-c','import cv2,numpy;cv2.SIFT_create();print("OpenCV",cv2.__version__,"NumPy",numpy.__version__)'],check=True)
print('Local photo placement runtime installed; Tiksi picks it up on the next placement.')
