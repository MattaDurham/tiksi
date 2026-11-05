# Product model source index

Use this index before drawing an appliance, plumbing fixture, furniture item or
other manufactured product. Start with an existing model of the exact product,
verify it against the manufacturer's specification, and import or convert it.
Custom modelling is the fallback when the available geometry is missing,
inaccurate, incompatible or unsuitable for the permitted use.

Initial research: **3 November 2026**. Compiled: **5 November 2026**. Counts and
release dates below are research snapshots, not live totals. Peppermodern's
repository and the ABO registry were revisited during compilation. An entry
marked **lead** was discovered but needs further inspection before relying on its
coverage or licensing. A source listing is not certification of its geometry.

Branded product libraries already exist, including a recent small GitHub library
using Claude-generated SketchUp models. Large open datasets also exist. The
remaining opportunity is a maintained catalogue combining current product IDs,
reliable installation information, clear asset rights and reproducible builds.
Do not infer that a missing search result proves that a model does not exist.

## Choose a source

| Need | Start here | Then try |
| --- | --- | --- |
| Sub-Zero, Wolf or Cove appliance | [Manufacturer CAD library](#sub-zero-wolf-and-cove) | [Peppermodern](#peppermodern-mozaik-appliance-library), BIMobject |
| Bosch appliance | [Manufacturer specification library](#bosch) | Peppermodern, manufacturer product-page CAD download |
| Miele appliance | [Manufacturer CAD and BIM resources](#miele) | Peppermodern, the regional Miele catalogue |
| Brizo faucet or shower | [Brizo design files](#brizo) | BIMsmith, Peppermodern |
| Kohler plumbing fixture | [Kohler product and CAD libraries](#kohler) | Peppermodern, BIMobject |
| Other exact appliance or fixture | Manufacturer trade/specification page | [BIMobject](#bimobject), [BIMsmith](#bimsmith), [Archiproducts](#bimarchiproducts), [AEC-DATA](#aec-data) |
| Australian plumbing or building product | [BIMcontent](#bimcontent), [RubySketch](#rubysketch) | Manufacturer site, NBS Source |
| MEP equipment | [MEPcontent](#mepcontent), manufacturer site | BIMobject, [TiSoft](#tisoft-equipment-library) |
| Openly licensed product-linked GLB | [Amazon Berkeley Objects](#amazon-berkeley-objects-abo) | Per-asset licensed community sources |
| Generic editable CAD component | [FreeCAD library](#freecad-parts-library) | [OpeningDesign](#openingdesign-bim-objects), [CadCraft](#cadcraft-librarycraft) |
| Generic lightweight interior object | [Sweet Home 3D](#sweet-home-3d) | CadCraft, appropriately licensed Objaverse assets |
| IKEA furniture | [IKEA import tools](#ikea-import-tools) | Check availability and permitted use for the individual asset |

## Reuse workflow

1. Establish the manufacturer, exact model number, country/market, revision,
   size, finish, handing and installation configuration. Search the model number
   both with and without spaces, hyphens and finish suffixes. A product family
   name alone is insufficient to establish an exact match.
2. Search the manufacturer's product page and trade portal for **CAD**, **BIM**,
   **design files**, **technical resources** or **downloads**. Search the relevant
   aggregators below if that route fails. Check their brand pages and regional
   filters as well as general web search.
3. Download a suitable existing model and its specification into the private
   project folder. Retain original bytes, the source URL, download date, licence,
   product identity and any conversion report. A public index of links does not
   make third-party assets suitable for committing to this public repository.
4. Check units, orientation, origin, bounding dimensions and configuration.
   Distinguish the physical body, handle projection, adjustable feet, cabinet
   cutout, ventilation space, service space and door swing. Derive installation
   requirements from the current specification, not the model's bounding box.
5. Import or convert through the routes in [MODEL-EXCHANGE.md](MODEL-EXCHANGE.md).
   Tiksi supports browser mesh imports and local routes for SKP, IFC and other
   CAD formats when the corresponding engines are installed. An RFA listing may
   require its authoring application or an alternative format. If the current
   tool cannot import the file, try a conversion or authoring bridge first.
6. Prefer a correctly simplified existing model over a newly invented likeness.
   Preserve the source and record any transformations or simplifications. Do not
   stretch a product non-uniformly to conceal a mismatch with its specification.
7. If a custom build is necessary, record the sources searched and the concrete
   reason each candidate is unsuitable. Identify which dimensions are documented
   and which details are inferred. Label generic placeholders as generic; do not
   present a similar product as the specified SKU. Preserve builder code under
   the SketchUp archive rule in [AGENTS.md](AGENTS.md).

### Record for each reused asset

Keep this with the private project, not in the public source index:

| Field | Record |
| --- | --- |
| Identity | Manufacturer, model/SKU, market, finish, handing and configuration |
| Source | Product page, asset download URL, retrieval date and asset revision |
| Rights | Licence/terms URL, attribution and any redistribution restrictions |
| Geometry | Original format, units, dimensions checked, origin and orientation |
| Installation | Specification revision, cutout, clearances and connection references |
| Processing | Original file, converted file, conversion settings and changes |
| Confidence | Verified dimensions, unresolved discrepancies and inferred details |

## Manufacturer libraries

### Sub-Zero, Wolf and Cove

- **Access:** [Product specifications and CAD libraries](https://www.subzero-wolf.com/trade/product-specifications);
  [CAD-file instructions and limitations](https://www.subzero-wolf.com/assistance/answers/multi-brand/cad-file-drawings).
- **Coverage/formats:** Current-production appliances; bulk libraries include SKP,
  OBJ, RFA, DWG, DXF, GSM, 3DS and MAX. Individual product pages also offer files.
- **Use:** Strong first stop for exact appliances and native SketchUp assets.
  The FAQ says discontinued-product CAD files are unavailable. Check production
  status and the specific product's download rather than assuming full coverage.

### Bosch

- **Access:** [US specification library](https://www.bosch-home.com/us/experience-bosch/specification-library);
  [Canadian builder and trade resources](https://www.bosch-home.ca/en/experience-bosch/trade-resources).
- **Coverage:** Model-number lookup for specifications, manuals, installation
  guides and CAD files. Formats depend on the product/download.
- **Use:** Search the exact E-Nr/model and inspect the product's CAD package.
  Peppermodern's manifest identifies Bosch trade-CAD SketchUp sources for some
  products; that does not establish availability for every Bosch appliance.

### Miele

- **Access:** [Architect and designer technical resources](https://www.miele.co.uk/cs/project-business-1377);
  [January 2026 Canadian appliance overview](https://www.miele.ca/docs/default-source/projects-a-d-website/mieleapplianceoverview_jan2026_v1.pdf?sfvrsn=e72251ca_3).
- **Coverage:** Official 2D/3D CAD and BIM resources. The Canadian overview links
  a central CAD/BIM resource centre. Peppermodern identifies IFC downloads on
  regional Miele product pages.
- **Use:** Check the correct market. Similar names and European versus North
  American installation ranges can produce dimensional discrepancies.
- **Additional distribution:** [CAD Projekt's 18 June 2025 announcement](https://www.en.cadprojekt.com.pl/new-database-with-reliable-miele-equipment/)
  describes a Miele database with more than 160 appliance models for CAD Decor
  PRO and CAD Kuchnie. This is a software-specific catalogue, not an established
  openly redistributable asset collection.

### Brizo

- **Access:** [Design resources](https://www.brizo.com/design-resources);
  [example Litze 64063LF-PC product page](https://www.brizo.com/kitchen/product/64063LF-PC).
- **Formats:** Revit families, AutoCAD blocks and SketchUp files.
- **Use:** Follow **Design Files** from the product/resources page; also search
  BIMsmith. Match the finish and handle/spout configuration. Peppermodern's
  manifest includes Brizo products sourced from Brizo/BIMsmith.

### Kohler

- **Access:** [Official CAD library](https://la.kohler.com/en/cad-symbols);
  [official model-number/cutout guidance](https://assist.kohler.com/en/other-products/Cutout-Templates).
- **Coverage/formats:** The regional CAD library advertises more than 300 3D
  plumbing symbols, with DWG/DXF downloads and category packages. Product pages
  are another source of CAD files and cutout templates.
- **Use:** Verify that the file is for the intended regional product. A 2D cutout
  template and a 3D representation serve different purposes; retain both when
  relevant to installation.

### Fisher & Paykel

- **Access:** [US trade resources](https://www.fisherpaykel.com/us/trade-resources/);
  [example BIMobject product RS3084SLK1-26128](https://www.bimobject.com/en-us/fisher-and-paykel/product/RS3084SLK1-26128).
- **Coverage:** Manufacturer datasheets, installation resources and CAD files;
  the trade site also documents metadata embedded in its 3D CAD files.
- **Use:** Match model, hinge side and installation arrangement. The example
  BIMobject page supplies a product reference, dimensions and manufacturer link.

### Smeg

- **Access:** [Official 3D and BIM files](https://www.smeg.com/info/files-3d).
- **Coverage:** An appliance 3D archive and BIM resources for architects,
  designers and kitchen specialists.
- **Use:** A discovered manufacturer source to inspect for the required SKU;
  this research did not inventory its individual formats or licensing terms.

### GE Appliances Air & Water

- **Access:** [Official BIM library](https://www.geappliancesairandwater.com/bim-library/).
- **Coverage/formats:** Revit content distributed with BIMsmith for air
  conditioners, VRF equipment, water heaters and control devices.
- **Use:** Relevant to building services and utility equipment. This specific
  library does not establish coverage of GE's kitchen-appliance range.

### Herman Miller

- **Access:** [Official 3D models and planning tools FAQ](https://www.hermanmiller.com/resources/3d-models-and-planning-tools/faq/).
- **Status:** Lead for branded furniture. Official planning resources and
  material packages were discovered; check the model, software version and
  download terms before use.

## Product and BIM catalogues

### Peppermodern Mozaik Appliance Library

- **Access:** [Repository](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library),
  [manifest](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library/blob/main/MANIFEST.md),
  [specification provenance](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library/blob/main/specs/SOURCES.md),
  [release v1.4.16](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library/releases/tag/v1.4.16),
  [licence explanation](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library#license).
- **Snapshot:** Repository created 27 August 2026; release dated 31 October.
  Current manifest at research time: 57 products, 11 categories, 18 brands.
  The repository tree contained 57 SKP/MOZ pairs and 62 PDFs. Its website and
  repository description still advertised the earlier 36-product count.
- **Coverage:** Appliances, sinks, faucets, showers and tubs; brands include
  Bosch, Brizo, Kohler, Miele, Samsung, Sub-Zero and Wolf. Search by model number.
- **Rights:** Repository-authored content is MIT licensed. Incorporated
  manufacturer assets retain separate ownership; check the per-product source.
- **Use:** Closest discovered match to an open branded household-product
  library. Its [workflow](https://peppermodern.com/resources) uses specifications
  and Claude-written SketchUp scripts. No per-product Ruby builders were found
  in the inspected tree, so published models do not imply reproducible builds.
- **Quality evidence:** The [changelog](https://github.com/fshilmover/Peppermodern-Mozaik-Appliance-Library/blob/main/CHANGELOG.md)
  records discrepancies between manufacturer models and printed dimensions.

### BIMobject

- **Access:** [Kitchen appliances](https://www.bimobject.com/en-us/categories/kitchen/appliances);
  [user terms](https://business.bimobject.com/terms-of-service-eula).
- **Coverage:** Manufacturer-specific appliances, sinks, faucets and many other
  building products, with filters for brand, market and file type.
- **Use:** Inspect the individual product reference, dimensions, edition and
  manufacturer link. The Fisher & Paykel example above demonstrates an exact
  product record. Format and account/download requirements vary.
- **Rights:** The terms define permitted personal/professional building-project
  uses; they are not an open redistribution licence. Check current terms and
  any product-specific conditions before rehosting assets.

### BIMsmith

- **Access:** [Market](https://market.bimsmith.com/), [help](https://bimsmith.com/help),
  [terms](https://bimsmith.com/legal/terms-and-conditions).
- **Coverage/formats:** Manufacturer Revit families, cutsheets, specifications
  and technical data. The inspected brand list included Brizo, Delta, Kenmore
  and LG Air Conditioning Technologies.
- **Use:** Particularly useful when model geometry and specification documents
  are needed together. GE's official Air & Water library uses this platform.
- **Rights:** Proprietary service/content terms; free download does not establish
  permission to publish a derivative asset library.

### BIM.Archiproducts

- **Access:** [Catalogue](https://bim.archiproducts.com/en),
  [15 January 2026 platform explanation](https://www.archiproducts.com/en/news/designing-with-bim-and-3d_108638),
  [new-content newsletters](https://www.archiproducts.com/en/newsletter/bimselection).
- **Coverage:** The January article reports over 240,000 BIM/CAD objects across
  brands and building-product categories, with format filtering and a Revit
  plugin. This is not a count of household appliances or unique SKUs.
- **Use:** Search kitchen, bathroom, furniture and lighting products. The
  platform describes both manufacturer-supplied models checked by its team and
  models made by its team in collaboration with brands.
- **Quality context:** The article acknowledges incomplete families, models
  inconsistent with products and compatibility problems. Check the actual file
  even when a platform advertises verification. Asset rights require inspection.

### AEC-DATA

- **Access:** [Catalogue and updates](https://www.aec-data.com/en/).
- **Snapshot:** Approximately 39,027 products; format counts included 3,475 SKP,
  5,337 OBJ and 43 GLB files. Format counts overlap and are not additive product
  totals. Bathroom facilities were a particularly large category.
- **Coverage:** Brands included Hansgrohe, Grohe, Laufen, Roca, Ravak, Kaldewei,
  Riho and others, alongside furniture and heating products.
- **Recency:** Ravak updates dated 14 October and 29 September 2026; Zehnder
  update dated 10 July 2026.
- **Use:** Search by brand and application; check whether the desired format is
  available for that product. Download access is distinct from open licensing.

### BIMcontent

- **Access:** [Product search](https://bimcontent.com/content/),
  [news and library updates](https://bimcontent.com/news),
  [Revit plugin](https://bimcontent.com/download/bimcontent-add-in-for-revit/),
  [content standard](https://bimcontent.com/news/wp-content/uploads/2025/04/BIMcontent.com-Revit-Content-Standard.pdf).
- **Coverage:** Manufacturer Revit/ArchiCAD libraries, including Australian
  plumbing, washroom equipment and building products.
- **Recent example:** [3monkeez update, 22 May 2026](https://bimcontent.com/news/new-and-updated-revit-content-from-3monkeez/):
  246 Revit families representing 593 model types across eight ranges.
- **Use:** Strong regional source for sinks, taps, waste outlets, washroom
  accessories and related equipment. Family/type counts do not equal unique
  physical products; check the chosen configuration and permitted use.

### Bimroom

- **Access:** [Company and library description](https://www.bimroom.com/company),
  [manufacturer programme](https://www.bimroom.com/manufacturers).
- **Snapshot:** Reports 3,100+ manufacturer objects, 45+ manufacturers and 300+
  generic parametric objects, delivered through a native Revit plugin.
- **Use:** A relevant source and competitor for consistently structured content.
  Verification against manufacturer data is the provider's stated process,
  not an independent geometry audit from this research. Check asset terms.

### NBS Source

- **Access:** [BIM library](https://source.thenbs.com/en/gb/bimlibrary).
- **Coverage:** Generic and manufacturer objects connected to manufacturer
  literature and the NBS BIM Object Standard. This is the current home of the
  former National BIM Library.
- **Use:** Useful when specification integration matters. The BOS mark indicates
  compliance with that library's standard; still verify the required product
  and installation information. Free project use does not itself establish
  open redistribution rights.

### MEPcontent

- **Access:** [Trimble's library description](https://www.trimble.com/en/products/mepcontent).
- **Coverage/formats:** Manufacturer-specific Revit families, AutoCAD content
  and IFC files for MEP work, with category/manufacturer/keyword filtering.
- **Use:** Check country and article identity. The provider describes compact,
  manufacturer-verified and localised content; assess the required asset rather
  than relying on the platform's size claim.

### Bimstore

- **Access:** [Manufacturers](https://www.bimstore.co/manufacturers).
- **Coverage:** Manufacturer BIM objects and Revit families; the discovered
  catalogue includes GROHE, Stelrad and Crane Fluid Systems.
- **Status/use:** Manufacturer-directory finding. Inspect the individual file,
  product identity and terms; no full coverage or licence audit was performed.

### ARCAT

- **Access:** [Residential equipment](https://www.arcat.com/content-type/bim/equipment-11/residential-equipment-113000),
  [residential appliances](https://www.arcat.com/content-type/bim/equipment-11/residential-appliances-113100).
- **Coverage/formats:** Revit and DWG resources organised by CSI divisions,
  with product information and specification material.
- **Use:** Distinguish manufacturer-specific assets from ARCAT-authored generic
  families. The residential-equipment page explicitly links a download licence;
  inspect it before reuse or redistribution.

### RubySketch

- **Access:** [3D library categories](https://3dlibrary.rubysketch.com/categories).
- **Coverage:** Free CAD/BIM model discovery for building and design products.
  [NATSPEC's directory](https://bim.natspec.org/resources/bim-topics/35-object-libraries/208-object-libraries)
  describes Australian product objects in ArchiCAD, Revit, SketchUp and IFC.
- **Status/use:** Discovery lead, not a file-by-file audit. Check current product
  coverage, format and licence rather than assuming an old directory is current.

### ACCA usBIM library

- **Access:** [Catalogue](https://catalogue.accasoftware.com/en/),
  [library description and brands](https://www.accasoftware.com/en/bim-objects-library).
- **Snapshot:** The catalogue displayed 33,250 3D models plus other resource
  types. Brands included Smeg, Whirlpool, KitchenAid, Roca and others.
- **Use:** Additional source for appliances, furnishings and building objects.
  Check the particular download's format and Edificius/software requirements;
  the broad catalogue count is not a count of exact branded household SKUs.

### TiSoft equipment library

- **Access:** [Equipment library](https://www.ti-soft.com/library).
- **Coverage:** Equipment selected by category, brand, series and family, with
  technical characteristics, 3D models and manufacturer documents.
- **Status/use:** Lead for radiators, heat pumps and similar services equipment.
  Investigate export/interchange and TiSoft application requirements first.

### 3Dfindit and CADENAS PARTcommunity

- **Access:** [Official search-filter documentation](https://3dfindit.freshdesk.com/en/support/solutions/articles/103000281170-quick-filter-facets-search),
  [FreeCAD PARTcommunity portal](https://freecad.partcommunity.com/).
- **Coverage:** Manufacturer CAD catalogues, with AEC, BIM interior/furniture,
  MEP and other market filters.
- **Status/use:** Search leads for engineering and building-service components.
  The FreeCAD portal is a CADENAS service, distinct from the openly licensed
  FreeCAD community parts repository. Check format and manufacturer terms.

### Software-specific catalogues

- **[Chief Architect Sub-Zero/Wolf catalogue](https://www.chiefarchitect.com/3d-library/index.php?r=site%2Fdetail%2F1070%2F1000):**
  Free catalogue for Chief Architect/Home Designer; inspected page lists an
  update on 17 April 2026. Inspect compatibility and rights before attempting
  use outside that software.
- **[Chief Architect compact appliances](https://www.chiefarchitect.com/3d-library/index.php?r=site%2Fdetail%2F967%C2%A0):**
  Software-specific small-appliance catalogue; the inspected page listed paid
  or subscription access. A generic catalogue is not exact SKU coverage.
- **[SoftPlan 2026 symbols](https://ww2.softplan.com/?page_id=14460):**
  Describes Kohler linear-drain content and direct insertion of downloaded
  SketchUp symbols. Evidence of another distribution channel, not an open
  cross-application asset library.
- **Miele for CAD Decor/CAD Kuchnie:** See the manufacturer entry above.

## Open datasets and community libraries

### Amazon Berkeley Objects (ABO)

- **Access:** [Dataset and examples](https://amazon-berkeley-objects.s3.amazonaws.com/index.html),
  [AWS registry and licence](https://registry.opendata.aws/amazon-berkeley-objects/),
  [Amazon Science overview](https://www.amazon.science/code-and-datasets/amazon-berkeley-objects-abo-dataset),
  [research paper](https://arxiv.org/abs/2110.06199).
- **Coverage/formats:** 147,702 product listings; 7,953 products have 3D models
  in GLB. Metadata includes product IDs, brands, model information and dimensions.
- **Rights/recency:** CC BY 4.0. The registry explicitly records the change from
  CC BY-NC to CC BY in 2023 and says the dataset is **not updated**.
- **Use:** Strong open product-linked dataset for reusable assets and pipeline
  experiments. It is a historical collection, not evidence that a product is
  still sold or that its installation requirements are captured. Listing count
  must not be mistaken for model count.

### Google Scanned Objects

- **Access:** [Official dataset explanation](https://research.google/blog/scanned-objects-by-google-research-a-dataset-of-3d-scanned-common-household-items/),
  [paper](https://arxiv.org/abs/2204.11918).
- **Coverage/rights:** 1,030 scanned household objects, with metadata, under
  CC BY 4.0. Intended uses include robotics and simulation.
- **Use:** Real object scans can be useful references and reusable geometry.
  This collection does not establish comprehensive current appliance/fixture
  SKU coverage or installation-ready specification data.

### Objaverse and Objaverse++

- **Access:** [Official Objaverse 1.0 site](https://objaverse.allenai.org/objaverse-1.0/),
  [paper](https://arxiv.org/abs/2212.08051),
  [Objaverse++ paper, April 2025](https://arxiv.org/abs/2504.07334).
- **Coverage:** Objaverse advertises 800,000+ annotated objects with names,
  descriptions and tags. Objaverse++ is a quality-annotated curated subset.
- **Use:** Broad candidate discovery and research inputs. Check each source
  asset's licence, scale, identity and quality. Neither dataset's size nor
  curation establishes verified manufacturer/SKU coverage.
- **Unresolved:** The attempted Objaverse-XL project URL was inaccessible during
  research; use current official documentation before relying on XL details.

### TRELLIS-500K and its source datasets

- **Access:** [Microsoft's dataset documentation](https://github.com/microsoft/TRELLIS/blob/main/DATASET.md).
- **Coverage:** Curated asset metadata drawn from Objaverse/XL, ABO, 3D-FUTURE,
  HSSD and Toys4k, filtered for generation tasks. The documented training set
  contains 500,777 assets.
- **Use:** A research corpus, with source datasets as further leads. A training
  collection does not supply a current product-specification catalogue or
  erase the source assets' licence requirements. 3D-FUTURE, HSSD and Toys4k
  were identified here, not individually audited.

### FreeCAD parts library

- **Access:** [Community repository and licence](https://github.com/FreeCAD/FreeCAD-library),
  [official addon listing](https://www.freecad.org/addons.php?lang=en_EN),
  [parametric kitchen component discussion](https://community.osarch.org/discussion/2519/parametric-components-for-kitchens).
- **Coverage/formats:** Community CAD parts; contribution guidance calls for
  FCStd and STEP, optionally STL, with simple editable parametric construction.
  Families include architectural, mechanical, HVAC, hydraulic and piping parts.
- **Rights:** Repository README specifies CC BY 3.0, with attribution to authors.
- **Use:** Useful for editable components and generic parametric objects. Check
  individual product identity; community contribution alone does not establish
  manufacturer approval or current catalogue coverage.

### Sweet Home 3D

- **Access:** [Free models and per-collection licences](https://www.sweethome3d.com/free-3d-models/).
- **Snapshot/formats:** 1,602 ZIP downloads, generally lightweight OBJ/MTL
  models, under Free Art, Creative Commons attribution or other listed free
  licences, depending on collection.
- **Use:** Useful generic interior assets. Inspect the collection's actual
  licence and product identity; a named refrigerator or sink is not automatically
  a documented manufacturer SKU.

### CadCraft LibraryCraft

- **Access:** [Library](https://getcadcraft.com/library),
  [item format and feed](https://getcadcraft.com/library/format),
  [appliances](https://getcadcraft.com/library/browse?category=appliances/residential),
  [plumbing fixtures](https://getcadcraft.com/library/browse?category=plumbing/fixtures).
- **Coverage:** Generic equipment, fixtures and other items, plus credited
  third-party content. Initial landing-page counts differed from the live API;
  query the current catalogue instead of treating that page's totals as current.
- **Format:** Versioned JSON can carry a box or mesh, 2D plan, manufacturer/model,
  dimensions, clearances, service ports, variants, licences and provenance.
  The documented public API/feed permits discovery by other apps.
- **Use:** Useful architecture for interoperable asset records. The appliance
  and fixture samples inspected through the API were CC0 generics with empty
  maker/model fields. Do not infer branded coverage from schema support alone.

### OpeningDesign BIM objects

- **Access:** [Repository and licence](https://github.com/OpeningDesign/BIM_Objects),
  [OSArch discussion of the studio's Revit template](https://community.osarch.org/discussion/349/openingdesigns-open-source-revit-template).
- **Coverage:** An architectural studio's evolving project-object library,
  organised by construction divisions including equipment and plumbing.
- **Rights:** README says CC BY-SA 4.0 unless otherwise noted.
- **Use:** A reusable practice library, not an established comprehensive product
  database. Inspect individual items, exceptions and ShareAlike obligations.

### Woodfine BIM Library

- **Access:** [Catalogue](https://bim.woodfinegroup.com/),
  [platform documentation](https://documentation.pointsav.com/wiki/bim-and-real-property-surfaces).
- **Snapshot:** Seven objects and 18 key plans; structured specification records
  using IFC/Uniclass/DTCG, with a machine-readable surface. The site distinguishes
  BIM object-data and platform-code licences.
- **Use:** An adjacent example of machine-readable building specifications.
  Its small catalogue does not establish a branded household-product library.

### Additional research and generic-asset leads

| Lead | What was found | How to treat it |
| --- | --- | --- |
| [PartNet-derived GitHub collection](https://github.com/iceicepei/PartNet_Dataset) | Hierarchical part/shape segmentation dataset | Shape research; exact product identity and rights need separate inspection |
| [Thingi10K paper](https://arxiv.org/abs/1605.04797) | 10,000 3D-printing models | Mesh/printing benchmark, not a current appliance catalogue |
| [IKEA Object State Dataset paper](https://arxiv.org/abs/2111.08614) | Furniture assembly states, models and pose information | Assembly research; inspect asset access and rights |
| [M3DLayout retrieval repository](https://github.com/Graphic-Kiliani/Object-Retrieval-Layout2Scene) | Indoor-object retrieval across categories including appliances | Layout/retrieval lead; no verified brand/SKU catalogue established |
| [ASOS dataset preprint](https://www.preprints.org/manuscript/202502.0900) | Physical supermarket objects and 3D models | Adjacent research, not installed appliance/fixture coverage |
| [3DAssets home appliances pack](https://3dassets.dev/packs/home-appliances-and-utility) | Search result advertised CC0 generic appliance assets | Inspect files, current licence and dimensions; no verified SKUs |
| [1DesignTool appliance set](https://1designtool.com/3d/models/kitchen-appliances) | Generic low-poly GLB set; custom licence excludes standalone redistribution | Scene prop lead, unsuitable as proof of exact product coverage |
| [notjustchairs kitchen dataset](https://notjustchairs.ai/datasets/kitchen) | Kitchen object/appliance mesh collection with claimed QC | Inspect licence, files and identity; search lead only |

ShapeNet also appeared in research-paper comparisons. No evidence from those
comparisons established current exact appliance/fixture SKUs or sufficient
redistribution rights; inspect the original dataset terms if pursuing it.

## Retailer tools and restricted asset collections

### IKEA import tools

- **Access:** [IKEA download-button repository](https://github.com/apinanaivot/IKEA-3D-Model-Download-Button),
  [Blender IKEA Browser](https://extensions.blender.org/add-ons/ikea-browser/),
  [Firefox IMD extension](https://addons.mozilla.org/en-US/firefox/addon/imd-3d/),
  [Chrome downloader listing](https://chromewebstore.google.com/detail/ikea-3d-model-downloader/cfejhlbbbknglhfhgamjoimnanmoopje).
- **Capability:** Download/import existing retailer GLBs for products that offer
  a 3D view. The script names downloads using product name and colour; its README
  records a 30 January 2026 bug fix. Blender's extension page notes incomplete
  availability across IKEA products.
- **Rights/use:** Open-source tool code does not make the downloaded models open
  assets. The script's README specifies personal home planning and refers users
  to IKEA's terms. Inspect actual asset availability and intended use before
  choosing this route; these tools were not installed or exercised in research.

### Lowe's Open Builder

- **Access:** [Official project description](https://www.lowesinnovationlabs.com/projects/3d-product-visualization),
  [catalogue](https://www.lowesopenbuilder.com/),
  [licence terms](https://www.lowesopenbuilder.com/terms/).
- **Coverage:** Lowe's describes more than 500 free product assets including
  lighting, patio furniture, rugs and kitchen/bath accessories, introduced in 2022.
- **Rights/use:** Published terms specify personal/non-commercial use and
  restrict standalone redistribution. Despite the name, this is not a general
  open-asset foundation for a new catalogue. The description's historic asset
  count is not a verified current inventory of working downloads.

### Other commercial and community discovery sources

- **[SketchUp 3D Warehouse](https://3dwarehouse.sketchup.com/):** Check
  manufacturer collections as well as community uploads. Verify the uploader,
  exact model and dimensions; a complete kitchen scene or a similar-looking
  appliance does not establish a match to the specified product.
- **[Sketchfab appliances](https://sketchfab.com/tags/appliances):** Further
  per-asset discovery; inspect the original licence, author, scale and SKU.
- **[3D CAD Browser appliances](https://www.3dcadbrowser.com/3d-models/appliances):**
  Search results included named products and several exchange formats, with
  mixed free/paid access. A title alone does not verify specification accuracy.
- **[KitchenBuilder GitHub app](https://github.com/mrdakj/KitchenBuilder):**
  Credits several bundled Sketchfab appliances under CC BY 4.0, including a
  KitchenAid mixer. Useful attribution/source leads, not a demonstrated current
  multi-brand specification library.
- **[Boracity](https://www.boracity.com/about), [products](https://boracity.com/products):**
  Search results described a studio founded in January 2026 and a Revit-family
  marketplace. Direct retrieval returned 403. Treat claims, counts, product
  identity and licensing as unresolved leads.
- **[Free Foundry](https://freefoundry.net/resources/):** Search result describes
  open 3D-printable appliance replacement parts. Repair components are distinct
  from full appliance models; inspect files and licences if relevant.

## Architecture, design and research reading

These explain the landscape or provide discovery routes. Follow their links to
the actual asset provider before downloading or making licensing decisions.

| Reading | Date/status | Relevance |
| --- | --- | --- |
| [Archiproducts: Designing with BIM and 3D](https://www.archiproducts.com/en/news/designing-with-bim-and-3d_108638) | 15 January 2026 | Provider description of its catalogue, quality problems and model creation with brands |
| [BIMcontent: new 3monkeez Revit content](https://bimcontent.com/news/new-and-updated-revit-content-from-3monkeez/) | 22 May 2026 | Concrete recent plumbing-library expansion |
| [CAD Projekt: new Miele database](https://www.en.cadprojekt.com.pl/new-database-with-reliable-miele-equipment/) | 18 June 2025 | Recent appliance catalogue in specialist design software |
| [NATSPEC object-library directory](https://bim.natspec.org/resources/bim-topics/35-object-libraries/208-object-libraries) | Background directory; some links are historical | Editorial quality varies; useful regional and vendor discovery |
| [Harvard Loeb Library: materials databases](https://guides.library.harvard.edu/c.php?g=310640&p=8236707) | Research guide | Architectural product, manufacturer and specification discovery |
| [ArchDaily BIM product catalogue](https://www.archdaily.com/catalog/en/bim) | Live product-discovery page | More manufacturer/BIM leads, including bathroom and lighting products |
| [Creative Bloq: IKEA downloader](https://www.creativebloq.com/3d/free-ikea-3d-model-downloader-is-a-goldmine-for-interior-design-planning) | 31 January 2026 | Design-workflow coverage; verify rights using the original tool/retailer |
| [3Druck: IKEA downloader](https://3druck.com/en/programs/ikea-3d-model-downloader-open-source-script-saves-furniture-models-as-glb-files-59158436/) | 12 June 2026 | Additional coverage of the GLB extraction route |
| [Flameeyes: furniture websites to Sweet Home 3D](https://flameeyes.blog/2025/01/19/from-furniture-websites-to-sweet-home-3d/?amp=1) | 19 January 2025; discovery lead | Practical furniture-import discussion |
| [OSArch: OpenBIM](https://wiki.osarch.org/openbim/) | Background explanation | Open interchange standards and open-source asset rights are separate concepts |
| [Metsä Wood and ProdLib](https://www.metsagroup.com/metsawood/news-and-publications/news/2019/free-downloadable-open-source-wood-3d-design-objects-for-bim-and-cad-software/) | 10 December 2019 | Adjacent manufacturer-product distribution and timber design initiative |
| [AEC Magazine archive](https://aecmag.com/magazines/) | Industry-reading lead | Useful for following new BIM/AI platforms; no household-product library was established from the archive itself |

Community threads also surfaced practical sourcing and quality problems. They
are discovery context, not proof of geometry, licensing or complete coverage:

- [SketchUp: manufacturer downloads](https://www.reddit.com/r/Sketchup/comments/1dzspp5/does_anyone_know_of_more_companies_that_allow_you/).
- [BIM: family-library sources](https://www.reddit.com/r/bim/comments/13qa1qz/bim_families_sites_to_download_models/).
- [Bimroom launch/feedback](https://www.reddit.com/r/bim/comments/1nqvs6h/community_feedback_needed_bim_object_library_and/).
- [Fusion: kitchen-appliance libraries](https://www.reddit.com/r/Fusion360/comments/1glpr61).
- [Cabinet Vision: appliance/material sources](https://www.reddit.com/r/CabinetVision/comments/1p7ahsl/best_place_to_download_appliance_and_material/).
- [BIM: commercial kitchen files](https://www.reddit.com/r/bim/comments/1tm601y/looking_for_bim_files/).

## Maintaining this index

Add newly useful public sources here, with the inspection date, supported
formats, identity evidence and licence link. Keep unresolved discoveries marked
as leads until inspected. Prefer original providers over reposted asset packs.
Recheck live licences and product availability when selecting a model; preserve
the historical date when retaining an old inventory or release count.

If evaluating a new shared library, measure exact SKU coverage, supported
interchange formats, documented versus inferred dimensions, asset rights and
rebuildability. A small pilot should test real product sourcing before promising
complete brand catalogues. Keep project selections, downloads and any customer
or property context outside this public index.
