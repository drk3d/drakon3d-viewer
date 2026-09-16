# How Edges Work

Drakon3D draws a black outline along the edges of your model. This page explains
where those lines come from, why they sometimes differ between two files of the same
model, and what the **Edge Angle** slider actually does.

## The two kinds of edges

| | Exact edges | Computed edges |
|---|---|---|
| **Come from** | Rhino's own surface boundaries | The triangle mesh |
| **Used for** | Breps, extrusions, polysurfaces | Meshes, SubD, anything from STL / 3MF / GLB / STEP |
| **Accuracy** | Follows the true curve at any zoom | Follows the tessellation |
| **Edge Angle slider** | Filters them (exported files only) | Decides which ones exist |

**Exact edges** are the real boundaries Rhino stores with a surface. They stay smooth
however far you zoom in, and they include edges that meet at a shallow angle — the two
sides of a fillet, a tangent join between lofted patches.

**Computed edges** are found by looking at the mesh: wherever two triangles meet at a
sharp enough angle, a line is drawn. This is the only option for geometry that has no
surface data, such as an STL file.

A single model can use both at once. Each object gets whichever applies to it.

## Where your edges come from

**Exported from Rhino (`.rhv`)** — Every Brep carries its exact edges, measured by the
export plug-in. This is the most accurate result and the fastest to open, because the
viewer has no edges to calculate.

**A `.3dm` opened directly** — The viewer reads the exact edges out of the file itself
while it loads. The result matches an exported file, with one difference: the browser
cannot measure the angle at each edge, so the Edge Angle slider is greyed out (see
below).

**Everything else (STL, 3MF, GLB, STEP/IGES)** — There are no surfaces in these formats,
so every edge is computed from the mesh using the Edge Angle threshold.

**Rhino Mesh objects** are computed like any other mesh, using the Edge Angle
threshold. On faceted geometry — a massing study, a block model — that gives you the
same crisp outline a Brep would. On a dense scan or an imported tree it can look busy;
raise Edge Angle until only the edges you want survive.

**Point clouds get no edges**, since there are no triangles to find an angle between.

## The Edge Angle slider

The slider means the same thing in both cases — *how sharp does an edge have to be to
count?* — but it does a different job depending on what it is working with.

**Filtering exact edges (exported files).** Every edge is already there; the slider
hides the ones below the threshold. Raise it to remove tangent joins and clean up a busy
model, lower it to show every boundary. Nothing is recalculated, so the slider responds
as you drag it and the curves stay exact at any setting. Naked edges — boundaries with
nothing on the other side — are always shown.

**Generating computed edges.** The threshold decides which lines are created at all.
Moving the slider rebuilds them, so the change lands when you release it rather than as
you drag.

**Greyed out.** The slider is disabled when nothing in the model responds to it — most
commonly a `.3dm` of Breps opened in the viewer, where every edge is exact but has no
angle recorded. Hover it for the reason. To get the slider back on that model, export it
from Rhino as a `.rhv`.

## Large models

Calculating edges from a mesh is the slowest part of opening a file, so if a model would
need a lot of it, Drakon3D opens with edges switched off and tells you so.

Turn **Edges** back on under Settings → Visibility whenever you want them. The
calculation runs then, with a progress indicator, and the result stays for the rest of
the session. Objects that already carried exact edges appear immediately.

This is also why an exported `.rhv` of a large model opens with its edges already
showing: nothing needs to be calculated.

## Quick answers

**My edges look different after exporting the same model.** Expected. An exported file
carries the angle of every edge, so the Edge Angle slider can thin them out; the same
model opened as a `.3dm` shows every boundary.

**One object has no outline and the rest do.** Its surface is probably too smooth for
the current Edge Angle — common on SubD and on scanned or sculpted meshes. Lower the
slider until it appears.

**Turning Edges on did nothing.** Fixed in Drakon3D. Earlier versions could only show
edges that already existed, so on a model whose edges had to be calculated the switch
had no effect.

**Mesh objects used to have no outlines at all.** They are now outlined like any
other mesh, using the Edge Angle threshold. If a dense one looks busy, raise the
slider rather than switching edges off.
