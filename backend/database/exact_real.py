"""Explicit exact-REAL value fragments for trusted, fixed SQL templates.

This opt-in primitive does not rewrite SQL, execute statements, or change any
driver default. A caller may put the returned fragment in a known SQL *value*
slot and extend its positional parameters with the returned tuple. Never use
string replacement to rewrite arbitrary SQL or treat this as a DBAPI adapter.

Only native finite ``float`` and ``None`` inputs are supported. Negative zero
is deliberately rejected; neither this primitive nor REAL-column persistence
is a claim that a stored zero retains its sign bit. Unsupported values must
use their ordinary binding path, not be coerced into floats here.
"""
from __future__ import annotations

import math
import struct


__all__ = ("exact_real_binding",)


def exact_real_binding(value: float | None) -> tuple[str, tuple[int | None, ...]]:
    """Return a REAL/NULL value expression and one integer/NULL parameter.

    A finite nonzero binary64 is signed M * 2**E, with M <= 2**53-1. Integer
    mantissas and power-of-two factors are exact in binary64. After stripping
    M's trailing zero bits, -1074 <= E <= 1023; each monotone scaling step is
    at most 2**62 and remains representable between M and the final value.
    No floating-point parameter or decimal float spelling is generated.

    The outer unary ``+`` keeps the REAL value/type but removes CAST's SQL
    expression affinity. Without it, an adjacent TEXT operand could be
    coerced differently than with an ordinary REAL-valued ``?`` parameter.
    ``None`` retains the ordinary parameter's SQL NULL semantics, not zero.
    """
    if value is None:
        return "?", (None,)
    if type(value) is not float:
        raise TypeError("exact REAL binding accepts only native float or None")
    if not math.isfinite(value):
        raise ValueError("exact REAL binding requires a finite float")

    bits = struct.unpack(">Q", struct.pack(">d", value))[0]
    sign = bits >> 63
    fraction = bits & ((1 << 52) - 1)
    encoded_exponent = bits >> 52 & 2047
    if encoded_exponent == 0 and fraction == 0:
        if sign:
            raise ValueError("exact REAL binding does not support negative zero")
        return "(+CAST(? AS REAL))", (0,)

    mantissa = fraction if encoded_exponent == 0 else (1 << 52) | fraction
    exponent = -1074 if encoded_exponent == 0 else encoded_exponent - 1023 - 52
    while mantissa % 2 == 0:
        mantissa >>= 1
        exponent += 1

    expression = "CAST(? AS REAL)"
    remaining = abs(exponent)
    operator = "*" if exponent >= 0 else "/"
    while remaining:
        shift = min(62, remaining)
        # A fixed public power of two fits signed int64 and converts to REAL
        # exactly. The private mantissa remains a native integer parameter.
        factor = 1 << shift
        expression = "(" + expression + operator + "CAST(" + str(factor) + " AS REAL))"
        remaining -= shift

    return "(+" + expression + ")", (-mantissa if sign else mantissa,)
