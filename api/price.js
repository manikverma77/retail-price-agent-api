// POST /api/price
// Basic pricing engine using manual comps + mode adjustment

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weightedMedian(values, weights) {
  const sorted = values
    .map((v, i) => ({ v, w: weights[i] }))
    .sort((a, b) => a.v - b.v);

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0;

  for (let item of sorted) {
    cumulative += item.w;
    if (cumulative >= totalWeight / 2) {
      return item.v;
    }
  }

  return sorted[sorted.length - 1].v;
}

function classifyTrimTier(trimRaw) {
  const t = (trimRaw || "").toString().toUpperCase();

  if (!t) return { tier: "unknown", matched: null };

  // ULTRA / top trims across brands
  const ultra = ["DENALI", "HIGH COUNTRY", "LIMITED", "PLATINUM", "AUTOBIOGRAPHY", "SIGNATURE", "MAYBACH"];
  if (ultra.some(k => t.includes(k))) return { tier: "ultra", matched: ultra.find(k => t.includes(k)) };

  // PREMIUM trims
  const premium = ["KING RANCH", "LARAMIE", "LTZ", "SLT", "PREMIER", "RESERVE", "SUMMIT", "OVERLAND", "TRAIL BOSS", "AT4"];
  if (premium.some(k => t.includes(k))) return { tier: "premium", matched: premium.find(k => t.includes(k)) };

  // MID trims
  const mid = ["LARIAT", "BIG HORN", "BIGHORN", "SPORT", "XLT", "SLE", "LT", "ELEVATION", "RST", "REBEL"];
  if (mid.some(k => t.includes(k))) return { tier: "mid", matched: mid.find(k => t.includes(k)) };

  // BASE trims
  const base = ["TRADESMAN", "XL", "CUSTOM", "WT", "WORK TRUCK", "PRO", "ST"];
  if (base.some(k => t.includes(k))) return { tier: "base", matched: base.find(k => t.includes(k)) };

  return { tier: "unknown", matched: null };
}

function classifyCabTier(cabRaw) {
  const c = (cabRaw || "").toString().toUpperCase();

  if (!c) return "unknown";

  if (c.includes("CREW") || c.includes("MEGA")) return "premium";
  if (c.includes("DOUBLE") || c.includes("QUAD") || c.includes("SUPERCAB")) return "mid";
  if (c.includes("REGULAR")) return "base";

  return "unknown";
}

function classifyBoxTier(boxRaw) {
  const b = (boxRaw || "").toString().toUpperCase();

  if (!b) return "unknown";

  // Normalize common lengths
  if (b.includes("8")) return "long";
  if (b.includes("6")) return "standard";
  if (b.includes("5")) return "short";

  return "unknown";
}


module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const body = req.body || {};
    const vehicle = body.vehicle || {};
    const comps = body.comps || [];
    const compCount = comps.length;
    const mode = body.mode || "fast"; // fast or max

    if (!comps.length) {
      return res.status(400).json({ error: "No comps provided." });
    }

    // Normalize comp prices and km
    const compPrices = comps.map(c => Number(c.price));
    const compKms = comps.map(c => Number(c.km));

    // Compute baseline median price
    const baseMedian = median(compPrices);

    // Weight comps closer in KM more heavily
    const targetKm = Number(vehicle.km || 0);
    const weights = compKms.map(km => {
      const diff = Math.abs(km - targetKm);
      return 1 / (1 + diff / 20000); // smooth decay
    });

    const weightedBase = weightedMedian(compPrices, weights);

    let adjustedPrice = weightedBase;
    // Diagnostic breakdown (price + multipliers at each step)
    const breakdown = {
      weightedBase: { price: Math.round(weightedBase), multiplier: 1.0 }
    };
    
    // Condition adjustment (1–5)
    const conditionRatingRaw = body.conditionRating;
    const conditionRating = Number.isFinite(Number(conditionRatingRaw))
      ? Math.max(1, Math.min(5, Math.round(Number(conditionRatingRaw))))
      : 3; // default "average"

// Default condition multipliers (overrideable via body.conditionMultipliers)
const defaultConditionMultipliers = {
  1: 0.93,
  2: 0.97,
  3: 1.00,
  4: 1.02,
  5: 1.04
};

const conditionMultipliers =
  (body.conditionMultipliers && typeof body.conditionMultipliers === "object")
    ? { ...defaultConditionMultipliers, ...body.conditionMultipliers }
    : defaultConditionMultipliers;

const conditionMultiplier = conditionMultipliers[conditionRating] || 1.00;

adjustedPrice *= conditionMultiplier;
breakdown.afterCondition = {
  price: Math.round(adjustedPrice),
  multiplier: conditionMultiplier
};
    
    // Accident adjustment
const accidentGrade = body.accidentGrade || "minor";

// Default accident adjustment table (can be overridden later)
const defaultAccidentAdjustments = {
  none: 1.02,      // clean carfax premium
  minor: 1.00,
  moderate: 0.97,
  large: 0.94
};

const accidentAdjustments =
  (body.accidentAdjustments && typeof body.accidentAdjustments === "object")
    ? { ...defaultAccidentAdjustments, ...body.accidentAdjustments }
    : defaultAccidentAdjustments;

const accidentMultiplier =
  accidentAdjustments[accidentGrade] || 1.00;

adjustedPrice *= accidentMultiplier;
  breakdown.afterAccident = {
  price: Math.round(adjustedPrice),
  multiplier: accidentMultiplier
};
    
  // Cab/Box adjustment
const cabTier = classifyCabTier(vehicle.cab || "");
const boxTier = classifyBoxTier(vehicle.box || "");

// Default cab multipliers (overrideable via body.cabMultipliers)
const defaultCabMultipliers = {
  premium: 1.04,
  mid: 1.00,
  base: 0.95,
  unknown: 1.00
};

const cabMultipliers =
  (body.cabMultipliers && typeof body.cabMultipliers === "object")
    ? { ...defaultCabMultipliers, ...body.cabMultipliers }
    : defaultCabMultipliers;

const cabMultiplier = cabMultipliers[cabTier] || 1.00;
adjustedPrice *= cabMultiplier;
breakdown.afterCab = {
  price: Math.round(adjustedPrice),
  multiplier: cabMultiplier
};
    
// Default box multipliers (overrideable via body.boxMultipliers)
const defaultBoxMultipliers = {
  short: 1.00,
  standard: 1.00,
  long: 0.98,
  unknown: 1.00
};

const boxMultipliers =
  (body.boxMultipliers && typeof body.boxMultipliers === "object")
    ? { ...defaultBoxMultipliers, ...body.boxMultipliers }
    : defaultBoxMultipliers;

const boxMultiplier = boxMultipliers[boxTier] || 1.00;
adjustedPrice *= boxMultiplier;
breakdown.afterBox = {
  price: Math.round(adjustedPrice),
  multiplier: boxMultiplier
};
    
    // Trim tier adjustment
const trimRaw = vehicle.trim || "";
const { tier: trimTier, matched: matchedKeyword } = classifyTrimTier(trimRaw);

// Default trim multipliers (overrideable)
const defaultTrimMultipliers = {
  base: 1.00,
  mid: 1.02,
  premium: 1.05,
  ultra: 1.08,
  unknown: 1.00
};

const trimMultipliers =
  (body.trimMultipliers && typeof body.trimMultipliers === "object")
    ? { ...defaultTrimMultipliers, ...body.trimMultipliers }
    : defaultTrimMultipliers;

const trimMultiplier = trimMultipliers[trimTier] || 1.00;

adjustedPrice *= trimMultiplier;
breakdown.afterTrim = {
  price: Math.round(adjustedPrice),
  multiplier: trimMultiplier
};
    
    // Mode adjustment
    let modeMultiplier = 1.0;
    if (mode === "fast") modeMultiplier = 0.97;
    else if (mode === "max") modeMultiplier = 1.05;
    
    adjustedPrice *= modeMultiplier;
    
    // record mode step in breakdown
    breakdown.afterMode = {
      price: Math.round(adjustedPrice),
      multiplier: modeMultiplier
    };

    const recommendedList = Math.round(adjustedPrice);
    const expectedCloseLow = Math.round(recommendedList * 0.97);
    const expectedCloseHigh = Math.round(recommendedList * 0.995);
    const expectedCloseRange = [expectedCloseLow, expectedCloseHigh];

    const confidence =
      comps.length >= 8
        ? "high"
        : comps.length >= 4
        ? "medium"
        : "low";

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

  // cab/box
  cabTier,
  cabMultiplier,
  boxTier,
  boxMultiplier,

  // trim
  trimTier,
  trimMultiplier, 

  breakdown, 
});

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
