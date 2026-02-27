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

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const body = req.body || {};
    const vehicle = body.vehicle || {};
    const comps = body.comps || [];
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

    // Mode adjustment
    if (mode === "fast") {
      adjustedPrice *= 0.97; // -3%
    } else if (mode === "max") {
      adjustedPrice *= 1.05; // +5%
    }

    const recommendedList = Math.round(adjustedPrice);
    const expectedCloseLow = Math.round(recommendedList * 0.97);
    const expectedCloseHigh = Math.round(recommendedList * 0.995);

    const confidence =
      comps.length >= 8
        ? "high"
        : comps.length >= 4
        ? "medium"
        : "low";

    return res.status(200).json({
      recommendedList,
      expectedCloseRange: [expectedCloseLow, expectedCloseHigh],
      baseMedian,
      weightedBase: Math.round(weightedBase),
      mode,
      compCount: comps.length,
      confidence
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
