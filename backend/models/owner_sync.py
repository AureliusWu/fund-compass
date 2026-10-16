"""Closed, bounded Owner-sync inputs. No route or database side effects."""
from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

MAX_BODY_BYTES = 128 * 1024
MAX_JSON_DEPTH = 8
MAX_OPERATIONS = 200
MAX_SAFE_INTEGER = 2**53 - 1
SyncKind = Literal["watch", "holding", "manual_asset"]
_KINDS = frozenset(("watch", "holding", "manual_asset"))
_FUND_FIELDS = frozenset(("name", "shares", "cost", "target_weight"))
_MANUAL_FIELDS = frozenset(("name", "cls", "value", "note"))
_JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z")


class SyncValidationError(ValueError):
    """Safe error: never carries request fields or Pydantic input details."""
    def __init__(self, code: str = "invalid_sync_request"):
        self.code = code if code in {"invalid_sync_request", "invalid_sync_record"} else "invalid_sync_request"
        super().__init__("Owner sync input rejected")


class _FrozenDict(dict):
    def _deny(self, *args, **kwargs):
        raise TypeError("Owner sync values are immutable")
    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _deny


def js_trim(value: str) -> str:
    return value.strip(_JS_WHITESPACE)


def _units(value: str) -> int:
    # Both encodings are strict: escaped lone surrogates are invalid too.
    value.encode("utf-8", errors="strict")
    return len(value.encode("utf-16-le", errors="strict")) // 2


def _text(value: Any, maximum: int, *, empty: bool = False) -> str:
    if type(value) is not str or _units(value) > maximum or _CONTROLS.search(value):
        raise ValueError("invalid text")
    if not empty and not js_trim(value):
        raise ValueError("empty text")
    return value


def normalize_key(value: str, kind: str) -> str:
    if kind not in _KINDS or type(value) is not str or not 6 <= _units(value) <= 160:
        raise ValueError("invalid identity")
    if kind == "manual_asset":
        if not value.startswith("asset:"):
            raise ValueError("invalid manual identity")
        identifier = _text(value[6:], 154)
        if identifier != js_trim(identifier):
            raise ValueError("manual identity must be stable")
        return "asset:" + identifier
    if not re.match(r"^[0-9]{6}::", value):
        raise ValueError("invalid fund identity")
    account = js_trim(value[8:])
    _text(account, 64, empty=True)
    return value[:8] + account


def allowed_fields(kind: str) -> frozenset[str]:
    if kind not in _KINDS:
        raise ValueError("invalid kind")
    return _MANUAL_FIELDS if kind == "manual_asset" else _FUND_FIELDS


def normalize_sync_key(kind: str, key: str) -> str:
    return normalize_key(key, kind)


def _number(value: Any, *, nullable: bool, upper: float | None = None) -> Any:
    if value is None and nullable:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("invalid finite number")
    if type(value) is int and abs(value) > MAX_SAFE_INTEGER:
        raise ValueError("unsafe integer")
    if upper is not None and value > upper:
        raise ValueError("number out of range")
    return value


def validate_values(kind: str, values: Any, *, base: bool = False) -> dict[str, Any]:
    fields = allowed_fields(kind)
    if type(values) not in (dict, _FrozenDict) or len(values) > 16:
        raise ValueError("invalid values mapping")
    if not all(type(key) is str for key in values) or set(values) - fields - ({"kind", "deleted"} if base else set()):
        raise ValueError("unrecognized value field")
    out = dict(values)
    for key, value in out.items():
        if key == "kind":
            if type(value) is not str or value not in _KINDS:
                raise ValueError("invalid base kind")
        elif key == "deleted":
            if type(value) is not bool:
                raise ValueError("invalid base tombstone")
        elif key == "name":
            if value is not None or not base:
                _text(value, 200)
        elif key == "cls":
            if value is None and base:
                continue
            if value not in ("现金", "权益", "商品") or type(value) is not str:
                raise ValueError("invalid manual class")
        elif key == "note":
            if value is not None:
                _text(value, 2000, empty=True)
        else:
            _number(value, nullable=base or key != "value", upper=100 if key == "target_weight" else None)
    return out


def normalize_record(kind: str, values: Any, *, require_complete: bool = True) -> dict[str, Any]:
    """Validate a merged record; never infer absent holding finance as zero."""
    try:
        out = validate_values(kind, values)
        required = {"name", "cls", "value"} if kind == "manual_asset" else ({"name", "shares", "cost", "target_weight"} if kind == "holding" else {"name"})
        # This helper sees the merged stored record, not a partial operation.
        # Optional finance remains unknown; its identity/display fields cannot
        # disappear merely because a normal patch allows unknown shares.
        always_required = {"name", "cls", "value"} if kind == "manual_asset" else {"name"}
        if not always_required.issubset(out) or (require_complete and not required.issubset(out)):
            raise ValueError("incomplete record")
        if kind == "manual_asset":
            out.setdefault("note", None)
        else:
            if kind == "holding":
                if "shares" in out:
                    _number(out["shares"], nullable=not require_complete)
                elif require_complete:
                    raise ValueError("holding shares absent")
            for field in ("shares", "cost", "target_weight"):
                out.setdefault(field, None)
            if kind == "watch" and out["shares"] not in (None, 0):
                raise ValueError("watch contains a position")
        return out
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise SyncValidationError("invalid_sync_record") from None


class OwnerSyncOperation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    key: str
    kind: SyncKind
    deleted: bool
    changes: dict[str, Any] = Field(default_factory=dict)
    base_values: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def closed_values(self) -> "OwnerSyncOperation":
        object.__setattr__(self, "key", normalize_key(self.key, self.kind))
        object.__setattr__(self, "changes", _FrozenDict(validate_values(self.kind, self.changes)))
        # During a kind transition the base is the old kind's fields. Fund watch
        # and holding share a field namespace; manual records never share a key.
        object.__setattr__(self, "base_values", _FrozenDict(validate_values(self.kind, self.base_values, base=True)))
        return self


class OwnerSyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    request_id: str
    expected_revision: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    operations: tuple[OwnerSyncOperation, ...] = Field(min_length=1, max_length=MAX_OPERATIONS)
    _original_canonical: str | None = PrivateAttr(default=None)

    @field_validator("request_id")
    @classmethod
    def request_identity(cls, value: str) -> str:
        if not _REQUEST_ID.fullmatch(value):
            raise ValueError("invalid request id")
        return value

    @field_validator("operations", mode="before")
    @classmethod
    def json_array(cls, value: Any):
        if type(value) not in (list, tuple):
            raise ValueError("operations must be an array")
        return tuple(value)

    @model_validator(mode="after")
    def unique_identity(self) -> "OwnerSyncRequest":
        if len({operation.key for operation in self.operations}) != len(self.operations):
            raise ValueError("duplicate normalized identity")
        return self

    def canonical_body(self) -> str:
        if self._original_canonical is None:
            raise SyncValidationError()
        return self._original_canonical

    def request_hash(self) -> str:
        return hashlib.sha256(self.canonical_body().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _JsonNumber:
    token: str
    value: int | float


def _integer(token: str) -> _JsonNumber:
    value = int(token)
    if abs(value) > MAX_SAFE_INTEGER:
        raise ValueError("unsafe integer")
    return _JsonNumber(token, value)


def _float(token: str) -> _JsonNumber:
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return _JsonNumber(token, value)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate object key")
        result[key] = value
    return result


def _materialize(value: Any, depth: int = 1) -> Any:
    if depth > MAX_JSON_DEPTH:
        raise ValueError("JSON depth exceeded")
    if isinstance(value, _JsonNumber):
        return value.value
    if type(value) is str:
        value.encode("utf-8", errors="strict")
        return value
    if type(value) is dict:
        return {_materialize(key, depth + 1): _materialize(item, depth + 1) for key, item in value.items()}
    if type(value) is list:
        return [_materialize(item, depth + 1) for item in value]
    return value


def _original_json(value: Any) -> str:
    if isinstance(value, _JsonNumber):
        return value.token
    if type(value) is dict:
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + _original_json(value[key]) for key in sorted(value)) + "}"
    if type(value) is list:
        return "[" + ",".join(_original_json(item) for item in value) + "]"
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def parse_sync_request(raw: bytes | str) -> OwnerSyncRequest:
    """Only raw JSON can establish idempotency provenance; all errors are fixed."""
    try:
        if type(raw) is bytes:
            if len(raw) > MAX_BODY_BYTES:
                raise ValueError("body too large")
            text = raw.decode("utf-8", errors="strict")
        elif type(raw) is str:
            if len(raw.encode("utf-8", errors="strict")) > MAX_BODY_BYTES:
                raise ValueError("body too large")
            text = raw
        else:
            raise ValueError("raw JSON required")
        original = json.loads(text, object_pairs_hook=_pairs, parse_int=_integer, parse_float=_float,
                              parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("invalid number")))
        values = _materialize(original)
        if type(values) is not dict:
            raise ValueError("object required")
        request = OwnerSyncRequest.model_validate(values)
        request._original_canonical = _original_json(original)
        return request
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
        raise SyncValidationError() from None
