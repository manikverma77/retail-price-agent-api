// POST /api/normalizeSpec
// Optional VIN decode via NHTSA vPIC + basic normalization/validation.

function cleanStr(x) {
  return (x ?? "").toString().trim();
}
function up(x) {
  return cleanStr(x).toUpperCase();
}
function isVin(vin) {
  const v = cleanStr(vin);
  return v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(v);
}

function normalizeMake(make, model) {
  const mk = up(make);
  const mdl = up(model);
  if (
    mk === "DODGE" &&
    (mdl.includes("RAM") || mdl.includes("1500") || mdl.includes("2500") || mdl.includes("3500"))
  ) {
    return "RAM";
  }
  if (mk.includes("DODGE") && mk.includes("RAM")) return "RAM";
  return mk;
}

async function decodeVin(vin) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${encodeURIComponent(
    vin
  )}?format=json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`VIN decode failed (${resp.status})`);
  const data = await resp.json();
  const row = data?.Results?.[0] || {};
  return {
    ModelYear: row.ModelYear,
    Make: row.Make,
    Model: row.Model,
    Trim: row.Trim,
    FuelTypePrimary: row.FuelTypePrimary,
    EngineCylinders: row.EngineCylinders,
    DisplacementL: row.DisplacementL
  };
}

async function validateModelForMakeYear(make, year, model) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
    make
  )}/modelyear/${encodeURIComponent(year)}?format=json`;
  const resp = await fetch(url);
  if (!resp.ok) return { ok: null };
  const data = await resp.json();
  const models = (data?.Results || []).map((r) => up(r.Model_Name));
  const m = up(model);
  const ok =
    models.includes(m) ||
    models.some((x) => x === m.replace(/\s+/g, " ")) ||
    models.some((x) => x.includes(m) || m.includes(x));
  return { ok };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Use POST" });
      return;
    }

    const body = req.body || {};
    const warnings = [];
    const confidence = { yearMakeModel: "low", trim: "low", engine: "low" };
    const source = { vinDecoded: false };

    let year = cleanStr(body.year);
    let make = cleanStr(body.make);
    let model = cleanStr(body.model);
    let trim = cleanStr(body.trim);
    let engine = cleanStr(body.engine);
    let fuelType = cleanStr(body.fuelType);

    const vin = cleanStr(body.vin);
    if (vin) {
      if (!isVin(vin)) {
        warnings.push("VIN provided but invalid; ignored.");
      } else {
        const decoded = await decodeVin(vin);
        source.vinDecoded = true;
        source.decoded = decoded;

        if (decoded.ModelYear) year = decoded.ModelYear;
        if (decoded.Make) make = decoded.Make;
        if (decoded.Model) model = decoded.Model;
        if (decoded.Trim) trim = decoded.Trim;
        if (decoded.FuelTypePrimary) fuelType = decoded.FuelTypePrimary;

        if (!engine) {
          const parts = [];
          if (decoded.DisplacementL) parts.push(`${decoded.DisplacementL}L`);
          if (decoded.EngineCylinders) parts.push(`${decoded.EngineCylinders}cyl`);
          engine = parts.join(" ");
        }

        confidence.yearMakeModel = "high";
        confidence.trim = decoded.Trim ? "medium" : "low";
        confidence.engine = decoded.DisplacementL || decoded.EngineCylinders ? "medium" : "low";
      }
    }

    const makeNorm = normalizeMake(make, model);
    if (make && makeNorm !== up(make)) warnings.push(`Make normalized to "${makeNorm}".`);
    make = makeNorm;

    if (year && !/^\d{4}$/.test(year)) {
      warnings.push("Year invalid; cleared.");
      year = "";
    }

    if (year && make && model) {
      const v = await validateModelForMakeYear(make, year, model);
      if (v.ok === false) {
        warnings.push(`Model "${model}" not found under ${make} for ${year}; cleared model+trim.`);
        model = "";
        trim = "";
      } else if (v.ok === true) {
        confidence.yearMakeModel = confidence.yearMakeModel === "high" ? "high" : "medium";
      }
    }

    if (trim && !source.vinDecoded && up(trim) === "TOURING") {
      warnings.push(`Trim "${trim}" looks invalid; cleared (unvalidated).`);
      trim = "";
    }

    res.status(200).json({
      normalized: {
        vin: vin || null,
        year: year || null,
        make: make || null,
        model: model || null,
        trim: trim || null,
        engine: engine || null,
        fuelType: fuelType || null,
        region: cleanStr(body.region) || "GTA + Burlington",
        km: body.km ?? null,
        cab: cleanStr(body.cab) || null,
        box: cleanStr(body.box) || null,
        drivetrain: cleanStr(body.drivetrain) || null,
        transmission: cleanStr(body.transmission) || null,
        color: cleanStr(body.color) || null,
        accidentClaimAmount: body.accidentClaimAmount ?? null,
        owners: body.owners ?? null,
        postalCode: cleanStr(body.postalCode) || null
      },
      warnings,
      confidence,
      source
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Server error" });
  }
}
