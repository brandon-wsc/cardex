// ADR 0011: the only place raw numbers may touch money arithmetic. A
// finite `number` already names an exact decimal via its shortest
// round-trip string, so Dec keeps that value as a BigInt rational —
// .xx5 midpoints and boundary comparisons cannot drift the way IEEE-754
// doubles do. Money leaves Dec once per value, rounded half-up to cents.

const TEN = 10n;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x || 1n;
}

export class Dec {
  private constructor(
    private readonly num: bigint,
    private readonly den: bigint,
  ) {}

  private static make(num: bigint, den: bigint): Dec {
    const g = gcd(num, den);
    return new Dec(num / g, den / g);
  }

  private static coerce(other: Dec | number): Dec {
    return other instanceof Dec ? other : Dec.of(other);
  }

  static of(value: number): Dec {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Dec.of needs a finite number, got ${value}`);
    }
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(
      String(value),
    );
    if (!match) throw new RangeError(`Dec.of cannot parse ${value}`);
    const digits = (match[2] + (match[3] ?? "")).replace(/^0+(?=\d)/, "");
    const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
    const sign = match[1] === "-" ? -1n : 1n;
    return scale <= 0
      ? Dec.make(sign * BigInt(digits) * TEN ** BigInt(-scale), 1n)
      : Dec.make(sign * BigInt(digits), TEN ** BigInt(scale));
  }

  add(other: Dec | number): Dec {
    const o = Dec.coerce(other);
    return Dec.make(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(other: Dec | number): Dec {
    const o = Dec.coerce(other);
    return Dec.make(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(other: Dec | number): Dec {
    const o = Dec.coerce(other);
    return Dec.make(this.num * o.num, this.den * o.den);
  }

  div(other: Dec | number): Dec {
    const o = Dec.coerce(other);
    if (o.num === 0n) throw new RangeError("Dec division by zero");
    const num = this.num * o.den;
    const den = this.den * o.num;
    return den < 0n ? Dec.make(-num, -den) : Dec.make(num, den);
  }

  cmp(other: Dec | number): -1 | 0 | 1 {
    const o = Dec.coerce(other);
    const a = this.num * o.den;
    const b = o.num * this.den;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  static min(a: Dec, b: Dec): Dec {
    return a.cmp(b) <= 0 ? a : b;
  }

  static max(a: Dec, b: Dec): Dec {
    return a.cmp(b) >= 0 ? a : b;
  }

  // Half away from zero to `digits` decimal places — the single rounding
  // point reported money passes through.
  round(digits = 2): Dec {
    const factor = TEN ** BigInt(digits);
    const abs = this.num < 0n ? -this.num : this.num;
    const scaled = abs * factor;
    let q = scaled / this.den;
    const r = scaled % this.den;
    if (r * 2n >= this.den) q += 1n;
    return new Dec(this.num < 0n ? -q : q, factor);
  }

  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
}
