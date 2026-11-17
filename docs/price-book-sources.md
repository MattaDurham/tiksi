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
