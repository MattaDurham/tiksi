// tiksi price book: installed unit prices (materials and labour, contractor-installed, US
// dollars) for common renovation work (finishes, drywall, lighting, plumbing, permits) at three
// finish levels, each with a real product line as its placeholder material. Researched 2026-11
// from current cost guides, maker / retailer pages and official fee schedules;
// docs/price-book-sources.md lists the sources per work and how firm each figure is.
// National averages: a cost area's factor scales them (scope-takeoff.js). A permit instead
// carries each place's own typical totals (areaLevels), since fees follow fee schedules, not
// building costs. A material with priceChecked false has a price from a dealer or an
// estimate, not a published list price. Estimates to start a budget, never a quote.

export const PRICE_BOOK = {
 "asOf": "2026-11",
 "basis": "National average installed cost per unit in US dollars, materials plus labour, by a contractor (not DIY), from 2025-2026 consumer cost guides; multiply by the area factor for local prices.",
 "areas": [
  {
   "id": "national",
   "label": "US national average",
   "factor": 1
  },
  {
   "id": "nyc",
   "label": "New York City (Manhattan)",
   "factor": 1.32,
   "source": "https://craftsman-book.com/media/static/previews/2025_NBC_book_preview.pdf",
   "note": "Craftsman 2025 National Building Cost Manual area modification, New York (Manhattan) ZIP 100-102: +32%. BLS May 2025: NY-Newark-Jersey City construction trades mean wage $39.49/h vs $31.42 US (+26%). Co-op/condo building rules (insurance, elevator hours) can push Manhattan quotes higher.",
   "match": "New York, ?NY|New York City|NYC|Manhattan|Brooklyn|Queens|Bronx|Staten Island|W(est)? \\d+(st|nd|rd|th) St|E(ast)? \\d+(st|nd|rd|th) St"
  },
  {
   "id": "westchester",
   "label": "Westchester, NY",
   "factor": 1.15,
   "source": "https://craftsman-book.com/media/static/previews/2025_NBC_book_preview.pdf",
   "note": "Craftsman 2025: White Plains ZIP 105-108 +10%. BLS NY metro construction wages +26%; 60% labour x 1.26 + 40% materials x 1.02 = 1.16. Chosen 1.15.",
   "match": "\\bNY,? 10[5-8]\\d\\d\\b|Westchester|White Plains|Scarsdale|Mamaroneck|New Rochelle|Rye\\b|Yonkers"
  },
  {
   "id": "napa",
   "label": "Napa / SF Bay Area",
   "factor": 1.18,
   "source": "https://www.bls.gov/regions/west/news-release/2026/occupationalemploymentandwages_napa_20260709.htm",
   "note": "Craftsman 2025: ZIP 945 (Oakland SCF, includes Napa 94558/94559) +19%; Santa Rosa +5%; San Francisco +28%. BLS May 2025 Napa construction trades mean wage $38.35/h vs $31.42 US (+22%). Use 1.28 for San Francisco proper.",
   "match": "Napa|Sonoma|St\\.? Helena|Yountville|Calistoga|San Francisco|Bay Area"
  }
 ],
 "works": [
  {
   "id": "paint-walls",
   "label": "Paint walls",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 1.0,
     "likely": 1.3,
     "high": 1.7,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Eggshell Enamel",
      "price": 34.98,
      "per": "gal",
      "coverage": "250-400 sf/gal",
      "url": "https://www.behr.com/products/interior-paint/premium-plus-interior/premium-plus-interior-eggshell-enamel",
      "priceChecked": true
     },
     "laborShare": 0.8,
     "note": "2 coats, spot-patch nail holes only, cut in and roll, one colour per room"
    },
    "mid": {
     "low": 1.5,
     "likely": 2.0,
     "high": 2.6,
     "material": {
      "brand": "Benjamin Moore",
      "line": "Regal Select Waterborne Interior, Matte (N548)",
      "price": 78.0,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/regal-select-waterborne-interior-paint-matte-1-gallon-eggshell-2026-70/N548/ZWB100000002140330",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "patch and sand minor dings, caulk gaps, prime patches, 2 finish coats"
    },
    "high": {
     "low": 2.5,
     "likely": 3.25,
     "high": 4.5,
     "material": {
      "brand": "Farrow & Ball",
      "line": "Estate Emulsion (matt)",
      "price": 135.0,
      "per": "gal",
      "coverage": "about 350 sf/gal",
      "url": "https://www.farrow-ball.com/us/paint/all-white/estate-emulsion",
      "priceChecked": false
     },
     "laborShare": 0.75,
     "note": "careful prep and sanding, primer coat, 2-3 coats (deep colours need 3), crisp lines"
    }
   },
   "sources": [
    "https://homeguide.com/costs/cost-to-paint-interior-of-house",
    "https://homewyse.com/services/cost_to_paint_wall.html",
    "https://angi.com/articles/how-much-does-it-cost-paint-interior-house.htm"
   ]
  },
  {
   "id": "paint-walls-skim",
   "label": "Skim coat and paint walls",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 2.1,
     "likely": 2.6,
     "high": 3.2,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Eggshell Enamel",
      "price": 34.98,
      "per": "gal",
      "coverage": "250-400 sf/gal",
      "url": "https://www.behr.com/products/interior-paint/premium-plus-interior/premium-plus-interior-eggshell-enamel",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "one skim coat over patched areas and joints (Level 4), sand, prime, 2 coats paint"
    },
    "mid": {
     "low": 2.8,
     "likely": 3.5,
     "high": 4.5,
     "material": {
      "brand": "Benjamin Moore",
      "line": "Regal Select Waterborne Interior, Matte (N548)",
      "price": 78.0,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/regal-select-waterborne-interior-paint-matte-1-gallon-eggshell-2026-70/N548/ZWB100000002140330",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "full single skim of the wall, sand, prime, 2 coats"
    },
    "high": {
     "low": 4.0,
     "likely": 5.5,
     "high": 7.5,
     "material": {
      "brand": "Benjamin Moore",
      "line": "Aura Interior, Matte",
      "price": 99.0,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://benjaminmoore.com/en-us/offers",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "Level 5: two full skim coats, raking-light check, primer-surfacer, 2 coats premium paint"
    }
   },
   "sources": [
    "https://www.homewyse.com/services/cost_to_skim_coat.html",
    "https://angi.com/articles/cost-to-skim-coat-drywall.htm",
    "https://homeguide.com/costs/cost-to-paint-interior-of-house"
   ]
  },
  {
   "id": "wallpaper-install",
   "label": "Hang wallpaper",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 3.5,
     "likely": 4.5,
     "high": 6.0,
     "material": {
      "brand": "York Wallcoverings",
      "line": "prepasted / SureStrip double roll",
      "price": 90.0,
      "per": "double roll",
      "coverage": "about 56 sf/double roll",
      "url": "https://www.yorkwallcoverings.com/",
      "priceChecked": false
     },
     "laborShare": 0.6,
     "note": "machine-printed paper, simple match, walls already smooth and primed"
    },
    "mid": {
     "low": 6.0,
     "likely": 8.0,
     "high": 11.0,
     "material": {
      "brand": "York Wallcoverings",
      "line": "Multi Grass grasscloth",
      "price": 89.0,
      "per": "single roll (4 yd)",
      "coverage": "about 36 sf/roll",
      "url": "https://decoratorsbest.com/products/york-multi-grass-brown-wallpaper",
      "priceChecked": true
     },
     "laborShare": 0.5,
     "note": "grasscloth or large-repeat paper, wallpaper primer, careful seams"
    },
    "high": {
     "low": 27.0,
     "likely": 40.0,
     "high": 65.0,
     "material": {
      "brand": "Schumacher",
      "line": "designer wallpaper sold by the yard (e.g. Folly)",
      "price": 84.0,
      "per": "yd",
      "coverage": "about 2.25 sf/yd at 27 in. wide; 10 yd minimum",
      "url": "https://www.decoratorsbest.com/products/schumacher-folly-sky-wallpaper",
      "priceChecked": true
     },
     "laborShare": 0.25,
     "note": "designer paper by the yard (Phillip Jeffries can run higher), lining paper, specialist hanger"
    }
   },
   "sources": [
    "https://angi.com/articles/how-much-does-it-cost-hang-wallpaper.htm",
    "https://www.homeadvisor.com/cost/home-design-and-decor/install-wallpaper"
   ]
  },
  {
   "id": "remove-wallpaper",
   "label": "Remove wallpaper",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 0.75,
     "likely": 1.1,
     "high": 1.5,
     "material": null,
     "laborShare": 1.0,
     "note": "strippable paper on primed drywall, steam/score, wash walls"
    },
    "mid": {
     "low": 1.25,
     "likely": 1.75,
     "high": 2.4,
     "material": null,
     "laborShare": 1.0,
     "note": "older paper or several layers, minor gouge repair"
    },
    "high": {
     "low": 2.0,
     "likely": 2.75,
     "high": 3.5,
     "material": null,
     "laborShare": 1.0,
     "note": "paper on unprimed drywall or plaster, heavy repair before paint"
    }
   },
   "sources": [
    "https://homeadvisor.com/cost/home-design-and-decor/remove-wallpaper",
    "https://angi.com/articles/how-much-does-it-cost-hang-wallpaper.htm"
   ]
  },
  {
   "id": "wall-tile",
   "label": "Wall tile (shower/bath field tile)",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 12.0,
     "likely": 16.0,
     "high": 20.0,
     "material": {
      "brand": "Daltile",
      "line": "Restore 3x6 Glossy Bright White ceramic subway",
      "price": 2.79,
      "per": "sf",
      "coverage": "12.5 sf/case",
      "url": "https://superarbor.io/collections/tile/products/thdflt2245921",
      "priceChecked": true
     },
     "laborShare": 0.75,
     "note": "ceramic subway, straight lay, cement board + liquid waterproofing"
    },
    "mid": {
     "low": 20.0,
     "likely": 26.0,
     "high": 34.0,
     "material": {
      "brand": "Bedrosians",
      "line": "Cloe 2.5x8 glossy ceramic wall tile",
      "price": 8.29,
      "per": "sf",
      "coverage": "10.64 sf/carton",
      "url": "https://www.designshop.com/sample/300058433-100428705/bedrosians-tile-and-stone-cloe-ceramic-tile-creme-2-5-in-x-8-in",
      "priceChecked": true
     },
     "laborShare": 0.65,
     "note": "glossy handmade-look ceramic, membrane waterproofing (e.g. Schluter Kerdi), niche trim"
    },
    "high": {
     "low": 35.0,
     "likely": 48.0,
     "high": 65.0,
     "material": {
      "brand": "Fireclay Tile",
      "line": "Original handmade ceramic 3x6 (glazed)",
      "price": 28.0,
      "per": "sf",
      "coverage": "made to order, 25 sf minimum",
      "url": "https://designshop.com/sample/300030769-101385038/fireclay-tile-original-ceramic-tile-3-in-x-6-in",
      "priceChecked": true
     },
     "laborShare": 0.5,
     "note": "handmade or stone tile, pattern layout, metal edge trims, setting-quality installer"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/bathrooms/retile-bathroom-shower",
    "https://www.thisoldhouse.com/bathrooms/shower-tile-installation",
    "https://angi.com/articles/cost-to-tile-a-shower.htm"
   ]
  },
  {
   "id": "backsplash-tile",
   "label": "Backsplash tile",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 14.0,
     "likely": 18.0,
     "high": 23.0,
     "material": {
      "brand": "Daltile",
      "line": "Restore 3x6 Glossy Bright White ceramic subway",
      "price": 2.79,
      "per": "sf",
      "coverage": "12.5 sf/case",
      "url": "https://superarbor.io/collections/tile/products/thdflt2245921",
      "priceChecked": true
     },
     "laborShare": 0.75,
     "note": "ceramic subway over drywall, small area so cuts and outlets dominate"
    },
    "mid": {
     "low": 24.0,
     "likely": 30.0,
     "high": 38.0,
     "material": {
      "brand": "Bedrosians",
      "line": "Cloe 2.5x8 glossy ceramic wall tile",
      "price": 8.29,
      "per": "sf",
      "coverage": "10.64 sf/carton",
      "url": "https://www.designshop.com/sample/300058433-100428705/bedrosians-tile-and-stone-cloe-ceramic-tile-creme-2-5-in-x-8-in",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "handmade-look ceramic or porcelain, edge trim"
    },
    "high": {
     "low": 40.0,
     "likely": 55.0,
     "high": 75.0,
     "material": {
      "brand": "Fireclay Tile",
      "line": "Original handmade ceramic 3x6 (glazed)",
      "price": 28.0,
      "per": "sf",
      "coverage": "made to order, 25 sf minimum",
      "url": "https://designshop.com/sample/300030769-101385038/fireclay-tile-original-ceramic-tile-3-in-x-6-in",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "handmade, zellige or stone; minimum charge applies to small areas"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/kitchens/tile-backsplash-install",
    "https://match.angi.com/cost/kitchens/tile-backsplash-install",
    "https://bobvila.com/articles/kitchen-backsplash-cost"
   ]
  },
  {
   "id": "paint-ceiling",
   "label": "Paint ceiling",
   "applies": [
    "ceiling"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 0.9,
     "likely": 1.2,
     "high": 1.6,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Ceiling Flat",
      "price": 30.0,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.behr.com/products/interior-paint/premium-plus-interior",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "flat white, 2 coats, minimal prep"
    },
    "mid": {
     "low": 1.3,
     "likely": 1.75,
     "high": 2.3,
     "material": {
      "brand": "Benjamin Moore",
      "line": "Waterborne Ceiling Paint, Ultra Flat",
      "price": 60.99,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://store.benjaminmoore.com/storefront/us/en/shop-by-product/interior-paint",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "patch cracks, prime stains, 2 coats"
    },
    "high": {
     "low": 2.0,
     "likely": 2.75,
     "high": 3.75,
     "material": {
      "brand": "Benjamin Moore",
      "line": "Aura Interior, Matte",
      "price": 99.0,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://benjaminmoore.com/en-us/offers",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "skim-patched, primed, 2 coats premium matte; tinted ceilings"
    }
   },
   "sources": [
    "https://www.angi.com/articles/paint-ceiling-cost.htm",
    "https://www.homewyse.com/services/cost_to_paint_ceiling.html",
    "https://www.fixr.com/costs/paint-ceiling"
   ]
  },
  {
   "id": "refinish-hardwood",
   "label": "Refinish hardwood floor",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 3.0,
     "likely": 3.75,
     "high": 4.5,
     "material": {
      "brand": "Bona",
      "line": "Mega waterborne finish",
      "price": 100.0,
      "per": "gal",
      "coverage": "about 400-500 sf/gal per coat",
      "url": "https://ardec.ca/en/p/1187/bona-mega-waterborne-wood-floor-finish",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "sand to bare wood, natural (no stain), sealer + 2 topcoats"
    },
    "mid": {
     "low": 4.0,
     "likely": 5.0,
     "high": 6.0,
     "material": {
      "brand": "Bona",
      "line": "Traffic HD waterborne commercial finish",
      "price": 147.32,
      "per": "gal",
      "coverage": "about 500 sf/gal per coat",
      "url": "https://www.paneltown.com/product/bona-traffic-hd-water-based-finish-1-gallon",
      "priceChecked": true
     },
     "laborShare": 0.75,
     "note": "sand, optional stain, sealer + 3 coats (2 Traffic HD), dust containment"
    },
    "high": {
     "low": 6.0,
     "likely": 7.5,
     "high": 9.5,
     "material": {
      "brand": "Rubio Monocoat",
      "line": "Oil Plus 2C (hardwax oil)",
      "price": 185.0,
      "per": "1.3 L kit",
      "coverage": "about 300-500 sf/kit",
      "url": "https://www.rubiomonocoatusa.com/",
      "priceChecked": false
     },
     "laborShare": 0.75,
     "note": "dustless sanding, board repairs, colour sampling, stain + oil or 3-coat Traffic HD"
    }
   },
   "sources": [
    "https://www.thisoldhouse.com/flooring/cost-to-refinish-hardwood-floors",
    "https://fixr.com/costs/hardwood-floor-refinishing",
    "https://hallmarkfloors.com/2025/05/23/cost-to-refinish-hardwood-floors/"
   ]
  },
  {
   "id": "install-solid-hardwood",
   "label": "Install solid hardwood floor",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 8.0,
     "likely": 10.0,
     "high": 12.0,
     "material": {
      "brand": "Bruce",
      "line": "Natural Reflections oak, 5/16 x 2-1/4 in. prefinished solid",
      "price": 4.84,
      "per": "sf",
      "coverage": "40 sf/carton; add 5-10% waste",
      "url": "https://www.homedepot.com/p/Bruce-Natural-Reflections-Oak-Natural-5-16-in-Thick-x-2-1-4-in-Wide-x-Random-Length-Solid-Hardwood-Flooring-40-sq-ft-case-C5010/202667229",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "narrow prefinished strip, nail-down over sound subfloor"
    },
    "mid": {
     "low": 11.0,
     "likely": 14.0,
     "high": 17.0,
     "material": {
      "brand": "Somerset Hardwood Flooring",
      "line": "Character/Classic 3/4 x 5 in. white oak prefinished solid",
      "price": 6.5,
      "per": "sf",
      "coverage": "add 7-10% waste",
      "url": "https://www.somersetfloors.com/",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "3/4 in. plank, white oak, prefinished or site-finished, new underlayment"
    },
    "high": {
     "low": 18.0,
     "likely": 24.0,
     "high": 32.0,
     "material": {
      "brand": "Carlisle Wide Plank Floors",
      "line": "white oak wide plank (8-12 in.)",
      "price": 18.0,
      "per": "sf",
      "coverage": "custom milled; quote only",
      "url": "https://www.wideplankflooring.com/",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "wide-plank, site-finished, glue-assist nail, acclimation and moisture checks"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/flooring/install-wood-flooring",
    "https://inchcalculator.com/hardwood-floor-cost",
    "https://bobvila.com/articles/solid-wood-vs-engineered-wood-cost"
   ]
  },
  {
   "id": "install-engineered-hardwood",
   "label": "Install engineered hardwood floor",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 7.0,
     "likely": 8.5,
     "high": 10.0,
     "material": {
      "brand": "Floor & Decor (Westridge)",
      "line": "Fable White Oak wire-brushed engineered",
      "price": 4.99,
      "per": "sf",
      "coverage": "add 7-10% waste",
      "url": "https://www.flooranddecor.com/engineered-hardwood-wood/fable-white-oak-wire-brushed-engineered-hardwood-100811793.html",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "click or float over underlayment, thin wear layer"
    },
    "mid": {
     "low": 10.0,
     "likely": 12.0,
     "high": 14.5,
     "material": {
      "brand": "Floor & Decor (Woodland Reserve)",
      "line": "Voyage Waren White Oak wire-brushed engineered",
      "price": 7.22,
      "per": "sf",
      "coverage": "add 7-10% waste",
      "url": "https://www.flooranddecor.com/engineered-hardwood-wood/voyage-waren-white-oak-wire-brushed-engineered-hardwood-100906288.html",
      "priceChecked": true
     },
     "laborShare": 0.4,
     "note": "wider plank, 2-4 mm wear layer, glue-down or nail-down"
    },
    "high": {
     "low": 15.0,
     "likely": 19.0,
     "high": 25.0,
     "material": {
      "brand": "Hakwood",
      "line": "European oak engineered wide plank",
      "price": 15.0,
      "per": "sf",
      "coverage": "quote only",
      "url": "https://www.hakwood.com/",
      "priceChecked": false
     },
     "laborShare": 0.3,
     "note": "premium European oak, thick wear layer, full-spread glue over leveled subfloor"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/flooring/engineered-wood",
    "https://match.angi.com/cost/flooring/engineered-wood",
    "https://homegnome.com/blog/cost/engineered-hardwood-flooring-price/"
   ]
  },
  {
   "id": "install-lvp",
   "label": "Install luxury vinyl plank",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 4.5,
     "likely": 5.5,
     "high": 6.5,
     "material": {
      "brand": "LifeProof (Home Depot)",
      "line": "rigid core LVP, 22 mil wear layer",
      "price": 3.29,
      "per": "sf",
      "coverage": "about 20 sf/case",
      "url": "https://homedepot.com/b/Flooring-Vinyl-Flooring-Vinyl-Plank-Flooring/Highly-Rated/Lifeproof/N-5yc1vZbzjzZnv7Zbwo5o",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "click-lock floating floor over flat subfloor"
    },
    "mid": {
     "low": 6.5,
     "likely": 7.75,
     "high": 9.0,
     "material": {
      "brand": "COREtec",
      "line": "Pro Plus Enhanced (HD) planks",
      "price": 5.39,
      "per": "sf",
      "coverage": "add 7% waste",
      "url": "https://www.fergusonhome.com/coretec-vv488-02097/s1881700",
      "priceChecked": true
     },
     "laborShare": 0.4,
     "note": "thicker rigid core, attached pad, minor leveling, transitions"
    },
    "high": {
     "low": 8.5,
     "likely": 10.0,
     "high": 12.0,
     "material": {
      "brand": "Karndean",
      "line": "Korlok rigid core",
      "price": 6.99,
      "per": "sf",
      "coverage": "dealer quote",
      "url": "https://www.karndean.com/en-us/",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "premium LVP, full leveling, stair nosings and trims"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/luxury-vinyl-plank-flooring",
    "https://www.thisoldhouse.com/flooring/cost-to-install-vinyl-plank-flooring",
    "https://inchcalculator.com/how-much-does-it-cost-to-install-vinyl-flooring"
   ]
  },
  {
   "id": "porcelain-floor-tile",
   "label": "Porcelain floor tile",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 9.0,
     "likely": 11.0,
     "high": 13.5,
     "material": {
      "brand": "MSI",
      "line": "24x24 polished porcelain (Home Depot)",
      "price": 3.74,
      "per": "sf",
      "coverage": "add 10% waste",
      "url": "https://homedepot.com/b/Flooring-Tile/MOLOVO/MSI/24x24/4-Heavy-Traffic/N-5yc1vZar0yZm5hZycwZ1z0vvrfZ1z11918",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "standard size, straight lay, thinset over sound subfloor"
    },
    "mid": {
     "low": 13.0,
     "likely": 16.0,
     "high": 20.0,
     "material": {
      "brand": "Daltile",
      "line": "Volume 1.0 12x24 porcelain",
      "price": 4.5,
      "per": "sf",
      "coverage": "add 10% waste",
      "url": "https://www.daltile.com/",
      "priceChecked": false
     },
     "laborShare": 0.55,
     "note": "large format, uncoupling membrane, leveling clips"
    },
    "high": {
     "low": 22.0,
     "likely": 28.0,
     "high": 38.0,
     "material": {
      "brand": "Porcelanosa",
      "line": "large-format porcelain (dealer)",
      "price": 14.0,
      "per": "sf",
      "coverage": "showroom quote",
      "url": "https://www.porcelanosa-usa.com/",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "large-format or pattern lay, self-leveler, metal transitions; heated floor extra"
    }
   },
   "sources": [
    "https://fixr.com/costs/porcelain-tile-floor-installation",
    "https://www.homeadvisor.com/cost/flooring/install-ceramic-or-porcelain-tile/",
    "https://inchcalculator.com/tile-floor-cost"
   ]
  },
  {
   "id": "install-carpet",
   "label": "Install carpet with pad",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 3.25,
     "likely": 4.25,
     "high": 5.25,
     "material": {
      "brand": "LifeProof / TrafficMaster (Home Depot)",
      "line": "nylon/polyester broadloom, installed program",
      "price": 2.0,
      "per": "sf",
      "coverage": "12 ft rolls; add 10% waste",
      "url": "https://www.homedepot.com/b/Flooring-Carpet/N-5yc1vZarl0",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "polyester or basic nylon, rebond pad"
    },
    "mid": {
     "low": 5.0,
     "likely": 6.5,
     "high": 8.0,
     "material": {
      "brand": "Mohawk",
      "line": "SmartStrand (triexta)",
      "price": 4.0,
      "per": "sf",
      "coverage": "12 ft rolls; add 10% waste",
      "url": "https://www.mohawkflooring.com/",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "triexta or good nylon, better pad, stairs priced extra"
    },
    "high": {
     "low": 12.0,
     "likely": 18.0,
     "high": 28.0,
     "material": {
      "brand": "Stark Carpet",
      "line": "wool broadloom",
      "price": 15.0,
      "per": "sf",
      "coverage": "to the trade; quote",
      "url": "https://www.starkcarpet.com/",
      "priceChecked": false
     },
     "laborShare": 0.2,
     "note": "wool, felt or premium pad, specialist installer, seams pattern-matched"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/flooring/carpet-padding-prices",
    "https://homewyse.com/services/cost_to_install_carpet.html",
    "https://homegnome.com/blog/cost/carpet-installation-price/"
   ]
  },
  {
   "id": "remove-flooring",
   "label": "Remove existing flooring",
   "applies": [
    "floor"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 0.75,
     "likely": 1.25,
     "high": 1.75,
     "material": null,
     "laborShare": 1.0,
     "note": "carpet and pad or floating LVP/laminate, haul away"
    },
    "mid": {
     "low": 1.5,
     "likely": 2.25,
     "high": 3.0,
     "material": null,
     "laborShare": 1.0,
     "note": "nailed or glued wood, scrape adhesive"
    },
    "high": {
     "low": 3.0,
     "likely": 4.5,
     "high": 6.0,
     "material": null,
     "laborShare": 1.0,
     "note": "tile on thinset or mortar bed, grind, haul away"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/flooring/carpet-padding-prices",
    "https://www.homeadvisor.com/cost/flooring/install-ceramic-or-porcelain-tile/"
   ]
  },
  {
   "id": "paint-trim",
   "label": "Paint baseboard / trim",
   "applies": [
    "baseboard",
    "perimeter"
   ],
   "unit": "lf",
   "levels": {
    "budget": {
     "low": 1.0,
     "likely": 1.5,
     "high": 2.0,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Semi-Gloss Enamel",
      "price": 36.0,
      "per": "gal",
      "coverage": "about 400 sf/gal; ~150 lf of 5\" base per qt, 2 coats",
      "url": "https://www.behr.com/consumer/products/interior-paint/premium-plus-interior/premium-plus-interior-semi-gloss-enamel",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "2 coats, light sand, caulk top edge"
    },
    "mid": {
     "low": 1.75,
     "likely": 2.5,
     "high": 3.25,
     "material": {
      "brand": "Benjamin Moore",
      "line": "ADVANCE Waterborne Interior Alkyd, Satin",
      "price": 88.99,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/advance-interior-paint-satin-1-gallon-satin-shoes-2159-70/0792/ZWB100000000338435",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "degloss, fill, caulk, prime bare spots, 2 coats alkyd-hybrid enamel"
    },
    "high": {
     "low": 3.0,
     "likely": 4.0,
     "high": 5.5,
     "material": {
      "brand": "Fine Paints of Europe",
      "line": "Eurolux Hollandlac Brilliant (oil enamel)",
      "price": 85.0,
      "per": "qt",
      "coverage": "about 100 sf/qt per coat",
      "url": "https://www.finepaintsofeurope.com/",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "sand smooth, fill, 3 coats brushed oil enamel"
    }
   },
   "sources": [
    "https://homeguide.com/costs/cost-to-paint-trim-baseboards",
    "https://www.angi.com/articles/baseboard-painting-cost.htm",
    "https://www.homeadvisor.com/cost/painting/paint-trim-baseboards"
   ]
  },
  {
   "id": "install-baseboard",
   "label": "Install new baseboard",
   "applies": [
    "baseboard",
    "perimeter"
   ],
   "unit": "lf",
   "levels": {
    "budget": {
     "low": 5.0,
     "likely": 6.25,
     "high": 7.5,
     "material": {
      "brand": "Woodgrain Millwork",
      "line": "WG-1866 primed MDF base, 9/16 x 5-1/4 in.",
      "price": 2.46,
      "per": "lf",
      "coverage": "8 ft lengths; add 10% waste",
      "url": "https://www.homedepot.com/p/Woodgrain-Millwork-WG-1866-9-16-in-x-5-1-4-in-x-96-in-Primed-MDF-Base-Moulding-10001790/203209462",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "one-piece primed MDF, coped/mitred, nail and fill; painting separate"
    },
    "mid": {
     "low": 7.0,
     "likely": 8.5,
     "high": 10.0,
     "material": {
      "brand": "RESO",
      "line": "RMB-725 primed finger-jointed pine base, 11/16 x 7-1/4 in.",
      "price": 3.2,
      "per": "lf",
      "coverage": "80 lf per 10-pack",
      "url": "https://www.homedepot.com/p/RESO-RMB-725-11-16-in-D-x-7-1-4-in-W-x-96-in-L-Primed-Finger-Joined-Wood-Pine-Baseboard-10-Piece-80-ft-Total-RMB-725-96-10/336677279",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "taller primed pine base with shoe, scribed to floor"
    },
    "high": {
     "low": 11.0,
     "likely": 14.0,
     "high": 18.0,
     "material": {
      "brand": "Kuiken Brothers (millwork yard)",
      "line": "poplar built-up base (1x8 + cap + shoe)",
      "price": 7.0,
      "per": "lf",
      "coverage": "quote",
      "url": "https://www.kuikenbrothers.com/",
      "priceChecked": false
     },
     "laborShare": 0.55,
     "note": "built-up hardwood profile, scribed, glued joints, finish carpenter"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/walls-and-ceilings/install-baseboard",
    "https://match.angi.com/cost/walls-and-ceilings/install-baseboard",
    "https://www.homeserve.com/blog/cost-guide/install-baseboard/"
   ]
  },
  {
   "id": "install-crown",
   "label": "Install crown molding",
   "applies": [
    "perimeter"
   ],
   "unit": "lf",
   "levels": {
    "budget": {
     "low": 6.0,
     "likely": 7.5,
     "high": 9.0,
     "material": {
      "brand": "Alexandria Moulding",
      "line": "primed MDF crown, about 3-5/8 in.",
      "price": 1.75,
      "per": "lf",
      "coverage": "add 15% waste",
      "url": "https://homedepot.com/b/Building-Materials-Moulding-Millwork-Moulding-Baseboard/525-in/N-5yc1vZcbjpZ12kxZ1z1vep0",
      "priceChecked": false
     },
     "laborShare": 0.7,
     "note": "single-piece MDF crown, 8-9 ft ceiling, painting separate"
    },
    "mid": {
     "low": 9.0,
     "likely": 12.0,
     "high": 15.0,
     "material": {
      "brand": "Woodgrain Millwork",
      "line": "primed finger-jointed pine crown, about 5-1/4 in.",
      "price": 3.5,
      "per": "lf",
      "coverage": "add 15% waste",
      "url": "https://www.homedepot.com/b/Building-Materials-Moulding-Millwork-Moulding-Baseboard/N-5yc1vZcbjp",
      "priceChecked": false
     },
     "laborShare": 0.65,
     "note": "larger profile, coped inside corners, backing where needed"
    },
    "high": {
     "low": 18.0,
     "likely": 25.0,
     "high": 35.0,
     "material": {
      "brand": "Kuiken Brothers (millwork yard)",
      "line": "built-up poplar crown or run plaster cornice",
      "price": 10.0,
      "per": "lf",
      "coverage": "quote",
      "url": "https://www.kuikenbrothers.com/",
      "priceChecked": false
     },
     "laborShare": 0.6,
     "note": "multi-piece built-up crown, high ceilings, finish carpenter or plasterer"
    }
   },
   "sources": [
    "https://homeadvisor.com/cost/walls-and-ceilings/crown-molding-installation",
    "https://www.angi.com/articles/how-much-does-crown-molding-cost.htm",
    "https://bobvila.com/articles/cost-to-install-crown-molding"
   ]
  },
  {
   "id": "paint-door",
   "label": "Paint interior door, both sides, with casing",
   "applies": [
    "door"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 75,
     "likely": 100,
     "high": 130,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Semi-Gloss Enamel",
      "price": 36.0,
      "per": "gal",
      "coverage": "about 400 sf/gal; ~150 lf of 5\" base per qt, 2 coats",
      "url": "https://www.behr.com/consumer/products/interior-paint/premium-plus-interior/premium-plus-interior-semi-gloss-enamel",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "door hung in place, 2 coats both sides and casing"
    },
    "mid": {
     "low": 120,
     "likely": 160,
     "high": 210,
     "material": {
      "brand": "Benjamin Moore",
      "line": "ADVANCE Waterborne Interior Alkyd, Satin",
      "price": 88.99,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/advance-interior-paint-satin-1-gallon-satin-shoes-2159-70/0792/ZWB100000000338435",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "hardware off, sand, fill, prime, 2 coats; edges done"
    },
    "high": {
     "low": 200,
     "likely": 275,
     "high": 375,
     "material": {
      "brand": "Fine Paints of Europe",
      "line": "Eurolux Hollandlac Brilliant (oil enamel)",
      "price": 85.0,
      "per": "qt",
      "coverage": "about 100 sf/qt per coat",
      "url": "https://www.finepaintsofeurope.com/",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "door removed, sanded smooth, 3 brushed coats oil enamel"
    }
   },
   "sources": [
    "https://www.angi.com/articles/cost-to-paint-exterior-door.htm",
    "https://homeguide.com/costs/cost-to-paint-a-door",
    "https://www.fixr.com/costs/paint-interior-door"
   ]
  },
  {
   "id": "replace-interior-door",
   "label": "Replace interior pre-hung door",
   "applies": [
    "door"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 300,
     "likely": 400,
     "high": 500,
     "material": {
      "brand": "Masonite",
      "line": "2-panel square-top hollow-core primed pre-hung (30x80)",
      "price": 156.0,
      "per": "ea",
      "url": "https://homedepot.com/b/Doors-Windows-Interior-Doors-Prehung-Doors/Masonite/Textured/N-5yc1vZc5ijZyqZ12l3Z1z18clc",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "hollow-core pre-hung, reuse or simple casing, hardware separate"
    },
    "mid": {
     "low": 550,
     "likely": 700,
     "high": 900,
     "material": {
      "brand": "Masonite",
      "line": "Winslow 3-panel solid-core molded composite pre-hung",
      "price": 191.58,
      "per": "ea",
      "url": "https://www.arbor-home.com/collections/all/products/masonite-winslow-24-in-x-80-in-3-panel-craftsman-solid-core-molded-composite-right-hand-single-prehung-interior-door",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "solid-core pre-hung, new casing both sides, shim and plane"
    },
    "high": {
     "low": 1200,
     "likely": 1600,
     "high": 2200,
     "material": {
      "brand": "TruStile",
      "line": "stile-and-rail MDF or wood door, pre-hung by dealer",
      "price": 900.0,
      "per": "ea",
      "coverage": "dealer quote",
      "url": "https://www.trustile.com/",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "custom-size stile-and-rail door, new jamb and casing, finish carpenter"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/doors-and-windows/interior-door",
    "https://www.fixr.com/costs/install-interior-door",
    "https://handoff.ai/construction-costs/install-prehung-door"
   ]
  },
  {
   "id": "replace-door-hardware",
   "label": "Replace door lever set",
   "applies": [
    "door"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 70,
     "likely": 90,
     "high": 115,
     "material": {
      "brand": "Schlage",
      "line": "F10 Latitude passage lever",
      "price": 34.17,
      "per": "ea",
      "url": "https://www.build.com/schlage-f10-lat/s503198",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "passage or privacy lever into existing bore"
    },
    "mid": {
     "low": 180,
     "likely": 220,
     "high": 270,
     "material": {
      "brand": "Emtek",
      "line": "Stuttgart passage lever set, Brass Modern",
      "price": 138.4,
      "per": "ea",
      "url": "https://build.com/door-levers/c108545",
      "priceChecked": true
     },
     "laborShare": 0.35,
     "note": "solid brass lever and rose, may need latch/strike adjustment"
    },
    "high": {
     "low": 500,
     "likely": 600,
     "high": 750,
     "material": {
      "brand": "Rocky Mountain Hardware",
      "line": "bronze passage lever set",
      "price": 450.0,
      "per": "ea",
      "coverage": "dealer quote",
      "url": "https://www.rockymountainhardware.com/",
      "priceChecked": false
     },
     "laborShare": 0.2,
     "note": "cast bronze, may need new latch, rose alignment and strike mortise"
    }
   },
   "sources": [
    "https://www.airtasker.com/us/costs/door-knob-installation/doorknob-installation-cost",
    "https://www.angi.com/articles/door-knob-vs-handle.htm",
    "https://homegrail.com/doorknob-replacements/"
   ]
  },
  {
   "id": "paint-window",
   "label": "Paint window sash and casing (interior)",
   "applies": [
    "window"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 60,
     "likely": 80,
     "high": 100,
     "material": {
      "brand": "Behr",
      "line": "Premium Plus Interior Semi-Gloss Enamel",
      "price": 36.0,
      "per": "gal",
      "coverage": "about 400 sf/gal; ~150 lf of 5\" base per qt, 2 coats",
      "url": "https://www.behr.com/consumer/products/interior-paint/premium-plus-interior/premium-plus-interior-semi-gloss-enamel",
      "priceChecked": false
     },
     "laborShare": 0.9,
     "note": "casing and sash faces, 2 coats, minimal scraping"
    },
    "mid": {
     "low": 90,
     "likely": 125,
     "high": 165,
     "material": {
      "brand": "Benjamin Moore",
      "line": "ADVANCE Waterborne Interior Alkyd, Satin",
      "price": 88.99,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/advance-interior-paint-satin-1-gallon-satin-shoes-2159-70/0792/ZWB100000000338435",
      "priceChecked": true
     },
     "laborShare": 0.9,
     "note": "scrape, sand, glaze touch-up, prime, 2 coats; sash freed"
    },
    "high": {
     "low": 150,
     "likely": 210,
     "high": 280,
     "material": {
      "brand": "Fine Paints of Europe",
      "line": "Eurolux Hollandlac Brilliant (oil enamel)",
      "price": 85.0,
      "per": "qt",
      "coverage": "about 100 sf/qt per coat",
      "url": "https://www.finepaintsofeurope.com/",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "deglossed or stripped, reglazed where needed, 3 brushed coats; lead-safe practices if pre-1978"
    }
   },
   "sources": [
    "https://homeguide.com/costs/cost-to-paint-trim-baseboards",
    "https://remodeling.com/?p=40833"
   ]
  },
  {
   "id": "replace-window",
   "label": "Replace window (double-hung)",
   "applies": [
    "window"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 550,
     "likely": 750,
     "high": 950,
     "material": {
      "brand": "Pella",
      "line": "150 Series vinyl replacement double-hung",
      "price": 350.0,
      "per": "ea",
      "coverage": "price by size at Lowe's",
      "url": "https://www.lowes.com/pd/Pella-150-Series-Replacement-30-1-2-in-x-61-1-2-in-x-3-1-4-in-Jamb-White-Vinyl-Dual-pane-Double-Hung-Window-Full-Screen-Included/1002641132",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "vinyl insert into existing frame, interior stops reused"
    },
    "mid": {
     "low": 1100,
     "likely": 1400,
     "high": 1800,
     "material": {
      "brand": "Andersen",
      "line": "400 Series Woodwright double-hung insert",
      "price": 700.0,
      "per": "ea",
      "coverage": "dealer quote; Home Depot shows 400 Series tilt-wash at $436-609",
      "url": "https://www.andersenwindows.com/windows-and-doors/windows/single-hung-and-double-hung-windows/400-series-woodwright-double-hung-window",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "wood interior / clad exterior insert, new interior stops"
    },
    "high": {
     "low": 2000,
     "likely": 2600,
     "high": 3500,
     "material": {
      "brand": "Marvin",
      "line": "Ultimate Double Hung G2 (clad wood)",
      "price": 1350.0,
      "per": "ea",
      "coverage": "dealer quote",
      "url": "https://www.marvin.com/",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "premium clad-wood insert or full-frame, simulated divided lites, interior trim restored"
    }
   },
   "sources": [
    "https://www.ecowatch.com/windows/replacement/cost",
    "https://angi.com/articles/how-much-cost-wood-windows.htm",
    "https://todayshomeowner.com/windows/cost/window-replacement-cost/"
   ]
  },
  {
   "id": "paint-cabinet-front",
   "label": "Paint cabinet door or drawer front (with box face)",
   "applies": [
    "cabinet"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 60,
     "likely": 75,
     "high": 95,
     "material": {
      "brand": "Benjamin Moore (INSL-X)",
      "line": "Cabinet Coat urethane acrylic enamel",
      "price": 65.0,
      "per": "gal",
      "coverage": "about 350 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "clean, scuff, bonding primer, 2 brushed/rolled coats; boxes faces included"
    },
    "mid": {
     "low": 90,
     "likely": 115,
     "high": 140,
     "material": {
      "brand": "Benjamin Moore",
      "line": "ADVANCE Waterborne Interior Alkyd, Satin",
      "price": 88.99,
      "per": "gal",
      "coverage": "350-400 sf/gal",
      "url": "https://www.benjaminmoore.com/en-us/product/advance-interior-paint-satin-1-gallon-satin-shoes-2159-70/0792/ZWB100000000338435",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "doors removed and sprayed, frames brushed, 2 coats over primer"
    },
    "high": {
     "low": 140,
     "likely": 170,
     "high": 210,
     "material": {
      "brand": "Sherwin-Williams",
      "line": "Emerald Urethane Trim Enamel (sprayed)",
      "price": 95.0,
      "per": "gal",
      "coverage": "about 350 sf/gal",
      "url": "https://www.sherwin-williams.com/",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "off-site spray booth, grain fill, 3 coats, interiors and edges"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/paint-kitchen-cabinets",
    "https://certapro.com/blog/interior/how-much-does-kitchen-cabinet-painting-cost/",
    "https://match.angi.com/cost/painting/paint-a-small-project"
   ]
  },
  {
   "id": "replace-cabinet-front",
   "label": "Replace cabinet door or drawer front",
   "applies": [
    "cabinet"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 110,
     "likely": 150,
     "high": 190,
     "material": {
      "brand": "CabinetNow",
      "line": "unfinished shaker replacement door",
      "price": 65.77,
      "per": "ea",
      "url": "https://cabinetnow.com/how-to/semihandmade-nieu-and-cabinetnow-price-and-finish-comparison-for-ikea-replacement-cabinet-doors",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "stock-size shaker front, painted on site, existing hinges reused"
    },
    "mid": {
     "low": 220,
     "likely": 280,
     "high": 350,
     "material": {
      "brand": "Semihandmade",
      "line": "DIY Shaker door (maple frame, MDF panel)",
      "price": 89.0,
      "per": "ea",
      "coverage": "unfinished; factory-painted options cost more",
      "url": "https://www.semihandmade.com/products/diy-shaker-door-for-akurum-grouped",
      "priceChecked": true
     },
     "laborShare": 0.4,
     "note": "custom-size fronts, finished, new soft-close hinges"
    },
    "high": {
     "low": 400,
     "likely": 520,
     "high": 700,
     "material": {
      "brand": "Local cabinet shop",
      "line": "custom painted inset/shaker front, conversion varnish",
      "price": 300.0,
      "per": "ea",
      "coverage": "local quote",
      "url": "https://www.homewyse.com/services/cost_to_replace_cabinet_doors.html",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "made-to-measure fronts, sprayed finish, new hinges, adjust reveals"
    }
   },
   "sources": [
    "https://inchcalculator.com/cabinet-doors-cost-guide",
    "https://www.homewyse.com/services/cost_to_replace_cabinet_doors.html",
    "https://www.angi.com/articles/new-cabinet-doors-cost.htm"
   ]
  },
  {
   "id": "new-cabinets",
   "label": "New cabinets (base + wall)",
   "applies": [
    "cabinet-run"
   ],
   "unit": "lf",
   "levels": {
    "budget": {
     "low": 200,
     "likely": 275,
     "high": 350,
     "material": {
      "brand": "Hampton Bay (Home Depot)",
      "line": "Shaker Satin White stock assembled base, 30 in. (KB30-SSW)",
      "price": 291.78,
      "per": "ea (30 in. wide)",
      "url": "https://www.dkhardware.com/hampton-bay-kb30-ssw-shaker-satin-white-stock-assembled-base-kitchen-cabinet-with-ball-bearing-drawer-glides-30-in-x-34-product-3914825.html",
      "priceChecked": true
     },
     "laborShare": 0.35,
     "note": "stock sizes with fillers, basic install; counter separate"
    },
    "mid": {
     "low": 450,
     "likely": 600,
     "high": 800,
     "material": {
      "brand": "KraftMaid",
      "line": "semi-custom framed cabinetry",
      "price": 350.0,
      "per": "lf",
      "coverage": "dealer quote",
      "url": "https://www.kraftmaid.com/",
      "priceChecked": false
     },
     "laborShare": 0.3,
     "note": "semi-custom sizes and finishes, crown/light rail, soft-close"
    },
    "high": {
     "low": 900,
     "likely": 1200,
     "high": 1700,
     "material": {
      "brand": "Crown Point Cabinetry",
      "line": "custom inset cabinetry",
      "price": 900.0,
      "per": "lf",
      "coverage": "quote",
      "url": "https://www.crown-point.com/",
      "priceChecked": false
     },
     "laborShare": 0.25,
     "note": "custom inset or local shop, scribed panels, full-height uppers"
    }
   },
   "sources": [
    "https://homeadvisor.com/cost/cabinets-and-countertops/install-cabinets",
    "https://origin-2.fixr.com/costs/cabinets-installation",
    "https://www.lawnstarter.com/blog/?p=76448"
   ]
  },
  {
   "id": "cabinet-pull",
   "label": "Install cabinet pull or knob",
   "applies": [
    "cabinet"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 10,
     "likely": 13,
     "high": 17,
     "material": {
      "brand": "Amerock",
      "line": "Appoint 5-1/16 in. bar pull",
      "price": 7.92,
      "per": "ea",
      "url": "https://homedepot.com/p/Amerock-Appoint-5-1-16-in-128mm-Traditional-Oil-Rubbed-Bronze-Bar-Cabinet-Pull-BP36760ORB/313761552",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "drill with jig, standard spacing"
    },
    "mid": {
     "low": 25,
     "likely": 35,
     "high": 45,
     "material": {
      "brand": "Rejuvenation",
      "line": "solid brass cabinet pull",
      "price": 30.0,
      "per": "ea",
      "url": "https://www.rejuvenation.com/",
      "priceChecked": false
     },
     "laborShare": 0.25,
     "note": "solid brass pull, filling old holes if spacing changes"
    },
    "high": {
     "low": 75,
     "likely": 110,
     "high": 160,
     "material": {
      "brand": "Rocky Mountain Hardware",
      "line": "cast bronze cabinet pull",
      "price": 95.0,
      "per": "ea",
      "coverage": "dealer quote",
      "url": "https://www.rockymountainhardware.com/",
      "priceChecked": false
     },
     "laborShare": 0.15,
     "note": "cast bronze/handmade hardware, back-plates, careful layout"
    }
   },
   "sources": [
    "https://www.countbricks.com/post/cabinet-hardware-installation-cost",
    "https://bobvila.com/articles/cost-to-install-cabinet-hardware"
   ]
  },
  {
   "id": "counter-quartz",
   "label": "Quartz countertop",
   "applies": [
    "counter"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 50,
     "likely": 60,
     "high": 70,
     "material": {
      "brand": "MSI",
      "line": "Q Premium Natural Quartz, entry colours (e.g. Iced White)",
      "price": 18.0,
      "per": "sf (slab)",
      "coverage": "slab about 55 sf; wholesale $670-1,330/slab",
      "url": "https://www.msisurfaces.com/blogs/post/2025/09/01/how-much-should-you-expect-to-pay-for-quartz-countertops.aspx",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "3 cm, eased edge, one undermount sink cutout, standard template"
    },
    "mid": {
     "low": 70,
     "likely": 85,
     "high": 100,
     "material": {
      "brand": "Caesarstone",
      "line": "standard/mid colour series quartz",
      "price": 45.0,
      "per": "sf (slab)",
      "url": "https://slabwise.com/guides/caesarstone-quartz-countertops",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "brand-name quartz, mitred or eased edge, cooktop cutout"
    },
    "high": {
     "low": 100,
     "likely": 125,
     "high": 160,
     "material": {
      "brand": "Caesarstone",
      "line": "premium veined (e.g. Statuario Maximus, Calacatta)",
      "price": 70.0,
      "per": "sf (slab)",
      "url": "https://slabwise.com/guides/caesarstone-statuario-maximus-kitchen-countertop-sample",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "book-matched veining, mitred waterfall edges, full-height splash extra"
    }
   },
   "sources": [
    "https://inchcalculator.com/new-countertop-cost-guide",
    "https://www.fixr.com/costs/install-quartz-countertop",
    "https://slabwise.com/guides/quartz-countertop-per-square-foot-cost"
   ]
  },
  {
   "id": "counter-stone",
   "label": "Natural stone countertop",
   "applies": [
    "counter"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 45,
     "likely": 60,
     "high": 75,
     "material": {
      "brand": "MSI",
      "line": "Level 1 granite (e.g. Luna Pearl)",
      "price": 25.0,
      "per": "sf (slab)",
      "url": "https://www.msisurfaces.com/",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "common granite, 3 cm, eased edge, sealed"
    },
    "mid": {
     "low": 75,
     "likely": 95,
     "high": 120,
     "material": {
      "brand": "MSI",
      "line": "Carrara White marble (honed)",
      "price": 40.0,
      "per": "sf (slab)",
      "url": "https://www.homeadvisor.com/r/marble-vs-granite",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "Carrara marble or common quartzite, honed, sealed"
    },
    "high": {
     "low": 130,
     "likely": 170,
     "high": 230,
     "material": {
      "brand": "Calacatta Gold marble / Taj Mahal quartzite",
      "line": "premium natural slab",
      "price": 150.0,
      "per": "sf (slab)",
      "coverage": "stone yard quote",
      "url": "https://www.homeadvisor.com/r/marble-vs-granite",
      "priceChecked": false
     },
     "laborShare": 0.3,
     "note": "rare slab, book-matched, mitred edges, impregnating sealer"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/marble-countertops",
    "https://www.homeadvisor.com/r/marble-vs-granite",
    "https://slabwise.com/guides/marble-granite-slabs-countertop-fabrication-installation"
   ]
  },
  {
   "id": "replace-light-fixture",
   "label": "Replace light fixture",
   "applies": [
    "fixture",
    "light"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 150,
     "likely": 200,
     "high": 260,
     "material": {
      "brand": "Hampton Bay",
      "line": "Eastpoint 13 in. 2-light flush mount",
      "price": 54.97,
      "per": "ea",
      "url": "https://homedepot.com/b/Lighting-Flush-Mount-Ceiling-Lights/Incandescent/Bulk-Pricing/N-5yc1vZc7nkZbwo6kZ1z1ajb6",
      "priceChecked": true
     },
     "laborShare": 0.7,
     "note": "swap on existing box and wiring, licensed electrician"
    },
    "mid": {
     "low": 400,
     "likely": 550,
     "high": 750,
     "material": {
      "brand": "Rejuvenation",
      "line": "Rose City pendant with vintage shade",
      "price": 219.0,
      "per": "ea",
      "url": "https://rejuvenation.com/products/rose-city-pendant-with-vintage-art-deco-geometric-schoolhouse-shade",
      "priceChecked": true
     },
     "laborShare": 0.4,
     "note": "pendant or decorative fixture, fixture-rated box check, dimmer compatible"
    },
    "high": {
     "low": 900,
     "likely": 1300,
     "high": 2000,
     "material": {
      "brand": "Visual Comfort & Co.",
      "line": "designer pendant (e.g. Largo XL)",
      "price": 599.0,
      "per": "ea",
      "url": "https://www.houzz.com/products/pendant-lighting/manufacturer--plc_lighting--visualcomfort",
      "priceChecked": true
     },
     "laborShare": 0.3,
     "note": "designer fixture, heavy or multi-light, bracing and height setting"
    }
   },
   "sources": [
    "https://match.angi.com/cost/electrical/install-a-lighting-fixture",
    "https://www.homeadvisor.com/cost/electrical/repair-a-lighting-fixture",
    "https://homeguide.com/costs/cost-to-replace-or-repair-a-light-fixture"
   ],
   "group": "Lighting"
  },
  {
   "id": "replace-device",
   "label": "Replace outlet or switch, with cover plate",
   "applies": [
    "fixture"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 75,
     "likely": 100,
     "high": 130,
     "material": {
      "brand": "Leviton",
      "line": "Decora 15A tamper-resistant duplex receptacle",
      "price": 3.2,
      "per": "ea",
      "coverage": "plate about $1-3",
      "url": "https://www.walmart.com/ip/168390309",
      "priceChecked": true
     },
     "laborShare": 0.9,
     "note": "like-for-like device and plastic plate; per-unit price falls when several are done in one visit"
    },
    "mid": {
     "low": 140,
     "likely": 175,
     "high": 220,
     "material": {
      "brand": "Lutron",
      "line": "Caseta smart dimmer",
      "price": 53.99,
      "per": "ea",
      "url": "https://www.casetawireless.com/",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "dimmer or USB/GFCI device, screwless plate"
    },
    "high": {
     "low": 230,
     "likely": 300,
     "high": 400,
     "material": {
      "brand": "Forbes & Lomax",
      "line": "unlacquered brass toggle switch with plate",
      "price": 150.0,
      "per": "ea",
      "url": "https://www.forbesandlomax.com/",
      "priceChecked": false
     },
     "laborShare": 0.4,
     "note": "designer toggle/plate, deep box or mud-ring adjustment"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/electrical/install-a-switch/",
    "https://www.hometips.com/repair-fix/electrical-outlet-repair-cost.html",
    "https://www.fixr.com/costs/install-light-switch"
   ],
   "group": "Lighting"
  },
  {
   "id": "remove-object",
   "label": "Remove / demolish an object",
   "applies": [
    "object"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 40,
     "likely": 75,
     "high": 125,
     "material": null,
     "laborShare": 1.0,
     "note": "small item (shelf, accessory, small fixture), patch holes, bagged disposal"
    },
    "mid": {
     "low": 75,
     "likely": 125,
     "high": 200,
     "material": null,
     "laborShare": 1.0,
     "note": "mid item (vanity, built-in, appliance), cap utilities, haul away"
    },
    "high": {
     "low": 150,
     "likely": 250,
     "high": 400,
     "material": null,
     "laborShare": 1.0,
     "note": "large or careful item (built-in cabinetry, salvage for reuse), protect finishes"
    }
   },
   "sources": [
    "https://fixr.com/costs/handyman",
    "https://www.housecallpro.com/resources/how-to-price-handyman-jobs/"
   ]
  },
  {
   "id": "reinstall-object",
   "label": "Reinstall an object",
   "applies": [
    "object"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 50,
     "likely": 90,
     "high": 150,
     "material": null,
     "laborShare": 1.0,
     "note": "rehang or reset small item on existing fixings"
    },
    "mid": {
     "low": 90,
     "likely": 150,
     "high": 250,
     "material": null,
     "laborShare": 1.0,
     "note": "reset mid-size item, new fixings, level and scribe"
    },
    "high": {
     "low": 200,
     "likely": 325,
     "high": 500,
     "material": null,
     "laborShare": 1.0,
     "note": "reinstall large or delicate item, reconnect services by trade"
    }
   },
   "sources": [
    "https://fixr.com/costs/handyman",
    "https://www.housecallpro.com/resources/how-to-price-handyman-jobs/"
   ]
  },
  {
   "id": "hang-drywall-walls",
   "label": "Hang and finish drywall on walls",
   "applies": [
    "wall"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 1.75,
     "likely": 2.4,
     "high": 3.25,
     "material": {
      "brand": "USG Sheetrock",
      "line": "UltraLight Panels 1/2 in. x 4 ft. x 8 ft. (model 14113411708)",
      "price": 15.58,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.homedepot.com/b/USG-Sheetrock-Brand/N-5yc1vZomd",
      "priceChecked": false
     },
     "laborShare": 0.75,
     "note": "new 1/2 in. lightweight board on existing framing, screwed, taped, 3 coats to Level 4, sanded, one coat drywall primer; not painted"
    },
    "mid": {
     "low": 2.4,
     "likely": 3.1,
     "high": 4.0,
     "material": {
      "brand": "Gold Bond (National Gypsum)",
      "line": "PURPLE XP 1/2 in. x 4 ft. x 8 ft. mold- and moisture-resistant (model 50001464)",
      "price": 16.97,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.lowes.com/pd/Gold-Bond-Common-1-2-in-x-4-ft-x-8-ft-Actual-0-5-in-x-4-ft-x-8-ft-PURPLE-XP-Drywall-Panel/1002062128",
      "priceChecked": false
     },
     "laborShare": 0.75,
     "note": "Level 4 with better board: mold/moisture-resistant board in baths, kitchens and laundry, 5/8 in. Type X where code needs a fire separation, paper-faced metal corner bead, high-build primer; not painted"
    },
    "high": {
     "low": 3.5,
     "likely": 4.5,
     "high": 6.0,
     "material": {
      "brand": "CertainTeed",
      "line": "M2Tech 1/2 in. x 4 ft. x 8 ft. moisture- and mold-resistant, Level 5 skim",
      "price": 27.99,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.lowes.com/pd/CertainTeed-Common-1-2-in-x-4-ft-x-8-ft-Actual-0-5-in-x-4-ft-x-8-ft-Drywall-Panel/1002992798",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "Level 5: Level 4 plus a full skim coat (or spray primer-surfacer) over the whole face, checked under raking light, primed; for flat paint, glossy finishes and long sight lines; not painted"
    }
   },
   "sources": [
    "https://www.homeguide.com/costs/drywall-installation-cost",
    "https://www.homewyse.com/services/cost_to_install_drywall.html",
    "https://www.fixr.com/costs/drywall-ceiling-installation",
    "https://inchcalculator.com/drywall-cost-guide"
   ],
   "group": "Drywall"
  },
  {
   "id": "hang-drywall-ceiling",
   "label": "Hang and finish drywall on ceilings",
   "applies": [
    "ceiling"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 2.1,
     "likely": 2.9,
     "high": 3.9,
     "material": {
      "brand": "USG Sheetrock",
      "line": "UltraLight Panels 1/2 in. x 4 ft. x 8 ft. (rated sag-resistant for ceilings)",
      "price": 15.58,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.homedepot.com/b/USG-Sheetrock-Brand/N-5yc1vZomd",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "new 1/2 in. sag-resistant board overhead with a lift, screwed, taped, Level 4, primed; not painted; ceilings up to about 9 ft"
    },
    "mid": {
     "low": 2.8,
     "likely": 3.7,
     "high": 4.8,
     "material": {
      "brand": "Gold Bond (National Gypsum)",
      "line": "PURPLE XP 1/2 in. x 4 ft. x 8 ft. mold- and moisture-resistant (model 50001464)",
      "price": 16.97,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.lowes.com/pd/Gold-Bond-Common-1-2-in-x-4-ft-x-8-ft-Actual-0-5-in-x-4-ft-x-8-ft-PURPLE-XP-Drywall-Panel/1002062128",
      "priceChecked": false
     },
     "laborShare": 0.8,
     "note": "Level 4 with better board: mold/moisture-resistant board in wet rooms, 5/8 in. Type X under occupied floors or where code requires, primed; not painted"
    },
    "high": {
     "low": 4.0,
     "likely": 5.4,
     "high": 7.25,
     "material": {
      "brand": "CertainTeed",
      "line": "M2Tech 1/2 in. x 4 ft. x 8 ft. moisture- and mold-resistant, Level 5 skim",
      "price": 27.99,
      "per": "sheet",
      "coverage": "32 sf/sheet",
      "url": "https://www.lowes.com/pd/CertainTeed-Common-1-2-in-x-4-ft-x-8-ft-Actual-0-5-in-x-4-ft-x-8-ft-Drywall-Panel/1002992798",
      "priceChecked": false
     },
     "laborShare": 0.85,
     "note": "Level 5 ceiling: full skim coat for downlight and window glare, raking-light check, primed; not painted"
    }
   },
   "sources": [
    "https://homeguide.com/costs/drywall-ceiling-cost",
    "https://www.fixr.com/costs/drywall-ceiling-installation",
    "https://www.homewyse.com/services/cost_to_install_drywall.html"
   ],
   "group": "Drywall"
  },
  {
   "id": "drywall-repair",
   "label": "Repair drywall or plaster",
   "applies": [
    "wall",
    "ceiling"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 8.0,
     "likely": 12.0,
     "high": 18.0,
     "material": {
      "brand": "USG Sheetrock",
      "line": "Easy Sand 45 setting-type joint compound, 18 lb bag",
      "price": 20.0,
      "per": "bag",
      "coverage": "about 50-80 sf of patching per bag",
      "url": "https://www.usg.com/content/usgcom/en/products/walls/joint-compounds-and-textures.html",
      "priceChecked": false
     },
     "laborShare": 0.9,
     "note": "cut out and replace damaged board in sections of about 5-30 sf, tape, Level 4 feather to match, spot prime; small patches under about 4 sf carry a $150-250 visit minimum"
    },
    "mid": {
     "low": 12.0,
     "likely": 18.0,
     "high": 28.0,
     "material": {
      "brand": "USG Sheetrock",
      "line": "Easy Sand 45 setting compound plus Sheetrock UltraLight board",
      "price": 20.0,
      "per": "bag",
      "coverage": "about 50-80 sf of patching per bag",
      "url": "https://www.usg.com/content/usgcom/en/products/walls/joint-compounds-and-textures.html",
      "priceChecked": false
     },
     "laborShare": 0.9,
     "note": "patch, feather wide to hide the repair, match existing texture or plaster skim, prime the whole repaired bay"
    },
    "high": {
     "low": 20.0,
     "likely": 30.0,
     "high": 50.0,
     "material": {
      "brand": "USG Sheetrock",
      "line": "Sheetrock Brand Durabond / Easy Sand with Level 5 skim of the repaired bay",
      "price": 22.0,
      "per": "bag",
      "coverage": "about 40-60 sf per bag",
      "url": "https://www.usg.com/content/usgcom/en/products/walls/joint-compounds-and-textures.html",
      "priceChecked": false
     },
     "laborShare": 0.92,
     "note": "repair old plaster or high-visibility surfaces: re-secure or replace lath, base and finish coats or Level 5 skim of the bay so the patch disappears under raking light"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/repair-drywall",
    "https://homeguide.com/costs/drywall-repair-cost",
    "https://www.homeadvisor.com/cost/walls-and-ceilings/repair-drywall"
   ],
   "group": "Drywall"
  },
  {
   "id": "demo-drywall",
   "label": "Remove drywall or plaster and haul away",
   "applies": [
    "wall",
    "ceiling"
   ],
   "unit": "sf",
   "levels": {
    "budget": {
     "low": 1.0,
     "likely": 1.5,
     "high": 2.25,
     "material": null,
     "laborShare": 0.8,
     "note": "remove drywall from walls or ceilings, pull fasteners, bag debris, dumpster or haul-away; asbestos and lead testing excluded"
    },
    "mid": {
     "low": 2.25,
     "likely": 3.0,
     "high": 4.25,
     "material": null,
     "laborShare": 0.8,
     "note": "remove plaster and lath (wood or metal), heavier debris and more haul loads, floor protection, broom clean; testing excluded"
    },
    "high": {
     "low": 4.25,
     "likely": 5.75,
     "high": 8.0,
     "material": null,
     "laborShare": 0.85,
     "note": "plaster or drywall removal with plastic dust containment and negative air, bagged carry-out through common halls and service elevator under building rules, daily clean-up; abatement excluded"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/interior-demolition",
    "https://www.homewyse.com/services/cost_to_remove_lath_and_plaster.html",
    "https://homeguide.com/costs/cost-of-plastering-walls",
    "https://www.countbricks.com/post/how-much-does-it-cost-to-remove-sheetrock"
   ],
   "group": "Drywall"
  },
  {
   "id": "recessed-light-new",
   "label": "Add a recessed light",
   "applies": [
    "ceiling",
    "light"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 200,
     "likely": 275,
     "high": 375,
     "material": {
      "brand": "Juno (Acuity)",
      "line": "Contractor Select WF6 6 in. canless wafer, selectable CCT (WF6 SWW5 90CRI)",
      "price": 22.53,
      "per": "ea",
      "url": "https://www.homedepot.com/p/Juno-Contractor-Select-WF6-ADJ-SWW5-6-in-Selectable-CCT-Ultra-Slim-Canless-Integrated-LED-White-Recessed-Light-Trim-WF6-ADJ-SWW5-90CRI-MW-M6/325999848",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "can-less LED wafer cut into an existing ceiling, new cable fished from a nearby light or switch box, switch leg, ceiling patch around the cut; existing circuit has capacity"
    },
    "mid": {
     "low": 325,
     "likely": 450,
     "high": 600,
     "material": {
      "brand": "WAC Lighting",
      "line": "Aether 3.5 in. round adjustable trim with remodel housing (R3ARAT)",
      "price": 218.65,
      "per": "ea",
      "url": "https://lightingnewyork.com/product/lighting/ceiling-lights/recessed/wac-lighting-aether-recessed-r3arat-f827-bn/1761643.html",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "small-aperture adjustable downlight (WAC Aether, or Juno/Halo housing with a trim), remodel housing, new wiring and switch leg, ceiling patch; 90+ CRI, dims to low levels"
    },
    "high": {
     "low": 600,
     "likely": 850,
     "high": 1200,
     "material": {
      "brand": "Visual Comfort Architectural (Element by Tech Lighting)",
      "line": "Entra 3 in. LED remodel housing with flangeless trim",
      "price": 262.0,
      "per": "ea",
      "url": "https://build.com/visual-comfort-en3s-lo930aai/s1919517",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "architectural downlight (Element/Entra, DMF M Series, Lucifer or Kelvix), flangeless mud-in trim set into a skim-coated ceiling, new wiring, careful patch; Lucifer and Kelvix are priced by quote"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/electrical/recessed-lighting-installation",
    "https://fixr.com/costs/recessed-lighting-installation",
    "https://www.inchcalculator.com/recessed-lighting-cost-guide/",
    "https://homeguide.com/costs/cost-to-install-recessed-lighting"
   ],
   "group": "Lighting"
  },
  {
   "id": "recessed-light-replace",
   "label": "Replace a recessed light",
   "applies": [
    "light"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 90,
     "likely": 125,
     "high": 175,
     "material": {
      "brand": "Halo (Cooper Lighting)",
      "line": "LT560 5/6 in. LED retrofit baffle trim (LT560WH6930)",
      "price": 14.78,
      "per": "ea",
      "url": "https://elliottelectric.com/P/Item/ETL/LT560WH6930",
      "priceChecked": true
     },
     "laborShare": 0.85,
     "note": "LED retrofit trim screwed into the existing can's socket, no ceiling work; per light when several are done in one visit"
    },
    "mid": {
     "low": 175,
     "likely": 250,
     "high": 350,
     "material": {
      "brand": "Juno (Acuity)",
      "line": "Contractor Select WF6 6 in. canless wafer (replaces the old housing)",
      "price": 22.53,
      "per": "ea",
      "url": "https://www.homedepot.com/p/Juno-Contractor-Select-WF6-ADJ-SWW5-6-in-Selectable-CCT-Ultra-Slim-Canless-Integrated-LED-White-Recessed-Light-Trim-WF6-ADJ-SWW5-90CRI-MW-M6/325999848",
      "priceChecked": true
     },
     "laborShare": 0.8,
     "note": "remove the old can, fit a new can-less wafer or new housing and trim in the same hole, small patch where the hole size changes"
    },
    "high": {
     "low": 450,
     "likely": 650,
     "high": 950,
     "material": {
      "brand": "Visual Comfort Architectural (Element by Tech Lighting)",
      "line": "Entra 3 in. LED remodel housing with trim",
      "price": 262.0,
      "per": "ea",
      "url": "https://build.com/visual-comfort-en3s-lo930aai/s1919517",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "remove the old can, fit a small-aperture architectural remodel housing, patch the oversized hole and refinish that area of ceiling"
    }
   },
   "sources": [
    "https://fixr.com/costs/recessed-lighting-installation",
    "https://homeguide.com/costs/cost-to-install-recessed-lighting",
    "https://www.homeyou.com/recessed-lighting-installation-cost"
   ],
   "group": "Lighting"
  },
  {
   "id": "dimmer-switch",
   "label": "Install a dimmer switch",
   "applies": [
    "light",
    "fixture"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 85,
     "likely": 120,
     "high": 175,
     "material": {
      "brand": "Lutron",
      "line": "Diva C.L LED+ dimmer, single-pole/3-way (DVCL-153P)",
      "price": 25.69,
      "per": "ea",
      "url": "https://electricbargainstores.com/collections/dvcl-153p",
      "priceChecked": true
     },
     "laborShare": 0.8,
     "note": "replace a switch with an LED-rated dimmer in the existing box, new wall plate; per device when several are done in one visit"
    },
    "mid": {
     "low": 140,
     "likely": 190,
     "high": 275,
     "material": {
      "brand": "Lutron",
      "line": "Caseta smart dimmer (PD-6WCL)",
      "price": 64.95,
      "per": "ea",
      "url": "https://www.abt.com/Lutron-Caseta-White-Wireless-In-Wall-Dimmer-PD6WCLWH/p/107531.html",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "Caseta smart dimmer, no neutral needed, Claro plate, share of the Smart Bridge ($80-130 once per home) and app set-up; 3-way adds a Pico or companion"
    },
    "high": {
     "low": 300,
     "likely": 450,
     "high": 800,
     "material": {
      "brand": "Lutron",
      "line": "RadioRA 3 Sunnata PRO LED+ dimmer (RRST-PRO-N)",
      "price": 178.07,
      "per": "ea",
      "url": "https://electricbargainstores.com/products/lutron-rrst-pro-n-wh",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "RadioRA 3 Sunnata dimmer by a Lutron dealer, share of the processor and dealer programming; a Palladiom keypad position runs $800-1,500"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/install-light-switch",
    "https://ajlongelectric.com/services/dimmer-switches/alexandria",
    "https://latestcost.com/lutron-lighting-system-cost-product-tier-installation-scope/",
    "https://www.myidealav.com/lutron-radiora-3"
   ],
   "group": "Lighting"
  },
  {
   "id": "replace-toilet",
   "label": "Replace a toilet",
   "applies": [
    "plumbing",
    "toilet"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 400,
     "likely": 550,
     "high": 750,
     "material": {
      "brand": "American Standard",
      "line": "Champion 4 two-piece elongated 1.28 gpf",
      "price": 279.0,
      "per": "ea",
      "url": "https://www.lowes.com/pd/American-Standard-Champion-4-White-Round-Standard-Height-2-piece-Toilet-12-in-Rough-In-Size/3006748",
      "priceChecked": false
     },
     "laborShare": 0.45,
     "note": "remove and haul old toilet, new wax ring or foam seal, closet bolts and braided supply on the existing flange and shut-off; Glacier Bay is about $150 less"
    },
    "mid": {
     "low": 650,
     "likely": 850,
     "high": 1100,
     "material": {
      "brand": "TOTO",
      "line": "Drake two-piece elongated 1.28 gpf, CeFiONtect, universal height (CST776CEFG#01)",
      "price": 409.64,
      "per": "ea",
      "url": "https://www.walmart.com/ip/282706601",
      "priceChecked": true
     },
     "laborShare": 0.4,
     "note": "TOTO Drake plus a soft-close seat, new shut-off valve, flange repair ring if needed"
    },
    "high": {
     "low": 1300,
     "likely": 1800,
     "high": 6000,
     "material": {
      "brand": "Duravit",
      "line": "ME by Starck one-piece rimless toilet with seat",
      "price": 955.0,
      "per": "ea",
      "url": "https://catalog.ultradesigncenter.com/Denver-Colorado/Duravit-2173012085-White-Floor-Mount-One-Piece-Toilet.HTM",
      "priceChecked": true
     },
     "laborShare": 0.3,
     "note": "designer one-piece toilet (Duravit ME by Starck) with careful scribe to the floor; a TOTO Neorest integrated-bidet toilet ($4,000+) sits at the top of the range and needs a GFCI outlet behind it"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/plumbing/install-a-toilet",
    "https://angi.com/articles/how-much-does-toilet-installation-cost.htm",
    "https://www.hometips.com/buying-guides/toilet-replacement-cost.html"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-bath-vanity-sink-faucet",
   "label": "Replace a bathroom vanity, top, sink and faucet",
   "applies": [
    "plumbing",
    "vanity"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 750,
     "likely": 1050,
     "high": 1450,
     "material": {
      "brand": "Glacier Bay",
      "line": "Spa 30 in. vanity with cultured-marble top and integral sink",
      "price": 299.0,
      "per": "ea",
      "url": "https://www.homedepot.com/b/Bath-Bathroom-Vanities/N-5yc1vZcfv3",
      "priceChecked": false
     },
     "laborShare": 0.5,
     "note": "30 in. stock vanity with integral top and sink, basic single-handle faucet, new P-trap and supplies to existing rough-in, haul old vanity"
    },
    "mid": {
     "low": 1500,
     "likely": 2100,
     "high": 2900,
     "material": {
      "brand": "Kohler",
      "line": "Winnow 30 in. vanity with sink and quartz top (33578-ASB)",
      "price": 719.39,
      "per": "ea",
      "url": "https://www.kohler.com/en/products/vanities/shop-vanities/winnow-30-bathroom-vanity-cabinet-w-sink-and-quartz-top-33578-asb",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "30-36 in. quality vanity with quartz top and undermount sink, Kohler or Moen faucet ($250-450), new shut-offs, scribe to wall"
    },
    "high": {
     "low": 4500,
     "likely": 6500,
     "high": 9500,
     "material": {
      "brand": "Waterworks",
      "line": "Henry one-hole lavatory faucet with cross handle (HLS401), with a stone-topped vanity",
      "price": 1795.0,
      "per": "ea",
      "url": "https://www.waterworks.com/us_en/henry-one-hole-lavatory-faucet-with-cross-handle-hls401",
      "priceChecked": true
     },
     "laborShare": 0.3,
     "note": "designer or semi-custom vanity with stone top, fireclay or stone sink, Waterworks or Kallista faucet, exposed or polished-nickel trap; layout unchanged"
    }
   },
   "sources": [
    "https://thisoldhouse.com/bathrooms/reviews/bathroom-vanity-replacement-cost",
    "https://angi.com/articles/how-much-should-bathroom-vanity-install-labor-cost.htm",
    "https://www.countbricks.com/post/cost-to-replace-vanity"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-bath-faucet",
   "label": "Replace a bathroom faucet",
   "applies": [
    "plumbing",
    "faucet"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 175,
     "likely": 250,
     "high": 350,
     "material": {
      "brand": "Moen",
      "line": "Adler single-handle bathroom faucet",
      "price": 90.0,
      "per": "ea",
      "url": "https://www.moen.com/products/bathroom-faucets",
      "priceChecked": false
     },
     "laborShare": 0.6,
     "note": "swap faucet and pop-up drain on the existing sink, new supply lines"
    },
    "mid": {
     "low": 450,
     "likely": 600,
     "high": 800,
     "material": {
      "brand": "Kohler",
      "line": "Purist single-handle bathroom sink faucet",
      "price": 450.0,
      "per": "ea",
      "url": "https://www.kohler.com/en/products/bathroom-sink-faucets",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "Kohler Purist or Moen premium line, matching drain, new shut-offs if old ones seize"
    },
    "high": {
     "low": 1800,
     "likely": 2200,
     "high": 2900,
     "material": {
      "brand": "Waterworks",
      "line": "Henry one-hole lavatory faucet with cross handle (HLS401)",
      "price": 1795.0,
      "per": "ea",
      "url": "https://www.waterworks.com/us_en/henry-one-hole-lavatory-faucet-with-cross-handle-hls401",
      "priceChecked": true
     },
     "laborShare": 0.15,
     "note": "Waterworks Henry or Kallista One (about $720-1,200) with matching drain; widespread sets cost more to fit"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/plumbing/cost-to-replace-a-bathroom-faucet",
    "https://www.homeadvisor.com/cost/plumbing/install-a-faucet",
    "https://anytimeplumbing.net/how-much-do-plumbers-charge-to-replace-a-faucet/"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-kitchen-sink",
   "label": "Replace a kitchen sink",
   "applies": [
    "plumbing"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 450,
     "likely": 650,
     "high": 900,
     "material": {
      "brand": "Glacier Bay",
      "line": "33 in. stainless steel drop-in double-bowl sink",
      "price": 180.0,
      "per": "ea",
      "url": "https://www.homedepot.com/b/Kitchen-Kitchen-Sinks/N-5yc1vZarsa",
      "priceChecked": false
     },
     "laborShare": 0.6,
     "note": "same-size stainless drop-in in the existing counter cut-out, new strainers, trap and disposal reconnect"
    },
    "mid": {
     "low": 900,
     "likely": 1250,
     "high": 1700,
     "material": {
      "brand": "Kraus",
      "line": "Standart PRO 32 in. undermount 16-gauge stainless sink",
      "price": 386.0,
      "per": "ea",
      "url": "https://www.houzz.com/products/modern--coastal/kitchen-sinks/manufacturer--kraus",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "undermount stainless (Kraus or Kohler) under the existing stone counter: cut old sink free, new clips and epoxy, sealant, new drain kit; minor cut-out trimming"
    },
    "high": {
     "low": 2400,
     "likely": 3200,
     "high": 4500,
     "material": {
      "brand": "Shaws (Rohl)",
      "line": "Shaker 30 in. fireclay apron-front sink (MS3018)",
      "price": 1374.75,
      "per": "ea",
      "url": "https://Dwell.Com/product/shaws-shaker-30-farmhouse-single-basin-fireclay-kitchen-sink-7526cd56",
      "priceChecked": true
     },
     "laborShare": 0.45,
     "note": "fireclay apron sink (Shaws or Julien): base cabinet front cut down and sink support built, counter cut-out remade by the fabricator, new drain; may not fit every existing counter"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/sink-installation",
    "https://www.countbricks.com/post/cost-to-replace-kitchen-sink",
    "https://www.homeserve.com/blog/cost-guide/undermount-sink-installation/"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-kitchen-faucet",
   "label": "Replace a kitchen faucet",
   "applies": [
    "plumbing"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 275,
     "likely": 375,
     "high": 500,
     "material": {
      "brand": "Moen",
      "line": "Adler single-handle pull-down kitchen faucet",
      "price": 150.0,
      "per": "ea",
      "url": "https://www.moen.com/products/kitchen-faucets",
      "priceChecked": false
     },
     "laborShare": 0.55,
     "note": "swap a single-hole or deck-plate faucet, new supplies"
    },
    "mid": {
     "low": 550,
     "likely": 750,
     "high": 1000,
     "material": {
      "brand": "Delta",
      "line": "Trinsic single-handle pull-out kitchen faucet (4159)",
      "price": 509.0,
      "per": "ea",
      "url": "https://studio41.com/product/delta-faucet-trinsic-single-handle-pull-out-kitchen-faucet/",
      "priceChecked": true
     },
     "laborShare": 0.35,
     "note": "Delta Trinsic or Kohler Purist/Artifacts pull-down, new shut-offs; touch models need a battery or outlet"
    },
    "high": {
     "low": 1900,
     "likely": 2400,
     "high": 3200,
     "material": {
      "brand": "Waterstone",
      "line": "Parche kitchen faucet (3800)",
      "price": 1839.75,
      "per": "ea",
      "url": "https://studio41.com/product/waterstone-waterstone-parche-kitchen-faucet/",
      "priceChecked": true
     },
     "laborShare": 0.2,
     "note": "Waterstone or Perrin & Rowe (lead time 16-20 weeks) bridge or single faucet; extra holes in stone drilled by the fabricator"
    }
   },
   "sources": [
    "https://www.homeadvisor.com/cost/plumbing/install-a-faucet",
    "https://www.homewyse.com/services/cost_to_replace_kitchen_faucet.html",
    "https://www.fixr.com/costs/sink-installation"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-shower-valve-trim",
   "label": "Replace a shower valve and trim",
   "applies": [
    "plumbing",
    "shower"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 450,
     "likely": 700,
     "high": 1000,
     "material": {
      "brand": "Moen",
      "line": "Posi-Temp pressure-balancing valve with trim kit",
      "price": 150.0,
      "per": "ea",
      "url": "https://www.moen.com/products/shower-valves",
      "priceChecked": false
     },
     "laborShare": 0.75,
     "note": "new pressure-balance valve body and trim, opened from the back wall or an access panel, drywall patch; tile untouched"
    },
    "mid": {
     "low": 1300,
     "likely": 1800,
     "high": 2500,
     "material": {
      "brand": "Grohe",
      "line": "Grohtherm single-function 2-handle thermostatic valve trim (24110000) with Rapido SmartBox rough-in",
      "price": 573.0,
      "per": "ea",
      "url": "https://grohe.us/thermostatic-valves-trims/single-function-2-handle-thermostatic-valve-trim/GROHE-BRUSHED-NICKEL-24110EN0",
      "priceChecked": true
     },
     "laborShare": 0.55,
     "note": "thermostatic rough-in and trim, opening through the tile with a small tile patch or trim plate, or from behind with a drywall patch"
    },
    "high": {
     "low": 3500,
     "likely": 5000,
     "high": 7500,
     "material": {
      "brand": "Waterworks",
      "line": "thermostatic valve with volume control and trim (e.g. Henry or Dornbracht equivalent)",
      "price": 3000.0,
      "per": "ea",
      "url": "https://www.waterworks.com/us_en/",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "high-end thermostatic valve with separate volume controls (Waterworks, Dornbracht), wall opened through tile, tile repair by a setter; matching spare tile assumed"
    }
   },
   "sources": [
    "https://www.homeserve.com/blog/cost-guide/shower-valve-replacement",
    "https://www.amenify.com/blog/shower-valve-replacement-cost",
    "https://www.thepricer.org/shower-valve-replacement-cost/"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-bathtub",
   "label": "Replace a bathtub",
   "applies": [
    "plumbing",
    "tub"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 1800,
     "likely": 2600,
     "high": 3600,
     "material": {
      "brand": "American Standard",
      "line": "Princeton enameled steel 60 x 30 in. alcove tub",
      "price": 450.0,
      "per": "ea",
      "url": "https://americanstandardbathing.com/products/american-standard-princeton-pro-steel-60-x-30-inch-above-floor-rough-integral-apron-bathtub-with-left-hand-outlet-1392202",
      "priceChecked": false
     },
     "laborShare": 0.65,
     "note": "remove and haul old alcove tub, set new steel or acrylic tub on mortar, new drain and overflow, patch the bottom course of surround; same size and drain side"
    },
    "mid": {
     "low": 3200,
     "likely": 4300,
     "high": 5800,
     "material": {
      "brand": "Kohler",
      "line": "Villager 60 x 30-1/4 in. cast iron alcove bath (K-716)",
      "price": 808.0,
      "per": "ea",
      "url": "https://studio41.com/product/kohler-villager-60-x-30-1-4-alcove-bath-left-drain/",
      "priceChecked": true
     },
     "laborShare": 0.6,
     "note": "cast iron alcove tub (three-person carry, about 300 lb), old tub broken out, new drain, tile surround repair at the flange"
    },
    "high": {
     "low": 7000,
     "likely": 9500,
     "high": 14000,
     "material": {
      "brand": "Victoria + Albert",
      "line": "freestanding volcanic limestone soaking tub (e.g. Amiata) with floor-mount filler",
      "price": 4500.0,
      "per": "ea",
      "url": "https://www.vandabaths.com/us",
      "priceChecked": false
     },
     "laborShare": 0.35,
     "note": "freestanding soaking tub with floor-mount filler ($800-3,400), drain moved in the floor, supplies through the floor, floor patch; alcove-to-freestanding build-back of the wall is extra"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/install-or-replace-bathtub",
    "https://www.homeadvisor.com/cost/plumbing/install-a-bathtub",
    "https://www.homeyou.com/bathtub-replacement-cost",
    "https://www.blockrenovation.com/guides/the-real-cost-of-installing-a-freestanding-tub"
   ],
   "group": "Plumbing"
  },
  {
   "id": "replace-dishwasher",
   "label": "Replace a dishwasher",
   "applies": [
    "plumbing",
    "appliance",
    "dishwasher"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 900,
     "likely": 1100,
     "high": 1350,
     "material": {
      "brand": "GE",
      "line": "24 in. top-control dishwasher (GDT650SYVFS)",
      "price": 848.0,
      "per": "ea",
      "url": "https://www.plessers.com/ge/gdt650syvfs",
      "priceChecked": true
     },
     "laborShare": 0.22,
     "note": "unit plus swap on existing water, drain and power, new supply line and air gap or high loop, haul old unit"
    },
    "mid": {
     "low": 1350,
     "likely": 1600,
     "high": 1900,
     "material": {
      "brand": "Bosch",
      "line": "500 Series 24 in. dishwasher (SHP65DM5N)",
      "price": 1249.0,
      "per": "ea",
      "url": "https://www.bosch-home.com/us/productslist/dishwashers",
      "priceChecked": false
     },
     "laborShare": 0.18,
     "note": "Bosch 500 with new supply line and haul-away; anti-tip brackets to stone counters"
    },
    "high": {
     "low": 2400,
     "likely": 2900,
     "high": 3800,
     "material": {
      "brand": "Bosch",
      "line": "Benchmark panel-ready 24 in. dishwasher (SHV9PCM3N)",
      "price": 1999.0,
      "per": "ea",
      "url": "https://www.bosch-home.com/us/en/product/SHV9PCM3N",
      "priceChecked": true
     },
     "laborShare": 0.25,
     "note": "panel-ready Bosch Benchmark or Miele G 7000 ($2,150-3,700), custom panel fitted by the cabinetmaker (panel itself extra), toe-kick scribe"
    }
   },
   "sources": [
    "https://www.fixr.com/costs/dishwasher-installation",
    "https://homeadvisor.com/cost/kitchens/install-dishwasher",
    "https://angi.com/articles/how-much-does-dishwasher-installation-cost.htm"
   ],
   "group": "Plumbing"
  },
  {
   "id": "permit-building-minor",
   "label": "Building permit, minor alteration",
   "applies": [
    "permit"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 350,
     "likely": 600,
     "high": 1000,
     "material": null,
     "laborShare": 0.2,
     "note": "permit and plan-review fees for a kitchen or bath with no layout change, filed by the contractor; laborShare is the filing-service share. Area factor does not fit: use areaNotes. NYC: Alt-2 by RA/PE plus co-op/condo review, typically $6,000-18,000."
    },
    "mid": {
     "low": 600,
     "likely": 1000,
     "high": 1600,
     "material": null,
     "laborShare": 0.4,
     "note": "fees on a higher job valuation plus simple permit drawings and filing; area factor does not fit, use areaNotes"
    },
    "high": {
     "low": 1000,
     "likely": 1700,
     "high": 3000,
     "material": null,
     "laborShare": 0.55,
     "note": "fees on a high valuation plus stamped drawings and a filing or expediting service; area factor does not fit, use areaNotes"
    }
   },
   "areaNotes": {
    "nyc": "$6,000-18,000. DOB alteration filing (Alt-2) by a registered architect or PE: DOB fee $290 for the first $3,000 plus $17.75 per $1,000 in buildings of 7+ floors ($280 + $10.30 below 7 floors), so about $1,300 for a $60,000 bath and $2,400 for a $120,000 kitchen; expediter $750-2,500; RA/PE filing drawings $3,000-8,000; asbestos survey (ACP5) $450-1,200; co-op/condo alteration agreement review by the building's architect and managing agent $1,000-5,000 (refundable damage deposit of $2,500-10,000 not counted). In-place fixture swaps that DOB treats as minor work skip the filing but still need the building's alteration approval ($1,000-3,000).",
    "westchester": "$1,200-5,000. A Westchester village FY 2026-27: $200 application plus $19 per $1,000 of construction cost, certificate of completion $75, so about $1,400 for a $60,000 bath; most villages want RA/PE-stamped drawings for alterations above about $20,000 ($1,500-4,000). Neighbouring towns (Mamaroneck, Scarsdale, Rye) charge similar per-$1,000 rates.",
    "napa": "$1,200-3,500. Napa County (unincorporated) PBES schedule effective July 7, 2025: building inspection fee from job valuation (minimum $410), plan review about 70% of the inspection fee, issuance $54 ($58.05 with surcharge), plus state SMIP and CBSC surcharges; Title 24 energy forms if lighting or ventilation change. The City of Napa uses its own schedule (plan review 33% of the permit fee, $244 minimum)."
   },
   "sources": [
    "https://angi.com/articles/how-much-does-building-permit-cost.htm",
    "https://www.homeadvisor.com/article.show.Building-Permits.8600.html",
    "https://www.nyc.gov/assets/buildings/pdf/dn-cost.pdf"
   ],
   "group": "Permits",
   "areaLevels": {
    "nyc": {
     "budget": {
      "low": 6000,
      "likely": 8000,
      "high": 10000
     },
     "mid": {
      "low": 10000,
      "likely": 12000,
      "high": 14000
     },
     "high": {
      "low": 14000,
      "likely": 16000,
      "high": 18000
     }
    },
    "westchester": {
     "budget": {
      "low": 1200,
      "likely": 1850,
      "high": 2450
     },
     "mid": {
      "low": 2450,
      "likely": 3100,
      "high": 3750
     },
     "high": {
      "low": 3750,
      "likely": 4350,
      "high": 5000
     }
    },
    "napa": {
     "budget": {
      "low": 1200,
      "likely": 1600,
      "high": 1950
     },
     "mid": {
      "low": 1950,
      "likely": 2350,
      "high": 2750
     },
     "high": {
      "low": 2750,
      "likely": 3100,
      "high": 3500
     }
    }
   }
  },
  {
   "id": "permit-building-major",
   "label": "Building permit, major alteration",
   "applies": [
    "permit"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 1500,
     "likely": 2500,
     "high": 4000,
     "material": null,
     "laborShare": 0.4,
     "note": "permit and plan review for a layout change or structural work (walls moved or removed, plumbing relocated), with permit drawings and an engineer's letter; design fees beyond the permit set excluded; area factor does not fit, use areaNotes"
    },
    "mid": {
     "low": 2500,
     "likely": 4000,
     "high": 6500,
     "material": null,
     "laborShare": 0.5,
     "note": "as budget on a larger valuation, plus structural calculations and more inspections"
    },
    "high": {
     "low": 4500,
     "likely": 7500,
     "high": 12000,
     "material": null,
     "laborShare": 0.6,
     "note": "large valuation, full stamped permit set, engineer, filing or expediting service, special inspections"
    }
   },
   "areaNotes": {
    "nyc": "$15,000-45,000. Alt-2 (Alt-CO if egress or occupancy changes) by RA/PE: DOB fee at $290 + $17.75 per $1,000 over $3,000 in 7+ floor buildings (about $3,800 for a $200,000 job, plus plumbing and other work-type filings); architect/PE drawings and filing $8,000-25,000; structural engineer $2,000-6,000; expediter $1,500-4,000; co-op/condo alteration agreement with building architect and engineer review, board approval and legal $2,500-10,000; wet-over-dry rules can block relocating kitchens and baths. Board review alone can take one month to a year.",
    "westchester": "$5,000-15,000. A Westchester village: $200 application plus $19 per $1,000 (about $3,050 for $150,000 of work), certificate of occupancy $200, Board of Architectural Review $150 if the exterior changes; stamped architect and structural drawings $4,000-12,000.",
    "napa": "$4,000-12,000. Napa County: valuation-based inspection fee plus about 70% plan review, engineering review for structural changes, SMIP/CBSC surcharges, Title 24 energy compliance, possible fire and environmental-health referrals billed hourly; stamped drawings and structural calculations extra in the higher part of the range."
   },
   "sources": [
    "https://angi.com/articles/how-much-does-building-permit-cost.htm",
    "https://homeadvisor.com/cost/architects-and-engineers/get-a-building-permit",
    "https://www.nyc.gov/assets/buildings/pdf/dn-cost.pdf"
   ],
   "group": "Permits",
   "areaLevels": {
    "nyc": {
     "budget": {
      "low": 15000,
      "likely": 20000,
      "high": 25000
     },
     "mid": {
      "low": 25000,
      "likely": 30000,
      "high": 35000
     },
     "high": {
      "low": 35000,
      "likely": 40000,
      "high": 45000
     }
    },
    "westchester": {
     "budget": {
      "low": 5000,
      "likely": 6650,
      "high": 8350
     },
     "mid": {
      "low": 8350,
      "likely": 10000,
      "high": 11650
     },
     "high": {
      "low": 11650,
      "likely": 13350,
      "high": 15000
     }
    },
    "napa": {
     "budget": {
      "low": 4000,
      "likely": 5350,
      "high": 6650
     },
     "mid": {
      "low": 6650,
      "likely": 8000,
      "high": 9350
     },
     "high": {
      "low": 9350,
      "likely": 10650,
      "high": 12000
     }
    }
   }
  },
  {
   "id": "permit-electrical",
   "label": "Electrical permit",
   "applies": [
    "permit"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 75,
     "likely": 150,
     "high": 300,
     "material": null,
     "laborShare": 0.2,
     "note": "stand-alone electrical permit for a few circuits or fixtures, pulled by the electrician; area factor does not fit, use areaNotes"
    },
    "mid": {
     "low": 150,
     "likely": 250,
     "high": 450,
     "material": null,
     "laborShare": 0.35,
     "note": "permit for a kitchen or bath rewire, several inspections"
    },
    "high": {
     "low": 250,
     "likely": 450,
     "high": 750,
     "material": null,
     "laborShare": 0.45,
     "note": "larger scope or new circuits and panel work, rough and final inspections, electrician's filing time"
    }
   },
   "areaNotes": {
    "nyc": "$300-1,200. Filed by a licensed master electrician in DOB NOW: Electrical; fee by formula ($40 permit fee plus per-part fees under the rule effective November 21, 2026), at least $130 due at filing; electrician's filing and inspection attendance $200-600; the building's alteration agreement usually requires the permit even for small rewiring.",
    "westchester": "$300-600. a Westchester village electrical permit $150; the inspection itself is done by an approved third-party electrical inspection agency ($150-350 per job) that issues the certificate.",
    "napa": "$450-900. Napa County stand-alone trade permit: issuance $54 ($58.05 with surcharge) plus inspection fee (building inspection minimum $410), more for panel upgrades or many circuits; City of Napa minimum $244."
   },
   "sources": [
    "https://angi.com/articles/how-much-does-building-permit-cost.htm",
    "https://www.inchcalculator.com/recessed-lighting-cost-guide/",
    "https://rules.cityofnewyork.us/rule/amendment-of-rules-regarding-fees-for-electrical-permits-and-licensing-and-compensation-of-registered-design-professionals/"
   ],
   "group": "Permits",
   "areaLevels": {
    "nyc": {
     "budget": {
      "low": 300,
      "likely": 450,
      "high": 600
     },
     "mid": {
      "low": 600,
      "likely": 750,
      "high": 900
     },
     "high": {
      "low": 900,
      "likely": 1050,
      "high": 1200
     }
    },
    "westchester": {
     "budget": {
      "low": 300,
      "likely": 350,
      "high": 400
     },
     "mid": {
      "low": 400,
      "likely": 450,
      "high": 500
     },
     "high": {
      "low": 500,
      "likely": 550,
      "high": 600
     }
    },
    "napa": {
     "budget": {
      "low": 450,
      "likely": 500,
      "high": 600
     },
     "mid": {
      "low": 600,
      "likely": 700,
      "high": 750
     },
     "high": {
      "low": 750,
      "likely": 800,
      "high": 900
     }
    }
   }
  },
  {
   "id": "permit-plumbing",
   "label": "Plumbing permit",
   "applies": [
    "permit"
   ],
   "unit": "ea",
   "levels": {
    "budget": {
     "low": 75,
     "likely": 175,
     "high": 350,
     "material": null,
     "laborShare": 0.2,
     "note": "plumbing permit for fixture replacement on existing rough-in, pulled by the plumber; area factor does not fit, use areaNotes"
    },
    "mid": {
     "low": 175,
     "likely": 300,
     "high": 500,
     "material": null,
     "laborShare": 0.35,
     "note": "kitchen or bath with several fixtures, rough and final inspections"
    },
    "high": {
     "low": 300,
     "likely": 500,
     "high": 850,
     "material": null,
     "laborShare": 0.45,
     "note": "relocated drains or gas, pressure tests, more fixtures and inspections"
    }
   },
   "areaNotes": {
    "nyc": "$600-2,500. Plumbing is a work type on the DOB alteration job, filed by a licensed master plumber (fee from the plumbing cost at the alteration rates above, minimum $130 per subsequent filing); plumber's filing, sign-off and inspection attendance $500-1,500; gas work adds a gas authorization and pressure test.",
    "westchester": "$200-500. A Westchester village: $200 for the first four fixtures plus $25 per additional fixture (a full bath with toilet, sink, tub and shower valve is $200; bath plus kitchen about $300).",
    "napa": "$450-900. Napa County stand-alone plumbing permit: issuance $54 plus the inspection fee (minimum $410), more for water heaters, gas lines or many fixtures; City of Napa minimum $244."
   },
   "sources": [
    "https://angi.com/articles/how-much-does-building-permit-cost.htm",
    "https://www.homeadvisor.com/article.show.Building-Permits.8600.html",
    "https://www.nyc.gov/assets/buildings/pdf/dn-cost.pdf"
   ],
   "group": "Permits",
   "areaLevels": {
    "nyc": {
     "budget": {
      "low": 600,
      "likely": 900,
      "high": 1250
     },
     "mid": {
      "low": 1250,
      "likely": 1550,
      "high": 1850
     },
     "high": {
      "low": 1850,
      "likely": 2200,
      "high": 2500
     }
    },
    "westchester": {
     "budget": {
      "low": 200,
      "likely": 250,
      "high": 300
     },
     "mid": {
      "low": 300,
      "likely": 350,
      "high": 400
     },
     "high": {
      "low": 400,
      "likely": 450,
      "high": 500
     }
    },
    "napa": {
     "budget": {
      "low": 450,
      "likely": 500,
      "high": 600
     },
     "mid": {
      "low": 600,
      "likely": 700,
      "high": 750
     },
     "high": {
      "low": 750,
      "likely": 800,
      "high": 900
     }
    }
   }
  }
 ]
};
