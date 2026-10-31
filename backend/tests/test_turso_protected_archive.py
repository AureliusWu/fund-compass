"""Only newly generated synthetic archive bytes/files; no source or credentials."""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "tools" / "turso_protected_archive.py"
SPEC = importlib.util.spec_from_file_location("turso_protected_archive", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(module)

PRIVATE = b"synthetic-new-private-archive-only-not-real-data\0" * 300
RESOURCE, IMAGE = "1" * 64, "2" * 64
IDENTITY = dict(expected_source_resource_sha256=RESOURCE, expected_source_image_sha256=IMAGE,
                expected_source_archive_sha256=hashlib.sha256(PRIVATE).hexdigest())
REAL_WINDOWS = pytest.mark.skipif(os.name != "nt", reason="real CurrentUser DPAPI requires Windows")


def fails(function, *args, **kwargs):
    with pytest.raises(module.ProtectedArchiveError) as failure:
        function(*args, **kwargs)
    assert failure.value.args == ("protected_archive_failed",)


def test_import_has_no_credential_or_network_operation(monkeypatch):
    def forbidden(*_args, **_kwargs): pytest.fail("constructor/import discovered credentials or network")
    for name in ("socket", "getaddrinfo", "create_connection"):
        monkeypatch.setattr(socket, name, forbidden)
    monkeypatch.setattr(os, "getenv", forbidden)
    fresh = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(fresh)
    assert fresh.PROFILE == module.PROFILE


@REAL_WINDOWS
def test_actual_current_user_dpapi_bytes_roundtrip_and_tamper_and_wrong_hash():
    protected = module.protect_archive_bytes(PRIVATE, **IDENTITY)
    assert type(protected) is bytes and PRIVATE not in protected
    assert len(protected) <= module.MAX_PROTECTED_FILE_BYTES
    assert module.unprotect_archive_bytes(protected, **IDENTITY) == PRIVATE
    for index in (0, len(module._OUTER_PREFIX), len(protected) - 1):
        changed = bytearray(protected); changed[index] ^= 1
        fails(module.unprotect_archive_bytes, bytes(changed), **IDENTITY)
    for name in IDENTITY:
        fails(module.unprotect_archive_bytes, protected, **{**IDENTITY, name: "f" * 64})


@REAL_WINDOWS
def test_actual_cipher_tamper_with_recomputed_outer_sha_still_rejected_by_dpapi_or_inner_hash():
    protected = module.protect_archive_bytes(PRIVATE, **IDENTITY)
    offset = len(module._OUTER_PREFIX) + module._BINDING_BYTES
    cipher = bytearray(protected[offset + 40:]); cipher[-1] ^= 1
    forged = protected[:offset + 8] + hashlib.sha256(cipher).digest() + bytes(cipher)
    fails(module.unprotect_archive_bytes, forged, **IDENTITY)


@REAL_WINDOWS
def test_actual_new_cipher_file_fsync_close_readback_and_independent_restore(tmp_path, monkeypatch):
    path = tmp_path / "our-new-synthetic-archive.dpapi"
    original_write, original_fsync, original_close = os.write, os.fsync, os.close
    events, writes = [], []
    def write(fd, chunk):
        writes.append(bytes(chunk)); events.append("write")
        return original_write(fd, chunk)
    def fsync(fd): events.append("fsync"); return original_fsync(fd)
    def close(fd): events.append("close"); return original_close(fd)
    monkeypatch.setattr(os, "write", write)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "close", close)
    receipt = module.write_protected_archive(PRIVATE, output_path=str(path), **IDENTITY)
    assert receipt["local_current_user_readback_verified"] is True
    assert receipt["cross_machine_restore_verified"] is receipt["cloud_restore_verified"] is False
    assert receipt["migration_authorized"] is False
    assert events.index("write") < events.index("fsync") < events.index("close")
    assert PRIVATE not in b"".join(writes) and path.read_bytes() == b"".join(writes)
    assert module.read_protected_archive(str(path), **IDENTITY) == PRIVATE
    assert receipt["protected_file_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert PRIVATE.decode("ascii") not in json.dumps(receipt)
    original = path.read_bytes()
    fails(module.write_protected_archive, PRIVATE, output_path=str(path), **IDENTITY)
    assert path.read_bytes() == original  # O_EXCL never overwrites.


@REAL_WINDOWS
def test_actual_hard_link_and_missing_parent_are_rejected(tmp_path):
    path, alias = tmp_path / "cipher.dpapi", tmp_path / "alias.dpapi"
    module.write_protected_archive(PRIVATE, output_path=str(path), **IDENTITY)
    os.link(path, alias)
    fails(module.read_protected_archive, str(alias), **IDENTITY)
    fails(module.read_protected_archive, str(path), **IDENTITY)
    missing = tmp_path / "never-created-parent" / "archive.dpapi"
    fails(module.write_protected_archive, PRIVATE, output_path=str(missing), **IDENTITY)
    assert not missing.parent.exists()


@REAL_WINDOWS
@pytest.mark.parametrize("boundary", ["fsync", "close", "readback"])
def test_cipher_write_or_close_or_readback_failure_never_returns_a_verified_receipt(tmp_path, monkeypatch, boundary):
    path = tmp_path / ("our-new-failure-" + boundary + ".dpapi")
    class Hostile(Exception):
        def __str__(self): raise AssertionError("private cleanup error string accessed")
        def __repr__(self): raise AssertionError("private cleanup error repr accessed")
    if boundary == "fsync":
        def fail_fsync(_fd): raise Hostile(PRIVATE)
        monkeypatch.setattr(os, "fsync", fail_fsync)
    elif boundary == "close":
        original_close, closed = os.close, []
        def fail_after_close(fd):
            original_close(fd)
            closed.append(fd)
            if len(closed) == 1: raise Hostile(PRIVATE)
        monkeypatch.setattr(os, "close", fail_after_close)
    else:
        monkeypatch.setattr(module, "_read_cipher", lambda *_a, **_k: b"wrong ciphertext")
    fails(module.write_protected_archive, PRIVATE, output_path=str(path), **IDENTITY)
    assert path.exists()  # No automatic deletion or overwrite after unknown I/O.
    ciphertext = path.read_bytes()
    assert ciphertext.startswith(module._OUTER_PREFIX) and PRIVATE not in ciphertext


@REAL_WINDOWS
def test_file_size_bound_rejects_new_owned_sparse_fixture_before_decryption(tmp_path, monkeypatch):
    path = tmp_path / "our-new-oversize-fixture.dpapi"
    with path.open("xb") as stream:
        stream.truncate(module.MAX_PROTECTED_FILE_BYTES + 1)
    monkeypatch.setattr(module, "_crypt", lambda *_a, **_k: pytest.fail("oversize file reached native decrypt"))
    fails(module.read_protected_archive, str(path), **IDENTITY)


@REAL_WINDOWS
def test_reparse_parent_is_rejected_before_opening_output(tmp_path, monkeypatch):
    parent = tmp_path / "our-existing-parent"
    parent.mkdir()
    destination = parent / "archive.dpapi"
    original_lstat = os.lstat
    def reparse_lstat(path, *args, **kwargs):
        info = original_lstat(path, *args, **kwargs)
        if str(path).lower() == str(parent).lower():
            return SimpleNamespace(st_mode=info.st_mode, st_nlink=info.st_nlink,
                st_file_attributes=module._REPARSE, st_dev=info.st_dev, st_ino=info.st_ino)
        return info
    monkeypatch.setattr(os, "lstat", reparse_lstat)
    fails(module.write_protected_archive, PRIVATE, output_path=str(destination), **IDENTITY)
    assert not destination.exists()


@pytest.mark.parametrize("path", [
    "relative.dpapi", "C:relative.dpapi", "\\\\server\\share\\archive.dpapi", "//server/share/archive.dpapi",
    "\\\\?\\C:\\archive.dpapi", "\\\\.\\C:\\archive.dpapi", "C:\\folder\\..\\archive.dpapi",
    "C:\\folder\\.\\archive.dpapi", "C:\\folder\\file.dpapi:stream", "C:\\NUL", "C:\\CON.txt",
    "C:\\folder\\COM¹.txt", "C:\\folder\\file. ", "C:\\folder\\file.", "C:\\folder\\", "C:\\folder\\bad\0name",
    "C:\\folder\\a?b", "C:\\folder\\a*b", "C:\\folder\\CONIN$",
    "C:\\folder\\NUL .txt", "C:\\folder\\CON .txt", "C:\\folder\\COM1 .txt",
])
def test_nonordinary_paths_fail_before_crypto_or_file_access(monkeypatch, path):
    monkeypatch.setattr(module, "_crypt", lambda *_a, **_k: pytest.fail("invalid path encrypted bytes"))
    fails(module.write_protected_archive, PRIVATE, output_path=path, **IDENTITY)


def test_native_bytes_and_archive_cipher_bounds_reject_before_dpapi(monkeypatch):
    monkeypatch.setattr(module, "_crypt", lambda *_a, **_k: pytest.fail("invalid input called DPAPI"))
    for value in (b"", bytearray(PRIVATE), "secret"):
        fails(module.protect_archive_bytes, value, **IDENTITY)
    monkeypatch.setattr(module, "MAX_ARCHIVE_BYTES", 16)
    fails(module.protect_archive_bytes, PRIVATE, **IDENTITY)
    fails(module.unprotect_archive_bytes, b"x" * (module.MAX_PROTECTED_FILE_BYTES + 1), **IDENTITY)
    fails(module.protect_archive_bytes, PRIVATE, **{**IDENTITY, "expected_source_archive_sha256": "f" * 64})


def test_plaintext_inner_body_hash_and_binding_are_checked_even_if_native_unprotect_succeeds(monkeypatch):
    saved = []
    def fake_crypt(data, *, decrypt):
        if not decrypt: saved.append(data); return b"our-new-fake-ciphertext"
        return saved[0]
    monkeypatch.setattr(module, "_crypt", fake_crypt)
    protected = module.protect_archive_bytes(PRIVATE, **IDENTITY)
    assert module.unprotect_archive_bytes(protected, **IDENTITY) == PRIVATE
    original = saved[0]
    for offset in (0, len(module._INNER_PREFIX), len(original) - 1,
                   len(module._INNER_PREFIX) + module._BINDING_BYTES + 8):
        changed = bytearray(original); changed[offset] ^= 1; saved[0] = bytes(changed)
        fails(module.unprotect_archive_bytes, protected, **IDENTITY)
    saved[0] = original + b"extra"
    fails(module.unprotect_archive_bytes, protected, **IDENTITY)


def test_cipher_length_sha_and_magic_reject_before_native_decrypt(monkeypatch):
    monkeypatch.setattr(module, "_crypt", lambda data, *, decrypt: b"fake-ciphertext")
    protected = module.protect_archive_bytes(PRIVATE, **IDENTITY)
    monkeypatch.setattr(module, "_crypt", lambda *_a, **_k: pytest.fail("invalid frame reached native decrypt"))
    offset = len(module._OUTER_PREFIX) + module._BINDING_BYTES
    for value in (protected[:-1], protected + b"x", b"x" + protected[1:],
                  protected[:offset] + struct.pack(">Q", module.MAX_CIPHER_BYTES + 1) + protected[offset + 8:]):
        fails(module.unprotect_archive_bytes, value, **IDENTITY)


def test_reparse_and_link_attributes_fail_closed():
    directory = SimpleNamespace(st_mode=0o040700, st_nlink=1, st_file_attributes=module._REPARSE)
    fails(module._ordinary, directory, directory=True)
    symbolic = SimpleNamespace(st_mode=0o120700, st_nlink=1, st_file_attributes=0)
    fails(module._ordinary, symbolic, directory=False)
    hardlink = SimpleNamespace(st_mode=0o100600, st_nlink=2, st_file_attributes=0)
    fails(module._ordinary, hardlink, directory=False)


def test_unknown_native_error_is_never_stringified_or_leaked(monkeypatch, capsys):
    class Hostile(Exception):
        def __str__(self): raise AssertionError("unknown error string accessed")
        def __repr__(self): raise AssertionError("unknown error repr accessed")
    def fail_native(*_args, **_kwargs): raise Hostile(PRIVATE)
    monkeypatch.setattr(module, "_crypt", fail_native)
    fails(module.protect_archive_bytes, PRIVATE, **IDENTITY)
    output = capsys.readouterr()
    assert output.out == output.err == ""


@REAL_WINDOWS
def test_actual_dpapi_uses_only_current_user_ui_forbidden_and_wipes_native_buffers(monkeypatch):
    native = module._Windows()
    original_protect = native.crypt.CryptProtectData
    original_unprotect = native.crypt.CryptUnprotectData
    original_free = native.kernel.LocalFree
    allocated, flags, freed = {}, [], []
    def operation(function):
        def invoke(source, description, entropy, reserved, prompt, flag, output):
            assert description is entropy is reserved is prompt is None
            flags.append(flag)
            result = function(source, description, entropy, reserved, prompt, flag, output)
            if result:
                blob = ctypes.cast(output, ctypes.POINTER(module._Blob)).contents
                allocated[ctypes.cast(blob.pbData, ctypes.c_void_p).value] = blob.cbData
            return result
        return invoke
    def free(pointer):
        address = ctypes.cast(pointer, ctypes.c_void_p).value
        count = allocated[address]
        assert ctypes.string_at(pointer, count) == b"\0" * count
        freed.append(address)
        return original_free(pointer)
    monkeypatch.setattr(native.crypt, "CryptProtectData", operation(original_protect))
    monkeypatch.setattr(native.crypt, "CryptUnprotectData", operation(original_unprotect))
    monkeypatch.setattr(native.kernel, "LocalFree", free)
    monkeypatch.setattr(module, "_Windows", lambda: native)
    protected = module.protect_archive_bytes(PRIVATE, **IDENTITY)
    assert module.unprotect_archive_bytes(protected, **IDENTITY) == PRIVATE
    assert flags == [1, 1] and len(freed) == 2
