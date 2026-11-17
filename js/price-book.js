// tiksi price book: installed unit prices (materials and labour, contractor-installed, US
// dollars) for common renovation work at three finish levels, each with a real product line as
// its placeholder material. Researched 2026-11 from current cost guides and maker / retailer
// pages; docs/price-book-sources.md lists the sources per work and how firm each figure is.
// National averages: a cost area's factor scales them (scope-takeoff.js). A material with
// priceChecked false has a price from a dealer or an estimate, not a published list price.
// Estimates to start a budget, never a quote.

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
    "fixture"
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
   ]
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
   ]
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
  }
 ]
};
