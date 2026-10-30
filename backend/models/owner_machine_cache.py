"""Explicit preparation inputs, not notification or client-held cache data."""
from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import Field, PrivateAttr, field_validator

from models.owner_machine import MachineInput
from models.owner_sync import MAX_SAFE_INTEGER, _float, _integer, _materialize, _pairs

MAX_CACHE_BODY_BYTES = 16 * 1024


class MachineCachePrepare(MachineInput):
    request_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
    worker_build_sha: str = Field(pattern=r"^[0-9a-f]{40}$")
    expected_revision: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    # This is a separately authorized public-cache operation, never an implicit
    # extension of the scheduled Worker's independent 34-observation budget.
    request_budget: Literal[100]
    _raw_request_hash: str | None = PrivateAttr(default=None)

    @field_validator("request_budget", mode="before")
    @classmethod
    def native_budget(cls, value):
        if type(value) is not int or value != 100:
            raise ValueError("explicit native request budget required")
        return value

    def request_hash(self) -> str:
        if self._raw_request_hash is None:
            raise ValueError("original cache preparation bytes required")
        return self._raw_request_hash


def parse_cache_prepare(raw: bytes | str) -> MachineCachePrepare:
    if type(raw) is bytes:
        if len(raw) > MAX_CACHE_BODY_BYTES:
            raise ValueError("invalid cache preparation")
        raw = raw.decode("utf-8", errors="strict")
    if (type(raw) is not str or len(raw.encode("utf-8")) > MAX_CACHE_BODY_BYTES
            or raw.startswith("\ufeff")):
        raise ValueError("invalid cache preparation")
    value = json.loads(raw, object_pairs_hook=_pairs, parse_int=_integer, parse_float=_float,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
    request = MachineCachePrepare.model_validate(_materialize(value))
    request._raw_request_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return request
