from __future__ import annotations

import os
import re
import threading
import winreg
from pathlib import Path
from typing import Optional

import skia

_FONT_LOCK = threading.Lock()
_CACHED_FONTS: list[dict] = []
_FAMILY_TO_FILE: dict[str, Path] = {}

_FONT_EXTS = {".ttf", ".otf", ".ttc", ".otc"}
_JP_SAMPLE_CP = ord("あ")


def _iter_font_dirs() -> list[Path]:
    dirs: list[Path] = []
    win_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    if win_dir.is_dir():
        dirs.append(win_dir)
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        user_fonts = Path(local_app) / "Microsoft" / "Windows" / "Fonts"
        if user_fonts.is_dir():
            dirs.append(user_fonts)
    return dirs


def _iter_registry_font_entries() -> list[tuple[str, Path, bool]]:
    """Return (display_name, file_path, is_user_installed) from Windows Fonts registry."""
    results: list[tuple[str, Path, bool]] = []
    win_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    hives = [
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts", True),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts", False),
    ]
    for hive, subkey, is_user in hives:
        try:
            with winreg.OpenKey(hive, subkey) as key:
                count = winreg.QueryInfoKey(key)[1]
                for i in range(count):
                    try:
                        name, val, _ = winreg.EnumValue(key, i)
                    except OSError:
                        continue
                    if not isinstance(val, str) or not val.strip():
                        continue
                    p = Path(val.strip())
                    if not p.is_absolute():
                        p = win_fonts / p
                    if p.suffix.lower() in _FONT_EXTS and p.exists():
                        results.append((str(name), p, is_user))
        except OSError:
            continue
    return results


def _normalize_reg_family(reg_name: str) -> str:
    clean = re.sub(r"\s*\([^)]*\)\s*$", "", reg_name).strip()
    clean = clean.split("&")[0].strip()
    return clean


def scan_system_fonts(force: bool = False) -> list[dict]:
    """Enumerate installed fonts from both Skia FontMgr and Windows Registry/user dirs."""
    global _CACHED_FONTS, _FAMILY_TO_FILE
    with _FONT_LOCK:
        if _CACHED_FONTS and not force:
            return _CACHED_FONTS

        fm = skia.FontMgr.RefDefault()
        skia_families = {fm.getFamilyName(i) for i in range(fm.countFamilies()) if fm.getFamilyName(i)}

        family_map: dict[str, dict] = {}
        file_map: dict[str, Path] = {}

        # 1. Registry entries (captures both HKLM system fonts and HKCU newly-installed user fonts)
        reg_entries = _iter_registry_font_entries()
        known_paths: set[Path] = set()
        for reg_name, path, is_user in reg_entries:
            known_paths.add(path.resolve())
            fam_hint = _normalize_reg_family(reg_name)
            actual_fam = fam_hint
            has_jp = False
            try:
                tf = skia.Typeface.MakeFromFile(str(path))
                if tf is not None:
                    tf_fam = tf.getFamilyName()
                    if tf_fam:
                        actual_fam = tf_fam
                    has_jp = tf.unicharToGlyph(_JP_SAMPLE_CP) != 0
            except Exception:
                pass
            if not actual_fam:
                continue
            key = actual_fam.lower()
            if key not in file_map:
                file_map[key] = path
            if fam_hint and fam_hint.lower() not in file_map:
                file_map[fam_hint.lower()] = path
            prev = family_map.get(key)
            family_map[key] = {
                "family": actual_fam,
                "has_japanese": bool(has_jp or (prev["has_japanese"] if prev else False)),
                "is_user_installed": bool(is_user or (prev["is_user_installed"] if prev else False)),
                "has_file": True,
            }

        # 2. Direct scan of user font directory for files dropped directly without registry update
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            user_dir = Path(local_app) / "Microsoft" / "Windows" / "Fonts"
            if user_dir.is_dir():
                for fp in user_dir.iterdir():
                    if fp.is_file() and fp.suffix.lower() in _FONT_EXTS and fp.resolve() not in known_paths:
                        try:
                            tf = skia.Typeface.MakeFromFile(str(fp))
                            if tf is not None:
                                fam = tf.getFamilyName() or fp.stem
                                has_jp = tf.unicharToGlyph(_JP_SAMPLE_CP) != 0
                                key = fam.lower()
                                file_map.setdefault(key, fp)
                                family_map.setdefault(
                                    key,
                                    {
                                        "family": fam,
                                        "has_japanese": has_jp,
                                        "is_user_installed": True,
                                        "has_file": True,
                                    },
                                )
                        except Exception:
                            continue

        # 3. Merge Skia FontMgr families (in case DirectWrite knows virtual/variable families)
        default_style = skia.FontStyle.Normal()
        for fam in skia_families:
            key = fam.lower()
            has_jp = False
            try:
                tf = fm.matchFamilyStyle(fam, default_style)
                if tf is not None:
                    has_jp = tf.unicharToGlyph(_JP_SAMPLE_CP) != 0
            except Exception:
                pass
            if key not in family_map:
                family_map[key] = {
                    "family": fam,
                    "has_japanese": has_jp,
                    "is_user_installed": False,
                    "has_file": key in file_map,
                }
            else:
                family_map[key]["has_japanese"] = bool(family_map[key]["has_japanese"] or has_jp)

        ordered = sorted(
            family_map.values(),
            key=lambda x: (not x["has_japanese"], not x["is_user_installed"], x["family"].lower()),
        )
        _CACHED_FONTS = ordered
        _FAMILY_TO_FILE = file_map
        return ordered


def resolve_typeface_file(family: str) -> Optional[Path]:
    """Return local font file path if known (enables loading newly-installed fonts without restart)."""
    if not family:
        return None
    if not _FAMILY_TO_FILE:
        scan_system_fonts(force=False)
    key = family.strip().lower()
    p = _FAMILY_TO_FILE.get(key)
    if p and p.exists():
        return p
    # Rescan once on miss so freshly-installed fonts work immediately
    scan_system_fonts(force=True)
    p = _FAMILY_TO_FILE.get(key)
    return p if (p and p.exists()) else None
