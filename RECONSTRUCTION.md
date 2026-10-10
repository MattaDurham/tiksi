# Local photo reconstruction

Tiksi's PHOTO TO 3D view reconstructs real geometry from overlapping photographs using
Apple RealityKit Object Capture on a supported Mac. Processing uses the Mac's CPU/GPU;
phone browsers can upload photographs and inspect results through the local server or
Tailscale. Keep the Mac awake. GitHub Pages serves the browser app but cannot run this
native engine.

From an isolated Tiksi worktree, build the worker for the same state directory used by
the local server:

```sh
python3 tools/build-reconstruction.py --state-dir .tiksi-state
python3 tools/serve.py --port 8643 --state-dir .tiksi-state
```

The build needs Apple's Xcode Command Line Tools (`xcode-select --install`) and a
supported macOS Object Capture device. The build command checks hardware availability;
the UI reports unavailable engines instead of simulating a model. The Swift worker uses
only Apple's system frameworks. No third-party photogrammetry package, paid API key or
cloud upload is required. Framework distribution remains subject to Apple's platform
licenses; Tiksi's source retains the repository license.

Open PHOTO TO 3D from PHOTOS. Select original JPEG, PNG, HEIC/HEIF or TIFF files or photos
already stored in this property's library. Use 60–150 sharp, overlapping photos around a
stationary object or smaller site section, at two or three heights. Poorly textured,
reflective, moving or blurred subjects often fail. One photo or one panorama does not
provide enough viewpoints. HEIC uploads directly to the engine even where a browser
cannot preview HEIC. Photo library imports preserve original bytes, camera metadata,
resolution and transparency; only their gallery thumbnails are resized. Photos saved by
older Tiksi versions may already have been reduced to 2048 pixels: reimport originals.

Preview and reduced offer fast checks; medium, full and raw request more detail. The
engine can downsample when hardware memory is insufficient, and these notices appear
with the job. Tiksi does not resize inputs or decimate the output mesh. Native matching
runs one job at a time, outside the web server. Users can cancel the actual worker during
reconstruction or conversion. Jobs interrupted by server shutdown report interrupted.

Review reconstructed geometry and textures in 3D, save a self-contained GLB, or import it
as a scan into the current property. GLB retains native vertex positions, normals, UVs,
diffuse textures, normal maps, ambient occlusion and roughness maps. Full/raw output can
also include EXR displacement maps: glTF does not apply these maps, so the job explicitly
reports this limitation. Save native OBJ and maps to retain the complete original output,
including displacement, for tools that support it.

Ordinary RGB photographs cannot establish reliable real-world units or survey coordinates.
Depth-equipped HEIC capture can provide scale. Always check a known measurement and align
the imported scan in MODEL. This implementation creates a textured mesh; georeferenced
maps, multi-section registration and Gaussian splat training are separate workflows.

Uploads and models stay under the chosen local instance's private state directory,
separate from browser property saves. Removing a job deletes its local upload copies and
engine output; already imported scans and the original files remain. Each job accepts
20–300 photos, 60 MB per image and 2 GB total. At most 20 jobs are retained, one is processed
at a time, native processing times out after two hours, and model conversion after five
minutes. The GLB browser import limit is 600 MB. Large raw jobs may require substantial
memory, and phone viewing may need a reduced result. Back up exported projects/models;
a local instance is not automatic cloud backup.

The API uses an instance token, same-origin requests and host validation through the local
server. It accepts photo bytes and fixed quality settings, never arbitrary command or
filesystem paths. Capture data, generated models, native binaries and engine logs belong
in ignored instance state, not Git. Tests use temporary synthetic data and worker processes.

Primary references:

- [Apple photogrammetry command-line sample](https://developer.apple.com/documentation/realitykit/creating-a-photogrammetry-command-line-app)
- [Apple PhotogrammetrySession](https://developer.apple.com/documentation/realitykit/photogrammetrysession)
- [Apple photo capture guidance](https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture)
- [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)

Actual engine verification used Apple's published Rock36Images HEIC sample and OpenMVG's
Palm Desert Micro21 DJI scene dataset in temporary storage outside the repository. The
Apple sample produced 25,000 preview triangles with 1024-pixel texture, and 100,000 full
triangles with 4096-pixel diffuse, normal, AO and roughness maps. The 21-image outdoor scene
produced a textured terrain model. These fixtures are not redistributed in Git. Outputs
were decoded and rendered through Tiksi's actual GLB importer, not only checked for file
existence. See tests for bounded uploads, lifecycle, cancellation, failures and API security.
