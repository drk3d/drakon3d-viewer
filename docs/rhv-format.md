# `.rhv` — byRhinoView session package

Authoritative contract for the `.rhv` container. **Two independent producers write
this format** and they must not drift:

| Producer | Language | Entry point |
|---|---|---|
| Viewer "Save session" | JS | `buildSessionBuffer()` — `www/session.js` |
| Rhino export plugin | C# | `RhvWriter.Write()` — `rhino-plugin/src/RhvWriter.cs` |

The single reader is `loadSession()` in `www/session.js`.

Change this document **first**, then both producers, then the reader.

---

## 1. Byte layout

A `.rhv` file is a gzip stream wrapping an `RV3D` container. The gzip wrapper is
optional on read (detected by magic `1f 8b`) and always written.

```
RV3D container
┌────────────┬──────────┬────────────────────────────────────────────┐
│ offset     │ size     │ field                                      │
├────────────┼──────────┼────────────────────────────────────────────┤
│ 0          │ 4        │ magic — ASCII "RV3D" (52 56 33 44)         │
│ 4          │ 4        │ containerVersion — uint32 LE               │
│ 8          │ 4        │ jsonLength — uint32 LE, bytes              │
│ 12         │ jsonLen  │ metadata — UTF-8 JSON, no BOM              │
│ 12+jsonLen │ rest     │ payload — a complete GLB (glTF 2.0 binary) │
└────────────┴──────────┴────────────────────────────────────────────┘
```

There is no length field for the GLB — it runs to end of container.

### `containerVersion`

Describes the **byte layout above only**, not the JSON contents. Current value: `1`.

Bump *only* for a layout change (e.g. adding a chunk table). A reader that sees a
`containerVersion` above the highest it knows **must hard-fail** — it cannot locate
the fields. Everything additive belongs in the JSON instead, so in practice this
should stay at `1` for a long time.

---

## 2. Metadata JSON

### Versioning fields

```json
{
  "version": 4,
  "minViewerSchema": 3,
  "producer": {
    "name": "byRhinoView.RhinoExport",
    "version": "0.1.0",
    "host": "Rhino 8.14 (win)"
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version of this document. Monotonic. Informational for the reader. |
| `minViewerSchema` | The oldest schema a reader must fully understand to render this file **correctly**. |
| `producer` | Free-form provenance. Never drives behaviour — it exists so a bug report identifies which writer produced the file. |

`version` alone cannot answer "can I open this?", which is why `minViewerSchema`
exists. Reader rule:

```
magic != "RV3D"                        → not a package (try legacy JSON-only path)
containerVersion > MAX_CONTAINER       → hard fail  "newer container"
minViewerSchema > CURRENT_SCHEMA       → hard fail  "newer schema"
version > CURRENT_SCHEMA               → load, warn "some settings ignored"
otherwise                              → load
```

Consequence: **additive changes must not raise `minViewerSchema`.** Adding a new
settings key, a new annotation type, or a new producer field keeps
`minViewerSchema` where it is, so older viewers keep opening new files and simply
ignore what they don't know. Raise it only when an old reader would render the file
*wrong* rather than merely incomplete — e.g. if the meaning of an existing field
changes, or geometry starts relying on a glTF extension.

Missing `minViewerSchema` (files written before schema 4) is read as `3`.

### Content fields

All optional unless noted. Anything absent falls back to the viewer's default.

| Field | Type | Notes |
|---|---|---|
| `displayMode` | string | `wireframe` \| `shaded` \| `arctic` \| `rendered` \| `technical` |
| `settings` | object | See `buildSessionBuffer()` for the full key list. The plugin writes only the subset it can derive from the document. |
| `settings.modelUnit` | string | Restored early — drives the File Info panel. |
| `cameraState` | object | `{ position[3], target[3], up[3], projection }`, `projection` = `perspective` \| `parallel` |
| `parsedLayers` | array | **Required for layer UI.** See §3. |
| `parsedAnnotations` | array | See §4. |
| `rhinoNamedViews` | array | `{ name, position[3], up[3], target[3] }` |
| `namedViews` | array | Viewer-authored views. Plugin writes `[]`. |
| `customMaterials` | object | Viewer-side per-object overrides. Plugin writes `{}`. |
| `hiddenKeys` | array | Viewer-side hidden objects. Plugin writes `[]`. |
| `completedMeasurements` | array | Plugin writes `[]`. |
| `notes` | array | Plugin writes `[]`. |
| `customHdrData` / `customHdrName` | string \| null | Base64 HDR/EXR. Plugin writes `null`. |

---

## 3. `parsedLayers`

```json
{
  "index": 0,
  "name": "Walls::Exterior",
  "color": { "r": 200, "g": 200, "b": 200, "a": 255 },
  "visible": true,
  "parentLayerIndex": -1,
  "customMaterial": null,
  "originalCustomMaterial": null
}
```

- `name` is the **full path** with `::` separators, matching Rhino's `Layer.FullPath`.
- `color` components are 0–255 **sRGB**.
- `parentLayerIndex` is `-1` for root layers.
- `index` must match the `attributes.layerIndex` written into GLB node extras (§5).
  This is the join key for the whole layer UI — get it wrong and layer visibility
  silently controls the wrong objects.
- `customMaterial` is the layer's render material, or `null`. When present it must
  carry at least `color` as `#rrggbb`. `originalCustomMaterial` is an untouched copy
  used by the Reset button, so the two must be equal at write time.

## 4. `parsedAnnotations`

Two shapes, discriminated by `type`.

```json
{ "type": "TextDot", "text": "…", "position": [x,y,z],
  "layerIndex": 0, "objectColor": {"r":0,"g":0,"b":0,"a":255}, "visible": true }
```

```json
{ "type": "Text", "geomType": "TextEntity", "isDimension": false,
  "text": "…", "position": [x,y,z],
  "xAxis": [1,0,0], "yAxis": [0,1,0], "zAxis": [0,0,1],
  "textHeight": 1.0, "dimPoints": null,
  "layerIndex": 0, "objectColor": {…}, "visible": true, "isBold": false }
```

`textHeight` must already be resolved through the dimension-style parent chain — the
viewer does not resolve it.

---

## 5. GLB payload

A complete, self-contained glTF 2.0 binary. The viewer hands it to `GLTFLoader` via
`loadGeometryFromGLB()`.

Four rules the writer must honour. Each of these is a silent-corruption bug if
missed, not a load failure:

**5.1 — Z-up, no axis conversion.** glTF nominally specifies Y-up, but this viewer
works entirely in Rhino's Z-up space (camera up is forced to `[0,0,1]`, the ground
plane and named views assume it). Write Rhino coordinates verbatim. Do **not** apply
the usual Z-up→Y-up rotation.

**5.2 — Linear material colours.** `loadGeometryFromGLB()` calls
`postProcessModel(..., colorsAreSRGBStoredAsLinear = false)`, i.e. GLB colours are
taken as already-linear. `pbrMetallicRoughness.baseColorFactor` must therefore be
**linear**, so convert Rhino's sRGB colours on the way out. Skipping this makes the
model visibly brighter than the same file opened as `.3dm`.

**5.3 — Per-node `extras.attributes`.** Every renderable node carries:

```json
{ "attributes": {
    "id": "5f2c…",  "name": "…",  "layerIndex": 3,  "visible": true,
    "objectColor": { "r": 255, "g": 0, "b": 0, "a": 255 },
    "colorSource": 0, "materialSource": 0,
    "isInstanceDefinitionObject": false,
    "userStrings": { }
} }
```

`GLTFExporter` writes `object.userData` to node `extras` and `GLTFLoader` reads it
back, so this round-trips as `child.userData.attributes` — which is what
`postProcessModel()` reads.

`layerIndex` is mandatory. `colorSource`/`materialSource` use Rhino's enum values
where `0` means "from layer"; the viewer branches on that to decide whether an
object follows its layer colour.

**5.3b — Textures.** Images must be embedded as `bufferView`s (never external
URIs — the package has to stay self-contained) and must be `image/png` or
`image/jpeg`, the only two formats glTF allows. Rhino documents freely reference
TIFF/TGA/BMP, so a writer has to convert. A material carrying a
`baseColorTexture` is only useful if the primitives using it also write
`TEXCOORD_0`; Rhino's V axis runs opposite to glTF's, so UVs need `v → 1 - v`.

**5.3c — Quantization (optional).** Attributes may use normalized integer types
via `KHR_mesh_quantization`, which must appear in **both** `extensionsUsed` and
`extensionsRequired` — the data is unreadable without it. `three.js` GLTFLoader
supports it.

The writer's scheme: `POSITION` as normalized `SHORT` mapped from each mesh's own
bounding box, `NORMAL` as normalized `BYTE` padded to a 4-byte stride, indices and
`TEXCOORD_0` left alone (Rhino UVs routinely exceed `[0,1]` for tiling, which
normalized types cannot express). Accuracy is ~1/32767 of a mesh's extent.

The catch: the transform that undoes position quantization has to be composed
into **every node referencing that mesh**, or the geometry lands at the wrong
place and scale. Instanced meshes therefore get
`instanceXform * leafXform * dequant`. A quantized mesh referenced by a node with
no `matrix` is a bug.

**5.3d — Precomputed edges (optional).** A writer may ship edge geometry so the
viewer does not run `EdgesGeometry` per mesh at load — measured at 82% of load
time on an 18k-mesh model. Each edge object is a **child of the mesh node** (the
viewer looks it up with `mesh.getObjectByName('rhino-edges')`, which only searches
that mesh's descendants) and uses primitive **mode 1 (LINES)**, since GLTFLoader
maps mode 1 to `LineSegments` and mode 3 to `Line`.

The edge node **must** carry `extras.role = "rhino-edges"`:

```json
{ "name": "rhino-edges", "mesh": 42, "extras": { "role": "rhino-edges" } }
```

The name alone is not sufficient. GLTFLoader passes every node name through
`createUniqueName()`, so a file with N edge objects loads as one `rhino-edges`
plus `rhino-edges_1`, `rhino-edges_2`, … Since the viewer matches that name
exactly in a dozen places, relying on the name leaves **one** object with working
edges and turns the rest into loose selectable curves. `extras` is copied to
`userData` verbatim and never rewritten, so the viewer renames from the role on
load.

Two further constraints:

- **Quantization interaction.** Edge geometry is unquantized, but glTF composes
  transforms down the hierarchy — so under a quantized parent the child must carry
  the *inverse* of the parent's dequantization matrix, or the edges are scaled and
  offset by it.
- **Prefer real topology.** Brep edges are exact; `EdgesGeometry` is a
  dihedral-angle heuristic over the tessellated mesh. When edges come from
  topology there is no threshold to re-apply, and the viewer disables its
  edge-angle slider accordingly. Pure `Mesh` objects have no topology to read —
  writing dihedral edges for them is the case where edge data can exceed the
  geometry it describes, so it is better to write nothing and let the viewer build
  them on demand.

**5.4 — Nothing else in `userData`.** The viewer strips `originalMaterial`,
`renderedMaterial`, `shadedMaterial`, `materialColor` (per mesh) and `materials`,
`layers`, `groups`, `settings`, `warnings`, `objectType` (root) before its own
export, because they balloon the JSON chunk. The plugin must not write them either.

### Blocks

Rhino instance references are expanded into a node subtree per instance. Members
carry `attributes.isInstanceDefinitionObject = true`, and the group node carries the
*instance's own* `layerIndex` so that hiding the layer the instance sits on hides the
whole instance.

Where a definition is placed many times, reuse the same glTF `mesh` index across
instance nodes. glTF node reuse is what keeps a 463k-object file tractable — see
`sample_3dm/RhinoSample-Architecture-LCT-Mesh-RenderMode.3dm`.

---

## 6. HTML package

Both producers can also emit a single self-contained `.html`: the prebuilt
`viewer-shell.html` (from `npm run build:shell`) with the gzip'd RV3D container
injected at the `/*__RHV_PACKAGE__*/` placeholder.

> **`viewer-shell.html` is a build artifact of `www/`, and nothing rebuilds it
> automatically.** Every package embeds a whole copy of the viewer, so a stale shell
> means packages ship stale viewer code — with no error and no obvious symptom
> beyond "the package behaves like an older build". Run `npm run build:shell` after
> changing anything under `www/`, and bump the version tag in `index.html` when the
> change matters, since that tag is what identifies the shell.

| Global | Contents |
|---|---|
| `window.__RHV_PACKAGE__` | base64 of the container |
| `window.__RHV_PACKAGE_ENCRYPTED__` | `{v,salt,iv,data}` instead, when a password is set |
| `window.__RHV_PACKAGE_NAME__` | display name, e.g. `"model.rhv"` |
| `window.__RHV_HIDE_FILE__` | `true` to hide the File menu |

If the placeholder is absent, inject a `<script>` before
`<script type="module" id="app-bundle">`.

### Where the base64 goes

Those globals are the reader's contract and do not change. **How** the base64 gets
into them does matter for performance: a JavaScript string literal has to be
tokenised by the JS parser, which costs about **1 second per 70 MB**. The same bytes
as inert character data cost about **25 ms**.

So writers put the payload in an inert element and assign from it:

```html
<script id="rhv-payload" type="text/plain">H4sIAAAA…</script>
<script>
  var _p = document.getElementById("rhv-payload").textContent;
  window.__RHV_PACKAGE__ = _p;                       // or {…, data:_p} when encrypted
  window.__RHV_PACKAGE_NAME__ = "model.rhv";
</script>
```

Since the placeholder sits *inside* `<script id="rhv-package">`, the injected text
begins with `</script>` to close it. That is safe: the HTML parser ends a script
element at the first `</script`, and the base64 alphabet contains no `<`, so the
inert block cannot terminate early.

With a password, only the ciphertext moves out — `salt` and `iv` are a few bytes and
stay inline.

**Both forms must keep loading.** The reader is unchanged, so packages written as a
literal (anything produced before this was documented) still open. A writer emitting
a literal is not broken, just slower — `validate-rhv.mjs` warns rather than fails.

### Replace the FIRST occurrence only

`viewer-shell.html` contains `/*__RHV_PACKAGE__*/` **three times**: once at the real
injection site, and twice as string literals inside the minified bundle — that being
the viewer's own copy of this same logic.

JavaScript's `String.replace(stringPattern, …)` replaces only the first match, which
is what the viewer relies on. C#'s `String.Replace` replaces **all** of them, and
doing so injects the payload into the middle of the bundle's own JavaScript, breaking
its syntax. The package then loads with no error and never boots.

Encryption is AES-256-GCM with a PBKDF2-SHA256 key: **200,000 iterations**,
16-byte salt, 12-byte IV, 128-bit tag **appended to the ciphertext** (WebCrypto's
layout). All three blobs are base64. These constants are the entire compatibility
contract between the C# writer and the browser's WebCrypto reader — the plugin and
viewer are independent implementations, so changing any of them breaks existing
packages. `rhino-plugin/tools/crypto-compat/` verifies the two against each other.

## 7. Compatibility notes

- The viewer's own `.rhv` writer never populates `producer`; treat its absence as
  "written by the viewer".
- Files written before schema 4 have no `minViewerSchema`; read as `3`.
- The reader must tolerate a `.rhv` whose GLB contains no meshes (empty document).
