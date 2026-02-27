// api/price.js
// POST /api/price
//
// Lightweight retail-pricing engine (manual comps) with an explainable, tunable multiplier stack.
// Designed to scale across trucks/SUVs (2010–2025+) without hardcoding model-specific trims.
//
// Stack order (matches your "dealer reality" priorities):
//   1) KM-weighted market anchor (from comps)
//   2) Condition (1–5)
//   3) Accident grade
//   4) Engine type (diesel/gas/hybrid/electric)
//   5) Cab tier
//   6) Box tier
//   7) Trim tier
//   8) Mode (fast vs max)
//
// Everything is overrideable via request body tables to allow calibration + avoid drift.
// Includes a diagnostic breakdown with $ formatting, deltas, and per-step multipliers.

function formatCurrency(value) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: 0
  }).format(value);
}

function recordStep(breakdown, key, price, multiplier) {
  // Previous step is the last inserted key
  const keys = Object.keys(breakdown);
  const prevKey = keys[keys.length - 1];
  const prevPrice = breakdown[prevKey]?.price ?? Math.round(price);

  const roundedPrice = Math.round(price);
  const delta = roundedPrice - prevPrice;

  breakdown[key] = {
    price: roundedPrice,
    priceFormatted: formatCurrency(roundedPrice),
    delta,
    deltaFormatted: (delta >= 0 ? "+" : "-") + formatCurrency(Math.abs(delta)),
    multiplier
  };
}

function normalizeText(s) {
  return (s || "")
    .toString()
    .toUpperCase()
    .replace(/[_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Detect broad segment for trucks/SUVs without hardcoding every trim.
// Returns: "hd" | "halfton" | "other"
function detectVehicleSegment(vehicle) {
  const make = normalizeText(vehicle.make);
  const model = normalizeText(vehicle.model);
  const trim = normalizeText(vehicle.trim);
  const combined = normalizeText(`${make} ${model} ${trim}`);

  // --- HD patterns ---
  // RAM: 2500/3500
  if (/\b(2\s?500|3\s?500)\b/.test(combined)) return "hd";

  // Ford: F-250/F-350 (accept F250, F 250, SUPER DUTY)
  if (/\bF\s?-?\s?2\s?50\b/.test(combined)) return "hd";
  if (/\bF\s?-?\s?3\s?50\b/.test(combined)) return "hd";
  if (combined.includes("SUPER DUTY")) return "hd";

  // GM: 2500HD / 3500HD, 2500/3500
  if (/\b(2\s?500HD|3\s?500HD)\b/.test(combined)) return "hd";
  if (/\b(2\s?500|3\s?500)\b/.test(combined) && (combined.includes("SILVERADO") || combined.includes("SIERRA"))) return "hd";

  // --- Half-ton patterns ---
  // RAM 1500
  if (/\b1\s?500\b/.test(combined) && combined.includes("RAM")) return "halfton";

  // Ford F-150
  if (/\bF\s?-?\s?1\s?50\b/.test(combined)) return "halfton";

  // GM 1500
  if (/\b1\s?500\b/.test(combined) && (combined.includes("SILVERADO") || combined.includes("SIERRA"))) return "halfton";

  // Toyota / Nissan (default to half-ton if those models appear)
  if (combined.includes("TUNDRA")) return "halfton";
  if (combined.includes("TITAN")) return "halfton";

  return "other";
}


function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedMedian(values, weights) {
  // Weighted median of values, with corresponding positive weights.
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0;

  for (const p of pairs) {
    cumulative += p.w;
    if (cumulative >= totalWeight / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

function classifyTrimTier(trimRaw) {
  const t = (trimRaw || "").toString().toUpperCase().trim();
  if (!t) return { tier: "unknown", matched: null };

  // Ultra / top trims across brands
  const ultra = [
    "DENALI",
    "HIGH COUNTRY",
    "LIMITED",
    "PLATINUM",
    "AUTOBIOGRAPHY",
    "SIGNATURE",
    "MAYBACH"
  ];
  const ultraHit = ultra.find((k) => t.includes(k));
  if (ultraHit) return { tier: "ultra", matched: ultraHit };

  // Premium trims
  const premium = [
    "KING RANCH",
    "LARAMIE",
    "LTZ",
    "SLT",
    "PREMIER",
    "RESERVE",
    "SUMMIT",
    "OVERLAND",
    "TRAIL BOSS",
    "AT4"
  ];
  const premiumHit = premium.find((k) => t.includes(k));
  if (premiumHit) return { tier: "premium", matched: premiumHit };

  // Mid trims
  const mid = [
    "LARIAT",
    "BIG HORN",
    "BIGHORN",
    "SPORT",
    "XLT",
    "SLE",
    "LT",
    "ELEVATION",
    "RST",
    "REBEL"
  ];
  const midHit = mid.find((k) => t.includes(k));
  if (midHit) return { tier: "mid", matched: midHit };

  // Base trims
  const base = ["TRADESMAN", "XL", "CUSTOM", "WT", "WORK TRUCK", "PRO", "ST"];
  const baseHit = base.find((k) => t.includes(k));
  if (baseHit) return { tier: "base", matched: baseHit };

  return { tier: "unknown", matched: null };
}

function classifyCabTier(cabRaw) {
  const c = (cabRaw || "").toString().toUpperCase().trim();
  if (!c) return "unknown";

  // Premium
  if (c.includes("CREW") || c.includes("MEGA")) return "premium";

  // Mid (various OEM naming)
  if (c.includes("DOUBLE") || c.includes("QUAD") || c.includes("SUPERCAB"))
    return "mid";

  // Base
  if (c.includes("REGULAR")) return "base";

  return "unknown";
}

function classifyBoxTier(boxRaw) {
  const b = (boxRaw || "").toString().toUpperCase().trim();
  if (!b) return "unknown";

  // Simple heuristics by presence of "5", "6", "8" (works for "6'4", "6.5", "8ft", etc.)
  if (b.includes("8")) return "long";
  if (b.includes("6")) return "standard";
  if (b.includes("5")) return "short";

  return "unknown";
}

function classifyEngineType({ engineRaw, fuelTypeRaw }) {
  const e = (engineRaw || "").toString().toUpperCase();
  const f = (fuelTypeRaw || "").toString().toUpperCase();

  // Prefer explicit fuelType if present (e.g., from VIN decode)
  if (f.includes("DIESEL")) return "diesel";
  if (f.includes("GAS") || f.includes("GASOLINE")) return "gas";
  if (f.includes("HYBRID")) return "hybrid";
  if (f.includes("ELECTRIC")) return "electric";

  // Infer from engine string
  const dieselKeys = [
    "DIESEL",
    "CUMMINS",
    "DURAMAX",
    "POWER STROKE",
    "POWERSTROKE",
    "TDI",
    "D4D"
  ];
  if (dieselKeys.some((k) => e.includes(k))) return "diesel";

  if (e.includes("HYBRID")) return "hybrid";

  const electricKeys = ["ELECTRIC", " EV", "EV "];
  if (electricKeys.some((k) => e.includes(k))) return "electric";

  // If we see displacement/cylinder pattern but no diesel/hybrid/EV hints, assume gas
  if (
    /\d\.\dL/.test(e) ||
    e.includes("V6") ||
    e.includes("V8") ||
    e.includes("I4") ||
    e.includes("I6")
  ) {
    return "gas";
  }

  return "unknown";
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const body = req.body || {};
    const vehicle = body.vehicle || {};
    const comps = Array.isArray(body.comps) ? body.comps : [];
    const compCount = comps.length;
    const mode = (body.mode || "fast").toString().toLowerCase(); // "fast" or "max"

    if (compCount === 0) {
      return res.status(400).json({ error: "No comps provided." });
    }

    // --- Normalize comp numeric inputs ---
    const compPrices = comps
      .map((c) => Number(c.price))
      .filter((v) => Number.isFinite(v) && v > 0);

    const compKms = comps
      .map((c) => Number(c.km))
      .filter((v) => Number.isFinite(v) && v >= 0);

    if (compPrices.length === 0 || compKms.length === 0) {
      return res
        .status(400)
        .json({ error: "Comps must include numeric price and km." });
    }

    // NOTE: If compPrices and compKms lengths diverge due to filtering,
    // we should re-pair. To keep it simple and safe, re-build paired comps:
    const paired = comps
      .map((c) => ({ price: Number(c.price), km: Number(c.km) }))
      .filter(
        (p) =>
          Number.isFinite(p.price) &&
          p.price > 0 &&
          Number.isFinite(p.km) &&
          p.km >= 0
      );

    if (paired.length === 0) {
      return res
        .status(400)
        .json({ error: "Comps must include numeric price and km." });
    }

    const prices = paired.map((p) => p.price);
    const kms = paired.map((p) => p.km);

    // --- Baseline market anchor ---
    const baseMedian = median(prices);

    // If vehicle.km is missing, default targetKm to median comp km to avoid skewed weights.
    const targetKmRaw = Number(vehicle.km);
    const targetKm = Number.isFinite(targetKmRaw) && targetKmRaw > 0 ? targetKmRaw : median(kms);

    // Weight comps closer in KM more heavily (smooth decay)
    const weights = kms.map((km) => {
      const diff = Math.abs(km - targetKm);
      return 1 / (1 + diff / 20000);
    });

    const weightedBase = weightedMedian(prices, weights);

    // --- Multiplier stack ---
    let adjustedPrice = weightedBase;

    // Diagnostic breakdown (dealer-desk friendly)
    const breakdown = {};
    recordStep(breakdown, "weightedBase", weightedBase, 1.0);

    // 1) Condition (1–5)
    const conditionRatingRaw = body.conditionRating;
    const conditionRating = Number.isFinite(Number(conditionRatingRaw))
      ? Math.max(1, Math.min(5, Math.round(Number(conditionRatingRaw))))
      : 3; // default average

    const defaultConditionMultipliers = {
      1: 0.93,
      2: 0.97,
      3: 1.0,
      4: 1.02,
      5: 1.04
    };

    const conditionMultipliers =
      body.conditionMultipliers && typeof body.conditionMultipliers === "object"
        ? { ...defaultConditionMultipliers, ...body.conditionMultipliers }
        : defaultConditionMultipliers;

    const conditionMultiplier = conditionMultipliers[conditionRating] ?? 1.0;
    adjustedPrice *= conditionMultiplier;
    recordStep(breakdown, "afterCondition", adjustedPrice, conditionMultiplier);

    // 2) Accident grade
    const accidentGrade = (body.accidentGrade || "minor").toString().toLowerCase();

    const defaultAccidentAdjustments = {
      none: 1.02, // clean premium (can be tuned)
      minor: 1.0,
      moderate: 0.97,
      large: 0.94
    };

    const accidentAdjustments =
      body.accidentAdjustments && typeof body.accidentAdjustments === "object"
        ? { ...defaultAccidentAdjustments, ...body.accidentAdjustments }
        : defaultAccidentAdjustments;

    const accidentMultiplier = accidentAdjustments[accidentGrade] ?? 1.0;
    adjustedPrice *= accidentMultiplier;
    recordStep(breakdown, "afterAccident", adjustedPrice, accidentMultiplier);

    // 3) Engine type (diesel/gas/hybrid/electric)
    // Prefer explicit vehicle.fuelType if provided (e.g., from VIN decode).
    const engineType = classifyEngineType({
      engineRaw: vehicle.engine,
      fuelTypeRaw: vehicle.fuelType
    });

// Segment detection (used to tune engine premiums)
const segment = detectVehicleSegment(vehicle);

// Segment-aware default engine multipliers (overrideable)
const defaultEngineMultipliersBySegment = {
  hd:      { diesel: 1.07, gas: 1.00, hybrid: 1.03, electric: 1.02, unknown: 1.00 },
  halfton: { diesel: 1.03, gas: 1.00, hybrid: 1.03, electric: 1.02, unknown: 1.00 },
  other:   { diesel: 1.05, gas: 1.00, hybrid: 1.03, electric: 1.02, unknown: 1.00 }
};

// Optional override (same shape as defaultEngineMultipliersBySegment)
// Example: body.engineMultipliersBySegment.hd.diesel = 1.08
const engineMultipliersBySegment =
  (body.engineMultipliersBySegment && typeof body.engineMultipliersBySegment === "object")
    ? {
        ...defaultEngineMultipliersBySegment,
        ...body.engineMultipliersBySegment,
        hd: { ...defaultEngineMultipliersBySegment.hd, ...(body.engineMultipliersBySegment.hd || {}) },
        halfton: { ...defaultEngineMultipliersBySegment.halfton, ...(body.engineMultipliersBySegment.halfton || {}) },
        other: { ...defaultEngineMultipliersBySegment.other, ...(body.engineMultipliersBySegment.other || {}) }
      }
    : defaultEngineMultipliersBySegment;

const engineMultiplier =
  (engineMultipliersBySegment[segment] &&
   engineMultipliersBySegment[segment][engineType] != null)
    ? engineMultipliersBySegment[segment][engineType]
    : 1.00;

adjustedPrice *= engineMultiplier;
recordStep(breakdown, "afterEngine", adjustedPrice, engineMultiplier);

    // 4) Cab / 5) Box
    const cabTier = classifyCabTier(vehicle.cab);
    const boxTier = classifyBoxTier(vehicle.box);

    const defaultCabMultipliers = {
      premium: 1.04,
      mid: 1.0,
      base: 0.95,
      unknown: 1.0
    };

    const cabMultipliers =
      body.cabMultipliers && typeof body.cabMultipliers === "object"
        ? { ...defaultCabMultipliers, ...body.cabMultipliers }
        : defaultCabMultipliers;

    const cabMultiplier = cabMultipliers[cabTier] ?? 1.0;
    adjustedPrice *= cabMultiplier;
    recordStep(breakdown, "afterCab", adjustedPrice, cabMultiplier);

    const defaultBoxMultipliers = {
      short: 1.0,
      standard: 1.0,
      long: 0.98,
      unknown: 1.0
    };

    const boxMultipliers =
      body.boxMultipliers && typeof body.boxMultipliers === "object"
        ? { ...defaultBoxMultipliers, ...body.boxMultipliers }
        : defaultBoxMultipliers;

    const boxMultiplier = boxMultipliers[boxTier] ?? 1.0;
    adjustedPrice *= boxMultiplier;
    recordStep(breakdown, "afterBox", adjustedPrice, boxMultiplier);

    // 6) Trim tier
    const { tier: trimTier } = classifyTrimTier(vehicle.trim);

    const defaultTrimMultipliers = {
      base: 1.0,
      mid: 1.02,
      premium: 1.05,
      ultra: 1.08,
      unknown: 1.0
    };

    const trimMultipliers =
      body.trimMultipliers && typeof body.trimMultipliers === "object"
        ? { ...defaultTrimMultipliers, ...body.trimMultipliers }
        : defaultTrimMultipliers;

    const trimMultiplier = trimMultipliers[trimTier] ?? 1.0;
    adjustedPrice *= trimMultiplier;
    recordStep(breakdown, "afterTrim", adjustedPrice, trimMultiplier);

    // 7) Mode (fast vs max)
    // fast -> slight discount to clear faster
    // max  -> slight premium to maximize gross
    let modeMultiplier = 1.0;
    if (mode === "fast") modeMultiplier = 0.97;
    else if (mode === "max") modeMultiplier = 1.05;

    adjustedPrice *= modeMultiplier;
    recordStep(breakdown, "afterMode", adjustedPrice, modeMultiplier);

    // Final outputs
    const recommendedList = Math.round(adjustedPrice);
    const expectedCloseLow = Math.round(recommendedList * 0.97);
    const expectedCloseHigh = Math.round(recommendedList * 0.995);
    const expectedCloseRange = [expectedCloseLow, expectedCloseHigh];

    const confidence =
      compCount >= 8 ? "high" : compCount >= 4 ? "medium" : "low";

    return res.status(200).json({
      recommendedList,
      expectedCloseRange,
      baseMedian,
      weightedBase: Math.round(weightedBase),
      mode,
      compCount,
      confidence,

      // condition
      conditionRating,
      conditionMultiplier,

      // accident
      accidentGrade,
      accidentMultiplier,

      // engine
      segment, 
      engineType,
      engineMultiplier,

      // cab/box
      cabTier,
      cabMultiplier,
      boxTier,
      boxMultiplier,

      // trim
      trimTier,
      trimMultiplier,

      // diagnostic breakdown
      breakdown
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
