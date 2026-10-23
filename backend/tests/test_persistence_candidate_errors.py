"""Fixed allowlisted errors; no provider or database calls."""
import importlib.util
import io
import json
from pathlib import Path

import pytest

from service import persistence_verification as verification


SPEC = importlib.util.spec_from_file_location("candidate_error_tool", Path(__file__).resolve().parents[2] / "tools/persistence_candidate.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
PRIVATE = "synthetic-private-error-marker"


@pytest.mark.parametrize("code", sorted(module.VERIFICATION_ERROR_CODES))
def test_exact_known_verification_codes_are_allowlisted(code):
    assert module._safe_error_code(verification.VerificationError(code), verification.VerificationError,
                                  module.VERIFICATION_ERROR_CODES) == code


@pytest.mark.parametrize("code", sorted(module.ARGUMENT_ERROR_CODES))
def test_exact_known_argument_codes_are_allowlisted(code):
    assert module._safe_error_code(module.ArgumentError(code), module.ArgumentError,
                                  module.ARGUMENT_ERROR_CODES) == code


@pytest.mark.parametrize("kind", [RuntimeError, type("VerificationError", (RuntimeError,), {}),
                                   type("DerivedError", (verification.VerificationError,), {})])
def test_names_subclasses_and_attributes_are_not_trusted(kind):
    exc = kind(PRIVATE)
    exc.code = "source_code_drift"
    assert module._safe_error_code(exc, verification.VerificationError, module.VERIFICATION_ERROR_CODES) == module.OPERATION_FAILED


@pytest.mark.parametrize("args", [(PRIVATE,), (), ("source_code_drift", PRIVATE), (401,), (None,)])
def test_unknown_or_malformed_native_args_are_not_rendered(args):
    exc = verification.VerificationError(*args)
    assert module._safe_error_code(exc, verification.VerificationError, module.VERIFICATION_ERROR_CODES) == module.OPERATION_FAILED


def test_exception_string_and_custom_string_operations_are_never_called():
    class UnsafeString(str):
        def __str__(self):
            pytest.fail("must not render private exception strings")
        def __hash__(self):
            pytest.fail("must not hash custom exception strings")
    exc = verification.VerificationError(UnsafeString("source_code_drift"))
    assert module._safe_error_code(exc, verification.VerificationError, module.VERIFICATION_ERROR_CODES) == module.OPERATION_FAILED


@pytest.mark.parametrize("exc,expected", [
    (verification.VerificationError("source_code_drift"), "source_code_drift"),
    (verification.VerificationError(PRIVATE), module.OPERATION_FAILED),
    (type("VerificationError", (RuntimeError,), {})(PRIVATE), module.OPERATION_FAILED),
    (module.ArgumentError(PRIVATE), module.OPERATION_FAILED),
])
def test_main_error_path_never_outputs_success_or_private_text(tmp_path, monkeypatch, exc, expected):
    monkeypatch.setattr(module, "_path", lambda *a, **k: tmp_path / "unused.db")
    def failed(*args, **kwargs):
        raise exc
    monkeypatch.setattr(verification, "write_local_chain", failed)
    out, err = io.StringIO(), io.StringIO()
    code = module.main(["--database", "unused.db", "--namespace", "v9-acceptance-test", "write", "--candidate"],
                       stdout=out, stderr=err)
    assert code == 1 and out.getvalue() == ""
    assert json.loads(err.getvalue()) == {"ok": False, "error": expected}
    assert PRIVATE not in err.getvalue()
    assert not (tmp_path / "unused.db").exists()
