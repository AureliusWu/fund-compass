"""Bounded raw Owner analysis requests, without storage or market inputs."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

from models.owner_sync import (
    MAX_SAFE_INTEGER, _float, _integer, _materialize, _original_json, _pairs,
)

MAX_BODY_BYTES = 16 * 1024
MAX_EVIDENCE = 100
_REQUEST_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z")


class AnalysisValidationError(ValueError):
    """One non-sensitive error for every rejected raw analysis request."""

    code = "invalid_analysis_request"

    def __init__(self):
        super().__init__("Owner analysis input rejected")


class OwnerAnalysisEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    code: str = Field(pattern=r"^[0-9]{6}$")
    evidence_id: str = Field(pattern=r"^ev_[0-9a-f]{64}$")


class OwnerAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    request_id: str
    expected_revision: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    evidence: tuple[OwnerAnalysisEvidence, ...] = Field(min_length=1, max_length=MAX_EVIDENCE)
    _original_canonical: str | None = PrivateAttr(default=None)

    @field_validator("request_id")
    @classmethod
    def request_identity(cls, value: str) -> str:
        if not _REQUEST_ID.fullmatch(value):
            raise ValueError("invalid request id")
        return value

    @field_validator("evidence", mode="before")
    @classmethod
    def json_array(cls, value: Any):
        if type(value) not in (list, tuple):
            raise ValueError("evidence must be an array")
        return tuple(value)

    @model_validator(mode="after")
    def unique_funds(self) -> "OwnerAnalysisRequest":
        if len({item.code for item in self.evidence}) != len(self.evidence):
            raise ValueError("duplicate fund code")
        return self

    def canonical_body(self) -> str:
        if self._original_canonical is None:
            raise AnalysisValidationError()
        return self._original_canonical

    def request_hash(self) -> str:
        return hashlib.sha256(self.canonical_body().encode("utf-8")).hexdigest()


def parse_owner_analysis_request(raw: bytes | str) -> OwnerAnalysisRequest:
    """Only original raw JSON establishes a request's idempotency hash."""
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
        if text.startswith("\ufeff"):
            raise ValueError("BOM not allowed")
        original = json.loads(
            text, object_pairs_hook=_pairs, parse_int=_integer, parse_float=_float,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")),
        )
        values = _materialize(original)
        if type(values) is not dict:
            raise ValueError("object required")
        request = OwnerAnalysisRequest.model_validate(values)
        request._original_canonical = _original_json(original)
        return request
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError):
        raise AnalysisValidationError() from None
