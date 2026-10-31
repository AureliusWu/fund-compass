"""Closed, bounded machine task inputs; never accept client-side holdings."""
from __future__ import annotations

from datetime import date
import hashlib
import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

from models.api import EstimateContext, EstimateDiagnostics
from models.owner_analysis import OwnerAnalysisEvidence
from models.owner_sync import MAX_SAFE_INTEGER, _float, _integer, _materialize, _pairs

MAX_BODY_BYTES = 16 * 1024
MAX_EVIDENCE_BODY_BYTES = 128 * 1024
_ID = r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$"
_SHA = r"^[0-9a-f]{64}$"


class MachineInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    occurrence_date: str

    @field_validator("occurrence_date")
    @classmethod
    def exact_date(cls, value: str) -> str:
        if len(value) != 10 or date.fromisoformat(value).isoformat() != value:
            raise ValueError("invalid occurrence date")
        return value


class MachineInvocation(MachineInput):
    request_id: str = Field(pattern=_ID)
    trigger: Literal["scheduled", "manual"]
    slot: Literal["14:30", "14:40"]
    worker_build_sha: str = Field(pattern=r"^[0-9a-f]{40}$")


class MachinePrepare(MachineInvocation):
    expected_revision: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    source_hash: str = Field(pattern=_SHA)
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    evidence: tuple[OwnerAnalysisEvidence, ...] = Field(min_length=1, max_length=100)

    @field_validator("evidence", mode="before")
    @classmethod
    def array(cls, value):
        if type(value) is not list:
            raise ValueError("array required")
        return tuple(value)

    @model_validator(mode="after")
    def exact_codes(self):
        codes = [row.code for row in self.evidence]
        if codes != sorted(set(codes)):
            raise ValueError("sorted complete evidence required")
        return self


class MachineEstimateDiagnostics(EstimateDiagnostics):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class MachineEstimateContext(EstimateContext):
    """Canonical Worker market observations, not client financial decisions."""
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    diagnostics: MachineEstimateDiagnostics = Field(default_factory=MachineEstimateDiagnostics)

    @model_validator(mode="before")
    @classmethod
    def canonical_fields(cls, value):
        # The old public DTO still accepts documented aliases. A new machine
        # packet must not gain a second interpretation through that fallback.
        if (type(value) is not dict or set(value) - set(cls.model_fields)
                or value.get("kind") not in {"intraday_estimate", "qdii_next_nav_estimate", "holdings_model", "official_nav", "unavailable"}
                or value.get("kind") == "intraday_estimate" and value.get("nav_date") is not None):
            raise ValueError("canonical estimate context required")
        return value


class MachineObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    code: str = Field(pattern=r"^[0-9]{6}$")
    estimate_context: MachineEstimateContext


class MachineEvidence(MachineInvocation):
    expected_revision: int = Field(ge=0, le=MAX_SAFE_INTEGER)
    source_hash: str = Field(pattern=_SHA)
    policy_version: str = Field(pattern=r"^pol_[0-9a-f]{64}$")
    observations: tuple[MachineObservation, ...] = Field(min_length=1, max_length=100)
    _raw_request_hash: str | None = PrivateAttr(default=None)

    def request_hash(self):
        if self._raw_request_hash is None:
            raise ValueError("original machine evidence bytes required")
        return self._raw_request_hash

    @field_validator("observations", mode="before")
    @classmethod
    def array(cls, value):
        if type(value) is not list:
            raise ValueError("array required")
        return tuple(value)

    @model_validator(mode="after")
    def exact_codes(self):
        codes = [row.code for row in self.observations]
        if codes != sorted(set(codes)):
            raise ValueError("sorted complete observations required")
        return self


class MachineClaim(MachineInvocation):
    task_hash: str = Field(pattern=_SHA)


class MachineFinish(MachineInput):
    slot: Literal["14:30", "14:40"]
    attempt_hash: str = Field(pattern=_SHA)
    outcome: Literal["sent", "delivery_rejected", "delivery_ambiguous", "pre_delivery_failed"]


def parse_machine_input(raw: bytes | str, model, *, max_body_bytes=MAX_BODY_BYTES):
    """Reject duplicate keys, booleans-as-numbers and non-JSON representations."""
    if type(raw) is bytes:
        if len(raw) > max_body_bytes:
            raise ValueError("invalid machine input")
        raw = raw.decode("utf-8", errors="strict")
    if type(raw) is not str or len(raw.encode("utf-8")) > max_body_bytes or raw.startswith("\ufeff"):
        raise ValueError("invalid machine input")
    value = json.loads(raw, object_pairs_hook=_pairs, parse_int=_integer, parse_float=_float,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
    result = model.model_validate(_materialize(value))
    if isinstance(result, MachineEvidence):
        result._raw_request_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return result
