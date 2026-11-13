# Accuracy, evidence and recovery

A model can be internally consistent and still misrepresent the room. Tests of dimensions,
serialization and rendering establish software behavior; they do not establish site accuracy.
An observed appearance, an installed manufacturer identity and a proposed purchasable match
are separate claims. Selecting a substitute must not reshape the observed object.

## Reviewing a model

MODEL's **UNCERTAINTY** view shades geometry by its saved evidence:

| Color | Meaning |
| --- | --- |
| Teal | Observed, with a source reference |
| Amber | Inferred |
| Purple | Unknown or no evidence recorded |
| Rose | The geometry changed after its evidence review |

The layer changes mesh/point drawing materials and splat tint temporarily. It does not remove uncertain objects,
change saved finishes, or make uncertain product identities determine geometry confidence.
The normal visibility, tag and section controls still apply. A source reference is a review
record, not an automated validation of that source. Legacy objects start unknown.

The inspector records geometry evidence. Changes to an opening’s host wall or a room’s level
datum also invalidate a review made against that host. Inferred doorway floor patches stay
inferred even when the neighboring floor region has been observed. Component product links can retain an observed
identity and a separate proposed match. Material identities and proposed matches are separate
too. Product names alone do not verify installed identity. Imported unsupported fixture
subtypes retain their names; invalid confidence becomes unknown, with the original value
retained. Defaulted or adjusted dimensions remain reviewable.

## Geometry and dimensions

- Level height means finished floor to finished ceiling underside. The ceiling slab extends
  upward from that datum.
- Interior doorway thresholds receive floor only when floor regions exist on both sides
  across the doorway. Explicit voids and `floorContinuity: false` prevent bridging. This is
  not a substitute for reviewing steps, exterior thresholds and actual finish transitions.
- Opening `width` and `height` describe the wall opening. Door slab width is derived
  separately, including jambs, gaps and leaf count. The inspector and tape-reading targets can accept a slab width per leaf
  and convert it to the wall opening. Existing `width` readings remain wall-opening readings;
  they are never silently reinterpreted from their free-text description. It is not a measurement of usable passage clearance.
- Overlapping stored openings remain represented at their stored width and are reported.
  Wall solids use the union of their cuts. Manual resizing refuses overlap atomically.
- Opening profiles expose jamb, casing, sash, frame, muntin and leaf sizes, grid counts,
  door face and hardware choices. Unspecified profiles remain provisional. A flat door or
  ungridded window is not evidence that the real object has that configuration.

Applied tape readings return to review when the target changes or disappears. Geometry edits
retain the original reading. Takeoff scopes keep a source revision and display stale or
unverified status without overwriting manually edited quantities.

## Lighting and exchange

Lighting is illustrative. Estimated fixture output, fallback illumination, exposure, source
limits and lack of photometric validation prevent claims about illuminance or lighting design.
Fallback light does not create a visible fictional fixture. Imported lamp positions and
visibility are refreshed after object edits.

The SketchUp bridge remains limited. Supported group placement and parameter changes can
be read back. Vertical wall/room moves and detected local face edits block automatic rewrite
and are reported. Prior files are retained before browser-managed rewrites. Older mirrors
without face fingerprints have less change detection; retained copies are essential.
The mirror's simplified panes and room floors are not equivalent to the browser's complete
rendered assemblies. This is not full bidirectional fidelity.

Static GLB exports embed an evidence manifest; other export routes offer a companion
`.evidence.json` download. It contains element IDs, linked specifications, source references
and uncertainty metadata. Keep it beside the model. SketchUp exports retain source definition
IDs so a new SketchUp GUID need not break identity. GLB imports retain embedded evidence for
review. Reconverting changed node paths archives prior object edits and evidence instead of
silently attaching them to unrelated objects; reviewing that mapping is still necessary.

## Persistence and access

Project serialization follows direct product references, including proposed matches and
recoverable scopes. Deleting a scope must not discard product specifications still used by
the model. Linked products cannot be removed until their links are removed.

PROJECTS and PRODUCTS expose removed-record recovery. Saved conflict copies can be compared
and restored; the current workspace is preserved first. Restoration keeps original IDs and
refuses to overwrite an existing removed-record ID. Research history can be browsed and
unused finished jobs removed; jobs linked to current product records are protected.

Project documents are served through authenticated, project-scoped routes. Traversal,
symlinks escaping the project, executable files and unmounted projects are refused.

An unavailable Mac can show a read-only saved plan and project summary. It is a browser
snapshot, not a complete offline 3D/document viewer. Shell caching needs a secure origin
(localhost or HTTPS); an ordinary remote HTTP origin cannot install a service worker.
Unsent changes remain in their existing recovery store. Offline viewing never creates a
second writable workspace.

## Performance and completion checks

Video intake keeps file-backed blobs and hashes/uploads bounded slices. A freshly validated
mesh is reused for its first display. Secondary pages load on demand, and fixture-only edits
reuse the rest of the built model. These remove specific allocations and rebuilds; they do
not establish acceptable peak memory on every phone. Large mesh parsing, material changes
and changes with structural dependencies still warrant representative device measurements.

Completion requires following each discrepancy through its source, stored representation,
transformation and output. Record what was reproduced, its cause, the correction and a
regression that would fail without it. An unresolved cause remains unresolved even if a
retry passes. Browser capability skips must be distinguished from exercised paths; desktop
WebKit is not evidence of real-phone performance. Keep physical observation gaps separate
from software defects, and never use an instruction permitting a generic object as evidence
that the object is accurate.

The earlier intermittent kept-copy failure has not been assigned a proven root cause. Its
regression now checks server state before and after reconnection, proves that the injected
storage-read failure occurred, and waits for sync to settle. Those checks distinguish a
closed-page upload from unreadable-store replay; a later pass alone does not explain the
original failure. Touch-layout checks separately wait for raw device emulation and app state.

Service workers bypass Playwright's request interception. Fault-injection suites explicitly
block workers and assert that blocked writes were intercepted; the dedicated uncertainty and
offline browser journey runs the real worker. This keeps simulated network failures distinct
from real offline-cache behavior.
