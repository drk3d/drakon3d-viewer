/*
 * Drakon3D storefront embed.
 *
 * Usage:
 *   <drakon-viewer share="SHARE_ID" hide-file fit-viewport
 *     style="width:100%; height:700px; display:block;"></drakon-viewer>
 *   <script async src="https://viewer.drakon3d.com/embed.js"></script>
 *
 * The component deliberately keeps the Viewer in its own origin. Storefronts
 * therefore get a stable, small integration point while share authentication,
 * expiry and future Viewer updates continue to be handled by Drakon.
 */
(() => {
  const ELEMENT_NAME = 'drakon-viewer';
  const SHARE_ORIGIN = 'https://share.drakon3d.com';
  const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

  const enabled = (element, attribute) =>
    element.hasAttribute(attribute) && element.getAttribute(attribute) !== 'false';

  function viewerUrlFor(element) {
    const shareId = (element.getAttribute('share') || '').trim();
    if (!SHARE_ID_PATTERN.test(shareId)) return null;

    const url = new URL(`/s/${encodeURIComponent(shareId)}`, SHARE_ORIGIN);
    url.searchParams.set('embed', '1');

    if (enabled(element, 'hide-header')) {
      url.searchParams.set('header', '0');
    } else if (enabled(element, 'hide-file')) {
      url.searchParams.set('file', '0');
    }

    if (enabled(element, 'fit-viewport')) url.searchParams.set('viewport', 'full');
    return url.toString();
  }

  class DrakonViewerEmbed extends HTMLElement {
    static get observedAttributes() {
      return ['share', 'hide-header', 'hide-file', 'fit-viewport'];
    }

    connectedCallback() {
      this.render();
    }

    attributeChangedCallback() {
      if (this.isConnected) this.render();
    }

    render() {
      const src = viewerUrlFor(this);
      this.replaceChildren();
      if (!src) return;

      if (!this.style.display) this.style.display = 'block';
      const iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.title = 'Drakon3D Viewer';
      iframe.allow = 'fullscreen';
      iframe.allowFullscreen = true;
      iframe.loading = 'lazy';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.style.cssText = 'width:100%; height:100%; min-height:0; border:0; display:block;';
      this.append(iframe);
    }
  }

  if ('customElements' in window && !customElements.get(ELEMENT_NAME)) {
    customElements.define(ELEMENT_NAME, DrakonViewerEmbed);
  }
})();
