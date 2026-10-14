#!/usr/bin/env python3
"""Install optional CAD readers into ignored instance state, without changing system Python."""
import argparse
from pathlib import Path
import shutil
import subprocess
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--state-dir',type=Path,default=Path(__file__).resolve().parent.parent/'.tiksi-state')
parser.add_argument('--python',default=shutil.which('python3.13') or shutil.which('python3.12') or 'python3')
args=parser.parse_args();venv=args.state_dir/'converters/venv'
subprocess.run([args.python,'-m','venv',str(venv)],check=True)
subprocess.run([str(venv/'bin/python'),'-m','pip','install','ifcopenshell==0.9.0','ezdxf==1.4.4','cadquery-ocp==8.0.1.1.0','laspy==2.7.0','lazrs==0.8.2','rhino3dm==8.35.0','pye57==0.4.19'],check=True)
print('Local IFC, STEP/IGES, DXF and LAZ conversion runtime installed.')
