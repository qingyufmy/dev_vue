# -*- coding: utf-8 -*-
"""Windows-bound secret protection for AURUM Bridge configuration files."""
import base64
import ctypes
import ctypes.wintypes
import os


PROTECTED_PREFIX = "dpapi:v1:"
SECRET_FIELDS = ("token", "refresh_token", "saved_password")
_LEGACY_PASSWORD_KEY = b"AURUM_BRIDGE_v2"
_CRYPTPROTECT_UI_FORBIDDEN = 0x01


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _windows_crypto_apis():
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_pointer = ctypes.POINTER(_DataBlob)
    crypt32.CryptProtectData.argtypes = [
        blob_pointer, ctypes.wintypes.LPCWSTR, blob_pointer,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.wintypes.DWORD, blob_pointer,
    ]
    crypt32.CryptProtectData.restype = ctypes.wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        blob_pointer, ctypes.c_void_p, blob_pointer,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.wintypes.DWORD, blob_pointer,
    ]
    crypt32.CryptUnprotectData.restype = ctypes.wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return crypt32, kernel32


def _input_blob(data):
    buffer = ctypes.create_string_buffer(data)
    blob = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    return blob, buffer


def _dpapi_protect(data):
    if os.name != "nt":
        raise OSError("Windows DPAPI is required to protect Bridge credentials")
    source, source_buffer = _input_blob(data)
    output = _DataBlob()
    crypt32, kernel32 = _windows_crypto_apis()
    ok = crypt32.CryptProtectData(
        ctypes.byref(source), "AURUM Bridge credential", None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output),
    )
    del source_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def _dpapi_unprotect(data):
    if os.name != "nt":
        raise OSError("Windows DPAPI is required to read Bridge credentials")
    source, source_buffer = _input_blob(data)
    output = _DataBlob()
    crypt32, kernel32 = _windows_crypto_apis()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output),
    )
    del source_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def is_protected_secret(value):
    return isinstance(value, str) and value.startswith(PROTECTED_PREFIX)


def protect_secret(value):
    text = str(value or "")
    if not text or is_protected_secret(text):
        return text
    encrypted = _dpapi_protect(text.encode("utf-8"))
    return PROTECTED_PREFIX + base64.urlsafe_b64encode(encrypted).decode("ascii")


def unprotect_secret(value):
    text = str(value or "")
    if not text:
        return ""
    if not is_protected_secret(text):
        return text
    encoded = text[len(PROTECTED_PREFIX):]
    try:
        encrypted = base64.b64decode(encoded.encode("ascii"), altchars=b"-_", validate=True)
        return _dpapi_unprotect(encrypted).decode("utf-8")
    except Exception as error:
        raise ValueError("Bridge credential cannot be decrypted for this Windows user") from error


def _decode_legacy_password(value):
    """Decode the v2 fixed-key XOR format only during one-time migration."""
    try:
        encrypted = base64.b64decode(str(value).encode("ascii"), validate=True)
        decrypted = bytes(
            byte ^ _LEGACY_PASSWORD_KEY[index % len(_LEGACY_PASSWORD_KEY)]
            for index, byte in enumerate(encrypted)
        )
        text = decrypted.decode("utf-8")
        return text if text else None
    except (ValueError, UnicodeError):
        return None


def config_from_storage(value):
    """Return decrypted in-memory config and whether disk migration is needed."""
    config = dict(value or {})
    migrated = False
    try:
        secrets_version = int(config.get("secrets_version") or 0)
    except (TypeError, ValueError):
        secrets_version = 0
        migrated = True
    for field in SECRET_FIELDS:
        secret = config.get(field)
        if not secret:
            continue
        if is_protected_secret(secret):
            config[field] = unprotect_secret(secret)
            continue
        if field == "saved_password" and secrets_version < 1:
            legacy = _decode_legacy_password(secret)
            if legacy is not None:
                config[field] = legacy
        migrated = True
    if secrets_version < 1 and any(config.get(field) for field in SECRET_FIELDS):
        migrated = True
    return config, migrated


def config_for_storage(value):
    """Return a copy safe to serialize; never falls back to plaintext."""
    config = dict(value or {})
    for field in SECRET_FIELDS:
        if config.get(field):
            config[field] = protect_secret(config[field])
    config["secrets_version"] = 1
    return config
