# -*- coding: utf-8 -*-
"""Reproducible Windows build pipeline for the AURUM MT5 Bridge."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


REQUIRED_PACKAGES = (
    "nuitka", "PySide6", "shiboken6", "MetaTrader5", "numpy", "websockets", "certifi",
)
INNO_APP_ID = "{{AURUM-Bridge-2.3.0}"


def build_context(repo_root=None):
    root = Path(repo_root or Path(__file__).resolve().parents[2]).resolve()
    source = root / "public" / "ai" / "aurum_bridge_gui.py"
    icon = root / "public" / "ai" / "aurum_icon.ico"
    version_file = root / "VERSION"
    for path in (source, icon, version_file):
        if not path.is_file():
            raise FileNotFoundError(f"required build input missing: {path}")
    version = version_file.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"v\d+(?:\.\d+){2,3}", version):
        raise ValueError(f"invalid VERSION value: {version!r}")
    source_text = source.read_text(encoding="utf-8")
    match = re.search(r'^APP_VERSION\s*=\s*["\']([^"\']+)["\']', source_text, re.MULTILINE)
    if not match or match.group(1) != version:
        raise ValueError("VERSION and aurum_bridge_gui.py APP_VERSION do not match")
    return {
        "root": root,
        "source": source,
        "icon": icon,
        "version_file": version_file,
        "version": version,
        "numeric_version": version.removeprefix("v"),
        "nuitka_output": root / "dist_nuitka",
        "installer_output": root / "dist_inno",
    }


def nuitka_command(context, python_executable=None):
    output = context["nuitka_output"]
    source = context["source"]
    icon = context["icon"]
    excluded = ",".join((
        "PySide6.Qt3D*", "PySide6.QtBluetooth", "PySide6.QtCharts",
        "PySide6.QtDataVisualization", "PySide6.QtHelp", "PySide6.QtLocation",
        "PySide6.QtMultimedia", "PySide6.QtNfc", "PySide6.QtOpenGL",
        "PySide6.QtPositioning", "PySide6.QtQuick*", "PySide6.QtRemoteObjects",
        "PySide6.QtScxml", "PySide6.QtSensors", "PySide6.QtSerial*",
        "PySide6.QtSpatialAudio", "PySide6.QtStateMachine", "PySide6.QtSvg",
        "PySide6.QtTest", "PySide6.QtTextToSpeech", "PySide6.QtUiTools",
        "PySide6.QtWebChannel", "PySide6.QtWebEngine*", "PySide6.QtWebSockets",
        "numpy.f2py", "numpy.tests", "numpy.*.tests",
    ))
    command = [
        str(python_executable or sys.executable), "-m", "nuitka",
        "--standalone", "--assume-yes-for-downloads", "--enable-plugin=pyside6",
        "--windows-console-mode=disable", f"--windows-icon-from-ico={icon}",
        "--output-filename=AURUM_Bridge.exe", f"--output-dir={output}",
        "--include-package=PySide6", "--include-package=shiboken6",
        "--include-package=MetaTrader5", "--include-package=numpy",
        "--include-package=websockets", "--include-package=certifi",
        f"--nofollow-import-to={excluded}", "--noinclude-qt-translations",
        "--noinclude-data-files=*.pak", "--noinclude-data-files=v8_context_snapshot.bin",
        "--noinclude-data-files=icudtl.dat", "--noinclude-data-files=qt6.conf",
        "--noinclude-dlls=qt6webengine*", "--noinclude-dlls=Qt6WebEngine*",
        str(source),
    ]
    return command


def _inno_escape(value):
    return str(value).replace('"', '""')


def render_installer_script(context, source_dir):
    version = _inno_escape(context["numeric_version"])
    icon = _inno_escape(context["icon"])
    source = _inno_escape(Path(source_dir).resolve())
    output = _inno_escape(context["installer_output"])
    return f'''#define MyAppName "AI交易实验室"
#define MyAppVersion "{version}"
#define MyAppPublisher "AURUM Trading"
#define MyAppURL "https://www.cnfxtrade.com"
#define MyAppExeName "AURUM_Bridge.exe"
#define MyAppIcon "{icon}"
#define SourceDir "{source}"

[Setup]
AppId={INNO_APP_ID}
AppName={{#MyAppName}}
AppVersion={{#MyAppVersion}}
AppPublisher={{#MyAppPublisher}}
AppPublisherURL={{#MyAppURL}}
AppSupportURL={{#MyAppURL}}
AppUpdatesURL={{#MyAppURL}}
DefaultDirName=D:\\AURUM Bridge
DefaultGroupName={{#MyAppName}}
OutputDir={output}
OutputBaseFilename=AURUM_Bridge_Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile={{#MyAppIcon}}
UninstallDisplayIcon={{app}}\\aurum_icon.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UsePreviousAppDir=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{{cm:CreateDesktopIcon}}"; GroupDescription: "{{cm:AdditionalIcons}}"; Flags: unchecked

[Files]
Source: "{{#SourceDir}}\\*"; DestDir: "{{app}}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{{group}}\\{{#MyAppName}}"; Filename: "{{app}}\\{{#MyAppExeName}}"; IconFilename: "{{app}}\\aurum_icon.ico"
Name: "{{autodesktop}}\\{{#MyAppName}}"; Filename: "{{app}}\\{{#MyAppExeName}}"; IconFilename: "{{app}}\\aurum_icon.ico"; Tasks: desktopicon

[Run]
Filename: "{{app}}\\{{#MyAppExeName}}"; Description: "{{cm:LaunchProgram,{{#StringChange(MyAppName, '&', '&&')}}}}"; Flags: nowait postinstall skipifsilent
'''


def find_inno_compiler():
    candidates = [shutil.which("ISCC.exe"), shutil.which("ISCC")]
    local = os.environ.get("LOCALAPPDATA")
    program_files_x86 = os.environ.get("ProgramFiles(x86)")
    if local:
        candidates.append(str(Path(local) / "Programs" / "Inno Setup 6" / "ISCC.exe"))
    if program_files_x86:
        candidates.append(str(Path(program_files_x86) / "Inno Setup 6" / "ISCC.exe"))
    return next((Path(item).resolve() for item in candidates if item and Path(item).is_file()), None)


def missing_dependencies():
    return [name for name in REQUIRED_PACKAGES if importlib.util.find_spec(name) is None]


def verify_dependencies():
    missing = missing_dependencies()
    if missing:
        raise RuntimeError("missing build packages: " + ", ".join(missing))


def locate_distribution(context):
    candidates = sorted(
        path for path in context["nuitka_output"].glob("*.dist")
        if (path / "AURUM_Bridge.exe").is_file()
    )
    if len(candidates) != 1:
        raise RuntimeError(f"expected one Nuitka distribution containing AURUM_Bridge.exe, found {len(candidates)}")
    return candidates[0]


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Build the signed-ready AURUM Bridge installer inputs")
    parser.add_argument("--dry-run", action="store_true", help="validate inputs and print commands without writing files")
    parser.add_argument("--skip-installer", action="store_true", help="build the standalone directory only")
    parser.add_argument("--no-clean", action="store_true", help="keep prior dist_nuitka output before building")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    context = build_context()
    command = nuitka_command(context)
    if args.dry_run:
        missing = missing_dependencies()
        print(json.dumps({
            "version": context["version"],
            "nuitka_command": command,
            "installer_compiler": str(find_inno_compiler() or ""),
            "missing_packages": missing,
            "build_ready": not missing and find_inno_compiler() is not None,
        }, ensure_ascii=False, indent=2))
        return 0
    if os.name != "nt":
        raise RuntimeError("AURUM Bridge can only be built on Windows")
    verify_dependencies()
    if not args.no_clean and context["nuitka_output"].exists():
        shutil.rmtree(context["nuitka_output"])
    context["nuitka_output"].mkdir(parents=True, exist_ok=True)
    subprocess.run(command, cwd=context["root"], check=True)
    distribution = locate_distribution(context)
    shutil.copy2(context["icon"], distribution / "aurum_icon.ico")
    shutil.copy2(context["version_file"], distribution / "VERSION")
    if args.skip_installer:
        print(f"Bridge standalone build ready: {distribution}")
        return 0
    compiler = find_inno_compiler()
    if compiler is None:
        raise RuntimeError("Inno Setup 6 ISCC.exe was not found")
    context["installer_output"].mkdir(parents=True, exist_ok=True)
    installer_script = context["nuitka_output"] / "installer.generated.iss"
    installer_script.write_text(render_installer_script(context, distribution), encoding="utf-8")
    subprocess.run([str(compiler), str(installer_script)], cwd=context["root"], check=True)
    installer = context["installer_output"] / "AURUM_Bridge_Setup.exe"
    if not installer.is_file() or installer.stat().st_size <= 0:
        raise RuntimeError("Inno Setup completed without producing AURUM_Bridge_Setup.exe")
    print(f"Bridge installer ready: {installer} ({installer.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
