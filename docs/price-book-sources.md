# Price book sources (as of 2026-11)

All figures are national-average installed prices in US dollars per unit (materials plus labour, contractor-installed). Multiply them by the area factor. Most cost guides publish a single national range. I split that range across the budget, mid and high levels. The level notes in price-book.json say what each level includes.

Ratings:
- **Strong**: two or more independent guides agree within about 25%.
- **Fair**: two sources that agree loosely, or that measure on a different basis.
- **Thin**: one source, or my own estimate.

Material prices: `priceChecked: true` means I saw the price on a retailer or maker listing during this research. `false` means the price is approximate and should be checked before relying on it. 37 of the 84 materials are checked. Products sold through dealers (Carlisle, TruStile, Marvin, Rocky Mountain, Stark, Porcelanosa, Hakwood, Crown Point, Forbes & Lomax) publish no prices, so those figures are placeholders.

## Area factors

| Area | Factor | Basis |
|---|---|---|
| NYC | 1.32 | Craftsman 2025 National Building Cost Manual, area modification for Manhattan (ZIP 100-102): +32%. BLS OEWS May 2025: construction trades in the NY-Newark-Jersey City metro earn a mean of $39.49/h against $31.42 nationally (+26%), and that metro includes cheaper suburbs. Manhattan co-op and condo logistics (alteration agreements, insurance certificates, elevator hours) often add more. |
| Westchester | 1.15 | Craftsman 2025, White Plains (ZIP 105-108): +10%. The BLS metro wage ratio of 1.26, weighted 60% labour and 40% materials at 1.02, gives 1.16. I chose 1.15. |
| Napa | 1.18 | Craftsman 2025, ZIP 945 (the Oakland range, which covers Napa 94558/94559): +19%. Santa Rosa is +5% and San Francisco +28%. BLS May 2025 for the Napa metro: $38.35/h against $31.42 (+22%). |

RSMeans City Cost Index tables are paywalled, so I did not use them. The 2019 RSMeans figures quoted in search snippets were garbled. Sources: https://craftsman-book.com/media/static/previews/2025_NBC_book_preview.pdf (I extracted the text of the area modification table from the PDF), https://www.bls.gov/regions/northeast/news-release/2026/occupationalemploymentandwages_newyork_20260605.htm, https://www.bls.gov/regions/west/news-release/2026/occupationalemploymentandwages_napa_20260709.htm. **Fair.** Both sources agree, but neither is a renovation-specific index.

## Walls and ceiling

- **Paint walls**: HomeGuide gives $1-2/sf for walls only ($1-3 for all surfaces). Homewyse (Apr 2024) gives $1.15-2.48/sf. Angi gives $2-6/sf, but that is per sf of floor, which is a different basis. Book: 1.00 to 4.50 per sf of wall. **Strong.**
- **Skim coat and paint**: Homewyse (Jul 2025) gives $0.94-1.33/sf for the skim alone, and Angi and HomeAdvisor give $1.10-1.30/sf. I added the paint-walls price for each level. The high level (Level 5, two full coats) is my scaling of that. **Fair** for budget and mid, **thin** for high.
- **Wallpaper**: Angi and HomeAdvisor give $1-7/sf labour with the paper extra. Paper prices: York grasscloth $89 per 4-yd roll (about $2.50/sf), Schumacher $84/yd (about $37/sf), and Phillip Jeffries is reported at $180-400/yd. The high level is driven by the material. **Fair** for labour, **thin** for high-end paper.
- **Remove wallpaper**: Angi and HomeAdvisor give $0.60-3/sf. **Fair.**
- **Wall tile**: Angi gives $10-25/sf installed for ceramic and $20-65 for marble. This Old House averages $17.30/sf. HomeAdvisor gives $10-15/sf labour. Tile prices: Daltile Restore $2.32-2.79/sf, Bedrosians Cloé about $8.29/sf, Fireclay $28/sf. **Strong** for budget and mid, **fair** for high.
- **Backsplash**: HomeAdvisor and Angi both give $15-40/sf, with labour $5-20/sf. Angi gives $17-110 for stone. I priced it above wall tile because small areas and outlet cuts raise the cost per sf. **Strong.**
- **Paint ceiling**: Angi gives $1-3/sf (wider range $0.50-5). Homewyse and Fixr give $120-300 per ceiling. **Strong.**

## Floors

- **Refinish hardwood**: This Old House gives $3-8/sf. Hallmark gives $3-5 for oak and $5-8 for dustless. Woodworking Advisor gives $2-6. **Strong.** Bona Traffic HD was listed at $147/gal (checked). The Bona Mega and Rubio prices are approximate.
- **Solid hardwood**: HomeAdvisor and Inch Calculator give $11-25/sf, and another estimator gives $6-25. Bruce Natural Reflections was $4.84/sf at Home Depot (checked). Carlisle has no published price; the only figure I found was $12-28/sf material from a low-quality site, so treat it as a placeholder. **Fair** for budget and mid, **thin** for high.
- **Engineered hardwood**: Angi and HomeAdvisor give $7-20/sf, with labour $3-10. HomeGnome gives $7.50-12.50. Floor & Decor white oak was $4.99-9.99/sf (checked). **Strong.**
- **LVP**: Fixr gives $3-16/sf, with most people paying $5-12. This Old House gives $3-10 material plus $3-10 labour. CountBricks gives $1.50-2.40 labour. LifeProof was $2.98-3.49/sf and COREtec Pro Plus Enhanced $5.39/sf (both checked). **Strong.**
- **Porcelain floor tile**: Fixr says most people pay $10-20/sf. HomeAdvisor gives $3-15 labour. HomeGuide (via HGTV) gives $10-50. **Strong** for budget and mid, **fair** for high (Porcelanosa is priced by quote).
- **Carpet**: HomeAdvisor gives $3-11/sf, Homewyse (Oct 2025) $5.26-7.69, and HomeGnome $5-8.50. The wool level comes from one aggregator ($15-50 installed for Stark). **Strong** for budget and mid, **thin** for high.
- **Remove flooring** (added): HomeAdvisor gives $0.50-5/sf for carpet. Tile removal is $1-5/sf across several guides. **Fair.**

## Trim

- **Paint trim**: HomeGuide, Angi and HomeAdvisor all give $1-4/lf, and Angi goes up to $6. **Strong.**
- **Install baseboard**: HomeAdvisor gives $5.70-9.00/lf, and Angi and HomeGuide give $6-9. MDF base was $2.25-2.46/lf and 7-1/4" pine $3.20-3.68/lf (checked at Home Depot). The high level (built-up hardwood) is my estimate. **Strong** for budget and mid, **thin** for high.
- **Install crown**: Angi and HomeAdvisor give $4-23/lf, Bob Vila $4-15, and labour runs $3-12 (custom work $15-20). **Fair.** The materials at all three levels are approximate.

## Doors and windows

- **Paint door with casing**: Angi gives $75-150. HomeGuide gives $75-150 for the door and $80-250 with trim. Fixr averages $150 ($70-200). **Strong.**
- **Replace interior pre-hung door**: HomeAdvisor gives $362-1,232 and Handoff $238-642. Fixr says 2-5 hours at $44-83/h. Masonite listings were $156-192 (checked). **Strong** for budget and mid. The high level (TruStile) is **thin**.
- **Replace lever set**: handyman and Airtasker figures run about $75-150 per door, and Angi gives $140-350 for a new knob. Schlage Latitude was $34 and Emtek $138-222 (checked). **Fair.** Rocky Mountain is **thin**.
- **Paint window**: HomeGuide gives $50-120 for an interior frame with sash. Remodeling.com gives $65-225 with sash. **Fair.**
- **Replace window**: the Angi/HomeAdvisor average is $650. Vinyl runs $300-1,200 across several guides, wood-clad $700-1,400, and premium $1,400-2,800. Angi gives $700-2,000 for solid wood. **Fair.** The sources disagree, and none of the window unit prices were confirmed (Pella and Andersen show "get pricing" online; the Marvin figure is from a forum post).

## Cabinets and counters

- **Paint cabinet front**: guides give $70-125 per door and $30-110 per drawer front. Fixr gives $75-150. CertaPro gives $125-185 per piece. **Fair.** I used one price per front, so drawer fronts come out a little high.
- **Replace cabinet front**: Inch Calculator gives $200-400 per door (average $225). Another 2026 guide gives $180-330. Homewyse gives $411-595. Semihandmade DIY Shaker was $89 unfinished (checked). **Fair.**
- **New cabinets per lf**: HomeAdvisor gives stock $100-300, semi-custom $150-650 and custom $500-1,200 installed. Fixr and LawnStarter are similar. **Strong.** The KraftMaid and Crown Point prices are approximate.
- **Cabinet pull**: CountBricks gives $4-12 per pull for labour, and Bob Vila gives $5-30 labour. Amerock was $3.20-7.92 (checked). **Fair.** The mid and high hardware prices are **thin**.
- **Quartz**: Inch Calculator gives $50-150/sf, LawnStarter $55-150, and Slabwise says most pay $70-100. Fixr labour is $10-35. **Strong.**
- **Natural stone**: Fixr gives marble at an average of $100 ($50-200) and granite at $40-150. Slabwise and NKBA give $70-100 for natural stone. HomeAdvisor gives material of about $40/sf for Carrara and $150-200 for Calacatta. **Fair.**

## Electrical and generic

- **Replace light fixture**: HomeAdvisor gives $112-287 (average $199) for a simple swap and $158-1,017 (average $587) for installs. Electrician labour is $50-100/h for 1-2 hours. Fixture prices were checked: Hampton Bay $55, Rejuvenation $219, Visual Comfort $599. **Strong** for budget. Mid and high are driven by the fixture price.
- **Replace outlet or switch**: HomeTips gives $75-150 per outlet. HomeAdvisor averages $152 per switch ($100-203). Fixr gives $100-200. **Strong.**
- **Remove object / reinstall object**: these are built from handyman rates of $60-125/h (Thumbtack, HomeAdvisor, Fixr), with 0.5-3 hours plus disposal. No guide prices this work "per object", so all of it is **thin**. The material is set to null for both.

## Gaps worth knowing

- Several things are not in the book: drywall hanging, recessed lights (new circuits), plumbing fixtures, demolition by the room and permits.
- The search results included many low-quality pages with "2026" in their titles (for example, risingsunartscentre.org and kurlon.com). I ignored them as sources.


# Price book additions: sources (as of 2026-11)

These 19 works add drywall, recessed lights and dimmers, plumbing fixtures, and permits to price-book.json. All figures are national-average installed prices in US dollars per unit (materials plus labour, contractor-installed), to be multiplied by the area factor. The exception is permits: the area factor does not fit them, so each permit work carries an `areaNotes` field with typical local totals for NYC, Westchester and Napa. Most guides publish one national range, and that range is split across the budget, mid and high levels. The level notes in price-book-additions.json say what each level includes.

Ratings (same scale as price-book-sources.md):
- **Strong**: two or more independent guides agree within about 25%.
- **Fair**: two sources that agree loosely, or that measure on a different basis.
- **Thin**: one source, or an estimate built from rates rather than a published figure.

Material prices: `priceChecked: true` means the price appeared on a retailer or maker listing in search results during this research (November 2026). Those are listing snapshots, not live carts, and sale prices move. `false` means the price is approximate. 22 of the 42 materials are checked. Waterworks, Lucifer, Kelvix, Dornbracht, Victoria + Albert and Lutron's RadioRA 3/Palladiom range sell through showrooms or dealers, so their figures are list-price or placeholder figures.

Many search results came from low-quality "2026" pages (risingsunartscentre.org, kurlon.com, several pages.dev sites). They were ignored. HomeStars figures were left out because they are in Canadian dollars.

## Drywall

- **Hang and finish drywall on walls**: HomeGuide gives $1.50-3.50/sf for walls (materials $0.50-0.80, labour $1.00-2.70). Homewyse (May 2026) gives $2.26-2.69/sf for 1/2" board hung with tape and compound. Fixr (Jan 2025) gives labour of $1.25-3.00/sf at Level 4 and $1.50-3.50 at Level 5, with board at $0.42-0.63/sf. Secondary sources put Level 5 at $0.50-1.50/sf over Level 4. Inch Calculator gives $1.50-3.50/sf. The book uses 2.40 (budget, Level 4), 3.10 (mid, Level 4 with mold/moisture-resistant or Type X board) and 4.50 (high, Level 5), each including one primer coat. **Strong** for budget and mid. **Fair** for high, because the Level 5 premium comes from a range rather than a direct quote. Board prices: USG UltraLight 1/2" 4x8 was seen at $13.24-21.84 a sheet in cached Home Depot snapshots and $14.44 at a supply house. Gold Bond PURPLE XP was $16.97-18.19 at independent sellers. CertainTeed M2Tech was $27.99 at one seller. All three are marked unchecked.
- **Hang and finish drywall on ceilings**: HomeGuide gives $2.00-4.00/sf for ceilings against $1.50-3.50 for walls. Fixr gives $1.50-2.50/sf installed for standard ceiling board, $1.65-3.50 for fire-rated and $1.70-2.75 for moisture-resistant, and says ceiling labour runs higher. The book sets ceilings about 20% above walls: 2.90, 3.70 and 5.40. **Strong** for budget and mid, **fair** for high.
- **Repair drywall or plaster**: the guides measure two different jobs. Small patches cost $50-100/sf (HomeGuide), $50-75/sf (HomeAdvisor) and $60-80/sf (Fixr, which gives 4 sf at $240-320 and 20 sf at $1,200-1,600). Replacing whole walls or ceilings costs $2-6/sf (HomeGuide) or $2-5.50/sf (HomeAdvisor). Fixr also prices a full panel or section at $400-800, which is about $12-25/sf for a 4x8 sheet. The book prices the middle case, damaged areas of about 5-30 sf: 12, 18 and 30/sf, with a $150-250 visit minimum noted for patches under about 4 sf. **Fair** at the two ends. The chosen middle rate is **thin**, because no guide publishes it directly. It was interpolated from the per-panel figure.
- **Remove drywall or plaster and haul away**: Fixr gives $0.30-0.45/sf for drywall removal, labour only, with cleanup of $360-550 per job on top. CountBricks (Feb 2026) gives $2.55-5.70/sf including haul-off. For plaster, HomeGuide gives about $2-3/sf with disposal, Homewyse (May 2026) gives $4.57-9.44/sf for lath and plaster with protection and disposal on small jobs, and Fixr gives $0.45-0.75/sf for labour. The book uses 1.50 (drywall), 3.00 (plaster and lath) and 5.75 (containment and bagged carry-out under building rules). Asbestos and lead work is excluded, at $5-20/sf extra by one guide. **Fair**: the sources spread widely depending on whether disposal and setup are included.

## Recessed lights and dimmers

- **Add a recessed light**: HomeAdvisor (2025) averages $180 per fixture ($100-300). It gives $200-300 for canless LED including wiring and up to $200 more per light around joists and ducts. Angi gives $200-250 per fixture at 2-3 hours. Fixr (Jan 2025) gives $176-328 per light and electrician rates of $88-163/h. Inch Calculator gives $200-250 per fixture including $75-150 of wiring. HomeGuide adds $50-300 for ceiling repair. The book uses 275 (budget, wafer with patch), 450 (mid) and 850 (high, architectural with mud-in trim). **Strong** for budget. Mid and high are driven by the fixture price, so they are **fair**. Fixtures checked: Juno WF6 at $22.53 (Home Depot), WAC Aether 3.5" adjustable at $218.65-263.95 (Lighting New York, Lumens), Visual Comfort Entra 3" remodel housing with LED at $262 (Build.com), DMF M Series 4" at $212-256 (one retailer). Lucifer and Kelvix are priced by quote.
- **Replace a recessed light**: one contractor gives $90-160 per light for an electrician-installed retrofit trim, and Homeyou gives $98-286. HomeGuide gives retrofit kits at $5-40 and full can replacement at $125-300 per light. Angi gives kits at $25-50 plus electrician time at $85-105/h. The book uses 125, 250 and 650. **Fair** for budget and mid. High (an architectural remodel housing in an old can hole, with patch) is **thin**. Halo LT560 was $10.35-27.34 at distributors, and the book uses $14.78 (Elliott Electric).
- **Install a dimmer switch**: Fixr (Jan 2025) gives $75-100 installed for a standard dimmer and $85-150 for smart switches. Installers in San Diego and Virginia give $100-200 for a standard dimmer and $150-450 for a Caséta. The Caséta Smart Bridge costs $80-130 once per home. For RadioRA 3, one cost guide gives $120/220/350 per control before programming, and installer pages put whole retrofits of 30-50 dimmers at $8,000-15,000, about $200-300 per dimmer. The book uses 120, 190 and 450. **Strong** for budget, **fair** for mid, **thin** for high (dealer pricing varies, and Palladiom keypads were not priced). Devices checked: Diva DVCL-153P at $25.69, Caséta PD-6WCL at $64.95 (Abt) and $66.79 (Elliott Electric), Sunnata RRST-PRO-N at $178.07.

## Plumbing fixtures

All prices assume the fixture connects to the existing rough-in, removal and haul-away are included, and the plumber is licensed.

- **Replace a toilet**: HomeAdvisor (2025) gives $224-533 (average $374). Angi gives $250-550 for labour. Hometips gives $400-850 total for a standard replacement, and ConsumerAffairs $150-600 installed. The book uses 550, 850 and 1,800. **Strong** for budget and mid. High is driven by the fixture and is **fair**: a TOTO Neorest above $4,000 sets the top of the range at $6,000. Fixtures: TOTO Drake CST776CEFG at $355-410 (Walmart, Faucet Depot), with TOTO's own list price at $460-690. Duravit ME by Starck was $741-1,005 at US dealers. The American Standard Champion 4 was seen at $279-320 (Lowe's and Home Depot), but the model and seat varied between listings, so it is marked unchecked.
- **Replace a bathroom vanity, top, sink and faucet**: This Old House (updated June 2026) gives labour of $665-3,300 (average $1,983) for removal, plumbing and fitting, excluding products. It gives stock vanities at $100-2,600 and custom ones at $500-2,800 plus $200-1,000 to install. Angi (2025) gives $300-2,200 (up to $3,800). CountBricks gives $900-7,500. The book uses 1,050, 2,100 and 6,500. **Fair**: the guides agree on labour but cover very different products. Products checked: Kohler Winnow 30" with quartz top at $719.39 (kohler.com), Waterworks Henry HLS401 at $1,795 (waterworks.com list price). Glacier Bay Spa 30" was $299 at a reseller (unchecked).
- **Replace a bathroom faucet**: HomeAdvisor (2025) and Angi give $170-360, with most jobs about $270. Plumber labour runs $100-300 (Ben's Plumbing) or $120-300 (Anytime Plumbing). The book uses 250, 600 and 2,200. The mid and high levels are the faucet price plus that labour. **Strong** for budget, **fair** for mid and high. Kallista One was $721-769 on Houzz.
- **Replace a kitchen sink**: Fixr (Aug 2025) gives $450-1,050 for a replacement in an existing counter, undermount at $200-2,000 installed, apron-front at $1,000-4,000 (which needs cabinet work) and labour of $100-500. CountBricks gives $600-3,000 for undermount, with most jobs $1,000-1,800, and $150-1,000 for counter cut-out changes. The book uses 650, 1,250 and 3,200. **Fair**: the sources agree on the shape but not the spread. Sinks checked: Kraus Standart PRO 32" at $386 (Houzz sale), Shaws Shaker 30" at $1,374.75 (Dwell/Build.com) to $1,934 (General Plumbing Supply), and Rohl Shaws Original at $2,038.50.
- **Replace a kitchen faucet**: HomeAdvisor gives $162-364 (average $262, broader $91-600). Homewyse (Jul 2025) gives $535-857, which includes overhead. Fixr says a new kitchen faucet costs $300-800 to install. The book uses 375, 750 and 2,400. **Strong** for budget, **fair** for mid and high. Faucets checked: Delta Trinsic pull-out at $509 (Studio41), Waterstone Parche 3800 at $1,839.75 sale and $2,453 regular (Studio41). Perrin & Rowe Mimas was only found in UK prices (£330-520) and is not used as the material.
- **Replace a shower valve and trim**: no major guide covers this well. HomeServe and Amenify give $150-575 for a complete valve replacement and $200-1,000 (average $500) with trim, adding $100-500 for thermostatic parts. Another guide gives $350-1,300 for a mixing valve, and says tile access pushes the cost higher. The book uses 700 (pressure-balance, opened from behind), 1,800 (thermostatic, small tile patch) and 5,000 (high-end thermostatic with tile repair). **Fair** for budget. Mid and high are **thin**: they are built from valve prices plus tile-repair time. The Grohe Grohtherm trim lists at $573-796 on grohe.us, and the rough-in box is extra. The Waterworks and Dornbracht figures are placeholders.
- **Replace a bathtub**: Fixr (Aug 2025) gives alcove tubs at $450-1,400 installed, removal at $200-1,200 and labour at $1,200-3,000, with averages by material of about $4,800-6,000. HomeAdvisor (2025) gives $2,074-9,709 (average $5,890). It gives removal at $50-100 for fiberglass and $300 or more for cast iron, and says $400-1,900 is added when the tub type changes. Homeyou (Apr 2026) gives $1,534-6,321 (average $3,294). Freestanding guides give $2,000-6,500 and $3,500-6,800, with floor-mount fillers at $300-1,200 for the fixture (Brizo Rook about $3,360). The book uses 2,600, 4,300 and 9,500. **Fair**: the guides mix tub-only swaps with surround work. Kohler Villager 60x30 was $683-887 (checked at $808). The American Standard Princeton steel tub was $345-682 at Walmart, and the Victoria + Albert figure is a placeholder.
- **Replace a dishwasher**: Fixr (Jan 2026) gives $400-1,500 (average $1,000). It gives labour of $150-300 with existing hookups, haul-away of $100-250, and high-end brands at $1,500-2,000 or more. HomeAdvisor gives $370-1,500, and Angi averages $1,200 for unit plus labour. The book uses 1,100, 1,600 and 2,900. **Strong** for budget and mid. High is driven by the unit price, so it is **fair**: the custom panel is excluded, and the cabinetmaker's fitting time is included. Units checked: GE GDT650SYVFS at $848 (Plessers; $949 list, $544-985 over 90 days), Bosch Benchmark SHV9PCM3N at $1,999 (bosch-home.com). Bosch 500 SHP65DM5N lists at $1,249 per a comparison site (unchecked). Miele G 7000 models were $2,149-3,699.

## Permits

National guides: Angi (2025) gives a typical building permit at $1,647 ($525-3,041), with bathroom remodels averaging about $600 and kitchens about $1,000. HomeAdvisor gives the same bath and kitchen figures. Plumbing permits run $50-500 (HomeAdvisor and Angi), and electrical permits $50-350 or $40-500 across guides. Inch Calculator gives $50-350 for a lighting permit. Within each permit work, the levels reflect a larger job valuation and more paid filing help, not finish quality. `laborShare` is the share of the total that goes to filing and drawing services rather than government fees.

Local fee schedules used:
- **NYC DOB**: "DOB NOW: Build, Cost Reporting, Alteration Filings & Fee Updates", Winter 2026 release, updated January 2026 (nyc.gov/assets/buildings/pdf/dn-cost.pdf; the text was extracted from the PDF). Alteration filings cost $170 for the first $5,000 plus $2.60 per $1,000 in 1-3 family homes, $280 for the first $3,000 plus $10.30 per $1,000 below 7 floors, and $290 for the first $3,000 plus $17.75 per $1,000 at 7 floors and up. The minimum for a subsequent filing is $130. Electrical permits: the DOB rule adopted for November 21, 2026 sets a $40 permit fee plus parts fees, with at least $130 due at filing. The per-part amounts were not extracted. Expediters charge $750-1,500 for an Alt-2 (one expediter's price page), or "a couple thousand dollars" (Brick Underground). For co-ops, one contractor guide gives alteration review fees of $1,000-2,000 and architect/engineer fees of $5,000-15,000 or more. One NYC guide gives asbestos (ACP5) surveys at $450-1,200 per apartment and total soft costs of $10,000-30,000 on a $200,000 gut renovation. A 2014 StreetEasy anecdote describes $6,000 of architect plans growing to about $10,000 with the expediter.
- **Westchester, A Westchester village** building department fees for FY 2026-27, adopted May 28, 2026 and effective June 1, 2026 (the text was extracted from the PDF). Residential building permits cost a $200 application fee plus $19 per $1,000 of construction cost (commercial: $250 plus $32). A certificate of completion is $75 and a certificate of occupancy $200. Plumbing costs $200 for the first four fixtures plus $25 per additional fixture. Electrical is $150, and Architectural Review is $150 per application. Electrical inspections in Westchester villages are done by approved third-party agencies. Their $150-350 fee is an estimate and is **thin**.
- **Napa County** (unincorporated), Planning, Building & Environmental Services fee schedule effective July 7, 2025. The official PDF refused automated download, so these figures come from Jaspector's summary of it: a $410 minimum building inspection fee at valuations of $1-1,500 (the IBC valuation table sets fees above that), plan review at about 70% of the inspection fee, an issuance fee of $54 ($58.05 with surcharge), $372/h after hours, and a 400% penalty for unpermitted work. The City of Napa master fee schedule (effective February 3, 2025) has plan review at 33% of the permit fee and a $244 minimum, per the same summary. The city's PDF uses embedded fonts, and its tables could not be extracted.

Ratings:
- **Building permit, minor alteration**: national **fair** (Angi and HomeAdvisor agree, but both come from the same company's data). NYC **fair** (the DOB fee is official, the soft costs come from industry pages). Westchester **strong** for the fee itself (official schedule), with drawings **thin**. Napa **thin** (the structure is known but the valuation table was not read).
- **Building permit, major alteration**: national **thin**. No guide separates major from minor alterations, so the figures are scaled from Angi's upper range plus engineer letters. NYC **fair**, Westchester **fair**, Napa **thin**.
- **Electrical permit**: national **fair**. NYC **thin** (per-part fees not extracted). Westchester **fair**. Napa **thin**.
- **Plumbing permit**: national **fair**. NYC **thin**. Westchester **strong** (official per-fixture fees). Napa **thin**.

## Thin figures to check first

- Drywall repair at all three levels (interpolated rate per sf).
- High level of recessed-light replacement and of dimmers (RadioRA 3 and Palladiom dealer pricing).
- Mid and high shower valve (tile repair allowance, Waterworks and Dornbracht placeholders).
- Major-alteration permit nationally, and all Napa permit totals, until the Napa County PDF is read.
- NYC electrical and plumbing permit totals (per-part fees not extracted).
