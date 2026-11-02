# Onboarding a property: the real products

Onboarding turns a Polycam scan, site photos and walk-through videos into a Tiksi model. The
plan, walls, openings and fixture boxes come from the scan (see the scan, fixture and MEASURE
sections of `USER-GUIDE.md`). This file covers the next part. Every appliance, fixture and
system is identified as the actual product, documented, and modelled as that product. It must
not stay a generic stand-in.

The bar is a model that says "this is how it is built, and these are the actual things". Each
member is at its real size. Each product comes from its spec sheet or the manufacturer's model.
The mechanical connections are drawn: supply and drain lines, shutoff valves, vents, line sets,
the breaker panel and its circuits. A list kept only in a side folder does not meet this bar.
The findings go into the project file, onto each fixture, so the app and the SketchUp mirror
show them.

Work on a copy. Write the updated project to a new `.tiksi`, compare it, then replace the
original. Never write into the Trimble Connect Sync folders.

## 1. Brand pass: what is each thing?

Go through every appliance and fixture: range, fridge, dishwasher, washer and dryer,
microwave, range hood, mini-split or other HVAC heads and outdoor units, water heater,
faucets, shower trim, toilet, vanity, breaker panel, thermostat, light fixtures. For each one,
search all of the media for a readable logo or rating label. The tools prepare the views, and
you read them.

```
python3 scripts/onboard-media.py photo-tiles "<project>/Source media" --out <work>/tiles
python3 scripts/onboard-media.py video-sharp "<project>/Source media/IMG_1234.MOV" --out <work>/frames --every 1
python3 scripts/onboard-media.py keyframe-check "<project>/Source media/keyframes"
python3 scripts/onboard-media.py keyframe-sheets "<project>/Source media/keyframes" --out <work>/sheets
python3 scripts/onboard-media.py keyframe-angles "<project>/Source media/keyframes" --sighting 2445:150,510 --out <work>/angles-minisplit
```

- **Photos.** Read the full-resolution tiles, not the whole photo scaled down. A small logo is
  only legible at the camera's own pixels.
- **Videos.** `video-sharp` scores a dense burst (10 frames per second) by edge variance. It
  keeps the sharpest full-resolution frame of each window. Thumbnails and contact sheets are
  too small to read a logo; use them only to find the moment. Then run `video-sharp` with
  `--start`/`--end` around that moment and `--every 0.5`.
- **Polycam keyframes** (`keyframes/images` with `cameras/*.json` and `depth/*.png`). They give
  angles the photos lack: on one project the mini-split logo was readable only there.
  - Find a first sighting on the numbered sheets.
  - `keyframe-angles` takes that keyframe and pixel and lists every other keyframe that sees
    the same spot (nearest and most centred first). It writes a crop for each.
  - Run `keyframe-check` first. It tests the poses against the depth maps. If it reports them
    inconsistent, read the sheets frame by frame instead.
- **Panel directory.** Photograph or find the breaker panel's directory card. Read every
  circuit: number, label and amps.

Record each item as one of these:

- **Confirmed**: the logo or rating label is read. List the evidence that reads it: the file,
  the video time or keyframe, a crop, and `reads: ["brand"]` or `["model"]`.
- **Likely**: no logo was read. The brand or model is a visual match against web listings; list
  the listings as sources.
- **Unidentified**: say what was searched.

Never present a guess as confirmed. Tiksi enforces this: a confirmed brand or model without
evidence that reads it is stored as likely. A brand can be confirmed while the model is only
likely. Get model numbers from rating labels: the dishwasher door edge, inside the washer lid,
the fridge's interior side wall, the range drawer frame, the side of a mini-split head.

## 2. Documents: spec sheet, installation drawing, manual

For each product with a brand and model, find the manufacturer's spec sheet, the installation
guide with its dimension drawing, and the owner's manual. Look on the manufacturer's site
first, then retailers' copies. Save them in the project folder:

```
python3 scripts/onboard-media.py fetch-docs --project "<project>/Tiksi/<name>.tiksi" --brand Frigidaire --model FFBD2412SS \
  --kind spec-sheet https://.../spec.pdf --kind installation https://.../install.pdf
```

The documents go to `Product documents/<Brand Model>/`, beside the Tiksi folder, with a
`.SOURCE.txt` for each file: address, date and SHA-256. Only public addresses are fetched, and
only PDFs and images are kept. Copy the printed document entries into the findings.

In the app, the same thing happens when someone types a brand and model on a fixture. The
product is filed in PRODUCTS, and FIND DOCUMENTS runs the local research service. ADD BY
ADDRESS saves one document.

## 3. Size and detail from the drawing

Read the drawing's overall width, depth (with handles) and height into `dims`, and cite the
page. Tiksi sizes the fixture from them and keeps the wall side where the scan or tape put it.
Every fixture linked to that product changes with it, in MODEL and in the SketchUp mirror.

Read the numbers the detailed stand-in is built from into `detail`:

| Fixture | `detail` |
| --- | --- |
| Range | `fuel`, `burners`, `knobs`, `backguard`, `drawer`, `window` |
| Dishwasher | `kick` height, `controls` (front or top), `handle` |
| Fridge | `layout` (top-freezer, bottom-freezer, french, side-by-side, single), `split`, `hinge` |
| Washer and dryer | `layout` (stacked, front-washer, front-dryer, top-washer), `split` |
| Toilet | `bowl` (elongated or round), `tank` (rim height) |
| Vanity | `doors`, `sink`, `kick`, `counter` |
| Breaker panel | `door` (open shows the breakers), `circuits` (`n`, `label`, `amps`, `poles`) |

Place the mechanical pieces as fixtures of their own (kind `fitting`), at their measured
places:

- `shutoff`: a supply stop with its supply line
- `line-set`: a mini-split's pipes down the wall
- `vent`: a dryer or bath vent
- `drain`: a trap and tailpiece
- `outdoor-unit`
- `water-heater` (kind `appliance`)

## 4. Model pass: the product's own 3D model

For each confirmed or likely product, look for a real model, in this order:

1. The manufacturer's model or CAD/BIM download.
2. SketchUp 3D Warehouse. Its search answers from a page on 3dwarehouse.sketchup.com at
   `/warehouse/v1.0/entities?q=<brand model>&contentType=3dw`.
3. BIMobject, BIMsmith, ARCAT, CADdetails.
4. Sketchfab, CGTrader.

Formats: `.glb`, `.skp`, `.obj`, `.fbx`, `.dae`, `.3ds` and `.usdz` all convert:

```
python3 scripts/onboard-media.py convert-model "<download>/model.skp" --out <work>/model.glb
```

A `.rfa` needs Revit. Do not sign in, pay or accept terms to get a model; if a model is behind
one of those, list it for the owner. Record where the model came from and its licence.

Tiksi stretches the model to the measured box and reports the fit. A real model in metres
needs almost no stretch. Above 10%, the model, its units or the measurement is wrong: check
it before keeping it. If the model's front faces the wall, set `turn` (90, 180 or 270). If no
model exists, keep the detailed stand-in and say in `assetNote` what was searched.

## 5. Write it into the project

Put everything in one findings file, the shape documented at the top of
`scripts/onboard-apply.mjs`, and apply it to a copy:

```
node scripts/onboard-apply.mjs --project "<name>.tiksi" --findings findings.json --out "<name> (products).tiksi"
```

The script uses the app's own rules. It reports each fixture's identity and how sure it is,
its PRODUCTS record, documents and drawing size, and the model fit. A fixture the scan missed
(a breaker panel, a shutoff) can be placed with `create`. Open the result in Tiksi and check
MODEL, then let the SketchUp mirror rewrite the `.skp`. Each product is a group named after
it, carrying its brand, model and confidence. Then replace the original file.

## Report

Report what was identified, as three lists: confirmed, likely and unidentified. Include the
evidence for each, the documents saved, which fixtures now use a real model and which keep
the detailed stand-in (and why), and any fit warnings. Name the rating labels still to
photograph.
