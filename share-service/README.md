# Drakon3D share service

This Cloudflare Worker holds temporary `.3dm` snapshots for `DkShare` and
returns them only to the Drakon3D Viewer. Objects expire after 14 days; also
configure an R2 lifecycle rule to delete the `shares/` prefix after 15 days as
a cleanup backstop.

## Deploy

1. In this folder, install dependencies and sign in to Cloudflare with Wrangler.
2. Create an R2 bucket named `drakon3d-shares`.
3. Set the Worker secret `DRAKON_SHARE_UPLOAD_TOKEN` to a unique, high-entropy
   value. Do not put this value in source control or ship it inside the plugin.
4. Deploy the Worker. Its public `workers.dev` URL becomes the value of
   `DRAKON_SHARE_API_URL` for the Drakon plugin. The Worker includes that
   public endpoint in each returned viewer link, so the static viewer needs no
   account-specific endpoint configured in source.

The uploader token is intentionally supplied at runtime by the plugin. For a
distributed release, replace the shared token with short-lived upload grants
issued by Drakon's licensing service; a permanent secret embedded in a Rhino
plugin can be extracted and is not safe.
