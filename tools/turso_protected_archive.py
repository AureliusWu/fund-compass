"""Explicit CurrentUser DPAPI protection of caller-owned private archive bytes.

Only ciphertext is written. This module does not discover credentials, access
the network, change ACLs, elevate, create directories, or authorize migration.
Current-user local readback is not cross-machine or cloud restoration. Restored
bytes still require the clean compiler's independent strict source admission.
The caller must select a controlled local, non-temporary existing parent. A
drive-letter path is not a mapped-volume/local-disk certificate. On Windows,
O_CREAT mode 0600 is not a private ACL: this module makes no ACL or deletion /
corruption protection claim and never changes the caller's permissions.
"""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import hmac
import ntpath
import os
import re
import stat
import struct

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_CIPHER_BYTES = MAX_ARCHIVE_BYTES + 64 * 1024
PROFILE = "windows-current-user-dpapi-archive-1"
_PROFILE = PROFILE.encode("ascii") + b"\0"
_FILE_MAGIC = b"SINAN-PROTECTED-ARCHIVE-1\0"
_PLAIN_MAGIC = b"SINAN-PRIVATE-ARCHIVE-1\0"
_OUTER_PREFIX = _FILE_MAGIC + _PROFILE
_INNER_PREFIX = _PLAIN_MAGIC + _PROFILE
_HASH_BYTES = 32
_BINDING_BYTES = 3 * _HASH_BYTES
_INNER_HEADER = len(_INNER_PREFIX) + _BINDING_BYTES + 8 + _HASH_BYTES
_OUTER_HEADER = len(_OUTER_PREFIX) + _BINDING_BYTES + 8 + _HASH_BYTES
MAX_PROTECTED_FILE_BYTES = MAX_CIPHER_BYTES + _OUTER_HEADER
_SHA = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_DRIVE = re.compile(r"[A-Za-z]:\Z", re.ASCII)
_RESERVED = frozenset({"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$",
                       *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10)),
                       *(f"COM{i}" for i in "¹²³"), *(f"LPT{i}" for i in "¹²³")})
_REPARSE = 0x400
_UI_FORBIDDEN = 1


class ProtectedArchiveError(Exception):
    """One fixed public failure, never Windows/provider/path/private details."""
    def __init__(self):
        super().__init__("protected_archive_failed")


def _fail():
    raise ProtectedArchiveError()


def _bindings(resource, image, archive):
    values = (resource, image, archive)
    if any(type(value) is not str or not _SHA.fullmatch(value) for value in values):
        _fail()
    return b"".join(bytes.fromhex(value) for value in values)


def _identities(expected_source_resource_sha256, expected_source_image_sha256, expected_source_archive_sha256):
    return _bindings(expected_source_resource_sha256, expected_source_image_sha256, expected_source_archive_sha256)


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


class _Windows:
    """System32-only libraries, CurrentUser flags and explicit native cleanup."""
    def __init__(self):
        if os.name != "nt":
            _fail()
        self.crypt = ctypes.WinDLL("Crypt32.dll", use_last_error=True, winmode=0x800)
        self.kernel = ctypes.WinDLL("Kernel32.dll", use_last_error=True, winmode=0x800)
        blob = ctypes.POINTER(_Blob)
        self.crypt.CryptProtectData.argtypes = [blob, wintypes.LPCWSTR, blob, wintypes.LPVOID,
                                              wintypes.LPVOID, wintypes.DWORD, blob]
        self.crypt.CryptProtectData.restype = wintypes.BOOL
        self.crypt.CryptUnprotectData.argtypes = [blob, ctypes.POINTER(wintypes.LPWSTR), blob,
                                                wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, blob]
        self.crypt.CryptUnprotectData.restype = wintypes.BOOL
        self.kernel.LocalFree.argtypes = [wintypes.HLOCAL]
        self.kernel.LocalFree.restype = wintypes.HLOCAL
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def crypt_bytes(self, data, *, decrypt):
        source_buffer = ctypes.create_string_buffer(data, len(data))
        source = _Blob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
        output = _Blob()
        cleanup_failed = False
        try:
            function = self.crypt.CryptUnprotectData if decrypt else self.crypt.CryptProtectData
            # No machine scope, password, entropy, description or prompt.
            succeeded = function(ctypes.byref(source), None, None, None, None, _UI_FORBIDDEN,
                                 ctypes.byref(output))
            maximum = MAX_ARCHIVE_BYTES + _INNER_HEADER if decrypt else MAX_CIPHER_BYTES
            if not succeeded or not output.pbData or not 1 <= output.cbData <= maximum:
                _fail()
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            # Python caller-owned immutable bytes cannot be promised zeroed.
            # Every additional native input/output allocation is explicitly
            # wiped before release, including error paths and ciphertext.
            ctypes.memset(ctypes.addressof(source_buffer), 0, len(data))
            if output.pbData:
                ctypes.memset(output.pbData, 0, output.cbData)
                cleanup_failed = bool(self.kernel.LocalFree(ctypes.cast(output.pbData, wintypes.HLOCAL)))
                output.pbData = ctypes.POINTER(ctypes.c_ubyte)()
                output.cbData = 0
            if cleanup_failed:
                _fail()

    def open_directory(self, path):
        # FILE_READ_ATTRIBUTES, FILE_SHARE_READ (no write/delete share),
        # OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
        handle = self.kernel.CreateFileW(path, 0x80, 1, None, 3, 0x02000000 | 0x00200000, None)
        if handle is None or handle == ctypes.c_void_p(-1).value:
            _fail()
        return handle

    def close_handle(self, handle):
        if not self.kernel.CloseHandle(handle):
            _fail()

    def open_read_fd(self, path):
        import msvcrt
        # Final component is opened without following a reparse point and
        # without permitting concurrent writes/deletion through another open.
        handle = self.kernel.CreateFileW(path, 0x80000000, 1, None, 3,
                                         0x00200000 | 0x08000000, None)
        if handle is None or handle == ctypes.c_void_p(-1).value:
            _fail()
        try:
            return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except Exception:
            self.close_handle(handle)
            _fail()


def _crypt(data, *, decrypt):
    return _Windows().crypt_bytes(data, decrypt=decrypt)


def protect_archive_bytes(archive, *, expected_source_resource_sha256, expected_source_image_sha256,
                          expected_source_archive_sha256):
    """Return ciphertext framing only; all identifiers come from the caller."""
    try:
        binding = _identities(expected_source_resource_sha256, expected_source_image_sha256,
                              expected_source_archive_sha256)
        if (type(archive) is not bytes or not 1 <= len(archive) <= MAX_ARCHIVE_BYTES
                or not hmac.compare_digest(hashlib.sha256(archive).digest(), binding[-32:])):
            _fail()
        plain = (_INNER_PREFIX + binding + struct.pack(">Q", len(archive))
                 + hashlib.sha256(archive).digest() + archive)
        cipher = _crypt(plain, decrypt=False)
        if type(cipher) is not bytes or not 1 <= len(cipher) <= MAX_CIPHER_BYTES:
            _fail()
        return _OUTER_PREFIX + binding + struct.pack(">Q", len(cipher)) + hashlib.sha256(cipher).digest() + cipher
    except Exception:
        raise ProtectedArchiveError() from None


def unprotect_archive_bytes(protected, *, expected_source_resource_sha256, expected_source_image_sha256,
                            expected_source_archive_sha256):
    """Return original private bytes only after all external/inner SHA checks.

    DPAPI success/error codes alone are not accepted as a tamper verdict.
    This does not run the clean compiler or authenticate a source database.
    """
    try:
        binding = _identities(expected_source_resource_sha256, expected_source_image_sha256,
                              expected_source_archive_sha256)
        if (type(protected) is not bytes or not _OUTER_HEADER < len(protected) <= MAX_PROTECTED_FILE_BYTES
                or not protected.startswith(_OUTER_PREFIX)):
            _fail()
        offset = len(_OUTER_PREFIX)
        if not hmac.compare_digest(protected[offset:offset + _BINDING_BYTES], binding):
            _fail()
        offset += _BINDING_BYTES
        length = struct.unpack(">Q", protected[offset:offset + 8])[0]
        cipher_sha, cipher = protected[offset + 8:offset + 40], protected[offset + 40:]
        if (not 1 <= length <= MAX_CIPHER_BYTES or length != len(cipher)
                or not hmac.compare_digest(hashlib.sha256(cipher).digest(), cipher_sha)):
            _fail()
        plain = _crypt(cipher, decrypt=True)
        if (type(plain) is not bytes or not _INNER_HEADER < len(plain) <= MAX_ARCHIVE_BYTES + _INNER_HEADER
                or not plain.startswith(_INNER_PREFIX)):
            _fail()
        offset = len(_INNER_PREFIX)
        if not hmac.compare_digest(plain[offset:offset + _BINDING_BYTES], binding):
            _fail()
        offset += _BINDING_BYTES
        length = struct.unpack(">Q", plain[offset:offset + 8])[0]
        body_sha, body = plain[offset + 8:offset + 40], plain[offset + 40:]
        actual = hashlib.sha256(body).digest()
        if (not 1 <= length <= MAX_ARCHIVE_BYTES or length != len(body)
                or not hmac.compare_digest(body_sha, actual) or not hmac.compare_digest(actual, binding[-32:])):
            _fail()
        return body
    except Exception:
        raise ProtectedArchiveError() from None


def _path(raw):
    if (type(raw) is not str or not 3 <= len(raw) <= 32700 or "\0" in raw
            or raw.startswith(("\\\\", "//"))):
        _fail()
    drive, rest = ntpath.splitdrive(raw)
    if not _DRIVE.fullmatch(drive) or not rest.startswith(("\\", "/")):
        _fail()
    parts = rest.replace("/", "\\").split("\\")[1:]
    if not parts or any(not part or part in (".", "..") or part.endswith((".", " "))
            or len(part) > 255 or any(ord(char) < 32 or char in '<>:"|?*' for char in part)
            or part.split(".", 1)[0].rstrip(" ").upper() in _RESERVED for part in parts):
        _fail()
    normalized = drive + "\\" + "\\".join(parts)
    parents = [drive + "\\"]
    for part in parts[:-1]:
        parents.append(ntpath.join(parents[-1], part))
    return normalized, tuple(parents)


def _ordinary(info, *, directory):
    attributes = getattr(info, "st_file_attributes", 0)
    if (attributes & _REPARSE or stat.S_ISLNK(info.st_mode)
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)):
        _fail()


@contextmanager
def _parents(raw):
    path, parents = _path(raw)
    windows = _Windows()
    handles = []
    try:
        for parent in parents:
            before = os.lstat(parent)
            _ordinary(before, directory=True)
            handle = windows.open_directory(parent)
            handles.append(handle)
            after = os.lstat(parent)
            _ordinary(after, directory=True)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                _fail()
        yield path, windows
    finally:
        failed = False
        for handle in reversed(handles):
            try:
                windows.close_handle(handle)
            except Exception:
                failed = True
        if failed:
            _fail()


def _read_cipher(path, windows):
    before = os.lstat(path)
    _ordinary(before, directory=False)
    if not _OUTER_HEADER < before.st_size <= MAX_PROTECTED_FILE_BYTES:
        _fail()
    fd = windows.open_read_fd(path)
    try:
        opened = os.fstat(fd)
        _ordinary(opened, directory=False)
        if (before.st_dev, before.st_ino, before.st_size) != (opened.st_dev, opened.st_ino, opened.st_size):
            _fail()
        chunks, count = [], 0
        while True:
            piece = os.read(fd, min(64 * 1024, MAX_PROTECTED_FILE_BYTES + 1 - count))
            if not piece:
                break
            count += len(piece)
            if count > MAX_PROTECTED_FILE_BYTES:
                _fail()
            chunks.append(piece)
        after = os.fstat(fd)
        _ordinary(after, directory=False)
        if (after.st_dev, after.st_ino, after.st_size, count) != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_size):
            _fail()
        return b"".join(chunks)
    finally:
        os.close(fd)


def read_protected_archive(input_path, *, expected_source_resource_sha256, expected_source_image_sha256,
                           expected_source_archive_sha256):
    """Independent local restore from an explicit ordinary path and three SHAs."""
    try:
        _identities(expected_source_resource_sha256, expected_source_image_sha256, expected_source_archive_sha256)
        with _parents(input_path) as (path, windows):
            protected = _read_cipher(path, windows)
            return unprotect_archive_bytes(protected,
                expected_source_resource_sha256=expected_source_resource_sha256,
                expected_source_image_sha256=expected_source_image_sha256,
                expected_source_archive_sha256=expected_source_archive_sha256)
    except Exception:
        raise ProtectedArchiveError() from None


def write_protected_archive(archive, *, output_path, expected_source_resource_sha256,
                            expected_source_image_sha256, expected_source_archive_sha256):
    """Create a NEW ciphertext file, fsync+close, independently restore and hash.

    Failure may leave a ciphertext-only artifact; never overwrite/delete it or
    call it a verified backup. The caller must select a fresh explicit path.
    """
    try:
        # Reject malformed paths before encryption. Parent existence, links and
        # real permissions are checked without mkdir/SetAcl/elevation.
        _path(output_path)
        protected = protect_archive_bytes(archive,
            expected_source_resource_sha256=expected_source_resource_sha256,
            expected_source_image_sha256=expected_source_image_sha256,
            expected_source_archive_sha256=expected_source_archive_sha256)
        with _parents(output_path) as (path, windows):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_BINARY, 0o600)
            try:
                _ordinary(os.fstat(fd), directory=False)
                view = memoryview(protected)
                offset = 0
                while offset < len(view):
                    count = os.write(fd, view[offset:offset + 64 * 1024])
                    if type(count) is not int or count <= 0:
                        _fail()
                    offset += count
                os.fsync(fd)
                info = os.fstat(fd)
                _ordinary(info, directory=False)
                if info.st_size != len(protected):
                    _fail()
            finally:
                os.close(fd)
            reread = _read_cipher(path, windows)
            if not hmac.compare_digest(hashlib.sha256(reread).digest(), hashlib.sha256(protected).digest()):
                _fail()
            restored = unprotect_archive_bytes(reread,
                expected_source_resource_sha256=expected_source_resource_sha256,
                expected_source_image_sha256=expected_source_image_sha256,
                expected_source_archive_sha256=expected_source_archive_sha256)
            if not hmac.compare_digest(restored, archive):
                _fail()
            result = {"profile": PROFILE, "source_resource_sha256": expected_source_resource_sha256,
                "source_image_sha256": expected_source_image_sha256,
                "source_archive_sha256": expected_source_archive_sha256,
                "archive_bytes": len(archive), "protected_file_bytes": len(protected),
                "protected_file_sha256": hashlib.sha256(protected).hexdigest(),
                "local_current_user_readback_verified": True, "cross_machine_restore_verified": False,
                "cloud_restore_verified": False, "migration_authorized": False}
        return result
    except Exception:
        raise ProtectedArchiveError() from None
