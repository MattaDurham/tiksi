// Estimating data for trim: production rates, supplies, option prices and how each moulding is sold.
//
// Curated from published sources and store pages for the wall trim package template (2026-11-17):
//   LABOR     man-hours per unit from published estimating books (mostly Craftsman National
//             Construction and Painting Estimators), JLC and Fine Homebuilding; rows with no published
//             figure are marked "estimate". Each task is counted from a job measure (`per`).
//   SUPPLIES  nails, glue, adhesive, caulk, filler, sandpaper, primer, paint, protection and blades, with
//             the store item, price, package size and the job measure each is counted from; `nailing`
//             gives nails per foot for each kind of trim; `tools` the assumed kit.
//   OPTIONS   the same rooms priced other ways (profile, material, finish, store): per-LF prices by
//             trim role, labor factors by task, and the products behind them.
//   STOCK     how each catalog moulding is sold (set lengths with prices and item numbers, by the foot
//             off long stock, or both).
// Prices were seen on the dates given in each record (`seen`); refresh them before pricing a new job.
// Pure data: trim-estimate.js reads it.

// Production rates (hours per unit) by task.
export const LABOR = {
 "seen": "2026-11-17",
 "note": "Hours are the typical figures from published estimating books (mostly Craftsman, with man-hours per unit), set between book rates and carpenters' reports where they disagree. Rows without a published figure are marked estimate. Running feet plus per-joint extras are used, never the all-in rates as well.",
 "rate_note": "Default $85/hr. New York-area carpenters' employee wage (US BLS, May 2025) is a $38.73/hr mean and $59.52 at the 90th percentile, before overhead; billed finish-carpentry rates run about $70-140/hr, so $85 is the low end for a New York finish carpenter and $100-125 would be normal.",
 "tasks": [
  {
   "id": "setup",
   "label": "Set up and protect the room",
   "per": "room_days",
   "unit": "room-days",
   "unit_one": "room-day",
   "hours": 0.5,
   "basis": "Painting estimator gives 20 to 30 min per day for setup on repaint jobs and a sample estimate with 2.0 hr of furniture-and-floor protection for a 5-room job (0.4 hr per room). Typical .5 for a carpenter moving the saw station room to room in an occupied house; high for heavy furniture.",
   "source": "Craftsman 2016 National Painting Cost Estimator; Fine Homebuilding forum, 'baseboard timing'",
   "low": 0.25,
   "high": 1.0
  },
  {
   "id": "layout",
   "label": "Lay out the room with the laser, find studs",
   "per": "rooms",
   "unit": "rooms",
   "unit_one": "room",
   "hours": 0.5,
   "basis": "Estimate. No published man-hour figure found. JLC (Forget 2025) describes the method: mark one wall, check it all around the room with a laser, then solve box widths from equal 3\" gaps.",
   "source": "Marc Forget, 'An Introduction to Wainscotting', JLC, Jun 13, 2025; Fine Homebuilding forum, 'picture frame wainscot for stairs - tips?'; estimate",
   "low": 0.25,
   "high": 1.0
  },
  {
   "id": "mark_frames",
   "label": "Mark panel-frame positions",
   "per": "frames_all",
   "unit": "frames",
   "unit_one": "frame",
   "hours": 0.06,
   "basis": "Estimate (about 2 to 6 minutes per frame). Not published anywhere found. Assumes the room layout above is done and frames repeat in each wall section, so stops/story sticks are used (JLC: 'stops can be set on the miter saw to speed up production').",
   "source": "Marc Forget, 'An Introduction to Wainscotting', JLC, Jun 13, 2025; estimate",
   "low": 0.03,
   "high": 0.1
  },
  {
   "id": "mark_battens",
   "label": "Mark batten positions",
   "per": "battens",
   "unit": "battens",
   "unit_one": "batten",
   "hours": 0.03,
   "basis": "Estimate (1 to 3 minutes per batten with a cross-line laser and a spacer block). No published figure found.",
   "source": "estimate",
   "low": 0.02,
   "high": 0.05
  },
  {
   "id": "remove_base",
   "label": "Remove existing base (deduct if it stays)",
   "per": "base_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.023,
   "basis": "Craftsman demolition units, laborer crew, no wall repair. Low = NRR large volume; typical = NRR small volume, matching the NHI single-member/salvage figures; high is an Estimate for careful removal over old plaster in an occupied room.",
   "source": "Craftsman 2009 National Repair & Remodeling Estimator; Craftsman 2026 National Home Improvement Estimator; estimate",
   "low": 0.015,
   "high": 0.035
  },
  {
   "id": "base",
   "label": "Baseboard, running feet",
   "per": "base_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.035,
   "basis": "Derived from the Craftsman per-piece table: ~60 pieces averaging 2.8 LF at about .092 hr per piece = .032 hr/LF; NRR large-volume .030. Typical rounded up for 5-1/4\" stock and an occupied house. Joint time added by the adders below.",
   "source": "Craftsman 2008 National Framing & Finish Carpentry Estimator; Craftsman 2017 National Repair & Remodeling Estimator",
   "low": 0.025,
   "high": 0.045
  },
  {
   "id": "stair_base",
   "label": "Baseboard on the stair (raked)",
   "per": "stair_base_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.18,
   "basis": "Estimate, about 3x flat baseboard all-in (.055), plus scribing at the treads. No published rate found.",
   "source": "estimate",
   "low": 0.1,
   "high": 0.3
  },
  {
   "id": "chair",
   "label": "Chair rail, running feet",
   "per": "chair_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.033,
   "basis": "NRR large-volume to small-volume range; typical between. Joints added separately.",
   "source": "Craftsman 2017 National Repair & Remodeling Estimator",
   "low": 0.025,
   "high": 0.043
  },
  {
   "id": "stair_chair",
   "label": "Chair rail on the stair (raked)",
   "per": "stair_chair_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.15,
   "basis": "Estimate, about 3x flat chair rail (.050). No published stair-trim rate found; only 10 LF, so the two angled transitions dominate.",
   "source": "Fine Homebuilding forum, 'picture frame wainscot for stairs - tips?'; estimate",
   "low": 0.1,
   "high": 0.25
  },
  {
   "id": "cap",
   "label": "Wainscot cap",
   "per": "cap_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.045,
   "basis": "Books .030 to .043; typical slightly above for a short 20 LF run (fixed setup and end returns weigh more).",
   "source": "Craftsman 2016 National Construction Estimator; Craftsman 2017 National Repair & Remodeling Estimator",
   "low": 0.03,
   "high": 0.06
  },
  {
   "id": "rail",
   "label": "Flat rails (board-and-batten top rail, kit rails)",
   "per": "rail_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.04,
   "basis": "Treated as running trim at book rates; no board-and-batten-specific labor line found.",
   "source": "Craftsman 2017 National Repair & Remodeling Estimator; Craftsman 2016 National Construction Estimator",
   "low": 0.03,
   "high": 0.06
  },
  {
   "id": "frame",
   "label": "Picture-frame panels: cut, assemble, hang",
   "per": "frames",
   "unit": "frames",
   "unit_one": "frame",
   "hours": 0.4,
   "basis": "No source publishes time per frame. Three Craftsman routes converge: per-piece table (two 2' + two 2'-6\" pieces) = .36 hr; NRR panel mold .030 to .043 hr/LF x 7.85 LF per frame = .24 to .34 hr; NCE 'applied molding, per miter cut' .112 x 4 joints = .45 hr.",
   "source": "Craftsman 2008 National Framing & Finish Carpentry Estimator; Craftsman 2017 National Repair & Remodeling Estimator",
   "low": 0.3,
   "high": 0.6
  },
  {
   "id": "raked_frame",
   "label": "Raked stair panels (odd-angle miters)",
   "per": "raked",
   "unit": "frames",
   "unit_one": "frame",
   "hours": 1.0,
   "basis": "Estimate, about 2.5x a square frame. No published figure. Forum carpenters report each raked box needs angle finding, bisected miters and a sled/jig because the acute angle exceeds the saw's swing; with only 5 frames there is little repetition to amortize that setup.",
   "source": "Fine Homebuilding forum, 'picture frame wainscot for stairs - tips?'; estimate",
   "low": 0.75,
   "high": 1.5
  },
  {
   "id": "batten",
   "label": "Battens and kit stiles",
   "per": "battens",
   "unit": "battens",
   "unit_one": "batten",
   "hours": 0.12,
   "basis": "Craftsman per-piece table for a 5' to 6' trim piece is .102 to .107 hr; typical rounded up for fitting under the cap/top rail and over the baseboard. Layout of the plumb line is the separate batten-marking line.",
   "source": "Craftsman 2008 National Framing & Finish Carpentry Estimator; Craftsman 2025 National Construction Estimator",
   "low": 0.08,
   "high": 0.2
  },
  {
   "id": "cope",
   "label": "Copes at inside corners",
   "per": "copes",
   "unit": "copes",
   "unit_one": "cope",
   "hours": 0.15,
   "basis": "Only use with the *_run rates. Field guide: 5 to 10 min coping plus 3 to 5 min cleanup = 8 to 15 min; typical .15 hr for 5-1/4\" colonial base (a long cope profile); high for out-of-square corners.",
   "source": "D and G Flooring, 'Price to Install Baseboard: Average Prices and Budget Guide'; Craftsman 2016 National Construction Estimator",
   "low": 0.08,
   "high": 0.25
  },
  {
   "id": "outside",
   "label": "Outside miters",
   "per": "outside",
   "unit": "miters",
   "unit_one": "miter",
   "hours": 0.1,
   "basis": "NCE prices an applied-molding miter cut at .112 hr in cabinet work; typical rounded to .10 for paint-grade wall trim with glued corners.",
   "source": "Craftsman 2025 National Construction Estimator; Gary Katz, 'Estimating Finish Carpentry', JLC, Jun 1, 2004",
   "low": 0.05,
   "high": 0.15
  },
  {
   "id": "scarf",
   "label": "Scarf joints",
   "per": "scarfs",
   "unit": "scarfs",
   "unit_one": "scarf",
   "hours": 0.1,
   "basis": "Estimate from NCE's per-cut figures (straight .067, miter .112): a scarf is one bevel pair glued in place, so treated like an outside miter.",
   "source": "Craftsman 2025 National Construction Estimator; estimate",
   "low": 0.05,
   "high": 0.15
  },
  {
   "id": "caulk",
   "label": "Caulk edges and joints",
   "per": "caulk_lf",
   "unit": "LF",
   "unit_one": "LF of bead",
   "hours": 0.022,
   "basis": "Craftsman caulking: 1/8\" bead .018 (large) to .024 (small volume); 1/4\" bead .025 to .033. Painting estimator 'Slow' (residential) 60 LF/hr = .017. Count bead LF: baseboard top edge 1 line, chair rail 2, panel moulding 2 per LF (inside and outside edge), battens 2 per side-run, cap 1 to 2.",
   "source": "Craftsman 2009 National Repair & Remodeling Estimator; Craftsman 2016 National Painting Cost Estimator",
   "low": 0.017,
   "high": 0.033
  },
  {
   "id": "fill",
   "label": "Fill nail holes, sand, spot-prime",
   "per": "trim_lf",
   "unit": "LF",
   "unit_one": "LF of trim",
   "hours": 0.012,
   "basis": "Painting estimator putty rate (60 SF/hr slow, where SF = LF on trim under 6\" high per NRR) gives .017; HomeWyse allows up to 2 hr per 100 LF for scrape, sand and patch prep on painted base (.020, includes more than nail holes).",
   "source": "Craftsman 2016 National Painting Cost Estimator; HomeWyse, 'Cost to Paint Baseboards'; estimate",
   "low": 0.008,
   "high": 0.02
  },
  {
   "id": "paint",
   "label": "Paint trim, two coats",
   "per": "trim_lf",
   "unit": "LF",
   "unit_one": "LF of trim",
   "hours": 0.0175,
   "basis": "First finish coat 0.01 + second 0.0075 hr per LF, over the factory primer.",
   "source": "Craftsman 2016 National Construction Estimator; Matis & Toole, Paint Contractor's Manual; Matis & Toole, Paint Contractor's Manual; Craftsman 2009 National Repair & Remodeling Estimator",
   "low": 0.0083,
   "high": 0.0125
  },
  {
   "id": "cleanup",
   "label": "Clean up",
   "per": "room_days",
   "unit": "room-days",
   "unit_one": "room-day",
   "hours": 0.4,
   "basis": "Same Craftsman painting figure, 20 to 30 min per day; typical .4 because trim cutting makes more dust than painting.",
   "source": "Craftsman 2016 National Painting Cost Estimator",
   "low": 0.25,
   "high": 0.75
  }
 ],
 "tasks_extra": [
  {
   "id": "prime_loose",
   "label": "Prime bare stock before install",
   "per": "trim_lf",
   "unit": "LF",
   "unit_one": "LF",
   "hours": 0.01,
   "basis": "One coat on loose stock, at the first-finish-coat rate.",
   "source": "Craftsman 2016 National Construction Estimator; Matis & Toole, Paint Contractor's Manual"
  }
 ]
};

// Supplies, nailing rules and the tool kit.
export const SUPPLIES = {
 "seen": "2026-11-17",
 "note": "Home Depot prices at a store in the New York suburbs unless named; Benjamin Moore from its own site; FastCap from Tool Nut.",
 "items": [
  {
   "id": "nail16_2_5",
   "category": "fasteners",
   "product": "Grip-Rite 2-1/2 in. x 16-gauge glue-collated straight finish nails",
   "store": "Home Depot",
   "item_no": "Internet 320715716 / SKU 1000038732",
   "package": "box of 1,000",
   "price": 14.68,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/320715716",
   "per": "nails_n16",
   "factor": 1,
   "per_package": 1000,
   "unit": "nails",
   "basis": "16 ga 2-1/2\" for base, chair rail and top rail through plaster (about 1\" thick) into studs: 2 per stud at 16\" o.c. = 1.5 per foot.",
   "tool": "finish_nailer_16"
  },
  {
   "id": "brad18_1_5",
   "category": "fasteners",
   "product": "Grip-Rite 1-1/2 in. x 18-gauge brad nails",
   "store": "Home Depot",
   "item_no": "Internet 204344840 / SKU 1006192694",
   "package": "box of 1,000",
   "price": 12.78,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/204344840",
   "per": "nails_b15",
   "factor": 1,
   "per_package": 1000,
   "unit": "brads",
   "basis": "18 ga 1-1/2\" for the wainscot cap into the top rail: 2 per foot.",
   "tool": "brad_nailer_18"
  },
  {
   "id": "brad18_2",
   "category": "fasteners",
   "product": "DEWALT 2 in. x 18-gauge brad nails",
   "store": "Home Depot",
   "item_no": "Internet 205647387 / SKU 1001188142",
   "package": "pack of 2,500",
   "price": 27.78,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/205647387",
   "per": "nails_b20",
   "factor": 1,
   "per_package": 2500,
   "unit": "brads",
   "basis": "18 ga 2\" for battens: 2 every foot, with adhesive.",
   "tool": "brad_nailer_18"
  },
  {
   "id": "pin23_1_25",
   "category": "fasteners",
   "product": "DEWALT 1-1/4 in. x 23-gauge pin nails",
   "store": "Home Depot",
   "item_no": "Internet 328798484 / SKU 1010945774",
   "package": "pack of 2,000",
   "price": 18.78,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/328798484",
   "per": "nails_p23",
   "factor": 1,
   "per_package": 2000,
   "unit": "pins",
   "basis": "23 ga 1-1/4\" for panel moulding: 1.5 per foot plus 2 across each corner.",
   "tool": "pin_nailer_23"
  },
  {
   "id": "glue_titebond2",
   "category": "adhesives",
   "product": "Titebond II Premium Wood Glue, 16 oz",
   "store": "Home Depot",
   "item_no": "Internet 100144210 / SKU 107209",
   "package": "16 oz bottle",
   "price": 8.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100144210",
   "per": "glued_joints",
   "factor": 1,
   "per_package": 150,
   "unit": "joints",
   "basis": "Wood glue on outside miters and scarf joints; about 150 joints a bottle (estimate).",
   "tool": null
  },
  {
   "id": "ca_2p10",
   "category": "adhesives",
   "product": "FastCap 2P-10 Solo Kit: 2 oz thick CA adhesive + 12 oz activator",
   "store": "Tool Nut",
   "item_no": "model 2P-10 SOLOKIT",
   "package": "2 oz adhesive + 12 oz activator",
   "price": 23.96,
   "seen": "2026-11-17",
   "url": "https://www.toolnut.com/products/fastcap-2p-10-solo-kit-2-oz-thick-adhesive-and-12-oz-activator-bundle",
   "per": "frame_corners",
   "factor": 1,
   "per_package": 500,
   "unit": "corners",
   "basis": "CA glue and activator on every panel-frame miter, which holds the corner while the pins grab; about 500 corners a kit (estimate).",
   "tool": null
  },
  {
   "id": "adh_ln606",
   "category": "adhesives",
   "product": "Liquid Nails Paneling and Molding adhesive LN-606, 10 oz",
   "store": "Home Depot",
   "item_no": "Internet 100165601 / SKU 211334",
   "package": "10 oz cartridge",
   "price": 5.28,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100165601",
   "per": "adhesive_lf",
   "factor": 1,
   "per_package": 30,
   "unit": "LF",
   "basis": "Construction adhesive behind battens, top rail and cap on plaster: 30 LF of 1/4\" bead a tube (Liquid Nails).",
   "tool": "caulk_gun"
  },
  {
   "id": "caulk_alexplus_12",
   "category": "caulk and filler",
   "product": "DAP Alex Plus acrylic latex caulk plus silicone, white, 10.1 oz (contractor 12-pack)",
   "store": "Home Depot",
   "item_no": "Internet 100658163 / SKU 381245",
   "package": "12 x 10.1 oz cartridges",
   "price": 36.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100658163",
   "per": "caulk_lf",
   "factor": 1.1,
   "per_package": 1200,
   "unit": "LF",
   "basis": "Paintable acrylic caulk on every edge against the wall and at joints, plus 10%: about 100 LF a tube at the 1/8\" bead trim takes (DAP gives 55 LF at 3/16\", about 124 LF at 1/8\"), 12 tubes a pack.",
   "tool": "caulk_gun"
  },
  {
   "id": "filler_pwx16",
   "category": "caulk and filler",
   "product": "DAP Plastic Wood-X with DryDex wood filler, 16 oz",
   "store": "Home Depot",
   "item_no": "Internet 206667346 / SKU 1001650872",
   "package": "16 oz tub",
   "price": 13.48,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/206667346",
   "per": "holes",
   "factor": 1,
   "per_package": 2000,
   "unit": "holes",
   "basis": "Wood filler for every nail hole; about 2,000 holes a 16 oz can (estimate).",
   "tool": "putty_knife"
  },
  {
   "id": "compound_es20",
   "category": "caulk and filler",
   "product": "USG Sheetrock Easy Sand 20 lightweight setting-type joint compound, 18 lb",
   "store": "Home Depot",
   "item_no": "Internet 100321609 / SKU 462910",
   "package": "18 lb bag",
   "price": 13.96,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100321609",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Setting compound to patch plaster where the old base or rail comes off; one bag for the house.",
   "tool": null
  },
  {
   "id": "sponge_220",
   "category": "abrasives",
   "product": "3M Pro Grade Precision block sanding sponge, 220 grit extra fine (2-pack)",
   "store": "Home Depot",
   "item_no": "Internet 313299142 / SKU 1005411490",
   "package": "2 sponges",
   "price": 9.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/313299142",
   "per": "rooms",
   "factor": 1,
   "per_package": 2,
   "unit": "rooms",
   "basis": "Fine sanding sponges for fills and caulk-free joints: a pack of 2 does two rooms.",
   "tool": "sanding_block"
  },
  {
   "id": "paper_220",
   "category": "abrasives",
   "product": "3M aluminum oxide sandpaper 9 x 11 in., 220 grit (25-pack)",
   "store": "Home Depot",
   "item_no": "Internet 202520446 / SKU 1008674919",
   "package": "25 sheets",
   "price": 13.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/202520446",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "220-grit sheets for scuffing filled spots before priming; one pack.",
   "tool": "sanding_block"
  },
  {
   "id": "primer_bin_qt",
   "category": "primer and paint",
   "product": "Zinsser B-I-N shellac-based primer, 1 qt",
   "store": "Home Depot",
   "item_no": "Internet 100398380 / SKU 164267",
   "package": "1 qt",
   "price": 32.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100398380",
   "per": "face_sf",
   "factor": 0.05,
   "per_package": 100,
   "unit": "sf",
   "basis": "Shellac spot primer on cut ends, scarfs and filler (about 5% of the painted surface): 100 sf a quart (Zinsser).",
   "tool": null
  },
  {
   "id": "chip_brush",
   "category": "primer and paint",
   "product": "Home Depot (unbranded) 1 in. flat chip brush",
   "store": "Home Depot",
   "item_no": "Internet 100626121 / SKU 130222",
   "package": "1 brush",
   "price": 1.27,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100626121",
   "per": "rooms",
   "factor": 2,
   "per_package": 1,
   "unit": "brushes",
   "basis": "Throwaway brushes for the shellac primer, 2 a room.",
   "tool": null
  },
  {
   "id": "paint_advance_gal",
   "category": "primer and paint",
   "product": "Benjamin Moore Advance Interior semi-gloss (793), 1 gal, tinted White Dove OC-17",
   "store": "Benjamin Moore",
   "item_no": "product 0793",
   "package": "1 gal",
   "price": 88.99,
   "seen": "2026-11-17",
   "url": "https://www.benjaminmoore.com/en-us/product/advance-interior-paint-semi-gloss-1-gallon/0793",
   "per": "face_sf",
   "factor": 2,
   "per_package": 400,
   "unit": "sf",
   "basis": "Trim paint, two coats over the factory primer, on the face and edge of every piece: 400 sf a gallon (Benjamin Moore, low end of 400-500).",
   "tool": null
  },
  {
   "id": "brush_25",
   "category": "primer and paint",
   "product": "Wooster 2-1/2 in. Pro nylon/polyester angle sash brush",
   "store": "Home Depot",
   "item_no": "Internet 206852097 / SKU 1001725050",
   "package": "1 brush",
   "price": 15.02,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/206852097",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "brushes",
   "basis": "Angle sash brush for trim; one for the house.",
   "tool": null
  },
  {
   "id": "roller_mini",
   "category": "primer and paint",
   "product": "Wooster 4 in. x 3/8 in. Super Trimmer set (frame, cover, tray)",
   "store": "Home Depot",
   "item_no": "Internet 203150987 / SKU 1002215486",
   "package": "1 set",
   "price": 10.56,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/203150987",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "sets",
   "basis": "4\" mini roller for flat panel moulding faces; one set.",
   "tool": null
  },
  {
   "id": "tape_scotchblue",
   "category": "protection",
   "product": "3M ScotchBlue Original painter's tape, 1.88 in. x 60 yd",
   "store": "Home Depot",
   "item_no": "Internet 100550611 / SKU 315026",
   "package": "1 roll (180 ft)",
   "price": 7.88,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100550611",
   "per": "trim_lf",
   "factor": 0.5,
   "per_package": 180,
   "unit": "LF",
   "basis": "Painter's tape where trim paint meets a wall colour (about half the trim edge): 180 ft a roll.",
   "tool": null
  },
  {
   "id": "n95_8210",
   "category": "protection",
   "product": "3M 8210 Plus N95 paint prep respirator (20-pack)",
   "store": "Home Depot",
   "item_no": "Internet 304748236 / SKU 492191",
   "package": "20 masks",
   "price": 30.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/304748236",
   "per": "rooms",
   "factor": 1,
   "per_package": 20,
   "unit": "rooms",
   "basis": "N95 masks for cutting MDF; a box of 20.",
   "tool": "miter_saw"
  },
  {
   "id": "gloves_nitrile",
   "category": "protection",
   "product": "HDX 3.5 mil disposable nitrile gloves (100)",
   "store": "Home Depot",
   "item_no": "Internet 319285600 / SKU 1007102409",
   "package": "100 gloves",
   "price": 15.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/319285600",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Nitrile gloves for caulk, filler and primer; a box.",
   "tool": null
  },
  {
   "id": "ramboard",
   "category": "site prep",
   "product": "Ram Board 38 in. x 100 ft. heavy-duty temporary floor protection",
   "store": "Home Depot",
   "item_no": "Internet 202088850 / SKU 1010835995",
   "package": "1 roll, 38 in. x 100 ft (about 316 sq ft)",
   "price": 65.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/202088850",
   "per": "base_lf",
   "factor": 3,
   "per_package": 316,
   "unit": "sf",
   "basis": "Floor protection along every trimmed wall, a 3 ft strip: 316 sf a roll.",
   "tool": null
  },
  {
   "id": "ramboard_tape",
   "category": "site prep",
   "product": "Ram Board floor protection seam tape, 3 in. x 164 ft",
   "store": "Home Depot",
   "item_no": "Internet 203579269 / SKU 1010835997",
   "package": "1 roll (164 ft)",
   "price": 11.5,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/203579269",
   "per": "base_lf",
   "factor": 1,
   "per_package": 164,
   "unit": "LF",
   "basis": "Seam tape for the floor protection: 164 ft a roll.",
   "tool": null
  },
  {
   "id": "plastic_9x12_6",
   "category": "site prep",
   "product": "HDX 9 ft. x 12 ft. 0.7 mil clear plastic drop cloths (6-pack)",
   "store": "Home Depot",
   "item_no": "Internet 204711647 / SKU 157769",
   "package": "6 sheets, 9 x 12 ft",
   "price": 11.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/204711647",
   "per": "rooms",
   "factor": 1,
   "per_package": 1,
   "unit": "rooms",
   "basis": "Plastic sheets over furniture, one 6-pack a room.",
   "tool": null
  },
  {
   "id": "zipdoor",
   "category": "site prep",
   "product": "Trimaco E-Z Up dust containment door",
   "store": "Home Depot",
   "item_no": "Internet 302851996 / SKU 1002746105",
   "package": "1 door",
   "price": 29.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/302851996",
   "per": "rooms",
   "factor": 0.3333333333333333,
   "per_package": 1,
   "unit": "doors",
   "basis": "Zipper dust door for the bedrooms' doorways (about one room in three).",
   "tool": "dust_containment"
  },
  {
   "id": "plastic_10x20",
   "category": "site prep",
   "product": "HDX 10 ft. x 20 ft. 1 mil clear plastic sheeting",
   "store": "Home Depot",
   "item_no": "Internet 204711649 / SKU 460370",
   "package": "1 sheet, 10 x 20 ft",
   "price": 5.48,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/204711649",
   "per": "rooms",
   "factor": 0.3333333333333333,
   "per_package": 1,
   "unit": "sheets",
   "basis": "Plastic for each dust door.",
   "tool": "dust_containment"
  },
  {
   "id": "bags_42",
   "category": "site prep",
   "product": "Husky 42 gal. contractor bags (50)",
   "store": "Home Depot",
   "item_no": "Internet 202973825 / SKU 267000",
   "package": "50 bags",
   "price": 32.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/202973825",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Contractor bags for offcuts and old trim; a box of 50.",
   "tool": null
  },
  {
   "id": "shims_wood",
   "category": "site prep",
   "product": "Nelson (contractor bundle) 12 in. contractor wood shims (42 per bundle)",
   "store": "Home Depot",
   "item_no": "Internet 202065065 / SKU 661619",
   "package": "42 shims",
   "price": 6.64,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/202065065",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Wood shims to bring base and rail out over dips in plaster; a bundle.",
   "tool": null
  },
  {
   "id": "rags",
   "category": "site prep",
   "product": "TOOLBOX professional white painter's rags (200 sheets)",
   "store": "Home Depot",
   "item_no": "Internet 203776822 / SKU 1001546627",
   "package": "200 sheets",
   "price": 14.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/203776822",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Rags for caulk and glue; a box.",
   "tool": null
  },
  {
   "id": "pencils",
   "category": "site prep",
   "product": "The Home Depot carpenter pencils with sharpener (10-pack)",
   "store": "Home Depot",
   "item_no": "Internet 313849151 / SKU 1005575556",
   "package": "10 pencils + sharpener",
   "price": 4.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/313849151",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Carpenter pencils.",
   "tool": null
  },
  {
   "id": "blade_12_80",
   "category": "blades",
   "product": "Diablo 12 in. x 80-tooth fine finish saw blade",
   "store": "Home Depot",
   "item_no": "Internet 100036926 / SKU 636010",
   "package": "1 blade (1 in. arbor)",
   "price": 59.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100036926",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "blades",
   "basis": "80-tooth finish blade for the 12\" miter saw: clean cuts on MDF and primed pine.",
   "tool": "miter_saw"
  },
  {
   "id": "blade_coping",
   "category": "blades",
   "product": "Husky 6.5 in. coping saw blades (5-pack, 12/15/20 TPI)",
   "store": "Home Depot",
   "item_no": "Internet 204748838 / SKU 1000032927",
   "package": "5 blades",
   "price": 5.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/204748838",
   "per": "copes",
   "factor": 1,
   "per_package": 40,
   "unit": "copes",
   "basis": "Coping saw blades: about 40 copes a 5-pack (estimate).",
   "tool": "coping_saw"
  },
  {
   "id": "blade_utility",
   "category": "blades",
   "product": "Milwaukee general purpose utility blades with dispenser (100)",
   "store": "Home Depot",
   "item_no": "Internet 204363382",
   "package": "100 blades",
   "price": 18.97,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/204363382",
   "per": "rooms",
   "factor": 1,
   "per_package": 60,
   "unit": "rooms",
   "basis": "Utility blades; a pack of 100.",
   "tool": "utility_knife"
  },
  {
   "id": "vac_bags",
   "category": "blades",
   "product": "RIDGID VF3502 dry pick-up dust bags (2-pack)",
   "store": "Home Depot",
   "item_no": "Internet 100390230 / SKU 515888",
   "package": "2 bags",
   "price": 25.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/100390230",
   "per": "rooms",
   "factor": 1,
   "per_package": 2,
   "unit": "rooms",
   "basis": "Fine-dust bags for the shop vac (MDF dust): 2 a pack, one a room.",
   "tool": "shop_vac"
  },
  {
   "id": "aa_batteries",
   "category": "blades",
   "product": "Energizer MAX AA alkaline batteries (8-pack)",
   "store": "Home Depot",
   "item_no": "Internet 206520631 / SKU 103328",
   "package": "8 batteries",
   "price": 9.48,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/206520631",
   "per": "rooms",
   "factor": 1,
   "per_package": 6,
   "unit": "rooms",
   "basis": "Batteries for the laser.",
   "tool": "laser"
  }
 ],
 "nailing": {
  "base": {
   "per": "base_lf",
   "gun": "n16",
   "nails_per_lf": 1.5
  },
  "stair_base": {
   "per": "stair_base_lf",
   "gun": "n16",
   "nails_per_lf": 1.5
  },
  "chair": {
   "per": "chair_lf",
   "gun": "n16",
   "nails_per_lf": 1.5
  },
  "stair_chair": {
   "per": "stair_chair_lf",
   "gun": "n16",
   "nails_per_lf": 1.5
  },
  "rail": {
   "per": "rail_lf",
   "gun": "n16",
   "nails_per_lf": 1.5
  },
  "cap": {
   "per": "cap_lf",
   "gun": "b15",
   "nails_per_lf": 2
  },
  "batten": {
   "per": "batten_lf",
   "gun": "b20",
   "nails_per_lf": 2
  },
  "panel": {
   "per": "panel_lf",
   "gun": "p23",
   "nails_per_lf": 1.5,
   "per_corner": 2
  }
 },
 "tools": [
  {
   "id": "miter_saw",
   "tool": "12 in. sliding compound miter saw",
   "product": "DEWALT 15 Amp 12 in. double-bevel sliding compound miter saw (DWS779)",
   "price": 629.0,
   "rentable": true,
   "uses": "Takes: Diablo 12 in. x 80-tooth fine finish saw blade, 3M 8210 Plus N95 paint prep respirator, RIDGID VF3502 dry pick-up dust bags",
   "if_switched": "10 in. cordless instead (Milwaukee M18 FUEL 2734-20, $599, Internet 300933735): no cord across the occupied house, takes the 10 in. blade (D1080X $53.97) instead; 10 in. capacity still cuts 5-1/4 in. base standing up. Non-sliding 12 in. (DEWALT DWS715, $299.99, Internet 309749587): fine for this trim, saves $329. Hand miter box: adds roughly a minute or more per cut and less accurate miters on 236 panel corners; not advised. MDF dust either way: run the saw into the vac and wear an N95.",
   "url": "https://www.homedepot.com/p/321488482"
  },
  {
   "id": "finish_nailer_16",
   "tool": "Cordless 16-gauge straight finish nailer",
   "product": "Milwaukee M18 FUEL Gen II 16-gauge straight finish nailer (tool only) (3020-20)",
   "price": 379.0,
   "rentable": true,
   "uses": "Takes: 2 in. x 16-gauge glue-collated straight finish nails, 2-1/2 in. x 16-gauge glue-collated straight finish nails",
   "if_switched": "Pneumatic (RIDGID R250SFF $99, Internet 305311411): add the compressor ($182.16), hose ($29.98) and air tool oil ($8.78); same nails; hose drag through an occupied house and compressor noise. Hand nailing: 6d finish nails (Grip-Rite 6F1 1 lb $7.82) and 4d (4F1 1 lb $9.98), a hammer ($29.97) and nail set ($11.97); pre-drill MDF ends, set and fill every head (bigger holes, more filler), several times slower, and more adhesive on plaster to make up for fewer fasteners. Angled-magazine cordless (rental DCN660D1): buy angled 16 ga nails instead.",
   "url": "https://www.homedepot.com/p/325695237"
  },
  {
   "id": "brad_nailer_18",
   "tool": "Cordless 18-gauge brad nailer",
   "product": "Milwaukee M18 FUEL Gen II 18-gauge brad nailer (tool only) (2746-20)",
   "price": 279.0,
   "rentable": true,
   "uses": "Takes: 1-1/4 in. x 18-gauge brad nails, 1-1/2 in. x 18-gauge brad nails, 2 in. x 18-gauge brad nails",
   "if_switched": "Pneumatic (RIDGID R213BNF $99, Internet 304530407, or DEWALT DWFP12233 $99): add compressor, hose and oil. RYOBI ONE+ P321 ($99) is a budget cordless option. Hand nailing panel moulding: 1 in. wire brads and a nail set, pre-drill the polyurethane, much slower; rely more on adhesive and tape to hold frames while it cures.",
   "url": "https://www.homedepot.com/p/309752194"
  },
  {
   "id": "pin_nailer_23",
   "tool": "23-gauge pin nailer",
   "product": "Milwaukee M12 23-gauge cordless pin nailer (tool only) (2540-20)",
   "price": 249.0,
   "rentable": false,
   "uses": "Takes: 1 in. x 23-gauge headless micropins, 1-1/4 in. x 23-gauge pin nails, FastCap 2P-10 Solo Kit: 2 oz thick CA adhesive + 12 oz activator",
   "if_switched": "Pneumatic (Porter-Cable PIN138 $139, Internet 202213592): needs compressor and hose. DEWALT 20V DCN623B ($239) or RYOBI PCL310B ($169) are cordless alternatives. No pin nailer at all: glue each panel miter with CA glue + activator and hold the frame with painter's tape until the adhesive grabs; adds a few minutes per frame (59 frames) and a second 2P-10 kit.",
   "url": "https://www.homedepot.com/p/314484000"
  },
  {
   "id": "battery_m18",
   "tool": "M18 batteries and charger (for 16 ga, 18 ga, jigsaw)",
   "product": "Milwaukee M18 XC starter kit, two 5.0 Ah batteries and charger (48-59-1852B)",
   "price": 199.0,
   "rentable": false,
   "uses": "",
   "if_switched": "Needed only if the carpenter has no M18 batteries. Switching platforms (DEWALT 20V or RYOBI ONE+) means that brand's batteries instead.",
   "url": "https://www.homedepot.com/p/320379720"
  },
  {
   "id": "battery_m12",
   "tool": "M12 battery and charger (for the pin nailer)",
   "product": "Milwaukee M12 2.0 Ah battery and charger starter kit (48-59-2420)",
   "price": 89.0,
   "rentable": false,
   "uses": "",
   "if_switched": "Needed only with the M12 pin nailer.",
   "url": "https://www.homedepot.com/p/205846389"
  },
  {
   "id": "coping_saw",
   "tool": "Coping saw",
   "product": "Husky 6 in. coping saw with wood handle (12228)",
   "price": 13.97,
   "rentable": false,
   "uses": "Takes: Husky 6.5 in. coping saw blades, Milwaukee general purpose utility blades with dispenser",
   "if_switched": "Coping foot on a jigsaw instead (Collins Coping Foot $46 + a jigsaw): faster and more repeatable on 35 copes of 5-1/4 in. base, uses jigsaw blades instead of coping blades, needs a bench and vac. Olson SF63510 7 in. coping saw ($8.66, Internet 304584733) is the classic alternative frame.",
   "url": "https://www.homedepot.com/p/204783720"
  },
  {
   "id": "laser",
   "tool": "Cross-line laser level",
   "product": "DEWALT 55 ft. green self-leveling cross-line laser (DW08802CG)",
   "price": 139.0,
   "rentable": false,
   "uses": "Takes: Energizer MAX AA alkaline batteries",
   "if_switched": "Without a laser: a 4 ft level and chalk line for chair rail and panel layout, slower on 59 frames and on wavy plaster. DEWALT DW088CG 100 ft ($189) is a brighter step up.",
   "url": "https://www.homedepot.com/p/303195787"
  },
  {
   "id": "stud_finder",
   "tool": "Stud finder",
   "product": "Franklin Sensors ProSensor M150 stud finder (FSM15002HD)",
   "price": 39.97,
   "rentable": false,
   "uses": "",
   "if_switched": "On plaster and lath, electronic finders read poorly; carry a magnetic finder that finds the lath nails over each stud (C.H. Hanson 3040, $13.99, Internet 202563186). No change in materials.",
   "url": "https://www.homedepot.com/p/317762970"
  },
  {
   "id": "tape",
   "tool": "Tape measure",
   "product": "Stanley 25 ft. FATMAX tape measure (33-725Y)",
   "price": 26.97,
   "rentable": false,
   "uses": "",
   "if_switched": "None.",
   "url": "https://www.homedepot.com/p/100052995"
  },
  {
   "id": "combo_square",
   "tool": "Combination square",
   "product": "Empire 12 in. combination square (E250)",
   "price": 17.98,
   "rentable": false,
   "uses": "Takes: The Home Depot carpenter pencils with sharpener",
   "if_switched": "None.",
   "url": "https://www.homedepot.com/p/100356502"
  },
  {
   "id": "angle_finder",
   "tool": "Angle finder / protractor for the stair rake",
   "product": "Bosch Miter Finder digital angle finder (GAM 220 MF)",
   "price": 214.86,
   "rentable": false,
   "uses": "",
   "if_switched": "A $13.26 Calculated Industries AccuMASTER 7455 (Internet 309454904) or an $8.97 Empire 27912 protractor reads the rake; you halve the angle by hand and make a test cut on scrap (a few minutes, a few inches of extra stock).",
   "url": "https://www.homedepot.com/p/207098854"
  },
  {
   "id": "block_plane",
   "tool": "Block plane",
   "product": "Stanley Bailey 6 in. low-angle block plane (12-960)",
   "price": 44.61,
   "rentable": false,
   "uses": "",
   "if_switched": "Without it: sand or file to fit backs of copes and scribe base to the floor; slower, more sandpaper.",
   "url": "https://www.homedepot.com/p/203727261"
  },
  {
   "id": "utility_knife",
   "tool": "Utility knife",
   "product": "Milwaukee FASTBACK folding utility knife with blade storage (48-22-1502)",
   "price": 16.97,
   "rentable": false,
   "uses": "Takes: Milwaukee general purpose utility blades with dispenser",
   "if_switched": "None.",
   "url": "https://www.homedepot.com/p/309350822"
  },
  {
   "id": "caulk_gun",
   "tool": "Caulk gun",
   "product": "Husky 10 oz. heavy-duty high-leverage drip-free caulk gun (19PT0902)",
   "price": 19.98,
   "rentable": false,
   "uses": "Takes: DAP Alex Plus acrylic latex caulk plus silicone, white, 10.1 oz, Liquid Nails Paneling and Molding adhesive LN-606, 10 oz, Liquid Nails Interior Projects latex construction adhesive LN-704, 10 oz",
   "if_switched": "Cordless (Milwaukee M12 2441-20, $179 tool only): steadier bead on ~1,700 LF of caulk lines and less hand fatigue with adhesive; same tubes.",
   "url": "https://www.homedepot.com/p/314993814"
  },
  {
   "id": "putty_knife",
   "tool": "Putty knives",
   "product": "Hyde 1-1/2 in. flex putty knife (1037)",
   "price": 11.9,
   "rentable": false,
   "uses": "Takes: DAP Plastic Wood-X with DryDex wood filler, 16 oz, USG Sheetrock Easy Sand 20 lightweight setting-type joint compound, 18 lb",
   "if_switched": "Finger-filling nail holes instead works but leaves more sanding.",
   "url": "https://www.homedepot.com/p/315657816"
  },
  {
   "id": "sanding_block",
   "tool": "Sanding block",
   "product": "3M Pro Grade Precision 220-grit block sanding sponge (2-pack) (24220PGP-XF-B2)",
   "price": 9.98,
   "rentable": false,
   "uses": "Takes: 3M Pro Grade Precision block sanding sponge, 220 grit extra fine, 3M general purpose sanding sponge, fine/medium, 3M aluminum oxide sandpaper 9 x 11 in., 220 grit",
   "if_switched": "A random-orbit sander is not needed for trim; it would add discs and a vac hose.",
   "url": "https://www.homedepot.com/p/313299142"
  },
  {
   "id": "shop_vac",
   "tool": "Shop vac with fine-dust filtration",
   "product": "RIDGID 12 gal. NXT wet/dry vac with OSHA-compatible filtration kit (HD1200E)",
   "price": 181.0,
   "rentable": false,
   "uses": "Takes: RIDGID VF3502 dry pick-up dust bags",
   "if_switched": "Without HEPA filtration MDF dust passes through into the house; replacement HEPA filter VF6000 $36.48 (Internet 100022800). A dedicated extractor (Festool, DeWalt) costs more but auto-starts with the saw.",
   "url": "https://www.homedepot.com/p/308058425"
  },
  {
   "id": "sawhorses",
   "tool": "Sawhorses / work table",
   "product": "DEWALT 32 in. metal folding sawhorses (2-pack) (DWST111552PK)",
   "price": 126.0,
   "rentable": false,
   "uses": "",
   "if_switched": "A miter saw stand (DEWALT DWX723, $249, Internet 202665436) gives outfeed support for 16 ft lengths; the horses with a sheet of plywood give a coping and gluing bench.",
   "url": "https://www.homedepot.com/p/309587072"
  },
  {
   "id": "drop_cloths",
   "tool": "Canvas drop cloths",
   "product": "Mutual Dropcloth Mutual 9 ft. x 12 ft. 8 oz. canvas drop cloth (80912)",
   "price": 22.75,
   "rentable": false,
   "uses": "Takes: HDX 9 ft. x 12 ft. 0.7 mil clear plastic drop cloths",
   "if_switched": "Canvas is reusable and not slippery; plastic alone is slippery under foot. Ram Board under the work area replaces canvas there.",
   "url": "https://www.homedepot.com/p/207173107"
  },
  {
   "id": "dust_containment",
   "tool": "Dust containment poles",
   "product": "ZipWall 10 ft. stainless steel dust barrier poles, 4-pack with 2 zippers (ZP4)",
   "price": 199.0,
   "rentable": false,
   "uses": "Takes: HDX 10 ft. x 20 ft. 1 mil clear plastic sheeting, Trimaco E-Z Up dust containment door",
   "if_switched": "For a doorway, the Trimaco E-Z Up door ($29.97) taped to the frame does the job without poles; poles are needed only for open archways or to wall off part of a room.",
   "url": "https://www.homedepot.com/p/333666187"
  },
  {
   "id": "coping_foot",
   "tool": "Coping foot for a jigsaw (alternative)",
   "product": "Collins Tool Co. Collins Coping Foot, standard (Standard (Highland Woodworking item 178257))",
   "price": 46.0,
   "rentable": false,
   "uses": "",
   "if_switched": "Replaces the jigsaw's flat base. Fits many professional jigsaws but not fixed-base ones (Highland's note); check the maker's fit list for the saw. Needs a jigsaw, e.g. Milwaukee M18 FUEL 2737-20 ($229, Internet 305658170) or DEWALT DCS334B ($239, Internet 305966991). Not sold at Home Depot.",
   "url": "https://www.highlandwoodworking.com/products/collinscopingfoot"
  },
  {
   "id": "compressor",
   "tool": "Compressor (only if switching to pneumatic nailers) (alternative)",
   "product": "DEWALT 6 gal. 165 PSI electric pancake air compressor (DXCM55126)",
   "price": 182.16,
   "rentable": true,
   "uses": "",
   "if_switched": "Adds hose (Flexzilla 1/4 in. x 50 ft HFZ1450YW2, $29.98, Internet 203225254) and air tool oil (Husky 8 oz HDA10800AV, $8.78, Internet 100047286, a few drops per nailer per day). Oil-free pancake compressors need no compressor oil.",
   "url": "https://www.homedepot.com/p/335996266"
  },
  {
   "id": "hand_nailing",
   "tool": "Hammer and nail set (only if hand nailing) (alternative)",
   "product": "DEWALT 16 oz steel rip claw hammer + DEWALT 3-piece nail set (DWHT51003 + DWHT58018)",
   "price": 41.94,
   "rentable": false,
   "uses": "",
   "if_switched": "Hammer $29.97 (Internet 316332751) + nail set $11.97 (Internet 203638542). Nails: Grip-Rite 6d 1 lb (6F1, $7.82, Internet 100027781) for base and chair rail, 4d 1 lb (4F1, $9.98, Internet 202308472) for cap and battens.",
   "url": "https://www.homedepot.com/p/316332751"
  }
 ]
};

// Option scenarios and the products behind their prices.
export const OPTIONS = {
 "seen": "2026-11-17",
 "note": "Each row changes one thing; labor factors are this package's estimates from the research notes (Appendix C).",
 "labor_note": "Two-piece runs about double the install time on that run; stain-grade oak adds about a third to install and replaces caulk and paint with putty, stain and clear coats; bare wood adds a priming pass.",
 "scenarios": [
  {
   "axis": "Today",
   "name": "Today's design",
   "what": "Colonial base (MDF), colonial chair rail, 1x3 battens and the shaker panels' 1x4 and 1x6 boards (finger-jointed pine), composite cap, polyurethane panel moulding; all primed; Home Depot and Lowe's.",
   "is_design": true,
   "per_lf": {},
   "labor_factor": {},
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Profile",
   "name": "Basic: flat stock",
   "what": "Square-edge boards for base, rail and cap, 1x2 for panels: butt joints and simple miters, no copes.",
   "is_design": false,
   "per_lf": {
    "base": 1.54,
    "chair": 1.06,
    "cap": 1.06,
    "panel": 0.83,
    "batten": 1.06
   },
   "labor_factor": {
    "base": 0.85,
    "chair": 0.85,
    "cap": 0.85,
    "frame": 0.85,
    "cope": 0.5
   },
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Profile",
   "name": "Premium: taller one-piece",
   "what": "7-1/4\" colonial base, 3\" chair rail, 1-3/4\" PVC cap, 1-1/4\" panel moulding, 1x4 battens.",
   "is_design": false,
   "per_lf": {
    "base": 3.57,
    "chair": 2.96,
    "cap": 2.46,
    "panel": 1.96,
    "batten": 1.42
   },
   "labor_factor": {
    "base": 1.15,
    "stair_base": 1.15,
    "chair": 1.15,
    "stair_chair": 1.15,
    "cap": 1.15,
    "rail": 1.15,
    "frame": 1.15,
    "raked_frame": 1.15,
    "batten": 1.15,
    "outside": 1.15,
    "scarf": 1.15,
    "cope": 1.25
   },
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Profile",
   "name": "Premium: built-up two-piece",
   "what": "1x8 base with a base cap, backer under the chair rail, flat cap with a bed moulding: two pieces on each run.",
   "is_design": false,
   "per_lf": {
    "base": 4.35,
    "chair": 5.17,
    "cap": 2.96,
    "panel": 1.96,
    "batten": 1.42
   },
   "labor_factor": {
    "base": 1.9,
    "stair_base": 1.9,
    "chair": 1.9,
    "stair_chair": 1.9,
    "cap": 1.9,
    "cope": 2,
    "frame": 1.15
   },
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Material",
   "name": "MDF wherever made",
   "what": "Primed MDF base, chair rail, battens and shaker boards; cap and panel moulding as today (no MDF panel moulding is listed). MDF dents and swells if wet, and is 1/32\" thinner than the pine boards.",
   "is_design": false,
   "per_lf": {
    "base": 2.57,
    "chair": 1.67,
    "cap": 1.88,
    "batten": 1.39,
    "1x4": 0.79,
    "1x6": 1.54
   },
   "labor_factor": {},
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Material",
   "name": "Finger-jointed pine",
   "what": "Primed finger-jointed pine for every piece.",
   "is_design": false,
   "per_lf": {
    "base": 2.78,
    "chair": 1.52,
    "cap": 2.28,
    "panel": 1.34,
    "batten": 1.06
   },
   "labor_factor": {},
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Material",
   "name": "Cellular PVC boards",
   "what": "Veranda PVC 1x4 and 1x6 for the shaker boards; everything else as today. Will not rot, swell or split and needs no primer, but costs about twice the pine, dents more easily and moves with heat.",
   "is_design": false,
   "per_lf": {
    "1x4": 2.54,
    "1x6": 3.81
   },
   "labor_factor": {},
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Material",
   "name": "Solid poplar",
   "what": "Paint-grade hardwood, bought bare: primed before install, ends pre-drilled.",
   "is_design": false,
   "per_lf": {
    "base": 7.52,
    "chair": 4.11,
    "cap": 3.59,
    "panel": 3.08,
    "batten": 1.91,
    "1x4": 2.8,
    "1x6": 4.1
   },
   "labor_factor": {
    "base": 1.1,
    "stair_base": 1.1,
    "chair": 1.1,
    "stair_chair": 1.1,
    "cap": 1.1,
    "rail": 1.1,
    "frame": 1.1,
    "raked_frame": 1.1,
    "batten": 1.1,
    "outside": 1.1,
    "scarf": 1.1
   },
   "supplies_per": {
    "face_sf": 0.1
   },
   "hours_per": {},
   "prime": true
  },
  {
   "axis": "Material",
   "name": "Red oak, stained",
   "what": "Stain-grade: tight joints and matched grain (about half again the install time), colored putty instead of caulk, stain and two clear coats with sanding between instead of paint.",
   "is_design": false,
   "per_lf": {
    "base": 9.14,
    "chair": 5.25,
    "cap": 2.44,
    "panel": 3.95,
    "batten": 3.0,
    "1x4": 4.1,
    "1x6": 5.98
   },
   "labor_factor": {
    "base": 1.5,
    "stair_base": 1.5,
    "chair": 1.5,
    "stair_chair": 1.5,
    "cap": 1.5,
    "rail": 1.5,
    "frame": 1.5,
    "raked_frame": 1.5,
    "batten": 1.5,
    "outside": 1.5,
    "scarf": 1.5,
    "cope": 1.5,
    "caulk": 0.2,
    "fill": 1.5,
    "paint": 1.8
   },
   "supplies_per": {},
   "hours_per": {}
  },
  {
   "axis": "Finish",
   "name": "Bare wood, same profiles",
   "what": "Unfinished solid pine of the same profiles, primed before install. Bare moulding costs more than primed finger-jointed, because it is solid wood.",
   "is_design": false,
   "per_lf": {
    "base": 7.78,
    "chair": 4.44,
    "cap": 2.87,
    "panel": 0.94,
    "batten": 1.53,
    "1x4": 1.62,
    "1x6": 2.42
   },
   "labor_factor": {},
   "supplies_per": {
    "face_sf": 0.1
   },
   "hours_per": {},
   "prime": true
  },
  {
   "axis": "Source",
   "name": "Lumberyard",
   "what": "Posted prices at Ring's End (Connecticut), primed finger-jointed pine in 16' lengths; a pro account is usually lower.",
   "is_design": false,
   "per_lf": {
    "base": 1.89,
    "chair": 2.65,
    "cap": 5.55,
    "panel": 1.15,
    "batten": 1.85,
    "1x4": 1.85,
    "1x6": 2.85
   },
   "labor_factor": {
    "scarf": 0.5
   },
   "supplies_per": {},
   "hours_per": {}
  }
 ],
 "products": [
  {
   "role": "base",
   "option": "Basic: flat stock",
   "product": "1x6 primed MDF board (flat base)",
   "store": "Home Depot",
   "item_no": "305126935",
   "size": "11/16 x 5-1/2 in.",
   "per_lf": 1.54,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/1-in-x-6-in-x-12-ft-Primed-MDF-Board-Common-11-16-in-x-5-1-2-in-x-12-ft-PE2EHD17x5-5x145/305126935",
   "notes": "Cheapest flat base found; MDF swells if wet-mopped."
  },
  {
   "role": "base",
   "option": "Premium: taller one-piece",
   "product": "Colonial base 7163, primed MDF, 7-1/4 in. tall",
   "store": "Lowe's",
   "item_no": "165037",
   "size": "9/16 x 7-1/4 in.",
   "per_lf": 3.57,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/pd/EverTrue-7-1-4-in-x-8-ft-Primed-MDF-Baseboard-Moulding-Actual-7-25-in-x-8-ft/1000445001",
   "notes": "One piece. 8 ft pieces mean more joints than today's 12 ft."
  },
  {
   "role": "base",
   "option": "Premium: built-up two-piece",
   "product": "Two-piece base: 1x8 primed FJ board + WM 163 primed FJ base cap",
   "store": "Home Depot",
   "item_no": "304798467 + 203898777",
   "size": "3/4 x 7-1/4 in. + 11/16 x 1-3/8 in. (about 8-5/8 in. tall)",
   "per_lf": 4.35,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/1-in-x-8-in-x-12-ft-Radiata-Pine-Finger-Joint-Primed-Board-253251/304798467",
   "notes": "Sum of the two component rows ($2.81 + $1.54). Two pieces per run: base install labor roughly doubles."
  },
  {
   "role": "base",
   "option": "MDF wherever made",
   "product": "Colonial base 163E, primed MDF (today's design)",
   "store": "Lowe's",
   "item_no": null,
   "size": "1/2 x 5-1/4 in.",
   "per_lf": 2.57,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/pd/EverTrue-5-1-4-in-x-12-ft-Primed-MDF-Baseboard-Moulding-Actual-5-25-in-x-12-ft/1000443167",
   "notes": ""
  },
  {
   "role": "base",
   "option": "Finger-jointed pine",
   "product": "Colonial base L163E, primed finger-jointed pine",
   "store": "Lowe's",
   "item_no": "193620",
   "size": "9/16 x 5-1/4 in.",
   "per_lf": 2.78,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/pd/EverTrue-5-1-4-in-x-12-ft-Primed-Baseboard-Moulding-Actual-5-25-in-x-12-ft/1000442631",
   "notes": "Same 163 profile family as today's MDF base, same store, same 12 ft length."
  },
  {
   "role": "base",
   "option": "Solid poplar",
   "product": "WM163 base moulding, solid poplar (unfinished)",
   "store": "Home Depot",
   "item_no": "329962623",
   "size": "0.56 x 5-1/4 in.",
   "per_lf": 7.52,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM163-0-56-in-D-x-5-25-in-W-x-96-in-L-Wood-Poplar-Baseboard-Moulding-MLDW01X05WM163PO/329962623",
   "notes": "Solid poplar, bare: needs priming."
  },
  {
   "role": "base",
   "option": "Red oak, stained",
   "product": "WM163 base moulding, solid red oak (unfinished)",
   "store": "Home Depot",
   "item_no": "329962625",
   "size": "0.56 x 5-1/4 in.",
   "per_lf": 9.14,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM163-0-56-in-D-x-5-25-in-W-x-96-in-L-Wood-Red-Oak-Baseboard-Moulding-MLDW01X05WM163RO/329962625",
   "notes": "Stain-grade; 8 ft pieces only."
  },
  {
   "role": "base",
   "option": "Bare wood, same profiles",
   "product": "WM163 base moulding, solid pine (unfinished)",
   "store": "Home Depot",
   "item_no": "329962622",
   "size": "0.56 x 5-1/4 in.",
   "per_lf": 7.78,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM163-0-56-in-D-x-5-25-in-W-x-96-in-L-Wood-Pine-Baseboard-Moulding-MLDW01X05WM163PI/329962622",
   "notes": "Bare is solid clear pine, not finger-jointed, so it costs more than primed FJ before priming is added."
  },
  {
   "role": "base",
   "option": "Lumberyard",
   "product": "M93 neck base L163, primed finger-jointed pine, 16 ft",
   "store": "Ring's End",
   "item_no": "L163FJ",
   "size": "11/16 x 5-1/4 in.",
   "per_lf": 1.89,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/neck-base-11-16-x-5-1-4-x-16-l163fj",
   "notes": "Lumberyard equivalent of today's 163 base, in FJ pine and 16 ft lengths (fewer joints). Ring's End calls it 'neck base'; confirm the profile drawing."
  },
  {
   "role": "base",
   "option": "lumberyard",
   "product": "1x6 Protected primed finger-joint pine trim board, 16 ft (flat base)",
   "store": "Ring's End",
   "item_no": "16PP",
   "size": "3/4 x 5-1/2 in.",
   "per_lf": 2.85,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/windsorone-protected-s4sse-trim-boards-16pp",
   "notes": "Lumberyard basic flat base."
  },
  {
   "role": "chair",
   "option": "Basic: flat stock",
   "product": "1x3 primed finger-joint pine trim board (flat rail)",
   "store": "Home Depot",
   "item_no": "202085979",
   "size": "0.719 x 2-1/2 in.",
   "per_lf": 1.06,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Pine-Finger-Joint-Common-1-in-x-3-in-x-8-ft-Actual-719-in-x-2-5-in-x-96-in-424600/202085979",
   "notes": "Same stock as today's batten; flat rail with eased edges."
  },
  {
   "role": "chair",
   "option": "Premium: taller one-piece",
   "product": "WP 300 chair rail, primed finger-jointed",
   "store": "Home Depot",
   "item_no": "203209490",
   "size": "1-1/16 x 3 in.",
   "per_lf": 2.96,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WP-300-1-1-16-in-x-3-in-x-96-in-Primed-Finger-Jointed-Chair-Rail-Moulding-10001778/203209490",
   "notes": "Larger one-piece rail."
  },
  {
   "role": "chair",
   "option": "Premium: built-up two-piece",
   "product": "Built-up chair rail: WP 959H backer + WM 390 rail",
   "store": "Home Depot",
   "item_no": "203209458 + 203209387",
   "size": "4-1/2 in. backer + 2-5/8 in. rail",
   "per_lf": 5.17,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WP-959H-7-16-in-x-4-1-2-in-x-96-in-Primed-Finger-Jointed-Chair-Rail-Backer-Moulding-10001788/203209458",
   "notes": "Sum of components ($3.64 + $1.53). Two pieces per run."
  },
  {
   "role": "chair",
   "option": "MDF wherever made",
   "product": "390 chair rail, primed MDF, 12 ft",
   "store": "Lowe's",
   "item_no": "919258",
   "size": "9/16 x 2-5/8 in.",
   "per_lf": 1.67,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/pd/2-5-8-in-x-12-ft-Primed-MDF-Chair-Rail-Moulding-Actual-2-625-in-x-12-ft/1000691426",
   "notes": ""
  },
  {
   "role": "chair",
   "option": "Finger-jointed pine",
   "product": "WM 390 chair rail, primed finger-jointed pine (today's design)",
   "store": "Home Depot",
   "item_no": "203209387",
   "size": "11/16 x 2-5/8 in.",
   "per_lf": 1.52,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WM-390-11-16-in-x-2-5-8-in-x-96-in-Primed-Finger-Jointed-Pine-Wood-Chair-Rail-Moulding-10000538/203209387",
   "notes": ""
  },
  {
   "role": "chair",
   "option": "Solid poplar",
   "product": "WM390 chair rail, solid poplar (unfinished)",
   "store": "Home Depot",
   "item_no": "330076271",
   "size": "0.69 x 2.63 in.",
   "per_lf": 4.11,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM390-0-69-in-D-x-2-63-in-W-x-96-in-L-Wood-Poplar-Chair-Rail-Molding-MLDW01X03WM390PO/330076271",
   "notes": "Bare solid poplar: needs priming."
  },
  {
   "role": "chair",
   "option": "Red oak, stained",
   "product": "WM390 chair rail, solid red oak (unfinished)",
   "store": "Home Depot",
   "item_no": "330076273",
   "size": "0.69 x 2.63 in.",
   "per_lf": 5.25,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM390-0-69-in-D-x-2-63-in-W-x-96-in-L-Wood-Red-Oak-Chair-Rail-Molding-MLDW01X03WM390RO/330076273",
   "notes": "Stain-grade."
  },
  {
   "role": "chair",
   "option": "Bare wood, same profiles",
   "product": "WM390 chair rail, solid pine (unfinished)",
   "store": "Home Depot",
   "item_no": "330076270",
   "size": "0.69 x 2.63 in.",
   "per_lf": 4.44,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-WM390-0-69-in-D-x-2-63-in-W-x-96-in-L-Wood-Pine-Chair-Rail-Moulding-MLDW01X03WM390PI/330076270",
   "notes": "Bare is solid pine; more than twice the primed FJ price."
  },
  {
   "role": "chair",
   "option": "Lumberyard",
   "product": "M203 chair rail with rabbet, primed finger-jointed pine, 16 ft",
   "store": "Ring's End",
   "item_no": "AB3113FJ",
   "size": "13/16 x 2 in.",
   "per_lf": 2.65,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/chair-rail-pfj-13-16-x-2-1-4-rabbet-x-16-ab3113fj",
   "notes": "Nearest primed yard rail to the standard; 16 ft lengths."
  },
  {
   "role": "cap",
   "option": "Basic: flat stock",
   "product": "1x3 primed finger-joint pine (flat cap)",
   "store": "Home Depot",
   "item_no": "202085979",
   "size": "0.719 x 2-1/2 in.",
   "per_lf": 1.06,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Pine-Finger-Joint-Common-1-in-x-3-in-x-8-ft-Actual-719-in-x-2-5-in-x-96-in-424600/202085979",
   "notes": "Flat cap laid on top of the boards/battens; often paired with a small cove or base cap under it (that would be a second piece)."
  },
  {
   "role": "cap",
   "option": "Premium: taller one-piece",
   "product": "Wainscot cap, PVC, 1-3/4 in.",
   "store": "Home Depot",
   "item_no": "309961715",
   "size": "3/4 x 1-3/4 in.",
   "per_lf": 2.46,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-1-3-4-in-x-3-4-in-x-96-in-Wainscot-Cap-Moulding-PVC-6069244/309961715",
   "notes": "Thicker (3/4 in.) cap."
  },
  {
   "role": "cap",
   "option": "Premium: built-up two-piece",
   "product": "Built-up cap: 1x4 primed FJ flat cap + WM 163 primed FJ base cap under it",
   "store": "Home Depot",
   "item_no": "202105909 + 203898777",
   "size": "3/4 x 3-1/2 in. + 11/16 x 1-3/8 in.",
   "per_lf": 2.96,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Finger-Joint-Common-1-in-x-4-in-x-12-ft-Actual-719-in-x-3-5-in-x-144-in-590599/202105909",
   "notes": "1x4x12 primed FJ ($16.98, $1.42/LF) + WM163 cap ($12.32/8 ft, $1.54/LF). Two pieces per run."
  },
  {
   "role": "cap",
   "option": "MDF wherever made",
   "product": "WCAP wainscot cap, primed composite (today's design)",
   "store": "Lowe's",
   "item_no": "29005",
   "size": "11/16 x 2 in.",
   "per_lf": 1.88,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/pd/EverTrue-2-in-x-8-ft-Primed-Composite-Wall-Panel-Moulding/1000444581",
   "notes": "Only made in composite; wood rows below are the nearest wood cap profiles, not the same profile."
  },
  {
   "role": "cap",
   "option": "Finger-jointed pine",
   "product": "WM 2921 ply cap, primed finger-jointed pine (sold by the foot)",
   "store": "Home Depot",
   "item_no": "206092603",
   "size": "9/16 x 1-1/8 in.",
   "per_lf": 2.28,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WM-2921-9-16-in-x-1-1-8-in-Primed-Finger-Jointed-Pine-Ply-Cap-Moulding-10004259/206092603",
   "notes": "$2.28/LF. Smaller than WCAP."
  },
  {
   "role": "cap",
   "option": "Solid poplar",
   "product": "M202 wainscot cap with rabbet, primed poplar",
   "store": "Ring's End",
   "item_no": "RECM",
   "size": "7/8 x 1-1/2 in.",
   "per_lf": 3.59,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/recm-wainscot-cap-recm",
   "notes": "True rabbeted wainscot cap; $3.59/LF."
  },
  {
   "role": "cap",
   "option": "Red oak, stained",
   "product": "Colonial base cap, oak (sold by the foot)",
   "store": "Home Depot",
   "item_no": "206092650",
   "size": "11/16 x 1-1/2 in.",
   "per_lf": 2.44,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-11-16-in-x-1-1-2-in-Oak-Colonial-Base-Cap-Moulding-10004241/206092650",
   "notes": "$2.44/LF. Base-cap profile used as a cap; no oak wainscot cap found at Home Depot or Lowe's."
  },
  {
   "role": "cap",
   "option": "Bare wood, same profiles",
   "product": "WM 292 wainscot panel cap, solid pine (unfinished)",
   "store": "Home Depot",
   "item_no": "100321404",
   "size": "9/16 x 1-1/8 in.",
   "per_lf": 2.87,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WM-292-9-16-in-x-1-1-8-in-Solid-Pine-Wainscot-Panel-Cap-Molding-10000766/100321404",
   "notes": "$2.87/LF; same profile as WM 2921, bare solid pine."
  },
  {
   "role": "cap",
   "option": "Lumberyard",
   "product": "M200 wainscot cap with 1/2 in. rabbet, primed poplar",
   "store": "Ring's End",
   "item_no": "BBC",
   "size": "1-3/4 x 1-1/2 in.",
   "per_lf": 5.55,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/bbc-wainscot-cap-1-2-rabbet-bbc",
   "notes": "$5.55/LF."
  },
  {
   "role": "panel",
   "option": "Basic: flat stock",
   "product": "1x2 primed finger-joint pine trim board, box of 15 (120 LF)",
   "store": "Home Depot",
   "item_no": "300125756",
   "size": "0.719 x 1-1/2 in.",
   "per_lf": 0.83,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/CMPC-1-in-x-2-in-x-8-ft-Primed-Finger-Joint-Pine-Trim-Board-Actual-Size-0-719-in-x-1-5-in-x-96-in-15-Piece-per-Box-CMPC0028748/300125756",
   "notes": "Square-edge 1x2 frames; 3/4 in. thick, so frames stand proud of the chair rail/cap less gracefully. Online box only."
  },
  {
   "role": "panel",
   "option": "Premium: built-up two-piece, Premium: taller one-piece",
   "product": "Ashford panel moulding PML01X00AS, primed polyurethane",
   "store": "Home Depot",
   "item_no": "203798675",
   "size": "1/2 x 1-5/8 in.",
   "per_lf": 1.96,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ekena-Millwork-1-2-in-x-1-5-8-in-x-94-1-2-in-Primed-Polyurethane-Panel-Moulding-1-Piece-7-88-Total-Linear-Feet-PML01X00AS/203798675",
   "notes": "Larger frame; Ekena sells matching corners."
  },
  {
   "role": "panel",
   "option": "Finger-jointed pine",
   "product": "Finger-joint pine panel moulding 43278, 10-pack (70 LF)",
   "store": "Home Depot",
   "item_no": "331521505",
   "size": "3/8 x 1-1/8 in.",
   "per_lf": 1.34,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Builders-Choice-0-375-in-D-x-1-125-in-W-x-84-in-L-Pine-Wood-Finger-Joint-Panel-Moulding-Pack-10-Pack-43278-93084PK/331521505",
   "notes": "10 x 7 ft pieces. Listing does not say primed."
  },
  {
   "role": "panel",
   "option": "Solid poplar",
   "product": "1265 panel moulding, unfinished poplar",
   "store": "Home Depot",
   "item_no": "332206673",
   "size": "7/16 x 1-1/2 in.",
   "per_lf": 3.08,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ornamental-Mouldings-4375-in-D-x-1-5-in-W-x-92-in-L-Unfinished-Poplar-Wood-Panel-Moulding-1265-92POPR/332206673",
   "notes": "Bare; larger than today's profile."
  },
  {
   "role": "panel",
   "option": "Red oak, stained",
   "product": "1265 panel moulding, unfinished red oak",
   "store": "Home Depot",
   "item_no": "334510411",
   "size": "7/16 x 1-1/2 in.",
   "per_lf": 3.95,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Ornamental-Mouldings-0-4375-in-D-x-1-5-in-W-x-92-in-L-Unfinished-Red-Oak-Wood-Panel-Moulding-1265-92ROAK/334510411",
   "notes": "Same profile as the poplar row."
  },
  {
   "role": "panel",
   "option": "Bare wood, same profiles",
   "product": "D7 panel moulding, unfinished",
   "store": "Home Depot",
   "item_no": "100389315",
   "size": "5/16 x 7/8 in.",
   "per_lf": 0.94,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/DecraMold-D7-5-16-in-x-7-8-in-x-96-in-Unfinished-Panel-Moulding-1-Piece-8-Total-Linear-Feet-10000092/100389315",
   "notes": "Same 7/8 in. face as today's moulding, thinner; bare."
  },
  {
   "role": "panel",
   "option": "Lumberyard",
   "product": "M139 panel bead, primed finger-jointed pine, 16 ft",
   "store": "Ring's End",
   "item_no": "AB86FJ",
   "size": "5/8 x 15/16 in.",
   "per_lf": 1.15,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/panel-bead-pfj-5-8-x-15-16-x-16-ab86fj",
   "notes": "Yard equivalent of today's standard size."
  },
  {
   "role": "1x6",
   "option": "MDF wherever made",
   "product": "1x6 primed MDF board, 12 ft",
   "store": "Home Depot",
   "item_no": "Internet #305126935, model PE2EHD17x5.5x145",
   "size": "11/16 x 5-1/2 in.",
   "per_lf": 1.54,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/305126935",
   "notes": "$18.48 per 12 ft; 8 ft $13.48."
  },
  {
   "role": "1x6",
   "option": "Solid poplar",
   "product": "1x6 poplar board (bare, sold by the foot)",
   "store": "Home Depot",
   "item_no": "Internet #302006547",
   "size": "3/4 x 5-1/2 in.",
   "per_lf": 4.1,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/302006547",
   "notes": "$4.10 a foot, random lengths."
  },
  {
   "role": "1x6",
   "option": "Red oak, stained",
   "product": "1x6 oak board, Weaber (bare, sold by the foot)",
   "store": "Home Depot",
   "item_no": "Internet #207059036, model 22065",
   "size": "3/4 x 5-1/2 in.",
   "per_lf": 5.98,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/207059036",
   "notes": "$5.98 a foot; the page says oak, probably red oak."
  },
  {
   "role": "1x6",
   "option": "Bare wood, same profiles",
   "product": "1x6 clear radiata pine board, 12 ft (bare)",
   "store": "Lowe's",
   "item_no": "Item #61009, model L512446112",
   "size": "3/4 x 5-1/2 in.",
   "per_lf": 2.42,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/search?searchTerm=61009",
   "notes": "$29.00 per 12 ft, delivered (not stocked at Yonkers); 8 ft $24.38."
  },
  {
   "role": "1x6",
   "option": "Cellular PVC boards",
   "product": "1x6 Veranda cellular PVC trim board, 8 ft",
   "store": "Home Depot",
   "item_no": "Internet #311635041, model H190OWS3",
   "size": "3/4 x 5-1/2 in.",
   "per_lf": 3.81,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/311635041",
   "notes": "$30.48 per 8 ft; 16 ft $58.98."
  },
  {
   "role": "1x4",
   "option": "MDF wherever made",
   "product": "1x4 primed MDF board, 12 ft",
   "store": "Home Depot",
   "item_no": "Internet #305126656, model PE2EHD17x3.5x145",
   "size": "11/16 x 3-1/2 in.",
   "per_lf": 0.79,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/305126656",
   "notes": "$9.48 per 12 ft; 8 ft $7.98. 1/32 in thinner than the pine boards."
  },
  {
   "role": "1x4",
   "option": "Solid poplar",
   "product": "1x4 poplar board (bare, sold by the foot)",
   "store": "Home Depot",
   "item_no": "Internet #202089083, model 0018480",
   "size": "3/4 x 3-1/2 in.",
   "per_lf": 2.8,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Poplar-Board-Common-1-in-x-4-in-x-R-L-Actual-0-75-in-x-3-5-in-x-R-L-0018480/202089083",
   "notes": "$2.80 a foot, random lengths."
  },
  {
   "role": "1x4",
   "option": "Red oak, stained",
   "product": "1x4 oak board, Weaber (bare, sold by the foot)",
   "store": "Home Depot",
   "item_no": "Internet #207059035, model 22060",
   "size": "3/4 x 3-1/2 in.",
   "per_lf": 4.1,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Weaber-1-in-x-4-in-x-Random-Length-S4S-Oak-Hardwood-Board-22060/207059035",
   "notes": "$4.10 a foot; the page says oak, probably red oak."
  },
  {
   "role": "1x4",
   "option": "Bare wood, same profiles",
   "product": "1x4 clear radiata pine board, 12 ft (bare)",
   "store": "Lowe's",
   "item_no": "Item #61008, model L512444112",
   "size": "3/4 x 3-1/2 in.",
   "per_lf": 1.62,
   "seen": "2026-11-17",
   "url": "https://www.lowes.com/search?searchTerm=61008",
   "notes": "$19.42 per 12 ft, delivered (not stocked at Yonkers); 8 ft $15.78."
  },
  {
   "role": "1x4",
   "option": "Cellular PVC boards",
   "product": "1x4 Veranda cellular PVC trim board, 8 ft",
   "store": "Home Depot",
   "item_no": "Internet #100265384, model H190LWS6",
   "size": "3/4 x 3-1/2 in.",
   "per_lf": 2.54,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Veranda-3-4-in-D-x-3-5-in-W-x-96-in-L-White-PVC-Trim-H190LWS6/100265384",
   "notes": "$20.34 per 8 ft; 16 ft $40.68."
  },
  {
   "role": "batten",
   "option": "Basic: flat stock, Finger-jointed pine",
   "product": "1x3 primed finger-joint pine trim board (today's design)",
   "store": "Home Depot",
   "item_no": "202085979",
   "size": "0.719 x 2-1/2 in.",
   "per_lf": 1.06,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Pine-Finger-Joint-Common-1-in-x-3-in-x-8-ft-Actual-719-in-x-2-5-in-x-96-in-424600/202085979",
   "notes": "Price unchanged from today's design."
  },
  {
   "role": "batten",
   "option": "Premium: built-up two-piece, Premium: taller one-piece",
   "product": "1x4 primed finger-joint pine trim board, 12 ft (wider batten)",
   "store": "Home Depot",
   "item_no": "202105909",
   "size": "0.719 x 3-1/2 in.",
   "per_lf": 1.42,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Finger-Joint-Common-1-in-x-4-in-x-12-ft-Actual-719-in-x-3-5-in-x-144-in-590599/202105909",
   "notes": "Wider batten; 181 LF of 1x3 would become 1x4 at the same LF if the layout holds."
  },
  {
   "role": "batten",
   "option": "MDF wherever made",
   "product": "1x3 MDF moulding board",
   "store": "Home Depot",
   "item_no": "204468315",
   "size": "1x3 nominal",
   "per_lf": 1.39,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/FINISHED-ELEGANCE-1-in-x-3-in-x-8-ft-MDF-Molding-Board-10003223/204468315",
   "notes": "Finished Elegance is sold pre-primed; the listing title says only 'MDF Molding Board'."
  },
  {
   "role": "batten",
   "option": "Basic: flat stock, Finger-jointed pine",
   "product": "1x3 primed finger-joint pine trim board (today's design)",
   "store": "Home Depot",
   "item_no": "202085979",
   "size": "0.719 x 2-1/2 in.",
   "per_lf": 1.06,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Trim-Board-Primed-Pine-Finger-Joint-Common-1-in-x-3-in-x-8-ft-Actual-719-in-x-2-5-in-x-96-in-424600/202085979",
   "notes": ""
  },
  {
   "role": "batten",
   "option": "Solid poplar",
   "product": "1x3 S4S poplar board (bare)",
   "store": "Home Depot",
   "item_no": "206201564",
   "size": "3/4 x 2-1/2 in.",
   "per_lf": 1.91,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Builders-Choice-1-in-x-3-in-x-8-ft-S4S-Poplar-Board-HLPO10308X/206201564",
   "notes": "Needs priming."
  },
  {
   "role": "batten",
   "option": "Red oak, stained",
   "product": "1x3 S4S red oak board (bare)",
   "store": "Home Depot",
   "item_no": "206201580",
   "size": "3/4 x 2-1/2 in.",
   "per_lf": 3.0,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/Builders-Choice-1-in-x-3-in-x-8-ft-S4S-Red-Oak-Board-O-BD10308X/206201580",
   "notes": "Stain-grade."
  },
  {
   "role": "batten",
   "option": "Bare wood, same profiles",
   "product": "1x3 select kiln-dried square-edge whitewood board (bare, clear)",
   "store": "Home Depot",
   "item_no": "203450507",
   "size": "3/4 x 2-1/2 in.",
   "per_lf": 1.53,
   "seen": "2026-11-17",
   "url": "https://www.homedepot.com/p/1-in-x-3-in-x-8-ft-Select-Kiln-Dried-Square-Edge-Whitewood-Board-418545/203450507",
   "notes": "Clear bare 1x3 costs more than primed FJ."
  },
  {
   "role": "batten",
   "option": "Lumberyard",
   "product": "1x4 Protected primed finger-joint pine trim board, 16 ft",
   "store": "Ring's End",
   "item_no": "14PP",
   "size": "3/4 x 3-1/2 in.",
   "per_lf": 1.85,
   "seen": "2026-11-17",
   "url": "https://www.ringsend.com/windsorone-protected-s4sse-trim-boards-14pp",
   "notes": "Ring's End lists no primed 1x3; 1x4 is the narrowest primed board (rip or use as wider batten)."
  }
 ]
};

// How each moulding is sold.
export const STOCK = {
 "seen": "2026-11-17",
 "note": "How each product is sold, from the stores' own pages (a Lowe's and a Home Depot in the New York suburbs), 2026-11-17. Store lengths over 13 ft are listed but not planned (the cap). Curated from research/stock-lengths-2026-11-17.json.",
 "products": {
  "lowes-163e12fbdpm": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 96,
     "price": 20.56,
     "item": "Lowe's item #29948, model 163E 8FBDPM",
     "url": "https://www.lowes.com/pd/EverTrue-5-1-4-in-x-8-ft-Primed-MDF-Baseboard-Moulding-Actual-5-25-in-x-8-ft/1000445081"
    },
    {
     "in": 144,
     "price": 30.84,
     "item": "Lowe's item #85821, model 163E12FBDPM",
     "url": "https://www.lowes.com/pd/EverTrue-5-1-4-in-x-12-ft-Primed-MDF-Baseboard-Moulding-Actual-5-25-in-x-12-ft/1000443167"
    }
   ],
   "evidence": "Lowe's sells the 1/2 in MDF 163E base as two items: 8 ft (#29948) and 12 ft (#85821). No 16 ft in this MDF.",
   "note": "A 16 ft version exists only in finger-jointed pine (L163E, item #193621), a different product."
  },
  "hd-10000538": {
   "sold": "both",
   "lengths": [
    {
     "in": 96,
     "price": 12.2,
     "item": "Internet #203209387, model 10000538, Store SO SKU #1000374696",
     "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WM-390-11-16-in-x-2-5-8-in-x-96-in-Primed-Finger-Jointed-Pine-Wood-Chair-Rail-Moulding-10000538/203209387"
    }
   ],
   "per_ft": 2.57,
   "max_in": 192,
   "foot_item": "Internet #206001713, model 10000537, Store SKU #369594",
   "foot_url": "https://www.homedepot.com/p/Woodgrain-Millwork-WM-390-11-16-in-x-2-5-8-in-Primed-Finger-Jointed-Chair-Rail-Moulding-10000537/206001713",
   "evidence": "Home Depot sells WM 390 two ways: 8 ft full sticks (#203209387, ship to store, at least 2) at $12.20, and in store off 16 ft stock (#206001713, 'Moulding Cut: By Linear Foot') at $2.57 a foot.",
   "note": "The 8 ft stick is cheaper per foot ($1.53), so the plan cuts from 8 ft sticks and buys a length off the 16 ft stock only for a run longer than an 8 ft stick holds. Shoppers' answers on the page say the aisle has a saw to cut the stock and you pay for the feet you take; the store page does not say."
  },
  "lowes-wcap-8fbdpm": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 96,
     "price": 15.02,
     "item": "Lowe's item #29005, model WCAP 8FBDPM",
     "url": "https://www.lowes.com/pd/EverTrue-2-in-x-8-ft-Primed-Composite-Wall-Panel-Moulding/1000444581"
    }
   ],
   "evidence": "Page has no length picker. Lowe's search 'WCAP wall panel moulding' returned only this 8 ft item."
  },
  "hd-pml00x00cl": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 94.5,
     "price": 12.62,
     "item": "Internet #203798670, model PML00X00CL",
     "url": "https://www.homedepot.com/p/Ekena-Millwork-1-2-in-x-7-8-in-x-94-5-in-Primed-Polyurethane-Panel-Moulding-1-Piece-7-88-Total-Linear-Feet-PML00X00CL/203798670"
    }
   ],
   "evidence": "No length picker on the page. A Home Depot search for the model number PML00X00CL goes straight to this one listing."
  },
  "hd-424600": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 96,
     "price": 8.52,
     "item": "Internet #202085979, model / store SKU 424600",
     "url": "https://www.homedepot.com/p/Trim-Board-Primed-Pine-Finger-Joint-Common-1-in-x-3-in-x-8-ft-Actual-719-in-x-2-5-in-x-96-in-424600/202085979"
    }
   ],
   "evidence": "On the 424600 page, the length picker (8, 12, 16 ft) applies across the whole board family; picking 12 ft jumps to a 5/4x6x12 board and picking 16 ft jumps to a 1x6x16 board ('We updated your selection based on the available options'), so 424600 itself is 8 ft only. A Home Depot search for '1 in. x 3 in. x 12 ft. primed finger joint' found only the 8 ft 424600 and the 16 ft PFJB1316 in primed finger-joint 1x3; 10 ft appeared only as unprimed whitewood (model 914657, $9.98).",
   "note": "The 16 ft primed 1x3 (PFJB1316, $16.98) is a different board, 11/16 in thick, and over the 13 ft cap; not planned."
  },
  "lowes-l51844412": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 96,
     "price": 10.58,
     "item": "Lowe's item #333346, model L5184448",
     "url": "https://www.lowes.com/pd/Common-1-in-x-4-in-x-8-ft-Actual-0-7187-in-x-3-5-in-x-8-ft-Primed-Pine-Board/1000842744"
    },
    {
     "in": 144,
     "price": 16.98,
     "item": "Lowe's item #356473, model L51844412",
     "url": "https://www.lowes.com/pd/1-in-x-4-in-x-12-ft-Square-Primed-Pine-Board/5002021501"
    }
   ],
   "evidence": "RELIABILT primed finger-jointed pine 1x4, 23/32 x 3-1/2 in, sold in 8, 12 and 16 ft (no 10 ft), not by the foot.",
   "note": "16 ft (item #131203, $20.98) is over the 13 ft limit and not stocked for pickup at the store checked. Home Depot sells the same size at the same 8 and 12 ft prices."
  },
  "lowes-l51844612": {
   "sold": "lengths",
   "lengths": [
    {
     "in": 96,
     "price": 16.37,
     "item": "Lowe's item #333348, model L5184468",
     "url": "https://www.lowes.com/search?searchTerm=333348"
    },
    {
     "in": 144,
     "price": 25.55,
     "item": "Lowe's item #356475, model L51844612",
     "url": "https://www.lowes.com/search?searchTerm=356475"
    }
   ],
   "evidence": "RELIABILT primed finger-jointed pine 1x6, 23/32 x 5-1/2 in, the same family and thickness as the 1x4; sold in 8, 12 and 16 ft, not by the foot.",
   "note": "Chosen over Home Depot's 1x6 because Home Depot's 8 and 16 ft boards are separate products listed 1/32 in thicker than its 12 ft, so they would not sit flush with the 1x4. 16 ft (item #131206, $31.52) is over the 13 ft limit."
  }
 }
};

export const ESTIMATE_DATA = { labor: LABOR, supplies: SUPPLIES, options: OPTIONS, stock: STOCK };
